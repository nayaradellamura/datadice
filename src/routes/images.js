import { Router } from 'express';
import { HttpError } from '../middleware/errorHandler.js';

/** Retrato da ficha, gerado com a chave do próprio jogador. */
export function imageRoutes() {
  const router = Router();

  router.post('/', async (req, res) => {
    if (!req.images) throw new HttpError(400, 'Imagens precisam da chave do Gemini. Cole uma em Configurações (pode ser junto com a chave da outra IA).', 'gemini_key');
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    if (!prompt) throw new HttpError(400, 'Descreva a imagem que deseja gerar.');
    if (prompt.length > 2000) throw new HttpError(400, 'A descrição da imagem deve ter até 2000 caracteres.');

    res.status(201).json({ url: await req.images.generate(prompt, { aspectRatio: '2:3', filePrefix: 'retrato' }) });
  });

  return router;
}
