import { HttpError } from '../middleware/errorHandler.js';
import { normalizeKey } from './memory.js';

export const VISUAL_KINDS = {
  npc: {
    table: 'npcs',
    style: 'fantasy RPG character portrait, detailed face, upper body',
    aspectRatio: '2:3',
    filePrefix: 'npc',
  },
  monster: {
    table: 'monsters',
    style: 'fantasy RPG creature illustration, full body, dramatic lighting',
    aspectRatio: '2:3',
    filePrefix: 'monstro',
  },
  location: {
    table: 'locations',
    style: 'fantasy RPG environment concept art, wide establishing shot, no people',
    aspectRatio: '3:2',
    filePrefix: 'local',
  },
};

const MAX_PER_TURN = 3;

const ALL_VISUALS = Object.entries(VISUAL_KINDS)
  .map(([kind, { table }]) =>
    `SELECT '${kind}' AS kind, id, campaign_id, name, description, image_url, image_status, image_error, created_at FROM ${table}`)
  .join(' UNION ALL ');

export function listVisuals(db, campaignId) {
  return db.all(`SELECT * FROM (${ALL_VISUALS}) v WHERE campaign_id = ? ORDER BY created_at DESC, kind, id DESC`, campaignId);
}

export async function illustrationsByMessage(db, campaignId) {
  const rows = await db.all(
    `SELECT mi.message_id, v.* FROM message_illustrations mi
     JOIN (${ALL_VISUALS}) v ON v.kind = mi.kind AND v.id = mi.entity_id
     WHERE v.campaign_id = ?
     ORDER BY mi.id`,
    campaignId,
  );
  const byMessage = new Map();
  for (const { message_id: messageId, ...visual } of rows) {
    if (!byMessage.has(messageId)) byMessage.set(messageId, []);
    byMessage.get(messageId).push(visual);
  }
  return byMessage;
}

/**
 * Cada imagem é gerada com o cliente (e a chave) do jogador que pediu. Nada fica guardado depois:
 * se o servidor reiniciar no meio, a imagem vira "falhou" e o jogador pede de novo.
 */
export function createVisuals({ db, onError = (err) => console.warn(`Imagem não gerada: ${err.message}`) }) {
  const running = new Map();

  function getVisual(t, kind, id) {
    return t.get(`SELECT * FROM (${ALL_VISUALS}) v WHERE kind = ? AND id = ?`, kind, id);
  }

  async function generate(kind, id, images) {
    const { table, style, aspectRatio, filePrefix } = VISUAL_KINDS[kind];
    const row = await db.get(`SELECT * FROM ${table} WHERE id = ? AND image_status = 'pending'`, id);
    if (!row) return;
    try {
      if (!images) throw new Error('A geração de imagens não está configurada.');
      const url = await images.generate(`${style}, ${row.image_prompt}`.slice(0, 2000), {
        aspectRatio, filePrefix, campaignId: row.campaign_id,
      });
      await db.run(`UPDATE ${table} SET image_url = ?, image_status = 'ready', image_error = NULL WHERE id = ?`, url, id);
    } catch (err) {
      // Só mensagens nossas, já pensadas para o jogador, vão para a tela.
      const reason = err instanceof HttpError ? err.message : 'Não foi possível gerar a imagem. Tente de novo.';
      await db.run(`UPDATE ${table} SET image_status = 'failed', image_error = ? WHERE id = ?`, reason, id);
      onError(err);
    }
  }

  function enqueue(kind, id, images) {
    const key = `${kind}:${id}`;
    if (running.has(key)) return;
    running.set(key, generate(kind, id, images).catch(onError).finally(() => running.delete(key)));
  }

  return {
    /**
     * Grava os elementos marcados pelo Mestre e os liga à mensagem, reutilizando o cache.
     * Roda dentro da transação do turno; a geração começa só depois, com enqueueAll.
     */
    async register(t, campaignId, messageId, illustrations) {
      if (!Array.isArray(illustrations)) return [];
      const results = [];

      for (const raw of illustrations) {
        if (results.length === MAX_PER_TURN) break;
        const config = Object.hasOwn(VISUAL_KINDS, raw?.kind ?? '') ? VISUAL_KINDS[raw.kind] : null;
        const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, 100) : '';
        const key = normalizeKey(name);
        if (!config || !key) continue;

        const description = typeof raw.description === 'string' ? raw.description.trim().slice(0, 1000) : '';
        const prompt = typeof raw.image_prompt_en === 'string' ? raw.image_prompt_en.trim().slice(0, 1000) : '';

        const existing = await t.get(`SELECT id, image_status FROM ${config.table} WHERE campaign_id = ? AND name_key = ?`, campaignId, key);
        let id;
        if (existing) {
          id = existing.id;
          // Uma imagem que falhou ganha nova chance quando o elemento volta à cena.
          if (existing.image_status === 'failed') {
            await t.run(`UPDATE ${config.table} SET image_status = 'pending', image_error = NULL WHERE id = ?`, id);
          }
        } else {
          const imagePrompt = prompt || description;
          if (!imagePrompt) continue;
          ({ id } = await t.run(
            `INSERT INTO ${config.table} (campaign_id, name, name_key, description, image_prompt) VALUES (?, ?, ?, ?, ?) RETURNING id`,
            campaignId, name, key, description, imagePrompt,
          ));
        }

        await t.run(
          'INSERT INTO message_illustrations (message_id, kind, entity_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
          messageId, raw.kind, id,
        );
        const visual = await getVisual(t, raw.kind, id);
        if (!results.some((item) => item.kind === visual.kind && item.id === visual.id)) results.push(visual);
      }
      return results;
    },

    enqueueAll(visuals, images) {
      for (const { kind, id, image_status: status } of visuals) {
        if (status === 'pending') enqueue(kind, id, images);
      }
    },

    async retry(kind, id, images) {
      if (!Object.hasOwn(VISUAL_KINDS, kind)) throw new HttpError(400, 'Tipo de imagem inválido.');
      const visual = await getVisual(db, kind, id);
      if (!visual) throw new HttpError(404, 'Imagem não encontrada.');
      if (visual.image_status === 'ready') throw new HttpError(409, 'Esta imagem já está pronta.');
      await db.run(`UPDATE ${VISUAL_KINDS[kind].table} SET image_status = 'pending', image_error = NULL WHERE id = ?`, id);
      // Lê antes de começar: a geração roda em paralelo e poderia terminar antes desta resposta.
      const pending = await getVisual(db, kind, id);
      enqueue(kind, id, images);
      return pending;
    },

    /** Na inicialização: o que ficou pela metade não tem mais a chave de quem pediu, então vira "tentar de novo". */
    async failInterrupted() {
      for (const { table } of Object.values(VISUAL_KINDS)) {
        await db.run(
          `UPDATE ${table} SET image_status = 'failed', image_error = ? WHERE image_status = 'pending'`,
          'A geração foi interrompida porque o servidor reiniciou. Tente de novo.',
        );
      }
    },

    waitForIdle: async () => {
      while (running.size) await Promise.all(running.values());
    },
  };
}
