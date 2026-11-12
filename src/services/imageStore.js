import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { HttpError } from '../middleware/errorHandler.js';

const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const NAME = /^\/images\/([\w-]{1,120}\.(png|jpg|webp))$/;

// Espaço de imagens por conta (retratos, Biblioteca, mesas, modelos). Evita que uma conta encha o banco.
export const MAX_USER_IMAGE_BYTES = (Number(process.env.MAX_USER_IMAGE_MB) || 100) * 1024 * 1024;

/** Recusa o envio se a conta passaria do espaço de imagens. */
export async function assertImageQuota(db, userId, adding) {
  const { used } = await db.get('SELECT COALESCE(SUM(size), 0) AS used FROM images WHERE user_id = ?', userId);
  if (used + adding > MAX_USER_IMAGE_BYTES) {
    const limit = Math.round(MAX_USER_IMAGE_BYTES / 1024 / 1024);
    throw new HttpError(413, `Você chegou ao limite de ${limit} MB de imagens. Exclua fichas, modelos ou mesas com imagens que não usa mais.`);
  }
}

/**
 * Guarda a imagem no banco e devolve a URL pública (/images/<nome>). O nome é aleatório:
 * as imagens são servidas sem login, então a URL não pode ser adivinhada.
 */
export async function saveImage(db, { buffer, extension, prefix = 'imagem', userId = null, campaignId = null }) {
  const mime = MIME[extension];
  if (!mime) throw new Error(`Formato de imagem não suportado: ${extension}`);
  const name = `${prefix}_${Date.now()}_${randomBytes(12).toString('hex')}.${extension}`;
  await db.run(
    'INSERT INTO images (name, user_id, campaign_id, mime, size, data) VALUES (?, ?, ?, ?, ?, ?)',
    name, userId, campaignId, mime, buffer.length, buffer,
  );
  return `/images/${name}`;
}

/**
 * Copia uma imagem que é da própria pessoa (ex.: do modelo para a Biblioteca de uma mesa, ou o contrário).
 * Cada cópia tem dono e mesa próprios: excluir a mesa não apaga a imagem do modelo. Devolve a URL nova,
 * ou null se a imagem não existir ou não for dessa pessoa.
 */
export async function copyOwnImage(db, { url, userId, campaignId = null, prefix = 'imagem' }) {
  const name = typeof url === 'string' && NAME.exec(url);
  if (!name) return null;
  const source = await db.get('SELECT size FROM images WHERE name = ? AND user_id = ?', name[1], userId);
  if (!source) return null;
  await assertImageQuota(db, userId, source.size);
  const copy = `${prefix}_${Date.now()}_${randomBytes(12).toString('hex')}.${name[2]}`;
  const result = await db.run(
    `INSERT INTO images (name, user_id, campaign_id, mime, size, data)
     SELECT ?, ?, ?, mime, size, data FROM images WHERE name = ? AND user_id = ?`,
    copy, userId, campaignId, name[1], userId,
  );
  return result.changes ? `/images/${copy}` : null;
}

/**
 * Apaga uma imagem que deixou de ser usada (trocada ou de uma ficha excluída). Se algo ainda aponta
 * para ela (retrato, Biblioteca, modelo, mensagem), fica.
 */
export async function deleteImageIfUnused(db, url) {
  const name = typeof url === 'string' && NAME.exec(url);
  if (!name) return;
  await db.run(
    `DELETE FROM images i WHERE i.name = ?
       AND NOT EXISTS (SELECT 1 FROM characters WHERE avatar_url = ?)
       AND NOT EXISTS (SELECT 1 FROM npcs WHERE image_url = ?)
       AND NOT EXISTS (SELECT 1 FROM monsters WHERE image_url = ?)
       AND NOT EXISTS (SELECT 1 FROM locations WHERE image_url = ?)
       AND NOT EXISTS (SELECT 1 FROM gm_templates WHERE image_url = ?)
       AND NOT EXISTS (SELECT 1 FROM messages WHERE image_id = i.id)`,
    name[1], url, url, url, url, url,
  );
}

/** GET /images/<nome>: serve a imagem do banco. A imagem nunca muda, então o navegador pode guardá-la. */
export function imageFileRoutes(db) {
  const router = Router();
  router.get('/:name', async (req, res, next) => {
    const { name } = req.params;
    if (!/^[\w-]{1,120}\.(png|jpg|webp)$/.test(name)) return next();
    const image = await db.get('SELECT mime, data FROM images WHERE name = ?', name);
    if (!image) return next();
    // Só este site usa as imagens (outros sites não conseguem embutir).
    res.set({ 'content-type': image.mime, 'cache-control': 'private, max-age=31536000, immutable', 'cross-origin-resource-policy': 'same-origin' });
    res.send(image.data);
  });
  return router;
}
