import { Router } from 'express';
import { asId, cleanText, positiveId } from '../http/validate.js';
import { HttpError } from '../middleware/errorHandler.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { copyOwnImage, deleteImageIfUnused } from '../services/imageStore.js';
import { normalizeKey } from '../services/memory.js';
import { tableFor } from '../services/tables.js';
import { cleanStats, storeUpload } from './tablePlay.js';

/**
 * "Meus modelos": NPCs, monstros e locais que o Mestre guarda na própria conta para reaproveitar em
 * qualquer mesa. Cada pessoa só vê e mexe nos seus.
 */
const KINDS = ['npc', 'monster', 'location'];
const LABELS = { npc: 'NPC', monster: 'monstro', location: 'local' };
const TABLES = { npc: 'npcs', monster: 'monsters', location: 'locations' };
export const MAX_TEMPLATES = 300;
const COLUMNS = 'id, kind, name, description, image_url, stats_json, created_at, updated_at';

const shape = ({ stats_json: stats, ...row }) => ({ ...row, stats: JSON.parse(stats || '{}') });

function kindOf(value) {
  if (!KINDS.includes(value)) throw new HttpError(400, 'Tipo inválido: use NPC, Monstro ou Local.');
  return value;
}

const duplicate = (err, kind) => {
  if (err.code === '23505') throw new HttpError(409, `Você já tem um modelo de ${LABELS[kind]} com esse nome.`);
  throw err;
};

export function templateRoutes(db) {
  const router = Router();
  const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 15, key: (req) => `u${req.user.id}`, message: 'Muitos envios seguidos. Aguarde um minuto.' });

  async function ownTemplate(req) {
    const id = asId(req.params.id);
    const row = id
      && (await db.get(`SELECT ${COLUMNS} FROM gm_templates WHERE id = ? AND user_id = ?`, id, req.user.id));
    if (!row) throw new HttpError(404, 'Modelo não encontrado.');
    return row;
  }

  /**
   * Grava um modelo dentro do limite da conta (com trava, para envios ao mesmo tempo não passarem dele).
   * Se não gravar (limite, nome repetido), a imagem já enviada ou copiada sai do banco.
   */
  async function insertTemplate(userId, { kind, name, description, imageUrl, statsJson }) {
    try {
      return await db.tx(async (t) => {
        await t.get('SELECT pg_advisory_xact_lock(3, ?)', userId);
        const { n } = await t.get('SELECT COUNT(*) AS n FROM gm_templates WHERE user_id = ?', userId);
        if (n >= MAX_TEMPLATES) throw new HttpError(409, `Você chegou a ${MAX_TEMPLATES} modelos. Exclua algum para guardar outro.`);
        return (await t.run(
          `INSERT INTO gm_templates (user_id, kind, name, name_key, description, image_url, stats_json)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
          userId, kind, name, normalizeKey(name), description, imageUrl, statsJson,
        )).rows[0];
      });
    } catch (err) {
      if (imageUrl) await deleteImageIfUnused(db, imageUrl);
      return duplicate(err, kind);
    }
  }

  // Imagem do modelo: nova (upload) ou cópia de uma imagem que já é da pessoa (ex.: da Biblioteca de uma mesa).
  async function imageFor(req, body) {
    if (body.image) return (await storeUpload(db, req.user, null, body.image, 'modelo')).url;
    if (body.image_from) return copyOwnImage(db, { url: body.image_from, userId: req.user.id, prefix: 'modelo' });
    return null;
  }

  router.get('/', async (req, res) => {
    const rows = await db.all(`SELECT ${COLUMNS} FROM gm_templates WHERE user_id = ? ORDER BY kind, name`, req.user.id);
    res.json(rows.map(shape));
  });

  router.post('/', uploadLimiter, async (req, res) => {
    const body = req.body ?? {};
    const kind = kindOf(body.kind);
    const name = cleanText(body.name, 'O nome', 100);
    const description = cleanText(body.description, 'A descrição', 4000, { required: false });
    const statsJson = JSON.stringify(kind === 'location' ? {} : cleanStats(body.stats));
    const imageUrl = await imageFor(req, body);
    res.status(201).json(shape(await insertTemplate(req.user.id, { kind, name, description, imageUrl, statsJson })));
  });

  // Guarda nos modelos uma ficha que já está na Biblioteca de uma mesa (só o Mestre daquela mesa).
  router.post('/from-library', uploadLimiter, async (req, res) => {
    const body = req.body ?? {};
    const table = await tableFor(db, req.user, body.table_id, { gm: true });
    const kind = kindOf(body.kind);
    const entry = await db.get(`SELECT * FROM ${TABLES[kind]} WHERE id = ? AND campaign_id = ?`, positiveId(body.id, 'Ficha'), table.id);
    if (!entry) throw new HttpError(404, 'Ficha não encontrada na Biblioteca.');
    const imageUrl = entry.image_url ? await copyOwnImage(db, { url: entry.image_url, userId: req.user.id, prefix: 'modelo' }) : null;
    res.status(201).json(shape(await insertTemplate(req.user.id, {
      kind, name: entry.name, description: entry.description, imageUrl, statsJson: kind === 'location' ? '{}' : entry.stats_json,
    })));
  });

  router.patch('/:id', uploadLimiter, async (req, res) => {
    const row = await ownTemplate(req);
    const body = req.body ?? {};
    const name = body.name === undefined ? row.name : cleanText(body.name, 'O nome', 100);
    const description = body.description === undefined ? row.description : cleanText(body.description, 'A descrição', 4000, { required: false });
    const stats = body.stats === undefined || row.kind === 'location' ? row.stats_json : JSON.stringify(cleanStats(body.stats));
    let imageUrl = body.remove_image === true ? null : row.image_url;
    imageUrl = (await imageFor(req, body)) ?? imageUrl;
    let updated;
    try {
      updated = (await db.run(
        `UPDATE gm_templates SET name = ?, name_key = ?, description = ?, stats_json = ?, image_url = ?, updated_at = now()
         WHERE id = ? RETURNING ${COLUMNS}`,
        name, normalizeKey(name), description, stats, imageUrl, row.id,
      )).rows[0];
    } catch (err) {
      if (imageUrl !== row.image_url) await deleteImageIfUnused(db, imageUrl);
      return duplicate(err, row.kind);
    }
    // A imagem antiga, trocada ou removida, sai do banco (se nada mais a usa).
    if (row.image_url && row.image_url !== imageUrl) await deleteImageIfUnused(db, row.image_url);
    res.json(shape(updated));
  });

  router.delete('/:id', async (req, res) => {
    const row = await ownTemplate(req);
    await db.run('DELETE FROM gm_templates WHERE id = ?', row.id);
    await deleteImageIfUnused(db, row.image_url);
    res.status(204).end();
  });

  return router;
}
