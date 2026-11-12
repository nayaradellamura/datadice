import { Router } from 'express';
import { HttpError } from '../middleware/errorHandler.js';
import { campaignFor } from '../services/access.js';
import { getParty } from '../services/promptBuilder.js';
import { turnOptions } from './chat.js';
import { buildRecapDirective, endSession, getSessionState, INTRO_DIRECTIVE } from '../services/sessions.js';

export function sessionRoutes(db, gameMaster, needsKey) {
  const router = Router();

  // Abre a sessão: introdução em campanha nova, resumo em campanha que está voltando.
  router.post('/campaigns/:id/session', needsKey, async (req, res) => {
    const campaign = await campaignFor(db, req.user, req.params.id);
    const actor = (await getParty(db, campaign.id)).find((row) => row.character_id === req.body?.character_id);
    if (!actor) throw new HttpError(400, 'Este personagem não está nesta campanha.');

    const { status } = await getSessionState(db, campaign.id);
    if (status === 'active') throw new HttpError(409, 'Esta sessão já está em andamento.');

    const opening = status === 'new'
      ? { sessionKind: 'intro', directive: INTRO_DIRECTIVE }
      : { sessionKind: 'recap', directive: await buildRecapDirective(db, campaign.id) };

    const result = await gameMaster.playTurn({ campaign, actor, message: opening.directive, ...opening, ...turnOptions(req) });
    res.status(201).json({ ...result, session: await getSessionState(db, campaign.id) });
  });

  router.post('/campaigns/:id/session/end', async (req, res) => {
    const campaign = await campaignFor(db, req.user, req.params.id);
    if ((await getSessionState(db, campaign.id)).status === 'new') {
      throw new HttpError(409, 'Esta campanha ainda não começou.');
    }
    await endSession(db, campaign.id);
    res.json({ session: await getSessionState(db, campaign.id) });
  });

  return router;
}
