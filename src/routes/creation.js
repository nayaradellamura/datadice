import { Router } from 'express';
import { HttpError } from '../middleware/errorHandler.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { campaignPrompt, cleanCampaign, LENGTHS, THEMES, TONES } from '../services/campaignGenerator.js';
import { logTokens } from '../services/gameMaster.js';
import { decodeImage } from '../services/geminiImages.js';
import { assertImageQuota, saveImage } from '../services/imageStore.js';

export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

/** Campanha criada pela IA a partir de um tema. Devolve um rascunho; nada é salvo até o jogador confirmar. */
export function campaignGeneratorRoutes(db, needsKey) {
  const router = Router();

  router.get('/themes', (_req, res) => {
    res.json({
      themes: THEMES.map(({ key, icon, title, blurb }) => ({ key, icon, title, blurb })),
      tones: Object.keys(TONES),
      lengths: Object.keys(LENGTHS),
    });
  });

  router.post('/generate', needsKey, async (req, res) => {
    const prompt = campaignPrompt(req.body ?? {});
    const source = { userId: req.user.id, kind: 'campaign' };
    let result;
    try {
      result = await req.llm.generateJson(prompt);
    } catch (err) {
      if (err.usage) await logTokens(db, err.model, err.usage, source);
      throw err;
    }
    await logTokens(db, result.model, result.usage, source);
    res.json(cleanCampaign(result.data));
  });

  return router;
}

/**
 * Retrato enviado pelo jogador. O navegador já reduz e regrava a imagem (o que descarta metadados);
 * aqui conferimos tamanho e formato pelos primeiros bytes antes de gravar no banco.
 */
export function portraitUploadRoutes(db) {
  const router = Router();
  const limiter = rateLimit({ windowMs: 60 * 1000, max: 15, key: (req) => `u${req.user.id}`, message: 'Muitos envios seguidos. Aguarde um minuto.' });

  router.post('/', limiter, async (req, res) => {
    const image = req.body?.image;
    if (typeof image !== 'string' || !image) throw new HttpError(400, 'Escolha uma imagem.');
    let decoded;
    try {
      decoded = decodeImage(image);
    } catch {
      throw new HttpError(400, 'Use uma imagem PNG, JPG ou WebP.');
    }
    if (decoded.buffer.length > MAX_UPLOAD_BYTES) throw new HttpError(413, 'A imagem passou de 3 MB, mesmo depois de reduzida. Escolha outra.');
    await assertImageQuota(db, req.user.id, decoded.buffer.length);
    const url = await saveImage(db, { ...decoded, prefix: 'retrato_enviado', userId: req.user.id });
    res.status(201).json({ url });
  });

  return router;
}
