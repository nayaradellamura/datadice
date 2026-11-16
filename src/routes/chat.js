import { Router } from 'express';
import { HttpError } from '../middleware/errorHandler.js';
import { campaignFor } from '../services/access.js';
import { getParty } from '../services/promptBuilder.js';

/** O navegador manda enable_image_gen; qualquer coisa diferente de true conta como desligado. */
export const turnOptions = (req) => ({
  llm: req.llm,
  images: req.images,
  // Imagens só com chave do Gemini (quem joga com outra IA pode colar as duas).
  illustrate: req.body?.enable_image_gen === true && Boolean(req.images),
  userId: req.user.id,
});

/**
 * O resultado vem do banco, nunca do navegador: assim ninguém consegue forjar o valor do dado.
 * Rolagens feitas enquanto o Mestre ainda respondia chegam juntas (roll_ids): ele reage a todas de uma vez.
 * Só recusa se o jogador já escreveu depois delas (a história seguiu).
 */
async function rollDirective(db, campaignId, rollIds) {
  const ids = [...new Set([].concat(rollIds).map(Number))].filter((id) => Number.isInteger(id) && id > 0 && id <= 2147483647).slice(0, 10);
  if (!ids.length) throw new HttpError(400, 'Rolagem não encontrada nesta campanha.');
  const rolls = await db.all(
    `SELECT id, message_text FROM messages
     WHERE campaign_id = ? AND sender_type = 'system' AND sender_name = 'Dados' AND id IN (${ids.map(() => '?').join(', ')})
     ORDER BY id`,
    campaignId, ...ids,
  );
  if (rolls.length !== ids.length) throw new HttpError(400, 'Rolagem não encontrada nesta campanha.');

  const answered = await db.get(
    `SELECT 1 FROM messages WHERE campaign_id = ? AND id > ? AND sender_type = 'player' LIMIT 1`,
    campaignId, rolls[0].id,
  );
  if (answered) throw new HttpError(409, 'O Mestre já seguiu a história depois desta rolagem.');

  const found = rolls.map((roll) => roll.id);
  if (rolls.length === 1) {
    return { ids: found, directive: `[Rolagem] ${rolls[0].message_text}
Esta rolagem acabou de ser feita no sistema. Se foi um teste que você pediu, use exatamente este resultado, compare com a CD que você definiu e narre a consequência. Se ninguém pediu, trate como a tentativa do personagem na cena atual. Não peça a mesma rolagem de novo.` };
  }
  return { ids: found, directive: `[Rolagens] ${rolls.map((roll) => roll.message_text).join(' | ')}
Estas rolagens foram feitas em sequência no sistema, algumas enquanto você narrava. Use exatamente estes resultados, na ordem, e narre a consequência de todas juntas. Não peça as mesmas rolagens de novo.` };
}

export function chatRoutes(db, gameMaster) {
  const router = Router();
  const reacted = new Set();

  router.post('/', async (req, res) => {
    const { campaign_id, character_id, message, roll_id, roll_ids } = req.body ?? {};

    const campaign = await campaignFor(db, req.user, campaign_id ?? 0);

    const actor = (await getParty(db, campaign.id)).find((row) => row.character_id === character_id);
    if (!actor) throw new HttpError(400, 'Este personagem não está nesta campanha.');
    if (actor.status === 'dead') throw new HttpError(400, 'Este personagem está morto.');

    if (roll_id !== undefined || roll_ids !== undefined) {
      const { directive, ids } = await rollDirective(db, campaign.id, Array.isArray(roll_ids) ? roll_ids : roll_id);
      // A mesma rolagem não gera duas respostas do Mestre.
      if (ids.some((id) => reacted.has(id))) throw new HttpError(409, 'O Mestre já reagiu a esta rolagem.');
      for (const id of ids) reacted.add(id);
      try {
        res.json(await gameMaster.playTurn({ campaign, actor, message: directive, directive, ...turnOptions(req) }));
      } catch (err) {
        for (const id of ids) reacted.delete(id);
        throw err;
      }
      if (reacted.size > 5000) reacted.clear();
      return;
    }

    const text = typeof message === 'string' ? message.trim() : '';
    if (!text) throw new HttpError(400, 'Escreva uma mensagem.');
    if (text.length > 4000) throw new HttpError(400, 'A mensagem deve ter até 4000 caracteres.');

    res.json(await gameMaster.playTurn({ campaign, actor, message: text, ...turnOptions(req) }));
  });

  return router;
}
