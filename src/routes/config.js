import { Router } from 'express';
import { readAiChoice } from '../middleware/auth.js';
import { PROVIDERS } from '../services/aiProviders.js';
import { rateLimit } from '../middleware/rateLimit.js';

export function configRoutes({ createLlm }) {
  const router = Router();
  const limiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: 'Muitos testes seguidos. Aguarde um minuto.' });

  // Confere a chave consultando o modelo, sem gerar texto: não gasta tokens nem pedidos do limite diário.
  router.post('/test-key', limiter, async (req, res) => {
    const choice = readAiChoice(req);
    const result = await createLlm(choice.key, choice).check();
    res.status(result.ok ? 200 : 400).json(result);
  });

  // Modelos que a chave pode usar (ChatGPT, Claude e OpenRouter), para o jogador escolher.
  router.post('/models', limiter, async (req, res) => {
    const choice = readAiChoice(req);
    if (choice.provider === 'gemini') {
      res.json({ models: [], default: null });
      return;
    }
    const models = await createLlm(choice.key, choice).listModels();
    res.json({ models: models.slice(0, 400), default: PROVIDERS[choice.provider].defaultModel });
  });

  return router;
}
