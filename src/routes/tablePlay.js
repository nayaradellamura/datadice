import { Router } from 'express';
import { HttpError } from '../middleware/errorHandler.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { MAX_UPLOAD_BYTES } from './creation.js';
import {
  rollAttack, rollCheckDetailed, rollDamage, rollDeathSave, rollDiceExpression,
} from '../services/dice.js';
import { decodeImage } from '../services/geminiImages.js';
import { assertImageQuota, copyOwnImage, deleteImageIfUnused, saveImage } from '../services/imageStore.js';
import { normalizeKey } from '../services/memory.js';
import { applyStatePatch, describeStateChange, saveState } from '../services/partyState.js';
import { getParty } from '../services/promptBuilder.js';
import { ABILITIES, parseCharacter, publicCharacter, publicPartyMember } from '../services/sheet.js';
import { tableFor } from '../services/tables.js';
import { cleanText, int, positiveId } from '../http/validate.js';

/*
 * O jogo dentro de uma mesa em grupo: chat em tempo real, rolagens, estado dos personagens, iniciativa,
 * Biblioteca (NPCs, monstros, locais), imagens e notas do Mestre. Nada aqui usa IA.
 *
 * Quem vê cada mensagem:
 *   all     → todos da mesa;
 *   gm      → só o Mestre e quem escreveu (rolagens secretas, "rolar só para o Mestre");
 *   private → o Mestre, quem escreveu e o destinatário (conversa privada entre Mestre e um jogador).
 * O Mestre vê tudo da própria mesa. O admin do sistema não entra nas mesas.
 */

const LIBRARY_TABLES = { npc: 'npcs', monster: 'monsters', location: 'locations' };
const LIBRARY_LABELS = { npc: 'NPC', monster: 'Monstro', location: 'Local' };
const MAX_LIBRARY = 300;
const MAX_NOTES = 200;
const MAX_INITIATIVE = 40;




const MESSAGE_SELECT = `SELECT m.id, m.kind, m.sender_type, m.sender_name, m.message_text AS text, m.user_id, m.character_id,
    m.visibility, m.recipient_user_id, r.name AS recipient_name,
    CASE WHEN i.name IS NULL THEN NULL ELSE '/images/' || i.name END AS image_url, m.created_at
  FROM messages m
  LEFT JOIN users r ON r.id = m.recipient_user_id
  LEFT JOIN images i ON i.id = m.image_id`;

// Quem pode ver a mensagem (a mesma regra do SQL de visibleWhere).
export function canSee(message, { userId, role }) {
  return message.visibility === 'all' || role === 'mestre' || message.user_id === userId || message.recipient_user_id === userId;
}

const visibleWhere = (table, user) => ({
  sql: '(m.visibility = \'all\' OR ?::boolean OR m.user_id = ? OR m.recipient_user_id = ?)',
  params: [table.my_role === 'mestre', user.id, user.id],
});

/** Atributos e ataques de NPCs e monstros, no formato da ficha (os ataques rolam como os do jogador). */
export function cleanStats(body = {}) {
  const abilities = {};
  for (const { key } of ABILITIES) abilities[key] = int(body.abilities?.[key], `O atributo ${key}`, 1, 30, 10);
  const attacks = (Array.isArray(body.attacks) ? body.attacks : []).slice(0, 12).map((attack) => ({
    name: cleanText(attack?.name, 'O nome do ataque', 60),
    bonus: cleanText(String(attack?.bonus ?? ''), 'O bônus do ataque', 10, { required: false }),
    damage: cleanText(attack?.damage, 'O dano do ataque', 60, { required: false }),
  }));
  return {
    armor_class: int(body.armor_class, 'A CA', 0, 40, 10),
    max_hp: int(body.max_hp, 'Os PV', 1, 9999, 10),
    speed: cleanText(body.speed ?? '9 m', 'O deslocamento', 40, { required: false }),
    challenge: cleanText(body.challenge ?? '', 'O nível de desafio', 20, { required: false }),
    abilities,
    attacks,
    notes: cleanText(body.notes ?? '', 'As anotações', 4000, { required: false }),
  };
}

/** Confere e grava uma imagem enviada (dentro da cota da conta). Devolve { id, url }. */
export async function storeUpload(db, user, campaignId, image, prefix) {
  if (typeof image !== 'string' || !image) throw new HttpError(400, 'Escolha uma imagem.');
  let decoded;
  try {
    decoded = decodeImage(image);
  } catch {
    throw new HttpError(400, 'Use uma imagem PNG, JPG ou WebP.');
  }
  if (decoded.buffer.length > MAX_UPLOAD_BYTES) throw new HttpError(413, 'A imagem passou de 3 MB, mesmo depois de reduzida. Escolha outra.');
  await assertImageQuota(db, user.id, decoded.buffer.length);
  const url = await saveImage(db, { ...decoded, prefix, userId: user.id, campaignId });
  const { id } = await db.get('SELECT id FROM images WHERE name = ?', url.slice('/images/'.length));
  return { id, url };
}

