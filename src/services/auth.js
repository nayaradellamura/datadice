import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { HttpError } from '../middleware/errorHandler.js';

export const ROLES = ['admin', 'player'];
const BCRYPT_ROUNDS = 12;
const TOKEN_TTL = '7d';
const LEGACY_EMAIL = 'local@rpg.invalid';
// Compara com um hash falso quando o e-mail não existe: a resposta demora o mesmo e não revela quem tem conta.
const DUMMY_HASH = bcrypt.hashSync(randomBytes(16).toString('hex'), BCRYPT_ROUNDS);

export const normalizeEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

export function validateEmail(value) {
  const email = normalizeEmail(value);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Informe um e-mail válido.');
  return email;
}

export function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 8) throw new HttpError(400, 'A senha precisa ter pelo menos 8 caracteres.');
  // O bcrypt ignora o que passa de 72 bytes; melhor recusar do que aceitar uma senha só em parte.
  if (Buffer.byteLength(value, 'utf8') > 72) throw new HttpError(400, 'A senha deve ter no máximo 72 caracteres.');
  return value;
}

export function validateName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 60) throw new HttpError(400, 'Informe um nome de até 60 caracteres.');
  return name;
}

export const hashPassword = (password) => bcrypt.hash(password, BCRYPT_ROUNDS);

export async function checkPassword(user, password) {
  const matches = await bcrypt.compare(typeof password === 'string' ? password : '', user?.password_hash ?? DUMMY_HASH);
  return Boolean(user?.password_hash) && matches;
}

export const signToken = (user, secret) =>
  jwt.sign({ userId: user.id, role: user.role }, secret, { algorithm: 'HS256', expiresIn: TOKEN_TTL });

export const verifyToken = (token, secret) => jwt.verify(token, secret, { algorithms: ['HS256'] });

export const publicUser = ({ id, name, email, role }) => ({ id, name, email, role });

/**
 * Segredo que assina os tokens. Em hospedagem, defina JWT_SECRET; sem ele, um segredo aleatório é
 * criado uma vez no arquivo indicado. Trocar o segredo desconecta todo mundo.
 */
export function loadJwtSecret(path, fromEnv = process.env.JWT_SECRET) {
  if (fromEnv) {
    if (fromEnv.length < 32) throw new Error('JWT_SECRET precisa ter pelo menos 32 caracteres.');
    return fromEnv;
  }
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  mkdirSync(dirname(path), { recursive: true });
  const secret = randomBytes(48).toString('base64url');
  writeFileSync(path, secret, { mode: 0o600, flag: 'wx' });
  return secret;
}

/**
 * Garante a conta admin. Se o e-mail já existe, ela vira admin com a nova senha. Num banco de antes
 * do login, a conta do jogador local é assumida, e o admin herda os personagens e campanhas dela.
 */
export async function ensureAdmin(db, { name, email, password }) {
  const clean = { name: validateName(name), email: validateEmail(email), password: validatePassword(password) };
  const hash = await hashPassword(clean.password);
  const existing = (await db.get('SELECT id FROM users WHERE email = ?', clean.email))
    ?? (await db.get('SELECT id FROM users WHERE email = ? AND password_hash IS NULL', LEGACY_EMAIL));
  if (existing) {
    await db.run(`UPDATE users SET name = ?, email = ?, password_hash = ?, role = 'admin' WHERE id = ?`,
      clean.name, clean.email, hash, existing.id);
    return { id: existing.id, created: false };
  }
  const { id } = await db.run(
    `INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin') RETURNING id`,
    clean.name, clean.email, hash,
  );
  return { id, created: true };
}

export const hasAdmin = async (db) =>
  Boolean(await db.get(`SELECT 1 FROM users WHERE role = 'admin' AND password_hash IS NOT NULL`));
