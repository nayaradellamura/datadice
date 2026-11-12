import { verifyToken } from '../services/auth.js';
import { HttpError } from './errorHandler.js';

const authError = (message) => new HttpError(401, message, 'auth');

/** Valida "Authorization: Bearer <token>". O papel vem do banco: rebaixar alguém vale na hora. */
export function authenticateToken(db, secret) {
  return async (req, _res, next) => {
    const match = /^Bearer\s+([\w-]+\.[\w-]+\.[\w-]+)$/.exec(req.get('authorization') ?? '');
    if (!match) throw authError('Entre na sua conta para continuar.');
    let payload;
    try {
      payload = verifyToken(match[1], secret);
    } catch {
      throw authError('Sua sessão expirou. Entre de novo.');
    }
    const user = Number.isInteger(payload.userId)
      && (await db.get('SELECT id, name, email, role FROM users WHERE id = ? AND password_hash IS NOT NULL', payload.userId));
    if (!user) throw authError('Sua sessão expirou. Entre de novo.');
    req.user = user;
    // Quando o login vence (em segundos desde 1970). O tempo real das mesas fecha o canal nessa hora.
    req.tokenExpiresAt = Number.isInteger(payload.exp) ? payload.exp * 1000 : null;
    next();
  };
}

export const isAdmin = (user) => user?.role === 'admin';

export function requireAdmin(req, _res, next) {
  if (!isAdmin(req.user)) throw new HttpError(403, 'Acesso restrito ao administrador.', 'forbidden');
  next();
}

// Chaves antigas: "AIza" + 35 caracteres. As novas do Google podem ter ponto (ex.: "AQ.Ab8...").
// Quem decide se a chave vale é o Google; aqui só barramos o que claramente não é chave.
const KEY_PATTERN = /^[A-Za-z0-9._-]{20,300}$/;

export function readGeminiKey(req) {
  const key = (req.get('x-gemini-key') ?? '').trim();
  if (!key) {
    throw new HttpError(401, 'Configure sua chave do Gemini em Configurações (ícone de engrenagem) para jogar.', 'gemini_key');
  }
  if (!KEY_PATTERN.test(key)) {
    const reason = key.length < 20
      ? `ela tem só ${key.length} caracteres; a chave inteira tem cerca de 39`
      : /\s/.test(key) ? 'ela tem espaços no meio' : 'ela tem caracteres que uma chave não tem (como aspas, = ou :)';
    throw new HttpError(
      401,
      `A chave colada não parece uma chave do Gemini: ${reason}. Copie de novo só a chave no Google AI Studio, sem aspas e sem "GEMINI_API_KEY=".`,
      'gemini_key',
    );
  }
  return key;
}

/**
 * BYOK: cada requisição traz a chave do próprio jogador no header "x-gemini-key". Ela só fica na
 * memória enquanto a requisição e as imagens pedidas por ela estão em andamento; nunca é gravada nem vai para o log.
 */
export function requireGeminiKey({ createLlm, createImages }) {
  return (req, _res, next) => {
    const key = readGeminiKey(req);
    req.llm = createLlm(key);
    req.images = createImages(key, req.user);
    next();
  };
}
