import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/app.js';
import { openDb } from './src/db/connection.js';
import { ensureAdmin, hasAdmin, loadJwtSecret } from './src/services/auth.js';
import { DEFAULT_MODEL } from './src/services/gemini.js';
import { DEFAULT_IMAGE_MODEL } from './src/services/geminiImages.js';

const env = process.env;
const port = Number(env.PORT) || 3000;
// Padrão: só este computador. Na hospedagem, defina HOST=0.0.0.0 atrás de um proxy com HTTPS.
const host = env.HOST || '127.0.0.1';
const textModel = env.GEMINI_MODEL || DEFAULT_MODEL;
const imageModel = env.GEMINI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
const dataDir = fileURLToPath(new URL('./data/', import.meta.url));

let db;
try {
  db = await openDb({ connectionString: env.DATABASE_URL, max: Number(env.DATABASE_POOL_SIZE) || 10 });
} catch (err) {
  console.error(`Não foi possível abrir o banco: ${err.message}`);
  console.error('Confira DATABASE_URL no .env e se o PostgreSQL está ligado (atalho "Abrir DataDice").');
  process.exit(1);
}
// Na hospedagem o disco do servidor é apagado a cada atualização: um segredo criado sozinho mudaria
// e desconectaria todo mundo. Por isso, em produção, JWT_SECRET é obrigatório.
if (env.NODE_ENV === 'production' && !env.JWT_SECRET) {
  console.error('Defina JWT_SECRET (32 caracteres ou mais) nas variáveis de ambiente da hospedagem.');
  process.exit(1);
}
const jwtSecret = loadJwtSecret(env.JWT_SECRET_FILE || `${dataDir}jwt-secret`);

// Conta admin inicial pelas variáveis de ambiente (útil na hospedagem). Só age se ainda não houver admin.
if (!(await hasAdmin(db)) && env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
  await ensureAdmin(db, { name: env.ADMIN_NAME || 'Admin', email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD });
  console.log(`Conta admin criada para ${env.ADMIN_EMAIL}.`);
}

const app = createApp({
  db,
  jwtSecret,
  registrationCode: env.REGISTRATION_CODE || '',
  textModel,
  imageModel,
  // Quantos proxies há na frente do servidor: 1 (só a hospedagem) ou 2 (Cloudflare + hospedagem).
  trustProxy: Number(env.TRUST_PROXY) || false,
  // Só na hospedagem, que sempre tem HTTPS. No computador local (http) isso travaria o navegador.
  hsts: env.NODE_ENV === 'production',
});

await app.locals.visuals.failInterrupted();
const server = app.listen(port, host, async () => {
  console.log(`DataDice em http://${host === '0.0.0.0' ? 'localhost' : host}:${port} (texto: ${textModel}, imagens: ${imageModel})`);
  if (!(await hasAdmin(db))) {
    console.warn('Ainda não há conta admin. Rode "npm run admin" para criar a sua.');
  }
  if (host !== '127.0.0.1' && host !== 'localhost' && !env.REGISTRATION_CODE) {
    console.warn('Atenção: o servidor está aberto e qualquer pessoa pode criar conta. Defina REGISTRATION_CODE para exigir convite.');
  }
});

// Uma promessa rejeitada sem tratamento não derruba o servidor sem deixar rastro.
process.on('unhandledRejection', (err) => console.error('Erro não tratado:', err));

// Desligamento limpo (a hospedagem manda SIGTERM ao atualizar): termina as respostas em andamento e fecha o banco.
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log('Encerrando o DataDice...');
    setTimeout(() => process.exit(1), 10000).unref();
    // As conexões em tempo real das mesas ficam abertas para sempre: fecha antes, senão o servidor não termina.
    app.locals.tableHub?.closeAll();
    server.close(async () => {
      await db.close().catch(() => {});
      process.exit(0);
    });
  });
}
