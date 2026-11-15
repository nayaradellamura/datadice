import { cleanModel, isProvider, PROVIDERS } from '../services/aiProviders.js';
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
      && (await db.get('SELECT id, name, email, role, token_version FROM users WHERE id = ? AND password_hash IS NOT NULL', payload.userId));
    // Senha trocada depois deste login: o token antigo não vale mais.
    if (!user || (payload.v ?? 0) !== user.token_version) throw authError('Sua sessão expirou. Entre de novo.');
    delete user.token_version;
    // "Ver como": o admin olha a conta da pessoa, sem poder mudar nada. Deixou de ser admin, o acesso acaba.
    if (payload.viewer !== undefined) {
      const viewer = Number.isInteger(payload.viewer)
        && (await db.get(`SELECT id, name FROM users WHERE id = ? AND role = 'admin' AND password_hash IS NOT NULL`, payload.viewer));
      if (!viewer) throw authError('O acesso de visualização acabou.');
      if (!['GET', 'HEAD'].includes(req.method)) {
        throw new HttpError(403, 'Você está no modo "Ver como": só dá para olhar, nada é alterado na conta da pessoa.', 'view_only');
      }
      req.viewer = viewer;
    }
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

// Chaves de outras IAs: OpenAI (sk-...), Anthropic (sk-ant-...), OpenRouter (sk-or-...).
const OTHER_KEY_PATTERN = /^[A-Za-z0-9._-]{20,400}$/;

/**
 * Qual IA o jogador escolheu (header "x-ai-provider"; sem ele, Gemini) e a chave dela. O Gemini usa
 * "x-gemini-key"; as outras, "x-ai-key". O modelo escolhido vem em "x-ai-model" (opcional).
 */
export function readAiChoice(req, { required = true } = {}) {
  const asked = (req.get('x-ai-provider') ?? '').trim();
  const provider = isProvider(asked) ? asked : 'gemini';
  if (provider === 'gemini') {
    if (!required && !(req.get('x-gemini-key') ?? '').trim()) return null;
    return { provider, key: readGeminiKey(req), model: null };
  }
  const { label } = PROVIDERS[provider];
  const key = (req.get('x-ai-key') ?? '').trim();
  if (!key) {
    if (!required) return null;
    throw new HttpError(401, `Configure sua chave do ${label} em Configurações (ícone de engrenagem) para jogar.`, 'gemini_key');
  }
  if (!OTHER_KEY_PATTERN.test(key)) {
    throw new HttpError(401, `A chave colada não parece uma chave do ${label}. Copie de novo só a chave, sem aspas nem espaços.`, 'gemini_key');
  }
  return { provider, key, model: cleanModel(req.get('x-ai-model')) };
}

/** Chave do Gemini só para as imagens (quem joga com outra IA pode colar as duas). */
const optionalGeminiKey = (req) => ((req.get('x-gemini-key') ?? '').trim() ? readGeminiKey(req) : null);

/**
 * BYOK: cada requisição traz a chave do próprio jogador nos headers. Ela só fica na memória enquanto a
 * requisição e as imagens pedidas por ela estão em andamento; nunca é gravada nem vai para o log.
 * Imagens são sempre do Gemini: sem chave do Gemini, req.images fica null.
 */
export function requireGeminiKey({ createLlm, createImages }) {
  return (req, _res, next) => {
    const choice = readAiChoice(req);
    req.llm = createLlm(choice.key, choice);
    const imageKey = choice.provider === 'gemini' ? choice.key : optionalGeminiKey(req);
    req.images = imageKey ? createImages(imageKey, req.user) : null;
    next();
  };
}