/** Iniciativa sempre em ordem decrescente; a vez continua com quem estava jogando. */
function sortInitiative(state, currentId) {
  state.entries.sort((a, b) => b.initiative - a.initiative);
  const index = state.entries.findIndex((entry) => entry.id === currentId);
  state.turn_index = index >= 0 ? index : Math.min(state.turn_index, Math.max(0, state.entries.length - 1));
  return state;
}

const stateOf = (row) => (row
  ? { round: row.round, turn_index: row.turn_index, entries: JSON.parse(row.entries_json), version: row.version }
  : { round: 1, turn_index: 0, entries: [], version: 0 });

async function loadInitiative(db, campaignId) {
  return stateOf(await db.get('SELECT * FROM campaign_initiative WHERE campaign_id = ?', campaignId));
}

/**
 * Muda a iniciativa com a linha travada: várias pessoas rolando ao mesmo tempo não se atropelam.
 * change(state) altera o estado; devolver false cancela a gravação. A versão sobe a cada gravação.
 */
async function changeInitiative(db, campaignId, change) {
  return db.tx(async (t) => {
    await t.run('INSERT INTO campaign_initiative (campaign_id) VALUES (?) ON CONFLICT (campaign_id) DO NOTHING', campaignId);
    const state = stateOf(await t.get('SELECT * FROM campaign_initiative WHERE campaign_id = ? FOR UPDATE', campaignId));
    const before = { ...state, entries: [...state.entries] };
    if ((await change(state)) === false) return { state, before, saved: false };
    state.version += 1;
    await t.run(
      `UPDATE campaign_initiative SET round = ?, turn_index = ?, entries_json = ?, version = ?, updated_at = now() WHERE campaign_id = ?`,
      state.round, state.turn_index, JSON.stringify(state.entries), state.version, campaignId,
    );
    return { state, before, saved: true };
  });
}

/** O que cada um vê da iniciativa: jogadores não veem os ocultos nem os PV de NPCs e monstros. */
function initiativeView(state, role) {
  const current = state.entries[state.turn_index] ?? null;
  // Para jogadores: sem ocultos, sem PV de NPCs e monstros e sem o vínculo com a Biblioteca (que revelaria fichas ocultas).
  const entries = role === 'mestre'
    ? state.entries
    : state.entries.filter((entry) => !entry.hidden).map(({ hp, max_hp: maxHp, library_id: _id, library_kind: _kind, ...entry }) => (entry.kind === 'pc' ? { ...entry, hp, max_hp: maxHp } : entry));
  return {
    active: state.entries.length > 0,
    round: state.round,
    version: state.version,
    current_id: current && (role === 'mestre' || !current.hidden) ? current.id : null,
    entries,
  };
}

function cleanInitiativeEntry(entry) {
  const kind = ['pc', 'npc', 'monster'].includes(entry?.kind) ? entry.kind : 'monster';
  const id = typeof entry?.id === 'string' && /^[\w-]{1,40}$/.test(entry.id) ? entry.id : null;
  if (!id) throw new HttpError(400, 'Entrada da iniciativa sem identificador.');
  const clean = {
    id,
    kind,
    name: cleanText(entry.name, 'O nome na iniciativa', 60),
    initiative: int(entry.initiative, 'A iniciativa', -10, 60, 0),
    hidden: Boolean(entry.hidden),
  };
  if (kind === 'pc') clean.character_id = positiveId(entry.character_id, 'Personagem');
  else {
    clean.max_hp = int(entry.max_hp, 'Os PV máximos', 0, 9999, 0);
    clean.hp = int(entry.hp, 'Os PV', 0, clean.max_hp || 9999, clean.max_hp);
    if (entry.library_id) clean.library_id = positiveId(entry.library_id, 'Ficha da Biblioteca');
    if (entry.library_kind) clean.library_kind = entry.library_kind === 'npc' ? 'npc' : 'monster';
  }
  return clean;
}

function libraryRow(kind, row, gm) {
  const base = {
    kind, id: row.id, name: row.name, description: row.description, image_url: row.image_url, revealed: row.revealed,
  };
  return gm ? { ...base, stats: JSON.parse(row.stats_json || '{}') } : base;
}

