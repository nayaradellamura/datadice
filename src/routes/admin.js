import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { HttpError } from '../middleware/errorHandler.js';
import { createPasswordReset, ROLES } from '../services/auth.js';
import { asId } from '../http/validate.js';
import { deleteImageIfUnused } from '../services/imageStore.js';

export function adminRoutes(db, { hub } = {}) {
  const router = Router();
  router.use(requireAdmin);

  router.get('/users', async (_req, res) => {
    res.json(await db.all(
      `SELECT u.id, u.name, u.email, u.role, u.created_at,
              (SELECT COUNT(*) FROM characters c WHERE c.user_id = u.id) AS characters,
              (SELECT COUNT(*) FROM campaigns c WHERE c.user_id = u.id AND c.mode <> 'grupo') AS campaigns,
              (SELECT COUNT(*) FROM campaigns c WHERE c.user_id = u.id AND c.mode = 'grupo') AS tables,
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

  // Esqueci minha senha: gera o código do link. O link completo é montado no navegador do admin
  // (com o endereço do site) e só é mostrado uma vez.
  router.post('/users/:id/password-reset', async (req, res) => {
    const id = asId(req.params.id);
    const user = id && (await db.get('SELECT id FROM users WHERE id = ? AND password_hash IS NOT NULL', id));
    if (!user) throw new HttpError(404, 'Usuário não encontrado.');
    res.status(201).json(await createPasswordReset(db, { userId: user.id, createdBy: req.user.id }));
  });

  /**
   * Remove a conta e tudo o que é dela: personagens, campanhas, mesas em que é Mestre (acabam para todos),
   * modelos e imagens. Nas mesas de outros Mestres ela sai e o grupo atualiza na hora; as mensagens que ela
   * mandou lá ficam (com o nome do personagem), para a história da mesa continuar legível. Não dá para desfazer.
   */
  router.delete('/users/:id', async (req, res) => {
    const id = asId(req.params.id);
    if (id && id === req.user.id) throw new HttpError(400, 'Você não pode remover a sua própria conta.');
    const user = id && (await db.get('SELECT id FROM users WHERE id = ? AND password_hash IS NOT NULL', id));
    if (!user) throw new HttpError(404, 'Usuário não encontrado.');

    const owned = (await db.all(`SELECT id FROM campaigns WHERE user_id = ? AND mode = 'grupo'`, user.id)).map((row) => row.id);
    const joined = (await db.all(
      `SELECT m.campaign_id AS id FROM campaign_members m JOIN campaigns c ON c.id = m.campaign_id
       WHERE m.user_id = ? AND c.user_id <> ? AND c.mode = 'grupo'`, user.id, user.id,
    )).map((row) => row.id);
    const images = (await db.all('SELECT name FROM images WHERE user_id = ?', user.id)).map((row) => `/images/${row.name}`);
    const counts = await db.get(
      `SELECT (SELECT COUNT(*) FROM characters WHERE user_id = ?) AS characters,
              (SELECT COUNT(*) FROM campaigns WHERE user_id = ? AND mode <> 'grupo') AS campaigns`,
      user.id, user.id,
    );

    // O banco apaga em cascata o que é da conta (personagens, campanhas, mesas, participações, notas, modelos).
    await db.run('DELETE FROM users WHERE id = ?', user.id);

    for (const tableId of owned) hub?.kick(tableId);
    for (const tableId of joined) {
      hub?.kick(tableId, user.id);
      hub?.publish(tableId, 'table', {});
      hub?.publish(tableId, 'party', {});
    }
    // Imagens que ainda estão em uso (ex.: enviadas no chat da mesa de outra pessoa) continuam.
    for (const url of images) await deleteImageIfUnused(db, url);
    res.json({ removed: user.id, characters: counts.characters, campaigns: counts.campaigns, tables: owned.length });
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
