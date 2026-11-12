import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { HttpError } from '../middleware/errorHandler.js';
import { rateLimit } from '../middleware/rateLimit.js';
import {
  checkPassword, hashPassword, normalizeEmail, publicUser, signToken, validateEmail, validateName, validatePassword,
} from '../services/auth.js';

const DEFAULT_LIMITS = { windowMs: 15 * 60 * 1000, max: 20 };

function sameCode(given, expected) {
  const a = Buffer.from(typeof given === 'string' ? given.trim() : '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authRoutes(db, { secret, registrationCode, limits = DEFAULT_LIMITS }) {
  const router = Router();
  const limiter = rateLimit({ ...limits, message: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' });

  router.get('/config', (_req, res) => {
    res.json({ registration_code_required: Boolean(registrationCode) });
  });

  router.post('/register', limiter, async (req, res) => {
    const body = req.body ?? {};
    // Com REGISTRATION_CODE definido, só cria conta quem recebeu o convite do Beta.
    if (registrationCode && !sameCode(body.code, registrationCode)) throw new HttpError(403, 'Código de convite inválido.');
    const name = validateName(body.name);
    const email = validateEmail(body.email);
    const password = validatePassword(body.password);
    if (await db.get('SELECT 1 FROM users WHERE email = ?', email)) {
      throw new HttpError(409, 'Já existe uma conta com este e-mail.');
    }
    const hash = await hashPassword(password);
    let user;
    try {
      user = (await db.run(
        `INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'player') RETURNING *`,
        name, email, hash,
      )).rows[0];
    } catch (err) {
      // Dois cadastros com o mesmo e-mail ao mesmo tempo: o banco barra o segundo.
      if (err.code === '23505') throw new HttpError(409, 'Já existe uma conta com este e-mail.');
      throw err;
    }
    res.status(201).json({ token: signToken(user, secret), user: publicUser(user) });
  });

  router.post('/login', limiter, async (req, res) => {
    const user = await db.get('SELECT * FROM users WHERE email = ?', normalizeEmail(req.body?.email));
    if (!(await checkPassword(user, req.body?.password))) throw new HttpError(401, 'E-mail ou senha incorretos.');
    res.json({ token: signToken(user, secret), user: publicUser(user) });
  });

  return router;
}
