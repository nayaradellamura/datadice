import { Router } from 'express';
import { HttpError } from '../middleware/errorHandler.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { positiveId } from '../http/validate.js';
import {
  formatJoinCode, linkCharacter, MAX_PENDING, MAX_PLAYERS, MAX_TABLES_AS_GM, newJoinCode, normalizeJoinCode,
  tableFor, unlinkCharactersOf,
} from '../services/tables.js';


function tableName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 100) throw new HttpError(400, 'O nome da mesa é obrigatório e deve ter até 100 caracteres.');
  return name;
}

const description = (value) => (typeof value === 'string' ? value.trim().slice(0, 4000) : '');

/** Gera um código que ainda não está em uso (a coluna é UNIQUE; colisão é raríssima, mas tratada). */
async function withFreshCode(action) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await action(newJoinCode());
    } catch (err) {
      if (err.code !== '23505' || !String(err.constraint ?? '').includes('join_code')) throw err;
    }
  }
  throw new HttpError(500, 'Não foi possível gerar o código da mesa. Tente de novo.');
}

/**
 * Mesas em grupo (Mestre humano, sem IA). Tudo aqui exige ser membro ativo da mesa; o admin não tem
 * acesso especial, porque as mesas são conversas privadas entre os jogadores.
 */
export function tableRoutes(db, { hub, joinLimits = { windowMs: 15 * 60 * 1000, max: 30 } } = {}) {
  const router = Router();
  // Avisos em tempo real: 'table' faz quem está na mesa recarregar membros e fichas.
  const changed = (tableId) => {
    hub?.publish(tableId, 'table', {});
    hub?.publish(tableId, 'party', {});
  };
  const gmOnly = (tableId) => hub?.publish(tableId, 'table', {}, (sub) => sub.role === 'mestre');
  // Freia quem tenta adivinhar códigos.
  const joinLimiter = rateLimit({ ...joinLimits, message: 'Muitas tentativas de código. Aguarde alguns minutos e tente de novo.' });
  const createLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, key: (req) => `u${req.user.id}`, message: 'Muitas mesas criadas seguidas. Aguarde um minuto.' });

  // Minhas mesas: as que mestro, as que jogo e os pedidos que ainda esperam aprovação.
  router.get('/', async (req, res) => {
    const rows = await db.all(
      `SELECT * FROM (
         SELECT c.id, c.name, c.world_description AS description, c.created_at, m.role, m.status,
           (SELECT u.name FROM campaign_members g JOIN users u ON u.id = g.user_id
            WHERE g.campaign_id = c.id AND g.role = 'mestre' LIMIT 1) AS gm_name,
           (SELECT COUNT(*) FROM campaign_members p
            WHERE p.campaign_id = c.id AND p.role = 'jogador' AND p.status = 'ativo') AS players,
           (SELECT COUNT(*) FROM campaign_members p
            WHERE p.campaign_id = c.id AND p.status = 'pendente') AS pending,
           (SELECT ch.name FROM campaign_characters cc JOIN characters ch ON ch.id = cc.character_id
            WHERE cc.campaign_id = c.id AND ch.user_id = m.user_id LIMIT 1) AS my_character
         FROM campaigns c JOIN campaign_members m ON m.campaign_id = c.id
         WHERE c.mode = 'grupo' AND m.user_id = ? AND m.status IN ('ativo', 'pendente')
       ) x ORDER BY (x.status = 'pendente'), x.created_at DESC, x.id DESC`,
      req.user.id,
    );
    // Quem só pediu para entrar ainda não vê nada além do nome da mesa e do Mestre.
    res.json(rows.map((row) => ({
      ...row,
      description: row.status === 'ativo' ? row.description : '',
      pending: row.role === 'mestre' ? row.pending : 0,
      players: row.status === 'ativo' ? row.players : null,
      max_players: MAX_PLAYERS,
    })));
  });

  router.post('/', createLimiter, async (req, res) => {
    const name = tableName(req.body?.name);
    const text = description(req.body?.description);
    const id = await withFreshCode((code) => db.tx(async (t) => {
      // Trava por conta: vários pedidos ao mesmo tempo não passam do limite de mesas.
      await t.get('SELECT pg_advisory_xact_lock(1, ?)', req.user.id);
      const owned = await t.get(
        `SELECT COUNT(*) AS n FROM campaign_members m JOIN campaigns c ON c.id = m.campaign_id
         WHERE m.user_id = ? AND m.role = 'mestre' AND c.mode = 'grupo'`,
        req.user.id,
      );
      if (owned.n >= MAX_TABLES_AS_GM) throw new HttpError(409, `Você já é Mestre de ${MAX_TABLES_AS_GM} mesas. Exclua uma para criar outra.`);
      const { id: campaignId } = await t.run(
        `INSERT INTO campaigns (user_id, mode, name, world_description, join_code) VALUES (?, 'grupo', ?, ?, ?) RETURNING id`,
        req.user.id, name, text, code,
      );
      await t.run(
        `INSERT INTO campaign_members (campaign_id, user_id, role, status) VALUES (?, ?, 'mestre', 'ativo')`,
        campaignId, req.user.id,
      );
      return campaignId;
    }));
    res.status(201).json(await tableView(db, req.user, id));
  });

  // Pedido de entrada pelo código. Código errado e mesa fechada dão a mesma resposta.
  router.post('/join', joinLimiter, async (req, res) => {
    const code = normalizeJoinCode(req.body?.code);
    const table = code && (await db.get(
      `SELECT id, name, join_open FROM campaigns WHERE join_code = ? AND mode = 'grupo'`, code,
    ));
    if (!table || !table.join_open) throw new HttpError(404, 'Código não encontrado, ou a mesa não está aceitando pedidos agora.');

    const result = await db.tx(async (t) => {
      // Trava a mesa: dois pedidos ao mesmo tempo não passam do limite.
      await t.get('SELECT id FROM campaigns WHERE id = ? FOR UPDATE', table.id);
      const member = await t.get(
        'SELECT role, status FROM campaign_members WHERE campaign_id = ? AND user_id = ?', table.id, req.user.id,
      );
      if (member?.role === 'mestre') throw new HttpError(409, 'Você é o Mestre desta mesa.');
      if (member?.status === 'ativo') throw new HttpError(409, 'Você já está nesta mesa.');
      if (member?.status === 'pendente') return 'pendente';
      const { n } = await t.get(
        `SELECT COUNT(*) AS n FROM campaign_members WHERE campaign_id = ? AND status = 'pendente'`, table.id,
      );
      if (n >= MAX_PENDING) throw new HttpError(409, 'Esta mesa já tem muitos pedidos esperando. Fale com o Mestre.');
      // Quem foi removido pode pedir de novo; o Mestre decide outra vez.
      await t.run(
        `INSERT INTO campaign_members (campaign_id, user_id, role, status) VALUES (?, ?, 'jogador', 'pendente')
         ON CONFLICT (campaign_id, user_id) DO UPDATE SET status = 'pendente', role = 'jogador', created_at = now()`,
        table.id, req.user.id,
      );
      return 'pendente';
    });
    gmOnly(table.id);
    res.status(201).json({ id: table.id, name: table.name, status: result });
  });

  router.get('/:id', async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id);
    res.json(await tableView(db, req.user, table.id));
  });

  router.patch('/:id', async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id, { gm: true });
    const body = req.body ?? {};
    const name = body.name === undefined ? table.name : tableName(body.name);
    const text = body.description === undefined ? table.world_description : description(body.description);
    if (body.join_open !== undefined && typeof body.join_open !== 'boolean') throw new HttpError(400, 'join_open deve ser verdadeiro ou falso.');
    const open = body.join_open ?? table.join_open;
    await db.run('UPDATE campaigns SET name = ?, world_description = ?, join_open = ? WHERE id = ?', name, text, open, table.id);
    hub?.publish(table.id, 'table', {});
    res.json(await tableView(db, req.user, table.id));
  });

  // Código novo: o antigo para de funcionar (útil se vazou).
  router.post('/:id/code', async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id, { gm: true });
    await withFreshCode((code) => db.run('UPDATE campaigns SET join_code = ? WHERE id = ?', code, table.id));
    res.json(await tableView(db, req.user, table.id));
  });

  router.delete('/:id', async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id, { gm: true });
    await db.run('DELETE FROM campaigns WHERE id = ?', table.id);
    hub?.kick(table.id);
    res.status(204).end();
  });

  router.post('/:id/members/:userId/approve', async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id, { gm: true });
    const userId = positiveId(req.params.userId, 'Jogador');
    await db.tx(async (t) => {
      await t.get('SELECT id FROM campaigns WHERE id = ? FOR UPDATE', table.id);
      const member = await t.get(
        `SELECT status FROM campaign_members WHERE campaign_id = ? AND user_id = ? AND role = 'jogador'`, table.id, userId,
      );
      if (member?.status !== 'pendente') throw new HttpError(404, 'Pedido não encontrado.');
      const { n } = await t.get(
        `SELECT COUNT(*) AS n FROM campaign_members WHERE campaign_id = ? AND role = 'jogador' AND status = 'ativo'`, table.id,
      );
      if (n >= MAX_PLAYERS) throw new HttpError(409, `A mesa já tem ${MAX_PLAYERS} jogadores. Remova alguém antes de aprovar.`);
      await t.run(`UPDATE campaign_members SET status = 'ativo' WHERE campaign_id = ? AND user_id = ?`, table.id, userId);
    });
    changed(table.id);
    res.json(await tableView(db, req.user, table.id));
  });

  // Recusar um pedido ou remover um jogador. As fichas dele saem da mesa (continuam na conta dele).
  router.delete('/:id/members/:userId', async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id, { gm: true });
    const userId = positiveId(req.params.userId, 'Jogador');
    await db.tx(async (t) => {
      const member = await t.get(
        `SELECT status FROM campaign_members WHERE campaign_id = ? AND user_id = ? AND role = 'jogador'`, table.id, userId,
      );
      if (!member || member.status === 'removido') throw new HttpError(404, 'Jogador não encontrado nesta mesa.');
      if (member.status === 'pendente') {
        await t.run('DELETE FROM campaign_members WHERE campaign_id = ? AND user_id = ?', table.id, userId);
      } else {
        await t.run(`UPDATE campaign_members SET status = 'removido' WHERE campaign_id = ? AND user_id = ?`, table.id, userId);
        await unlinkCharactersOf(t, table.id, userId);
      }
    });
    hub?.kick(table.id, userId);
    changed(table.id);
    res.json(await tableView(db, req.user, table.id));
  });

  // O jogador sai da mesa, ou cancela o pedido que ainda espera aprovação.
  router.post('/:id/leave', async (req, res) => {
    const tableId = positiveId(req.params.id, 'Mesa');
    await db.tx(async (t) => {
      const member = await t.get(
        `SELECT m.role FROM campaign_members m JOIN campaigns c ON c.id = m.campaign_id
         WHERE m.campaign_id = ? AND m.user_id = ? AND c.mode = 'grupo' AND m.status IN ('ativo', 'pendente')`,
        tableId, req.user.id,
      );
      if (!member) throw new HttpError(404, 'Mesa não encontrada.');
      if (member.role === 'mestre') throw new HttpError(400, 'O Mestre não sai da mesa: para encerrá-la, exclua a mesa.');
      await t.run('DELETE FROM campaign_members WHERE campaign_id = ? AND user_id = ?', tableId, req.user.id);
      await unlinkCharactersOf(t, tableId, req.user.id);
    });
    hub?.kick(tableId, req.user.id);
    changed(tableId);
    res.status(204).end();
  });

  // A ficha que o jogador usa nesta mesa (uma por mesa; escolher outra troca).
  router.put('/:id/character', async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id);
    if (table.my_role !== 'jogador') throw new HttpError(400, 'O Mestre não usa ficha de jogador na mesa.');
    const characterId = positiveId(req.body?.character_id, 'Personagem');
    // Só fichas da própria conta (nem o admin escolhe ficha de outra pessoa aqui).
    const character = await db.get('SELECT * FROM characters WHERE id = ? AND user_id = ?', characterId, req.user.id);
    if (!character) throw new HttpError(404, 'Personagem não encontrado.');
    await db.tx(async (t) => {
      const current = await t.get(
        `SELECT cc.character_id FROM campaign_characters cc JOIN characters ch ON ch.id = cc.character_id
         WHERE cc.campaign_id = ? AND ch.user_id = ?`,
        table.id, req.user.id,
      );
      if (current?.character_id === character.id) return;
      await unlinkCharactersOf(t, table.id, req.user.id);
      await linkCharacter(t, table.id, character);
    });
    changed(table.id);
    res.json(await tableView(db, req.user, table.id));
  });

  router.delete('/:id/character', async (req, res) => {
    const table = await tableFor(db, req.user, req.params.id);
    await db.tx((t) => unlinkCharactersOf(t, table.id, req.user.id));
    changed(table.id);
    res.json(await tableView(db, req.user, table.id));
  });

  return router;
}

