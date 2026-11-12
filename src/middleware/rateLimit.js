import { HttpError } from './errorHandler.js';

/**
 * Limite simples em memória: freia quem tenta adivinhar senhas ou abusa de uma rota.
 * Por padrão conta por IP; key permite contar por conta (pessoas jogando na mesma casa dividem o IP).
 */
export function rateLimit({ windowMs, max, message, key: keyOf = (req) => req.ip ?? 'desconhecido' }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = keyOf(req);
    let entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('retry-after', String(Math.ceil((entry.reset - now) / 1000)));
      throw new HttpError(429, message);
    }
    next();
  };
}
