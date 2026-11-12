import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { HttpError } from '../middleware/errorHandler.js';
import { campaignFor, characterFor } from '../services/access.js';
import { rollAttack, rollCheck, rollDamage, rollDeathSave, rollDiceExpression } from '../services/dice.js';
import {
  getSummary, MEMORY_COLUMNS, MEMORY_STATUSES, MEMORY_TYPES, MESSAGE_COLUMNS, normalizeKey,
} from '../services/memory.js';
import { getParty } from '../services/promptBuilder.js';
import { getSessionState, sessionMarkers } from '../services/sessions.js';
import { publicPartyMember } from '../services/sheet.js';
import { applyStatePatch, saveState } from '../services/partyState.js';
import { linkCharacter } from '../services/tables.js';
import { illustrationsByMessage } from '../services/visuals.js';
import { positiveId } from '../http/validate.js';



const publicParty = (rows) => rows.map(publicPartyMember);

function campaignFields(body) {
  const { name, system_prompt, world_description } = body ?? {};
  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (!cleanName || cleanName.length > 100) {
    throw new HttpError(400, 'O nome da campanha é obrigatório e deve ter até 100 caracteres.');
  }
  const text = (value) => (typeof value === 'string' ? value.trim().slice(0, 10000) : '');
  return { name: cleanName, system_prompt: text(system_prompt), world_description: text(world_description) };
}

function memoryFields(body, existing) {
  const pick = (key) => (body[key] === undefined ? existing?.[key] : body[key]);

  const name = typeof pick('name') === 'string' ? pick('name').trim() : '';
  const content = typeof pick('content') === 'string' ? pick('content').trim() : '';
  if (!name || name.length > 100) throw new HttpError(400, 'O nome é obrigatório e deve ter até 100 caracteres.');
  if (!content || content.length > 4000) throw new HttpError(400, 'O conteúdo é obrigatório e deve ter até 4000 caracteres.');

  const type = pick('type');
  if (!MEMORY_TYPES.includes(type)) throw new HttpError(400, 'Tipo de memória inválido.');

  const status = pick('status') ?? 'active';
  if (!MEMORY_STATUSES.includes(status)) throw new HttpError(400, 'Situação da memória inválida.');

  const importance = pick('importance') ?? 3;
  if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
    throw new HttpError(400, 'A importância deve ser um inteiro de 1 a 5.');
  }

  return { type, name, name_key: normalizeKey(name), content, importance, status, pinned: pick('pinned') ? 1 : 0 };
}

function rethrowDuplicate(err) {
  if (err.code === '23505') {
    throw new HttpError(409, 'Já existe uma memória com esse nome nesta campanha.');
  }
  throw err;
}

