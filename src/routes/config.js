import { Router } from 'express';
import { readGeminiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

export function configRoutes({ createLlm }) {
  const router = Router();
  const limiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: 'Muitos testes seguidos. Aguarde um minuto.' });

  // Confere a chave consultando o modelo, sem gerar texto: não gasta tokens nem pedidos do limite diário.
  router.post('/test-key', limiter, async (req, res) => {
    const result = await createLlm(readGeminiKey(req)).check();
    res.status(result.ok ? 200 : 400).json(result);
  });

  return router;
}
