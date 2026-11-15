import express, { Router } from 'express';
import { readGeminiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { logTokens } from '../services/gameMaster.js';
import { importCharacterPdf, MAX_PDF_BYTES } from '../services/sheetImport.js';

/**
 * Importar ficha em PDF. Devolve um rascunho de personagem para o formulário; nada é salvo aqui.
 * A chave do Gemini é opcional: sem ela, só a ficha oficial preenchível é lida.
 */
export function characterImportRoutes(db, { createLlm }) {
  const router = Router();
  const limiter = rateLimit({ windowMs: 60 * 1000, max: 6, key: (req) => `u${req.user.id}`, message: 'Muitas importações seguidas. Aguarde um minuto.' });
  const pdfBody = express.raw({ type: 'application/pdf', limit: MAX_PDF_BYTES });

  router.post('/', limiter, pdfBody, async (req, res) => {
    const llm = req.get('x-gemini-key') ? createLlm(readGeminiKey(req)) : null;
    const result = await importCharacterPdf(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), {
      llm,
      onUsage: (model, usage) => logTokens(db, model, usage, { userId: req.user.id, kind: 'import' }),
    });
    res.json(result);
  });

  return router;
}
