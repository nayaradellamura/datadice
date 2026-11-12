import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { createApp } from '../src/app.js';
import { requireGeminiKey } from '../src/middleware/auth.js';
import { dumpText, freshDb } from './db.js';
import { ensureAdmin, hasAdmin, loadJwtSecret, signToken } from '../src/services/auth.js';
import { addUser, authHeaders, GEMINI_KEY, SECRET } from './helpers.js';

const usage = { prompt: 10, completion: 5, total: 15 };
let db, server, base, llm;

async function request(method, path, { body, token, key = GEMINI_KEY, headers } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: headers ?? (token ? authHeaders(token, { key }) : { 'content-type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function start(options = {}) {
  db = await freshDb();
  llm = {
    keys: [],
    async generateJson() {
      return { data: { narration: 'A cena continua.', state_changes: [], memory_updates: [], illustrations: [] }, usage, model: 'fake' };
    },
    async check() { return { ok: true, message: 'Chave válida.' }; },
  };
  const app = createApp({ db, llm, jwtSecret: SECRET, authLimits: { windowMs: 60000, max: 10 }, ...options });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
}

beforeEach(() => start());
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

test('cadastro e login: senha guardada com bcrypt, token com userId e role', async () => {
  const registered = await request('POST', '/api/auth/register', { body: { name: 'Ana', email: ' Ana@Exemplo.com ', password: 'senha-forte-1' } });
  assert.equal(registered.status, 201);
  assert.deepEqual(registered.body.user, { id: registered.body.user.id, name: 'Ana', email: 'ana@exemplo.com', role: 'player' });

  const row = (await db.get('SELECT password_hash FROM users WHERE email = ?', 'ana@exemplo.com'));
  assert.match(row.password_hash, /^\$2[aby]\$12\$/);
  assert.ok(!row.password_hash.includes('senha-forte-1'));

  const payload = JSON.parse(Buffer.from(registered.body.token.split('.')[1], 'base64url'));
  assert.equal(payload.userId, registered.body.user.id);
  assert.equal(payload.role, 'player');

  const login = await request('POST', '/api/auth/login', { body: { email: 'ANA@exemplo.com', password: 'senha-forte-1' } });
  assert.equal(login.status, 200);
  const me = await request('GET', '/api/auth/me', { token: login.body.token });
  assert.equal(me.body.email, 'ana@exemplo.com');
});

test('cadastro recusa dados ruins e e-mail repetido; login errado não revela se o e-mail existe', async () => {
  for (const body of [
    { name: 'Ana', email: 'sem-arroba', password: 'senha-forte-1' },
    { name: 'Ana', email: 'a@b.co', password: 'curta' },
    { name: '', email: 'a@b.co', password: 'senha-forte-1' },
    { name: 'Ana', email: 'a@b.co', password: 'x'.repeat(73) },
  ]) {
    assert.equal((await request('POST', '/api/auth/register', { body })).status, 400, JSON.stringify(body));
  }
  await request('POST', '/api/auth/register', { body: { name: 'Ana', email: 'a@b.co', password: 'senha-forte-1' } });
  assert.equal((await request('POST', '/api/auth/register', { body: { name: 'Outra', email: 'A@B.co', password: 'senha-forte-2' } })).status, 409);

  const wrong = await request('POST', '/api/auth/login', { body: { email: 'a@b.co', password: 'errada-123' } });
  const missing = await request('POST', '/api/auth/login', { body: { email: 'ninguem@b.co', password: 'errada-123' } });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, missing.body);
});

test('muitas tentativas de login são freadas', async () => {
  const attempt = () => request('POST', '/api/auth/login', { body: { email: 'x@y.co', password: 'nada-disso' } });
  for (let i = 0; i < 10; i += 1) assert.equal((await attempt()).status, 401);
  const blocked = await attempt();
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /Muitas tentativas/);
});

test('com código de convite, só cria conta quem tem o código', async () => {
  await new Promise((resolve) => server.close(resolve));
  await start({ registrationCode: 'BETA-2026' });
  assert.equal((await request('GET', '/api/auth/config')).body.registration_code_required, true);
  const body = { name: 'Ana', email: 'a@b.co', password: 'senha-forte-1' };
  assert.equal((await request('POST', '/api/auth/register', { body })).status, 403);
  assert.equal((await request('POST', '/api/auth/register', { body: { ...body, code: 'errado' } })).status, 403);
  assert.equal((await request('POST', '/api/auth/register', { body: { ...body, code: 'BETA-2026' } })).status, 201);
});

