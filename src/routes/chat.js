import { Router } from 'express';
import { HttpError } from '../middleware/errorHandler.js';
import { campaignFor } from '../services/access.js';
import { getParty } from '../services/promptBuilder.js';

/** O navegador manda enable_image_gen; qualquer coisa diferente de true conta como desligado. */
export const turnOptions = (req) => ({
  llm: req.llm,
  images: req.images,
  illustrate: req.body?.enable_image_gen === true,
  userId: req.user.id,
});

/** O resultado vem do banco, nunca do navegador: assim ninguém consegue forjar o valor do dado. */
async function rollDirective(db, campaignId, rollId) {
  const id = Number(rollId);
  const roll = Number.isInteger(id) && id > 0 && id <= 2147483647 && (await db.get(
    `SELECT id, message_text FROM messages WHERE id = ? AND campaign_id = ? AND sender_type = 'system' AND sender_name = 'Dados'`,
    id, campaignId,
  ));
  if (!roll) throw new HttpError(400, 'Rolagem não encontrada nesta campanha.');

  const answered = await db.get(
    `SELECT 1 FROM messages WHERE campaign_id = ? AND id > ? AND sender_type IN ('gm', 'player') LIMIT 1`,
    campaignId, roll.id,
  );
  if (answered) throw new HttpError(409, 'O Mestre já seguiu a história depois desta rolagem.');

  return `[Rolagem] ${roll.message_text}
Esta rolagem acabou de ser feita no sistema. Se foi um teste que você pediu, use exatamente este resultado, compare com a CD que você definiu e narre a consequência. Se ninguém pediu, trate como a tentativa do personagem na cena atual. Não peça a mesma rolagem de novo.`;
}

export function chatRoutes(db, gameMaster) {
  const router = Router();

  router.post('/', async (req, res) => {
    const { campaign_id, character_id, message, roll_id } = req.body ?? {};

    const campaign = await campaignFor(db, req.user, campaign_id ?? 0);

    const actor = (await getParty(db, campaign.id)).find((row) => row.character_id === character_id);
    if (!actor) throw new HttpError(400, 'Este personagem não está nesta campanha.');
    if (actor.status === 'dead') throw new HttpError(400, 'Este personagem está morto.');

    if (roll_id !== undefined) {
      const directive = await rollDirective(db, campaign.id, roll_id);
      res.json(await gameMaster.playTurn({ campaign, actor, message: directive, directive, ...turnOptions(req) }));
      return;
    }

    const text = typeof message === 'string' ? message.trim() : '';
    if (!text) throw new HttpError(400, 'Escreva uma mensagem.');
    if (text.length > 4000) throw new HttpError(400, 'A mensagem deve ter até 4000 caracteres.');

    res.json(await gameMaster.playTurn({ campaign, actor, message: text, ...turnOptions(req) }));
  });

  return router;
}
