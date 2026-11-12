import { fileURLToPath } from 'node:url';
import express from 'express';
import { authenticateToken, requireGeminiKey } from './middleware/auth.js';
import { errorHandler, notFoundApi } from './middleware/errorHandler.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { campaignRoutes, memoryRoutes } from './routes/campaigns.js';
import { characterRoutes } from './routes/characters.js';
import { chatRoutes } from './routes/chat.js';
import { configRoutes } from './routes/config.js';
import { campaignGeneratorRoutes, portraitUploadRoutes } from './routes/creation.js';
import { imageRoutes } from './routes/images.js';
import { sessionRoutes } from './routes/sessions.js';
import { notifyCharacterTables, tablePlayRoutes } from './routes/tablePlay.js';
import { tableRoutes } from './routes/tables.js';
import { templateRoutes } from './routes/templates.js';
import { createTableHub } from './services/tableHub.js';
import { tokenRoutes } from './routes/tokens.js';
import { visualRoutes } from './routes/visuals.js';
import { publicUser } from './services/auth.js';
import { imageFileRoutes, saveImage } from './services/imageStore.js';
import { createGameMaster } from './services/gameMaster.js';
import { createGeminiClient } from './services/gemini.js';
import { createGeminiImageClient } from './services/geminiImages.js';
import { createVisuals } from './services/visuals.js';

export const DEFAULT_IMAGES_DIR = fileURLToPath(new URL('../public/images', import.meta.url));

// Só arquivos do próprio site; retratos antigos podem apontar para endereços https externos.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

// Na internet (HTTPS), o navegador passa a recusar abrir o site sem HTTPS por um ano.
const HSTS = 'max-age=31536000; includeSubDomains';

const securityHeaders = (hsts) => (_req, res, next) => {
  if (hsts) res.set('strict-transport-security', HSTS);
  res.set({
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    // Outras janelas e sites não conseguem se pendurar nesta página nem embutir as respostas dela.
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
  });
  next();
};

/**
 * llm e images substituem os clientes do Gemini nos testes. Fora deles, cada requisição cria os
 * clientes com a chave do próprio jogador (BYOK).
 */
export function createApp({
  db,
  jwtSecret,
  registrationCode = '',
  textModel,
  imageModel,
  llm,
  images,
  imagesDir = DEFAULT_IMAGES_DIR,
  onBackgroundError,
  authLimits,
  joinLimits,
  trustProxy = false,
  hsts = false,
}) {
  if (!jwtSecret) throw new Error('jwtSecret é obrigatório.');
  const app = express();
  const createLlm = llm ? () => llm : (apiKey) => createGeminiClient({ apiKey, model: textModel });
  // As imagens geradas vão para o banco, registradas em nome de quem pediu.
  const createImages = images ? () => images : (apiKey, user) => createGeminiImageClient({
    apiKey,
    model: imageModel,
    store: (image) => saveImage(db, { ...image, userId: user?.id ?? null }),
  });
  const visuals = createVisuals({ db, ...(onBackgroundError ? { onError: onBackgroundError } : {}) });
  const gameMaster = createGameMaster({ db, visuals, onBackgroundError });
  const needsKey = requireGeminiKey({ createLlm, createImages });
  const tableHub = createTableHub();

  app.disable('x-powered-by');
  // Atrás de proxies HTTPS (hospedagem), o IP real vem no cabeçalho. trustProxy é quantos proxies há
  // na frente: 1 (só a hospedagem) ou 2 (Cloudflare + hospedagem). Errar isso faz o limite de tentativas
  // contar todo mundo como uma pessoa só.
  if (trustProxy) app.set('trust proxy', trustProxy === true ? 1 : trustProxy);
  app.use(securityHeaders(hsts));
  // Rotas que recebem imagem em base64 (até 3 MB): o corpo grande só é lido depois do login (abaixo).
  // O resto da API aceita no máximo 200 KB.
  const bigBody = (req) => req.path.startsWith('/api/portraits') || req.path.startsWith('/api/templates')
    || /^\/api\/tables\/\d+\/(images|library)(\/|$)/.test(req.path);
  const smallJson = express.json({ limit: '200kb' });
  app.use((req, res, next) => (bigBody(req) ? next() : smallJson(req, res, next)));
  // Verificação de saúde para a hospedagem: o servidor responde e o banco também.
  app.get('/healthz', async (_req, res) => {
    await db.get('SELECT 1');
    res.set('cache-control', 'no-store').json({ ok: true });
  });
  // Imagens ficam no banco. A pasta é só para arquivos antigos que ainda não foram importados.
  app.use('/images', imageFileRoutes(db), express.static(imagesDir, { dotfiles: 'deny' }));
  // HTML, JS e CSS: o navegador sempre confere se há versão nova, senão uma atualização do
  // DataDice fica meio aplicada (página nova com script antigo). Imagens podem ficar em cache.
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), {
    setHeaders(res, path) {
      if (/\.(html|js|css)$/.test(path)) res.set('cache-control', 'no-cache');
    },
  }));

  app.use('/api/auth', authRoutes(db, { secret: jwtSecret, registrationCode, ...(authLimits ? { limits: authLimits } : {}) }));

  // Daqui em diante, tudo exige login.
  app.use('/api', authenticateToken(db, jwtSecret));
  const bigJson = express.json({ limit: '4500kb' });
  app.use((req, res, next) => (bigBody(req) ? bigJson(req, res, next) : next()));
  app.get('/api/auth/me', (req, res) => res.json(publicUser(req.user)));
  app.use('/api/config', configRoutes({ createLlm }));
  app.use('/api/characters', characterRoutes(db, { onChanged: (id) => notifyCharacterTables(db, tableHub, id) }));
  app.use('/api/portraits', portraitUploadRoutes(db));
  app.use('/api/campaigns', campaignGeneratorRoutes(db, needsKey));
  app.use('/api/campaigns', campaignRoutes(db));
  // Mesas em grupo: Mestre humano, sem IA e sem chave do Gemini.
  app.use('/api/tables', tableRoutes(db, { hub: tableHub, ...(joinLimits ? { joinLimits } : {}) }));
  app.use('/api/tables', tablePlayRoutes(db, tableHub));
  // Meus modelos: NPCs, monstros e locais do Mestre, reutilizáveis em qualquer mesa.
  app.use('/api/templates', templateRoutes(db));
  app.use('/api/memories', memoryRoutes(db));
  app.use('/api/chat', needsKey, chatRoutes(db, gameMaster));
  app.use('/api/tokens', tokenRoutes(db));
  app.use('/api/generate-image', needsKey, imageRoutes());
  app.use('/api/admin', adminRoutes(db));
  app.use('/api', visualRoutes(db, visuals, needsKey));
  app.use('/api', sessionRoutes(db, gameMaster, needsKey));
  app.use('/api', notFoundApi);
  app.use(errorHandler);

  app.locals.gameMaster = gameMaster;
  app.locals.visuals = visuals;
  app.locals.tableHub = tableHub;
  return app;
}