/**
 * Como a mesa aparece para quem pediu. Nunca inclui e-mails. Código, situação dos pedidos e
 * configurações de entrada só para o Mestre.
 */
async function tableView(db, user, id) {
  const table = await tableFor(db, user, id);
  const gm = table.my_role === 'mestre';
  const members = await db.all(
    `SELECT m.user_id, u.name, m.role, m.status, m.created_at,
            ch.id AS character_id, ch.name AS character_name, ch.race, ch.class, ch.level, ch.avatar_url
     FROM campaign_members m
     JOIN users u ON u.id = m.user_id
     LEFT JOIN LATERAL (
       SELECT c2.* FROM campaign_characters cc JOIN characters c2 ON c2.id = cc.character_id
       WHERE cc.campaign_id = m.campaign_id AND c2.user_id = m.user_id
       ORDER BY cc.id LIMIT 1
     ) ch ON true
     WHERE m.campaign_id = ? AND m.status ${gm ? "IN ('ativo', 'pendente')" : "= 'ativo'"}
     ORDER BY (m.role = 'mestre') DESC, m.created_at, m.user_id`,
    table.id,
  );
  const shape = (row) => ({
    user_id: row.user_id,
    name: row.name,
    role: row.role,
    status: row.status,
    character: row.character_id ? {
      id: row.character_id, name: row.character_name, race: row.race, class: row.class, level: row.level, avatar_url: row.avatar_url,
    } : null,
  });
  const active = members.filter((row) => row.status === 'ativo');
  const gmRow = active.find((row) => row.role === 'mestre');
  return {
    id: table.id,
    name: table.name,
    description: table.world_description,
    created_at: table.created_at,
    role: table.my_role,
    gm_name: gmRow?.name ?? '',
    max_players: MAX_PLAYERS,
    players: active.filter((row) => row.role === 'jogador').map(shape),
    my_character_id: active.find((row) => row.user_id === user.id)?.character_id ?? null,
    ...(gm ? {
      join_code: formatJoinCode(table.join_code),
      join_open: table.join_open,
      pending: members.filter((row) => row.status === 'pendente').map((row) => ({ user_id: row.user_id, name: row.name, requested_at: row.created_at })),
    } : {}),
  };
}
