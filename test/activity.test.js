import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { createApp } from '../src/app.js';
import { dumpText, freshDb } from './db.js';
import { addUser, authHeaders, GEMINI_KEY, SECRET } from './helpers.js';

// Registro de atividade no Painel Admin: o que cada conta fez, sem guardar conteúdo nem segredos.

let db, server, base, app;

async function call(user, method, path, body, headers) {
  const res = await fetch(base + path, {
    method,
    headers: user ? authHeaders(user.token, { key: null }) : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeEach(async () => {
  if (server) await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  db = await freshDb();
  app = createApp({ db, jwtSecret: SECRET, llm: {}, joinLimits: { windowMs: 60_000, max: 1000 } });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  app?.locals.tableHub.closeAll();
  server?.closeAllConnections?.();
  server?.close();
});

// A gravação acontece quando a resposta termina; espera um instante.
const settle = () => new Promise((resolve) => { setTimeout(resolve, 150); });

test('registra criar ficha, erros e login, e só o admin vê', async () => {
  const admin = await addUser(db, { role: 'admin', name: 'Admin' });
  const ana = await addUser(db, { name: 'Ana' });

  assert.equal((await call(ana, 'POST', '/api/characters', { name: 'Kael', race: 'Humano', class: 'Guerreiro' })).status, 201);
  assert.equal((await call(ana, 'POST', '/api/characters', { name: '' })).status, 400);
  // Ação frequente que deu certo não entra; leitura também não.
  await call(ana, 'GET', '/api/characters');
  // Senha errada fica no registro da conta, sem a senha.
  await call(null, 'POST', '/api/auth/register', { name: 'Bia', email: 'bia@teste.dev', password: 'senha-bem-forte-1' });
  await call(null, 'POST', '/api/auth/login', { email: 'bia@teste.dev', password: 'senha-errada-123' });
  // Erro na tela do celular.
  assert.equal((await call(ana, 'POST', '/api/client-error', { message: 'x is not a function', source: 'game.js:10', view: 'game' })).status, 204);
  await settle();

  assert.equal((await call(ana, 'GET', '/api/admin/activity')).status, 403);
  const { items } = (await call(admin, 'GET', '/api/admin/activity')).body;
  const lines = items.map((row) => [row.user_name, row.action, row.detail, row.status]);
  assert.deepEqual(lines.find((line) => line[1] === 'Criou personagem' && line[3] === 201), ['Ana', 'Criou personagem', 'Kael', 201]);
  const failed = items.find((row) => row.action === 'Criou personagem' && row.status === 400);
  assert.ok(failed.error);
  assert.ok(lines.some((line) => line[0] === 'Bia' && line[1] === 'Criou a conta'));
  assert.ok(items.some((row) => row.user_name === 'Bia' && row.action === 'Entrou na conta' && row.status === 401 && row.error === 'E-mail ou senha incorretos.'));
  assert.ok(items.some((row) => row.action === 'Erro na tela' && row.error === 'x is not a function' && row.detail === 'tela game · game.js:10'));
  assert.ok(!items.some((row) => row.action.startsWith('GET')));

  // Filtros: só uma conta, só erros.
  const onlyAna = (await call(admin, 'GET', `/api/admin/activity?user=${ana.id}&errors=1`)).body.items;
  assert.ok(onlyAna.length >= 2 && onlyAna.every((row) => row.user_id === ana.id && (row.status >= 400 || row.status === 0)));

  // "Visto por último" na lista de contas.
  const users = (await call(admin, 'GET', '/api/admin/users')).body;
  assert.ok(users.find((user) => user.id === ana.id).last_seen_at);

  // Nada de senha nem chave gravada.
  const dump = await dumpText(db);
  assert.ok(!dump.includes('senha-errada-123') && !dump.includes('senha-bem-forte-1'));
});

test('mensagens do Mestre IA só entram quando dão erro, e o texto nunca é gravado', async () => {
  const admin = await addUser(db, { role: 'admin', name: 'Admin' });
  const ana = await addUser(db, { name: 'Ana' });
  await fetch(`${base}/api/chat`, { method: 'POST', headers: authHeaders(ana.token, { key: GEMINI_KEY }), body: JSON.stringify({ campaign_id: 999, message: 'segredo da história' }) });
  await settle();
  const { items } = (await call(admin, 'GET', '/api/admin/activity')).body;
  const chat = items.find((row) => row.action === 'Mandou mensagem ao Mestre IA');
  assert.ok(chat && chat.status >= 400);
  assert.ok(!(await dumpText(db)).includes('segredo da história'));
});