test('authenticateToken: sem token, token adulterado, expirado ou de usuário apagado dão 401 com code "auth"', async () => {
  const user = await addUser(db);
  const forged = signToken({ id: user.id, role: 'admin' }, 'outro-segredo-com-mais-de-32-caracteres!!');
  const [header, payload] = user.token.split('.');
  const tampered = `${header}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), role: 'admin' })).toString('base64url')}.${user.token.split('.')[2]}`;
  const expired = (await import('jsonwebtoken')).default.sign({ userId: user.id, role: 'player', exp: 1 }, SECRET);
  const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${payload}.`;

  for (const headers of [
    { 'content-type': 'application/json' },
    { authorization: `Bearer ${forged}` },
    { authorization: `Bearer ${tampered}` },
    { authorization: `Bearer ${expired}` },
    { authorization: `Bearer ${none}` },
    { authorization: user.token },
  ]) {
    const res = await request('GET', '/api/characters', { headers });
    assert.equal(res.status, 401, JSON.stringify(headers));
    assert.equal(res.body.code, 'auth');
  }

  (await db.run('DELETE FROM users WHERE id = ?', user.id));
  assert.equal((await request('GET', '/api/characters', { token: user.token })).status, 401);
});

test('requireAdmin: Caderno do Mestre, métricas e painel admin dão 403 para jogador', async () => {
  const player = await addUser(db);
  const campaign = (await request('POST', '/api/campaigns', { token: player.token, body: { name: 'Vale' } })).body;
  for (const [method, path] of [
    ['GET', `/api/campaigns/${campaign.id}/memories`],
    ['POST', `/api/campaigns/${campaign.id}/memories`],
    ['PATCH', '/api/memories/1'],
    ['DELETE', '/api/memories/1'],
    ['GET', '/api/tokens/metrics'],
    ['GET', '/api/admin/users'],
    ['GET', '/api/admin/stats'],
    ['PATCH', `/api/admin/users/${player.id}`],
  ]) {
    const res = await request(method, path, { token: player.token, body: method === 'GET' || method === 'DELETE' ? undefined : { role: 'admin' } });
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  assert.equal((await db.get('SELECT role FROM users WHERE id = ?', player.id)).role, 'player');
});

test('o papel vem do banco: rebaixar um admin vale na hora, mesmo com token antigo', async () => {
  const admin = await addUser(db, { role: 'admin' });
  const other = await addUser(db, { role: 'admin' });
  assert.equal((await request('GET', '/api/admin/users', { token: other.token })).status, 200);
  assert.equal((await request('PATCH', `/api/admin/users/${other.id}`, { token: admin.token, body: { role: 'player' } })).status, 200);
  assert.equal((await request('GET', '/api/admin/users', { token: other.token })).status, 403);
  // E ninguém tira o próprio acesso de admin.
  assert.equal((await request('PATCH', `/api/admin/users/${admin.id}`, { token: admin.token, body: { role: 'player' } })).status, 400);
});

test('cada jogador vê e mexe só no que é seu; o admin vê tudo', async () => {
  const ana = await addUser(db);
  const bia = await addUser(db);
  const admin = await addUser(db, { role: 'admin' });
  const character = (await request('POST', '/api/characters', { token: ana.token, body: { name: 'Lia', race: 'Elfo', class: 'Mago' } })).body;
  const campaign = (await request('POST', '/api/campaigns', { token: ana.token, body: { name: 'Vale' } })).body;
  await request('POST', '/api/campaigns/join', { token: ana.token, body: { campaign_id: campaign.id, character_id: character.id } });

  assert.deepEqual((await request('GET', '/api/characters', { token: bia.token })).body, []);
  assert.deepEqual((await request('GET', '/api/campaigns', { token: bia.token })).body, []);
  for (const [method, path, body] of [
    ['GET', `/api/characters/${character.id}`],
    ['PUT', `/api/characters/${character.id}`, { name: 'Roubada', race: 'Elfo', class: 'Mago' }],
    ['GET', `/api/campaigns/${campaign.id}/state`],
    ['GET', `/api/campaigns/${campaign.id}/messages`],
    ['GET', `/api/campaigns/${campaign.id}/visuals`],
    ['PUT', `/api/campaigns/${campaign.id}`, { name: 'Roubada' }],
    ['DELETE', `/api/campaigns/${campaign.id}`],
    ['POST', `/api/campaigns/${campaign.id}/roll`, { character_id: character.id, kind: 'dice', expression: '1d20' }],
    ['POST', '/api/chat', { campaign_id: campaign.id, character_id: character.id, message: 'Oi' }],
    ['POST', `/api/campaigns/${campaign.id}/session`, { character_id: character.id }],
  ]) {
    const res = await request(method, path, { token: bia.token, body });
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  // Bia também não consegue colocar a personagem da Ana na campanha dela.
  const biaCampaign = (await request('POST', '/api/campaigns', { token: bia.token, body: { name: 'Outra' } })).body;
  assert.equal((await request('POST', '/api/campaigns/join', { token: bia.token, body: { campaign_id: biaCampaign.id, character_id: character.id } })).status, 404);

  assert.equal((await request('GET', `/api/characters/${character.id}`, { token: ana.token })).body.name, 'Lia');
  assert.equal((await request('GET', '/api/characters', { token: admin.token })).body.length, 1);
  assert.equal((await request('GET', '/api/campaigns', { token: admin.token })).body.length, 2);
  assert.equal((await request('GET', `/api/campaigns/${campaign.id}/state`, { token: admin.token })).status, 200);
});

test('BYOK: sem chave, ou com chave em formato estranho, o chat responde 401 pedindo a chave', async () => {
  const ana = await addUser(db);
  const character = (await request('POST', '/api/characters', { token: ana.token, body: { name: 'Lia', race: 'Elfo', class: 'Mago' } })).body;
  const campaign = (await request('POST', '/api/campaigns', { token: ana.token, body: { name: 'Vale' } })).body;
  await request('POST', '/api/campaigns/join', { token: ana.token, body: { campaign_id: campaign.id, character_id: character.id } });
  const body = { campaign_id: campaign.id, character_id: character.id, message: 'Oi' };

  const missing = await request('POST', '/api/chat', { token: ana.token, key: null, body });
  assert.equal(missing.status, 401);
  assert.equal(missing.body.code, 'gemini_key');
  assert.match(missing.body.error, /Configurações/);

  // Chave colada errada: a mensagem diz o que está errado.
  for (const [key, reason] of [
    ['curta', /só 5 caracteres/],
    ['tem espaço e é bem longa demais para ser chave', /caracteres que uma chave não tem|espaços/],
    [`GEMINI_API_KEY=${GEMINI_KEY}`, /caracteres que uma chave não tem/],
    [`"${GEMINI_KEY}"`, /caracteres que uma chave não tem/],
  ]) {
    const res = await request('POST', '/api/chat', { token: ana.token, key, body });
    assert.equal(res.status, 401, key);
    assert.equal(res.body.code, 'gemini_key');
    assert.match(res.body.error, /não parece uma chave do Gemini/);
    assert.match(res.body.error, reason, key);
  }

  // Formato novo do Google, com ponto, é aceito (quem confirma a validade é o Google).
  assert.equal((await request('POST', '/api/chat', { token: ana.token, key: 'AQ.Ab8RN6Lr2bQx-Fake_Chave.Nova123456', body })).status, 200);
  for (const path of ['/api/generate-image', `/api/campaigns/${campaign.id}/session`, '/api/config/test-key', '/api/visuals/npc/1/retry']) {
    assert.equal((await request('POST', path, { token: ana.token, key: null, body: { prompt: 'x', character_id: character.id } })).status, 401, path);
  }

  const ok = await request('POST', '/api/chat', { token: ana.token, body });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.narration, 'A cena continua.');
  assert.ok(!(await dumpText(db)).includes(GEMINI_KEY), 'a chave não fica gravada em nenhuma tabela');
});

test('BYOK: os clientes do Gemini são criados com a chave da própria requisição', async () => {
  const seen = [];
  const middleware = requireGeminiKey({
    createLlm: (key) => { seen.push(['texto', key]); return 'cliente-texto'; },
    createImages: (key) => { seen.push(['imagem', key]); return 'cliente-imagem'; },
  });
  const req = { get: (name) => (name === 'x-gemini-key' ? `  ${GEMINI_KEY} ` : undefined) };
  let called = false;
  middleware(req, {}, () => { called = true; });
  assert.ok(called);
  assert.deepEqual(seen, [['texto', GEMINI_KEY], ['imagem', GEMINI_KEY]]);
  assert.deepEqual([req.llm, req.images], ['cliente-texto', 'cliente-imagem']);
  assert.equal(req.geminiKey, undefined, 'a chave não fica pendurada na requisição');
});

test('teste da chave: devolve ok sem gerar texto', async () => {
  const ana = await addUser(db);
  const res = await request('POST', '/api/config/test-key', { token: ana.token, body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('métricas: cada jogador vê o próprio consumo; o admin vê por jogador e por modelo', async () => {
  const ana = await addUser(db, { name: 'Ana' });
  const admin = await addUser(db, { role: 'admin', name: 'Admin' });
  const character = (await request('POST', '/api/characters', { token: ana.token, body: { name: 'Lia', race: 'Elfo', class: 'Mago' } })).body;
  const campaign = (await request('POST', '/api/campaigns', { token: ana.token, body: { name: 'Vale' } })).body;
  await request('POST', '/api/campaigns/join', { token: ana.token, body: { campaign_id: campaign.id, character_id: character.id } });
  const turn = await request('POST', '/api/chat', { token: ana.token, body: { campaign_id: campaign.id, character_id: character.id, message: 'Oi' } });
  assert.equal(turn.body.tokens.totals.total_tokens, 15);

  assert.equal((await request('GET', '/api/tokens/usage', { token: ana.token })).body.total_tokens, 15);
  assert.equal((await request('GET', '/api/tokens/usage', { token: admin.token })).body.total_tokens, 0);
  const metrics = (await request('GET', '/api/tokens/metrics', { token: admin.token })).body;
  assert.equal(metrics.totals.total_tokens, 15);
  assert.equal(metrics.by_user.find((row) => row.name === 'Ana').total_tokens, 15);
  assert.equal(metrics.by_model[0].model_name, 'fake');
  const stats = (await request('GET', '/api/admin/stats', { token: admin.token })).body;
  assert.deepEqual([stats.users, stats.characters, stats.campaigns], [2, 1, 1]);
});

test('respostas levam cabeçalhos de segurança', async () => {
  const res = await fetch(`${base}/`);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('conta admin: o admin assume a conta local antiga com tudo dela, sem duplicar', async () => {
  await db.run(`INSERT INTO users (name, email) VALUES ('Jogador Local', 'local@rpg.invalid')`);
  const { id: localId } = await db.get(`SELECT id FROM users WHERE email = 'local@rpg.invalid'`);
  await db.run(`INSERT INTO campaigns (user_id, name) VALUES (?, 'Campanha antiga')`, localId);

  const { id, created } = await ensureAdmin(db, { name: 'Nay', email: 'nay@exemplo.com', password: 'senha-forte-1' });
  assert.deepEqual([id, created], [localId, false]);
  const admin = await db.get('SELECT * FROM users WHERE id = ?', localId);
  assert.deepEqual([admin.email, admin.role], ['nay@exemplo.com', 'admin']);
  assert.ok(admin.password_hash.startsWith('$2'));
  assert.equal((await db.get('SELECT user_id FROM campaigns')).user_id, localId);

  // Rodar de novo só troca a senha; não duplica a conta.
  await ensureAdmin(db, { name: 'Nay', email: 'nay@exemplo.com', password: 'outra-senha-2' });
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM users')).n, 1);
  assert.equal(await hasAdmin(db), true);
});

test('segredo do JWT: usa JWT_SECRET forte, recusa um fraco e cria um aleatório quando falta', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  assert.equal(loadJwtSecret('/nao/usado', 'x'.repeat(40)), 'x'.repeat(40));
  assert.throws(() => loadJwtSecret('/nao/usado', 'curto'), /32 caracteres/);
  const dir = mkdtempSync(join(tmpdir(), 'datadice-jwt-'));
  try {
    const first = loadJwtSecret(join(dir, 'jwt-secret'), '');
    assert.ok(first.length >= 60);
    assert.equal(loadJwtSecret(join(dir, 'jwt-secret'), ''), first, 'o mesmo segredo depois de reiniciar');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
