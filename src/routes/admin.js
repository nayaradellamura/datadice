import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { HttpError } from '../middleware/errorHandler.js';
import { ROLES } from '../services/auth.js';
import { asId } from '../http/validate.js';

export function adminRoutes(db) {
  const router = Router();
  router.use(requireAdmin);

  router.get('/users', async (_req, res) => {
    res.json(await db.all(
      `SELECT u.id, u.name, u.email, u.role, u.created_at,
              (SELECT COUNT(*) FROM characters c WHERE c.user_id = u.id) AS characters,
              (SELECT COUNT(*) FROM campaigns c WHERE c.user_id = u.id) AS campaigns,
              (SELECT COALESCE(SUM(total_tokens), 0) FROM token_logs t WHERE t.user_id = u.id) AS total_tokens
       FROM users u WHERE u.password_hash IS NOT NULL ORDER BY u.id`
    ));
  });

  router.patch('/users/:id', async (req, res) => {
    const role = req.body?.role;
    if (!ROLES.includes(role)) throw new HttpError(400, 'Papel inválido.');
    const id = asId(req.params.id);
    const user = id
      && (await db.get('SELECT id, role FROM users WHERE id = ? AND password_hash IS NOT NULL', id));
    if (!user) throw new HttpError(404, 'Usuário não encontrado.');
    // Evita ficar sem ninguém com acesso ao painel.
    if (user.id === req.user.id && role !== 'admin') throw new HttpError(400, 'Você não pode remover o seu próprio acesso de admin.');
    await db.run('UPDATE users SET role = ? WHERE id = ?', role, user.id);
    res.json({ id: user.id, role });
  });

  // Relatório geral do sistema.
  router.get('/stats', async (_req, res) => {
    const visuals = ['npcs', 'monsters', 'locations']
      .map((table) => `SELECT image_status FROM ${table}`).join(' UNION ALL ');
    res.json(await db.get(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE password_hash IS NOT NULL) AS users,
         (SELECT COUNT(*) FROM characters) AS characters,
         (SELECT COUNT(*) FROM campaigns) AS campaigns,
         (SELECT COUNT(*) FROM messages) AS messages,
         (SELECT COUNT(*) FROM (${visuals}) v WHERE image_status = 'ready') AS images_ready,
         (SELECT COUNT(*) FROM (${visuals}) v WHERE image_status = 'failed') AS images_failed`
    ));
  });

  return router;
}