export function campaignRoutes(db) {
  const router = Router();

  router.post('/', async (req, res) => {
    const { name, system_prompt, world_description } = campaignFields(req.body);
    const { id } = await db.run(
      'INSERT INTO campaigns (user_id, name, system_prompt, world_description) VALUES (?, ?, ?, ?) RETURNING id',
      req.user.id, name, system_prompt, world_description,
    );
    res.status(201).json(await campaignFor(db, req.user, id));
  });

  router.put('/:id', async (req, res) => {
    const campaign = await campaignFor(db, req.user, positiveId(req.params.id, 'Campanha'));
    const { name, system_prompt, world_description } = campaignFields(req.body);
    await db.run(
      'UPDATE campaigns SET name = ?, system_prompt = ?, world_description = ? WHERE id = ?',
      name, system_prompt, world_description, campaign.id,
    );
    res.json(await campaignFor(db, req.user, campaign.id));
  });

  // O admin vê todas as do Solo; cada jogador, só as que criou. Mesas em grupo ficam em /api/tables.
  // Cada campanha vem com o tamanho do grupo, o total de mensagens e a última jogada, para os cartões.
  const list = (where) => `SELECT * FROM (
      SELECT c.*,
        (SELECT COUNT(*) FROM campaign_characters cc WHERE cc.campaign_id = c.id) AS party_size,
        (SELECT COUNT(*) FROM messages m WHERE m.campaign_id = c.id) AS message_count,
        (SELECT MAX(m.created_at) FROM messages m WHERE m.campaign_id = c.id) AS last_played_at,
        (SELECT u.name FROM users u WHERE u.id = c.user_id) AS owner_name
      FROM campaigns c WHERE c.mode = 'solo' ${where}
    ) x ORDER BY COALESCE(x.last_played_at, x.created_at) DESC, x.id DESC`;
  router.get('/', async (req, res) => {
    res.json(req.user.role === 'admin'
      ? await db.all(list(''))
      : await db.all(list('AND c.user_id = ?'), req.user.id));
  });

  router.post('/join', async (req, res) => {
    const campaignId = positiveId(req.body?.campaign_id, 'campaign_id');
    const characterId = positiveId(req.body?.character_id, 'character_id');
    await campaignFor(db, req.user, campaignId);
    const character = await characterFor(db, req.user, characterId);

    const result = await linkCharacter(db, campaignId, character);
    if (result.changes === 0) throw new HttpError(409, 'Este personagem já está nesta campanha.');

    res.status(201).json({ party: publicParty(await getParty(db, campaignId)) });
  });

  router.get('/:id/state', async (req, res) => {
    const campaign = await campaignFor(db, req.user, positiveId(req.params.id, 'Campanha'));
    res.json({
      campaign,
      party: publicParty(await getParty(db, campaign.id)),
      chronicle: (await getSummary(db, campaign.id)).summary_text,
      session: await getSessionState(db, campaign.id),
    });
  });

  router.get('/:id/messages', async (req, res) => {
    const campaign = await campaignFor(db, req.user, positiveId(req.params.id, 'Campanha'));
    const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 200));
    const rows = await db.all(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE campaign_id = ? ORDER BY id DESC LIMIT ?`,
      campaign.id, limit,
    );
    const illustrations = await illustrationsByMessage(db, campaign.id);
    const markers = await sessionMarkers(db, campaign.id);
    res.json(rows.reverse().map((row) => ({
      ...row,
      illustrations: illustrations.get(row.id) ?? [],
      session: markers.get(row.id) ?? null,
    })));
  });

  router.post('/:id/roll', async (req, res) => {
    const campaign = await campaignFor(db, req.user, positiveId(req.params.id, 'Campanha'));
    const characterId = positiveId(req.body?.character_id, 'character_id');
    const row = (await getParty(db, campaign.id)).find((entry) => entry.character_id === characterId);
    if (!row) throw new HttpError(400, 'Este personagem não está nesta campanha.');
    const member = publicPartyMember(row);

    const { kind, key, mode, expression, index } = req.body;
    let text;
    let deathUpdate = null;
    let critical = false;
    if (kind === 'attack') {
      ({ text, critical } = rollAttack(member, index, mode));
    } else if (kind === 'damage') {
      text = rollDamage(member, index, req.body.critical === true);
    } else if (kind === 'dice') {
      text = rollDiceExpression(member, expression);
    } else if (kind === 'death') {
      const death = rollDeathSave(member);
      text = death.text;
      deathUpdate = death.update;
    } else {
      text = rollCheck(member, { kind, key, mode });
    }

    const message = await db.tx(async (t) => {
      if (deathUpdate) {
        await t.run(
          `UPDATE campaign_characters
           SET current_hp = ?, death_successes = ?, death_failures = ?, status = ?
           WHERE campaign_id = ? AND character_id = ?`,
          deathUpdate.hp, deathUpdate.successes, deathUpdate.failures, deathUpdate.status, campaign.id, characterId,
        );
      }
      return (await t.run(
        `INSERT INTO messages (campaign_id, sender_type, sender_name, message_text, user_id, character_id, kind)
         VALUES (?, 'system', 'Dados', ?, ?, ?, 'rolagem') RETURNING ${MESSAGE_COLUMNS}`,
        campaign.id, text, req.user.id, characterId,
      )).rows[0];
    });
    res.status(201).json({ ...message, critical, party: publicParty(await getParty(db, campaign.id)) });
  });

  // Ajustes manuais do jogador no estado do personagem durante a campanha.
  router.patch('/:id/characters/:characterId', async (req, res) => {
    const campaign = await campaignFor(db, req.user, positiveId(req.params.id, 'Campanha'));
    const characterId = positiveId(req.params.characterId, 'Personagem');
    const row = await db.get(
      'SELECT * FROM campaign_characters WHERE campaign_id = ? AND character_id = ?',
      campaign.id, characterId,
    );
    if (!row) throw new HttpError(404, 'Este personagem não está nesta campanha.');

    await saveState(db, applyStatePatch(row, req.body ?? {}));
    res.json({ party: publicParty(await getParty(db, campaign.id)) });
  });

  // Caderno do Mestre: só o admin.
  router.get('/:id/memories', requireAdmin, async (req, res) => {
    const campaign = await campaignFor(db, req.user, positiveId(req.params.id, 'Campanha'));
    res.json(await db.all(
      `SELECT ${MEMORY_COLUMNS} FROM campaign_memories WHERE campaign_id = ?
       ORDER BY pinned DESC, importance DESC, updated_at DESC, id DESC`,
      campaign.id,
    ));
  });

  router.post('/:id/memories', requireAdmin, async (req, res) => {
    const campaign = await campaignFor(db, req.user, positiveId(req.params.id, 'Campanha'));
    const f = memoryFields(req.body ?? {});
    try {
      const { rows } = await db.run(
        `INSERT INTO campaign_memories (campaign_id, type, name, name_key, content, importance, status, pinned, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user') RETURNING ${MEMORY_COLUMNS}`,
        campaign.id, f.type, f.name, f.name_key, f.content, f.importance, f.status, f.pinned,
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      rethrowDuplicate(err);
    }
  });

  return router;
}

export function memoryRoutes(db) {
  const router = Router();
  router.use(requireAdmin);

  async function getMemory(req) {
    const memory = await db.get(
      `SELECT ${MEMORY_COLUMNS} FROM campaign_memories WHERE id = ?`,
      positiveId(req.params.id, 'Memória'),
    );
    if (!memory) throw new HttpError(404, 'Memória não encontrada.');
    return memory;
  }

  router.patch('/:id', async (req, res) => {
    const memory = await getMemory(req);
    const f = memoryFields(req.body ?? {}, memory);
    // Editar o texto protege a ficha; apenas fixar ou mudar a importância, não.
    const editedText = f.content !== memory.content || f.name !== memory.name;
    const source = editedText ? 'user' : memory.source;
    try {
      await db.run(
        `UPDATE campaign_memories
         SET type = ?, name = ?, name_key = ?, content = ?, importance = ?, status = ?, pinned = ?, source = ?, updated_at = now()
         WHERE id = ?`,
        f.type, f.name, f.name_key, f.content, f.importance, f.status, f.pinned, source, memory.id,
      );
    } catch (err) {
      rethrowDuplicate(err);
    }
    res.json(await db.get(`SELECT ${MEMORY_COLUMNS} FROM campaign_memories WHERE id = ?`, memory.id));
  });

  router.delete('/:id', async (req, res) => {
    const memory = await getMemory(req);
    await db.run('DELETE FROM campaign_memories WHERE id = ?', memory.id);
    res.status(204).end();
  });

  return router;
}