export function tablePlayRoutes(db, hub) {
  const router = Router();
  // Por conta: várias pessoas jogando na mesma casa dividem o mesmo IP.
  const chatLimiter = rateLimit({ windowMs: 30 * 1000, max: 40, key: (req) => `u${req.user.id}`, message: 'Muitas mensagens seguidas. Respire e tente de novo em alguns segundos.' });
  const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 15, key: (req) => `u${req.user.id}`, message: 'Muitos envios seguidos. Aguarde um minuto.' });

  const messageById = (id) => db.get(`${MESSAGE_SELECT} WHERE m.id = ?`, id);

  async function postMessage(table, fields) {
    const { id } = await db.run(
      `INSERT INTO messages (campaign_id, sender_type, sender_name, message_text, user_id, character_id, kind, visibility, recipient_user_id, image_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      table.id, fields.sender_type, fields.sender_name, fields.text ?? '', fields.user_id ?? null, fields.character_id ?? null,
      fields.kind, fields.visibility ?? 'all', fields.recipient_user_id ?? null, fields.image_id ?? null,
    );
    const message = await messageById(id);
    hub.publish(table.id, 'message', message, (sub) => canSee(message, sub));
    return message;
  }

  const gmUserId = async (tableId) =>
    (await db.get(`SELECT user_id FROM campaign_members WHERE campaign_id = ? AND role = 'mestre'`, tableId)).user_id;

  async function activePlayer(tableId, userId) {
    return db.get(
      `SELECT u.id, u.name FROM campaign_members m JOIN users u ON u.id = m.user_id
       WHERE m.campaign_id = ? AND m.user_id = ? AND m.role = 'jogador' AND m.status = 'ativo'`,
      tableId, userId,
    );
  }

  async function myCharacter(table, user) {
    return (await getParty(db, table.id)).find((row) => row.user_id === user.id) ?? null;
  }

  const announceParty = (table) => hub.publish(table.id, 'party', {});

  // ---------- Tempo real ----------

  router.get('/:id/stream', async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id);
    hub.subscribe(table.id, { userId: req.user.id, role: table.my_role, expiresAt: req.tokenExpiresAt }, req, res);
  });

  // ---------- Chat ----------

  router.get('/:id/messages', async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id);
    const visible = visibleWhere(table, req.user);
    const limit = Math.min(300, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
    const after = Number.parseInt(req.query.after, 10);
    const before = Number.parseInt(req.query.before, 10);
    if (Number.isInteger(after) && after >= 0) {
      res.json(await db.all(
        `${MESSAGE_SELECT} WHERE m.campaign_id = ? AND m.id > ? AND ${visible.sql} ORDER BY m.id LIMIT ?`,
        table.id, after, ...visible.params, limit,
      ));
      return;
    }
    const rows = await db.all(
      `${MESSAGE_SELECT} WHERE m.campaign_id = ? AND m.id < ? AND ${visible.sql} ORDER BY m.id DESC LIMIT ?`,
      table.id, Number.isInteger(before) && before > 0 ? before : 2147483647, ...visible.params, limit,
    );
    res.json(rows.reverse());
  });

  router.post('/:id/messages', chatLimiter, async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id);
    const body = req.body ?? {};
    const text = cleanText(body.text, 'A mensagem', 4000);
    const gm = table.my_role === 'mestre';
    const fields = { user_id: req.user.id, text, visibility: 'all' };

    if (gm) {
      if (!['narracao', 'fala', 'ooc'].includes(body.kind)) throw new HttpError(400, 'Tipo de mensagem inválido.');
      fields.kind = body.kind;
      fields.sender_type = 'gm';
      fields.sender_name = body.kind === 'fala' ? cleanText(body.as, 'O nome de quem fala', 60)
        : body.kind === 'ooc' ? req.user.name : 'Mestre';
      if (body.to !== undefined && body.to !== 'all') {
        const player = await activePlayer(table.id, positiveId(body.to, 'Destinatário'));
        if (!player) throw new HttpError(400, 'Esse jogador não está na mesa.');
        fields.visibility = 'private';
        fields.recipient_user_id = player.id;
      }
    } else {
      if (!['fala', 'ooc'].includes(body.kind)) throw new HttpError(400, 'Tipo de mensagem inválido.');
      const character = body.kind === 'fala' ? await myCharacter(table, req.user) : null;
      fields.kind = body.kind;
      fields.sender_type = 'player';
      fields.sender_name = character?.name ?? req.user.name;
      fields.character_id = character?.character_id ?? null;
      if (body.to === 'gm') {
        fields.visibility = 'private';
        fields.recipient_user_id = await gmUserId(table.id);
      } else if (body.to !== undefined && body.to !== 'all') {
        throw new HttpError(400, 'Jogadores falam com todos ou só com o Mestre.');
      }
    }
    res.status(201).json(await postMessage(table, fields));
  });

  // Rolagens: o servidor rola (ninguém escolhe o resultado). secret: só o Mestre vê.
  router.post('/:id/roll', chatLimiter, async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id);
    const body = req.body ?? {};
    const gm = table.my_role === 'mestre';
    // O Mestre rola em segredo por padrão; o jogador escolhe rolar "só para o Mestre".
    const secret = gm ? body.secret !== false : body.secret === true;
    let text;
    let critical = false;
    let characterId = null;

    if (gm) {
      const label = cleanText(body.label ?? '', 'O nome da rolagem', 60, { required: false }) || 'Mestre';
      if (body.kind === 'dice') {
        text = rollDiceExpression({ name: label }, body.expression);
      } else if (body.kind === 'plain') {
        text = rollCheckDetailed({ name: label }, { kind: 'plain', mode: body.mode }).text;
      } else if (body.kind === 'monster_attack' || body.kind === 'monster_damage') {
        const kind = body.library_kind === 'npc' ? 'npc' : 'monster';
        const row = await db.get(
          `SELECT name, stats_json FROM ${LIBRARY_TABLES[kind]} WHERE id = ? AND campaign_id = ?`,
          positiveId(body.library_id, 'Ficha'), table.id,
        );
        if (!row) throw new HttpError(404, 'Ficha não encontrada na Biblioteca.');
        const member = { name: body.label ? label : row.name, sheet: { attacks: JSON.parse(row.stats_json || '{}').attacks ?? [] } };
        if (body.kind === 'monster_attack') ({ text, critical } = rollAttack(member, body.index, body.mode));
        else text = rollDamage(member, body.index, body.critical === true);
      } else {
        throw new HttpError(400, 'Tipo de rolagem inválido.');
      }
    } else {
      const row = await myCharacter(table, req.user);
      if (!row) {
        if (body.kind !== 'dice') throw new HttpError(400, 'Escolha sua ficha na aba Mesa para rolar testes e ataques.');
        text = rollDiceExpression({ name: req.user.name }, body.expression);
      } else {
        const member = publicPartyMember(row);
        characterId = row.character_id;
        if (body.kind === 'attack') {
          ({ text, critical } = rollAttack(member, body.index, body.mode));
        } else if (body.kind === 'damage') {
          text = rollDamage(member, body.index, body.critical === true);
        } else if (body.kind === 'dice') {
          text = rollDiceExpression(member, body.expression);
        } else if (body.kind === 'death') {
          if (!(row.current_hp === 0 && row.status === 'unconscious')) throw new HttpError(400, 'A salvaguarda contra a morte só vale com 0 PV e inconsciente.');
          const death = rollDeathSave(member);
          text = death.text;
          await db.run(
            `UPDATE campaign_characters SET current_hp = ?, death_successes = ?, death_failures = ?, status = ?
             WHERE campaign_id = ? AND character_id = ?`,
            death.update.hp, death.update.successes, death.update.failures, death.update.status, table.id, row.character_id,
          );
          announceParty(table);
        } else {
          const result = rollCheckDetailed(member, { kind: body.kind, key: body.key, mode: body.mode });
          text = result.text;
          // Iniciativa rolada durante um combate entra direto na ordem.
          if (body.kind === 'initiative') await joinInitiative(table, row, result.total, secret);
        }
      }
    }

    const message = await postMessage(table, {
      sender_type: 'system',
      sender_name: 'Dados',
      text,
      user_id: req.user.id,
      character_id: characterId,
      kind: 'rolagem',
      visibility: secret ? 'gm' : 'all',
    });
    res.status(201).json({ ...message, critical });
  });

  // ---------- Grupo: estado dos personagens ----------

  async function partyFor(table, user) {
    const rows = await getParty(db, table.id);
    const owners = new Map((await db.all(
      `SELECT u.id, u.name FROM campaign_members m JOIN users u ON u.id = m.user_id WHERE m.campaign_id = ?`, table.id,
    )).map((row) => [row.id, row.name]));
    return rows.map((row) => {
      const member = { ...publicPartyMember(row), owner_name: owners.get(row.user_id) ?? '' };
      if (table.my_role === 'mestre' || row.user_id === user.id) return member;
      // Dos outros jogadores, só o que se vê na mesa.
      const {
        character_id: characterId, user_id: userId, owner_name: ownerName, name, race, level, avatar_url: avatar,
        current_hp: hp, max_hp: maxHp, temp_hp: temp, status, conditions, armor_class: ac,
      } = member;
      return {
        character_id: characterId, user_id: userId, owner_name: ownerName, name, race, class: member.class, level,
        avatar_url: avatar, current_hp: hp, max_hp: maxHp, temp_hp: temp, status, conditions, armor_class: ac,
      };
    });
  }

  router.get('/:id/party', async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id);
    res.json(await partyFor(table, req.user));
  });

  // lock: true trava a linha (dentro de uma transação) para dois ajustes ao mesmo tempo não se perderem.
  async function partyRow(table, user, characterId, { conn = db, lock = false } = {}) {
    const row = await conn.get(
      `SELECT cc.*, ch.user_id AS owner_id, ch.name AS character_name FROM campaign_characters cc
       JOIN characters ch ON ch.id = cc.character_id WHERE cc.campaign_id = ? AND cc.character_id = ?
       ${lock ? 'FOR UPDATE OF cc' : ''}`,
      table.id, positiveId(characterId, 'Personagem'),
    );
    if (!row) throw new HttpError(404, 'Este personagem não está na mesa.');
    if (table.my_role !== 'mestre' && row.owner_id !== user.id) throw new HttpError(403, 'Só o Mestre mexe na ficha de outro jogador.');
    return row;
  }

  // Ajuste de estado (PV, condições...). hp_delta: dano (negativo, gasta antes os PV temporários) ou cura.
  router.patch('/:id/party/:characterId', async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id);
    const { row, next } = await db.tx(async (t) => {
      const current = await partyRow(table, req.user, req.params.characterId, { conn: t, lock: true });
      const body = { ...(req.body ?? {}) };
      if (body.hp_delta !== undefined) {
        const delta = int(body.hp_delta, 'O dano ou a cura', -9999, 9999, 0);
        if (delta < 0) {
          const absorbed = Math.min(current.temp_hp, -delta);
          body.temp_hp = current.temp_hp - absorbed;
          body.current_hp = Math.max(0, current.current_hp - (-delta - absorbed));
        } else {
          body.current_hp = Math.min(current.max_hp, current.current_hp + delta);
        }
        delete body.hp_delta;
      }
      const updated = applyStatePatch(current, body);
      await saveState(t, updated);
      return { row: current, next: updated };
    });
    const changes = describeStateChange(row, next);
    if (changes.length && table.my_role === 'mestre' && row.owner_id !== req.user.id) {
      // O jogador fica sabendo quando o Mestre mexe no personagem dele.
      await postMessage(table, {
        sender_type: 'system', sender_name: 'Mestre', kind: 'sistema', user_id: req.user.id,
        text: `O Mestre ajustou ${row.character_name}: ${changes.join('; ')}.`,
        visibility: 'private', recipient_user_id: row.owner_id, character_id: row.character_id,
      });
    } else if (changes.length && table.my_role !== 'mestre') {
      // E o Mestre fica sabendo quando o jogador mexe no próprio estado (só ele vê o aviso).
      await postMessage(table, {
        sender_type: 'system', sender_name: req.user.name, kind: 'sistema', user_id: req.user.id,
        text: `${req.user.name} ajustou ${row.character_name}: ${changes.join('; ')}.`,
        visibility: 'gm', character_id: row.character_id,
      });
    }
    announceParty(table);
    res.json(await partyFor(table, req.user));
  });

  // O Mestre abre e edita a ficha completa de um jogador da mesa.
  router.get('/:id/party/:characterId/sheet', async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id, { gm: true });
    const row = await partyRow(table, req.user, req.params.characterId);
    res.json(publicCharacter(await db.get('SELECT * FROM characters WHERE id = ?', row.character_id)));
  });

  const SHEET_LABELS = {
    name: 'nome', race: 'raça', class: 'classe', level: 'nível', xp: 'XP', max_hp: 'PV máximos', armor_class: 'CA',
    speed: 'deslocamento', str: 'Força', dex: 'Destreza', con: 'Constituição', int: 'Inteligência', wis: 'Sabedoria',
    cha: 'Carisma', background: 'antecedente', alignment: 'tendência', hit_die: 'dado de vida',
  };

  router.put('/:id/party/:characterId/sheet', async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id, { gm: true });
    const row = await partyRow(table, req.user, req.params.characterId);
    const current = await db.get('SELECT * FROM characters WHERE id = ?', row.character_id);
    const fields = parseCharacter(req.body);
    // Retrato e história são do jogador: o Mestre não troca (o retrato aparece em todas as mesas dele,
    // e a história entra nas campanhas com o Mestre IA).
    const columns = Object.keys(SHEET_LABELS).concat('player_name', 'sheet_json');
    await db.tx(async (t) => {
      await t.run(
        `UPDATE characters SET ${columns.map((column) => `"${column}" = ?`).join(', ')} WHERE id = ?`,
        ...columns.map((column) => fields[column]), current.id,
      );
      // Os PV de jogo mudam só nesta mesa; nas outras campanhas o jogador ajusta ao abrir a ficha.
      const gained = Math.max(0, fields.max_hp - current.max_hp);
      await t.run(
        'UPDATE campaign_characters SET max_hp = ?, current_hp = LEAST(?, current_hp + ?) WHERE character_id = ? AND campaign_id = ?',
        fields.max_hp, fields.max_hp, gained, current.id, table.id,
      );
    });
    const changed = Object.entries(SHEET_LABELS).filter(([column]) => fields[column] !== current[column]).map(([column, label]) =>
      (['level', 'xp', 'max_hp', 'armor_class', 'str', 'dex', 'con', 'int', 'wis', 'cha'].includes(column)
        ? `${label} ${current[column]} → ${fields[column]}` : label));
    if (fields.sheet_json !== current.sheet_json) changed.push('outros detalhes da ficha');
    if (changed.length && current.user_id !== req.user.id) {
      await postMessage(table, {
        sender_type: 'system', sender_name: 'Mestre', kind: 'sistema', user_id: req.user.id,
        text: `O Mestre alterou a ficha de ${fields.name}: ${changed.join('; ')}.`,
        visibility: 'private', recipient_user_id: current.user_id, character_id: current.id,
      });
    }
    await notifyCharacterTables(db, hub, current.id);
    res.json(publicCharacter(await db.get('SELECT * FROM characters WHERE id = ?', current.id)));
  });

  // ---------- Iniciativa ----------

  async function publishInitiative(table, state) {
    hub.publish(table.id, 'initiative', (sub) => initiativeView(state, sub.role));
  }

  async function joinInitiative(table, row, total, hidden) {
    const { state, saved } = await changeInitiative(db, table.id, (current) => {
      if (!current.entries.length) return false;
      const currentId = current.entries[current.turn_index]?.id;
      const existing = current.entries.find((entry) => entry.kind === 'pc' && entry.character_id === row.character_id);
      if (existing) existing.initiative = total;
      else if (current.entries.length < MAX_INITIATIVE) {
        current.entries.push({ id: `pc-${row.character_id}`, kind: 'pc', character_id: row.character_id, name: row.name, initiative: total, hidden });
      } else return false;
      sortInitiative(current, currentId);
      return true;
    });
    if (saved) await publishInitiative(table, state);
  }

  router.get('/:id/initiative', async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id);
    res.json(initiativeView(await loadInitiative(db, table.id), table.my_role));
  });

  // O Mestre monta e ajusta a ordem (adicionar, tirar, mudar PV e valores). Lista vazia encerra o combate.
  router.put('/:id/initiative', async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id, { gm: true });
    const body = req.body ?? {};
    if (!Array.isArray(body.entries) || body.entries.length > MAX_INITIATIVE) {
      throw new HttpError(400, `A iniciativa aceita até ${MAX_INITIATIVE} participantes.`);
    }
    const entries = body.entries.map(cleanInitiativeEntry);
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new HttpError(400, 'Participante repetido na iniciativa.');
    const seen = body.version === undefined ? null : int(body.version, 'A versão', 0, 2147483647, 0);
    const { state, before } = await changeInitiative(db, table.id, (current) => {
      // A ordem mudou desde que o Mestre a viu (ex.: um jogador rolou iniciativa): não sobrescreve.
      if (seen !== null && seen !== current.version) {
        throw new HttpError(409, 'A ordem de iniciativa mudou enquanto você editava (alguém rolou). A lista foi atualizada; faça a mudança de novo.', 'stale');
      }
      const currentId = body.current_id ?? current.entries[current.turn_index]?.id;
      current.round = entries.length ? int(body.round, 'A rodada', 1, 9999, current.round) : 1;
      current.turn_index = 0;
      current.entries = entries;
      sortInitiative(current, currentId);
      return true;
    });
    if (!before.entries.length && entries.length) {
      await postMessage(table, { sender_type: 'system', sender_name: 'Mestre', kind: 'sistema', user_id: req.user.id, text: 'Combate! Rolem iniciativa.' });
    } else if (before.entries.length && !entries.length) {
      await postMessage(table, { sender_type: 'system', sender_name: 'Mestre', kind: 'sistema', user_id: req.user.id, text: 'Fim do combate.' });
    }
    await publishInitiative(table, state);
    res.json(initiativeView(state, 'mestre'));
  });

  router.post('/:id/initiative/next', async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id, { gm: true });
    const step = req.body?.back === true ? -1 : 1;
    const { state } = await changeInitiative(db, table.id, (current) => {
      if (!current.entries.length) throw new HttpError(400, 'Não há combate em andamento.');
      let index = current.turn_index + step;
      if (index >= current.entries.length) { index = 0; current.round += 1; }
      if (index < 0) { index = current.entries.length - 1; current.round = Math.max(1, current.round - 1); }
      current.turn_index = index;
      return true;
    });
    const current = state.entries[state.turn_index];
    await postMessage(table, {
      sender_type: 'system', sender_name: 'Mestre', kind: 'sistema', user_id: req.user.id,
      text: `Rodada ${state.round} · vez de ${current.hidden ? 'alguém nas sombras' : current.name}.`,
    });
    await publishInitiative(table, state);
    res.json(initiativeView(state, 'mestre'));
  });

  // ---------- Biblioteca ----------

  async function libraryFor(table) {
    const gm = table.my_role === 'mestre';
    const result = [];
    for (const [kind, name] of Object.entries(LIBRARY_TABLES)) {
      const rows = await db.all(
        `SELECT * FROM ${name} WHERE campaign_id = ? ${gm ? '' : 'AND revealed'} ORDER BY name`, table.id,
      );
      result.push(...rows.map((row) => libraryRow(kind, row, gm)));
    }
    return result;
  }

  function libraryKind(value) {
    if (typeof value !== 'string' || !Object.hasOwn(LIBRARY_TABLES, value)) throw new HttpError(400, 'Tipo inválido: use NPC, Monstro ou Local.');
    return value;
  }

  const announceLibrary = (table) => hub.publish(table.id, 'library', {});

  async function announceReveal(table, user, kind, entry) {
    await postMessage(table, {
      sender_type: 'system', sender_name: 'Mestre', kind: 'sistema', user_id: user.id,
      text: `Nova entrada na Biblioteca: ${entry.name} (${LIBRARY_LABELS[kind]}).`,
    });
  }

  router.get('/:id/library', async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id);
    res.json(await libraryFor(table));
  });

  router.post('/:id/library', uploadLimiter, async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id, { gm: true });
    const body = req.body ?? {};
    const kind = libraryKind(body.kind);
    const name = cleanText(body.name, 'O nome', 100);
    const description = cleanText(body.description ?? '', 'A descrição', 4000, { required: false });
    const stats = kind === 'location' ? {} : cleanStats(body.stats);
    // Imagem nova, ou a de um modelo da própria pessoa (copiada para esta mesa).
    let image = body.image ? await storeUpload(db, req.user, table.id, body.image, 'biblioteca') : null;
    if (!image && body.image_from) {
      const url = await copyOwnImage(db, { url: body.image_from, userId: req.user.id, campaignId: table.id, prefix: 'biblioteca' });
      image = url ? { url } : null;
    }
    let row;
    try {
      row = await db.tx(async (t) => {
        // Trava a Biblioteca desta mesa: dois envios ao mesmo tempo não passam do limite.
        await t.get('SELECT pg_advisory_xact_lock(2, ?)', table.id);
        const { n } = await t.get(
          `SELECT (SELECT COUNT(*) FROM npcs WHERE campaign_id = ?) + (SELECT COUNT(*) FROM monsters WHERE campaign_id = ?)
                + (SELECT COUNT(*) FROM locations WHERE campaign_id = ?) AS n`, table.id, table.id, table.id,
        );
        if (n >= MAX_LIBRARY) throw new HttpError(409, `A Biblioteca chegou a ${MAX_LIBRARY} fichas. Exclua alguma para criar outra.`);
        return (await t.run(
          `INSERT INTO ${LIBRARY_TABLES[kind]} (campaign_id, name, name_key, description, image_url, image_status, revealed, stats_json)
           VALUES (?, ?, ?, ?, ?, 'ready', ?, ?) RETURNING *`,
          table.id, name, normalizeKey(name), description, image?.url ?? null, body.revealed === true, JSON.stringify(stats),
        )).rows[0];
      });
    } catch (err) {
      // Não gravou a ficha: a imagem enviada não fica perdida no banco.
      if (image) await deleteImageIfUnused(db, image.url);
      if (err.code === '23505') throw new HttpError(409, `Já existe ${LIBRARY_LABELS[kind]} com esse nome. Use outro (ex.: "${name} 2").`);
      throw err;
    }
    if (row.revealed) await announceReveal(table, req.user, kind, row);
    announceLibrary(table);
    res.status(201).json(libraryRow(kind, row, true));
  });

  router.patch('/:id/library/:kind/:entryId', uploadLimiter, async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id, { gm: true });
    const kind = libraryKind(req.params.kind);
    const sqlTable = LIBRARY_TABLES[kind];
    const row = await db.get(`SELECT * FROM ${sqlTable} WHERE id = ? AND campaign_id = ?`, positiveId(req.params.entryId, 'Ficha'), table.id);
    if (!row) throw new HttpError(404, 'Ficha não encontrada na Biblioteca.');
    const body = req.body ?? {};
    const name = body.name === undefined ? row.name : cleanText(body.name, 'O nome', 100);
    const description = body.description === undefined ? row.description : cleanText(body.description, 'A descrição', 4000, { required: false });
    const stats = body.stats === undefined || kind === 'location' ? row.stats_json : JSON.stringify(cleanStats(body.stats));
    const revealed = body.revealed === undefined ? row.revealed : body.revealed === true;
    let imageUrl = row.image_url;
    if (body.remove_image === true) imageUrl = null;
    if (body.image) imageUrl = (await storeUpload(db, req.user, table.id, body.image, 'biblioteca')).url;
    let updated;
    try {
      updated = (await db.run(
        `UPDATE ${sqlTable} SET name = ?, name_key = ?, description = ?, stats_json = ?, revealed = ?, image_url = ?, image_status = 'ready'
         WHERE id = ? RETURNING *`,
        name, normalizeKey(name), description, stats, revealed, imageUrl, row.id,
      )).rows[0];
    } catch (err) {
      if (imageUrl !== row.image_url) await deleteImageIfUnused(db, imageUrl);
      if (err.code === '23505') throw new HttpError(409, `Já existe ${LIBRARY_LABELS[kind]} com esse nome.`);
      throw err;
    }
    // A imagem antiga, trocada ou removida, sai do banco (se nada mais a usa).
    if (row.image_url && row.image_url !== imageUrl) await deleteImageIfUnused(db, row.image_url);
    if (!row.revealed && updated.revealed) await announceReveal(table, req.user, kind, updated);
    announceLibrary(table);
    res.json(libraryRow(kind, updated, true));
  });

  router.delete('/:id/library/:kind/:entryId', async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id, { gm: true });
    const kind = libraryKind(req.params.kind);
    const result = await db.run(
      `DELETE FROM ${LIBRARY_TABLES[kind]} WHERE id = ? AND campaign_id = ? RETURNING image_url`, positiveId(req.params.entryId, 'Ficha'), table.id,
    );
    if (!result.changes) throw new HttpError(404, 'Ficha não encontrada na Biblioteca.');
    await deleteImageIfUnused(db, result.rows[0].image_url);
    announceLibrary(table);
    res.status(204).end();
  });

  // ---------- Imagens do Mestre ----------

  router.post('/:id/images', uploadLimiter, async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id, { gm: true });
    const body = req.body ?? {};
    const caption = cleanText(body.caption ?? '', 'A legenda', 500, { required: false });
    let recipient = null;
    if (body.to !== undefined && body.to !== 'all') {
      recipient = await activePlayer(table.id, positiveId(body.to, 'Destinatário'));
      if (!recipient) throw new HttpError(400, 'Esse jogador não está na mesa.');
    }
    const image = await storeUpload(db, req.user, table.id, body.image, 'mesa');
    const message = await postMessage(table, {
      sender_type: 'gm', sender_name: 'Mestre', kind: 'imagem', user_id: req.user.id, text: caption, image_id: image.id,
      visibility: recipient ? 'private' : 'all', recipient_user_id: recipient?.id ?? null,
    });
    res.status(201).json(message);
  });

  router.get('/:id/gallery', async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id);
    const visible = visibleWhere(table, req.user);
    res.json(await db.all(
      `${MESSAGE_SELECT} WHERE m.campaign_id = ? AND m.kind = 'imagem' AND m.image_id IS NOT NULL AND ${visible.sql}
       ORDER BY m.id DESC LIMIT 200`,
      table.id, ...visible.params,
    ));
  });

  // ---------- Notas privadas do Mestre ----------

  const noteFields = (body) => ({
    title: cleanText(body?.title ?? '', 'O título', 120, { required: false }),
    body: cleanText(body?.body ?? '', 'A nota', 20000, { required: false }),
  });

  async function noteFor(table, user, id) {
    const note = await db.get(
      'SELECT id, title, body, created_at, updated_at FROM gm_notes WHERE id = ? AND campaign_id = ? AND user_id = ?',
      positiveId(id, 'Nota'), table.id, user.id,
    );
    if (!note) throw new HttpError(404, 'Nota não encontrada.');
    return note;
  }

  router.get('/:id/notes', async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id, { gm: true });
    res.json(await db.all(
      'SELECT id, title, body, created_at, updated_at FROM gm_notes WHERE campaign_id = ? AND user_id = ? ORDER BY updated_at DESC, id DESC',
      table.id, req.user.id,
    ));
  });

  router.post('/:id/notes', async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id, { gm: true });
    const fields = noteFields(req.body);
    const note = await db.tx(async (t) => {
      await t.get('SELECT pg_advisory_xact_lock(4, ?)', table.id);
      const { n } = await t.get('SELECT COUNT(*) AS n FROM gm_notes WHERE campaign_id = ?', table.id);
      if (n >= MAX_NOTES) throw new HttpError(409, `Limite de ${MAX_NOTES} notas por mesa.`);
      return (await t.run(
        'INSERT INTO gm_notes (campaign_id, user_id, title, body) VALUES (?, ?, ?, ?) RETURNING id, title, body, created_at, updated_at',
        table.id, req.user.id, fields.title, fields.body,
      )).rows[0];
    });
    res.status(201).json(note);
  });

  router.patch('/:id/notes/:noteId', async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id, { gm: true });
    const note = await noteFor(table, req.user, req.params.noteId);
    const fields = noteFields({ ...note, ...req.body });
    const { rows } = await db.run(
      'UPDATE gm_notes SET title = ?, body = ?, updated_at = now() WHERE id = ? RETURNING id, title, body, created_at, updated_at',
      fields.title, fields.body, note.id,
    );
    res.json(rows[0]);
  });

  router.delete('/:id/notes/:noteId', async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id, { gm: true });
    const note = await noteFor(table, req.user, req.params.noteId);
    await db.run('DELETE FROM gm_notes WHERE id = ?', note.id);
    res.status(204).end();
  });

  return router;
}

/** Avisa as mesas em que o personagem está que a ficha mudou (para recarregarem o grupo). */
export async function notifyCharacterTables(db, hub, characterId) {
  const rows = await db.all(
    `SELECT cc.campaign_id FROM campaign_characters cc JOIN campaigns c ON c.id = cc.campaign_id
     WHERE cc.character_id = ? AND c.mode = 'grupo'`,
    characterId,
  );
  for (const row of rows) hub.publish(row.campaign_id, 'party', {});
}
