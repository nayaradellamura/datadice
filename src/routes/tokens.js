import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { tokenTotals } from '../services/gameMaster.js';
import { userUsage } from '../services/usage.js';

export function tokenRoutes(db) {
  const router = Router();

  // Consumo do próprio jogador (a chave é dele).
  router.get('/usage', async (req, res) => res.json(await tokenTotals(db, req.user.id)));

  // Meu consumo: por dia, campanha, tipo de uso e modelo, com pedidos de hoje e custo estimado.
  router.get('/mine', async (req, res) => res.json(await userUsage(db, req.user.id, String(req.query.period ?? '30'))));

  // Métricas de Tokens: o sistema inteiro, por jogador, por modelo e por dia.
  router.get('/metrics', requireAdmin, async (_req, res) => {
    res.json({
      totals: await tokenTotals(db),
      by_user: await db.all(
        `SELECT u.id, u.name, u.email, COUNT(t.id) AS calls,
                COALESCE(SUM(t.prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(t.completion_tokens), 0) AS completion_tokens,
                COALESCE(SUM(t.total_tokens), 0) AS total_tokens
         FROM users u LEFT JOIN token_logs t ON t.user_id = u.id
         GROUP BY u.id ORDER BY total_tokens DESC, u.id`
      ),
      by_model: await db.all(
        `SELECT model_name, COUNT(*) AS calls, SUM(total_tokens) AS total_tokens
         FROM token_logs GROUP BY model_name ORDER BY total_tokens DESC`
      ),
      by_day: await db.all(
        `SELECT to_char("timestamp", 'YYYY-MM-DD') AS day, COUNT(*) AS calls, SUM(total_tokens) AS total_tokens
         FROM token_logs WHERE "timestamp" >= now() - interval '30 days'
         GROUP BY day ORDER BY day`
      ),
    });
  });

  return router;
}
