import { Router } from 'express';
import { HttpError } from '../middleware/errorHandler.js';
import { campaignFor, visualCampaignFor } from '../services/access.js';
import { listVisuals, VISUAL_KINDS } from '../services/visuals.js';

export function visualRoutes(db, visuals, needsKey) {
  const router = Router();

  router.get('/campaigns/:id/visuals', async (req, res) => {
    const campaign = await campaignFor(db, req.user, req.params.id);
    res.json(await listVisuals(db, campaign.id));
  });

  router.post('/visuals/:kind/:id/retry', needsKey, async (req, res) => {
    const { kind } = req.params;
    if (!Object.hasOwn(VISUAL_KINDS, kind)) throw new HttpError(400, 'Tipo de imagem inválido.');
    await visualCampaignFor(db, req.user, VISUAL_KINDS[kind].table, req.params.id);
    res.status(202).json(await visuals.retry(kind, Number(req.params.id), req.images));
  });

  return router;
}
