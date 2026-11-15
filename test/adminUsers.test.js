import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { createApp } from '../src/app.js';
import { freshDb } from './db.js';
import { addUser, authHeaders, SECRET } from './helpers.js';

// Admin remove uma conta: vai junto tudo o que é dela; as mesas de outros Mestres continuam.

let db, server, base, app;

async function call(user, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: authHeaders(user.token, { key: null }),
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

test('remover conta: apaga o que é dela, a mesa de outro Mestre continua e as mensagens ficam', async () => {
  const admin = await addUser(db, { role: 'admin', name: 'Admin' });
  const gm = await addUser(db, { name: 'Mestra' });
  const bia = await addUser(db, { name: 'Bia' });

  // Mesa da Mestra, com a Bia jogando.
  const table = (await call(gm, 'POST', '/api/tables', { name: 'Mesa da Mestra' })).body;
  await call(bia, 'POST', '/api/tables/join', { code: table.join_code });
  await call(gm, 'POST', `/api/tables/${table.id}/members/${bia.id}/approve`);
  const hero = (await call(bia, 'POST', '/api/characters', { name: 'Lyra', race: 'Elfa', class: 'Maga' })).body;
  await call(bia, 'PUT', `/api/tables/${table.id}/character`, { character_id: hero.id });
  assert.equal((await call(bia, 'POST', `/api/tables/${table.id}/messages`, { text: 'Eu abro a porta.', kind: 'fala' })).status, 201);
  // A Bia também é Mestre de uma mesa, com a Mestra jogando nela.
  const biaTable = (await call(bia, 'POST', '/api/tables', { name: 'Mesa da Bia' })).body;
  await call(gm, 'POST', '/api/tables/join', { code: biaTable.join_code });
  await call(bia, 'POST', `/api/tables/${biaTable.id}/members/${gm.id}/approve`);

  const listed = (await call(admin, 'GET', '/api/admin/users')).body.find((row) => row.id === bia.id);
  assert.equal(Number(listed.characters), 1);
  assert.equal(Number(listed.tables), 1);

  const removed = await call(admin, 'DELETE', `/api/admin/users/${bia.id}`);
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { removed: bia.id, characters: 1, campaigns: 0, tables: 1 });

  // A conta não entra mais, e nada dela ficou.
  assert.equal((await call(bia, 'GET', '/api/auth/me')).status, 401);
  assert.equal(await db.get('SELECT 1 AS x FROM characters WHERE user_id = ?', bia.id), undefined);
  assert.equal(await db.get('SELECT 1 AS x FROM campaigns WHERE id = ?', biaTable.id), undefined);
  // A mesa da Mestra continua, sem a Bia no grupo; a mensagem dela fica com o nome do personagem.
  const view = await call(gm, 'GET', `/api/tables/${table.id}`);
  assert.equal(view.status, 200);
  const party = (await call(gm, 'GET', `/api/tables/${table.id}/party`)).body;
  assert.ok(!JSON.stringify(party).includes('Lyra'));
  const message = await db.get('SELECT sender_name, user_id FROM messages WHERE campaign_id = ? AND message_text = ?', table.id, 'Eu abro a porta.');
  assert.deepEqual({ ...message }, { sender_name: 'Lyra', user_id: null });
  // A Mestra não vê mais a mesa da Bia.
  assert.ok(!(await call(gm, 'GET', '/api/tables')).body.some((t) => t.id === biaTable.id));
});

test('remover conta: só o admin, nunca a própria, e conta inexistente dá 404', async () => {
  const admin = await addUser(db, { role: 'admin' });
  const player = await addUser(db);
  const other = await addUser(db);
  assert.equal((await call(player, 'DELETE', `/api/admin/users/${other.id}`)).status, 403);
  const self = await call(admin, 'DELETE', `/api/admin/users/${admin.id}`);
  assert.equal(self.status, 400);
  assert.match(self.body.error, /própria conta/);
  assert.equal((await call(admin, 'DELETE', '/api/admin/users/99999')).status, 404);
  assert.equal((await call(admin, 'DELETE', `/api/admin/users/${other.id}`)).status, 200);
  assert.equal((await call(admin, 'DELETE', `/api/admin/users/${other.id}`)).status, 404);
});

test('remover conta: o retrato dela some; imagem que ela mandou na mesa de outro fica', async () => {
  const admin = await addUser(db, { role: 'admin' });
  const bia = await addUser(db);
  await db.run(`INSERT INTO images (name, user_id, mime, size, data) VALUES ('retrato_bia.png', ?, 'image/png', 3, '\\x010203')`, bia.id);
  await call(bia, 'POST', '/api/characters', { name: 'Lyra', race: 'Elfa', class: 'Maga', avatar_url: '/images/retrato_bia.png' });
  const gm = await addUser(db);
  const table = (await call(gm, 'POST', '/api/tables', { name: 'Mesa' })).body;
  const shared = await db.run(`INSERT INTO images (name, user_id, campaign_id, mime, size, data) VALUES ('mapa_bia.png', ?, ?, 'image/png', 3, '\\x010203') RETURNING id`, bia.id, table.id);
  await db.run(`INSERT INTO messages (campaign_id, sender_type, sender_name, message_text, user_id, image_id) VALUES (?, 'player', 'Lyra', 'Olhem o mapa', ?, ?)`, table.id, bia.id, shared.id);

  assert.equal((await call(admin, 'DELETE', `/api/admin/users/${bia.id}`)).status, 200);
  assert.equal(await db.get(`SELECT 1 AS x FROM images WHERE name = 'retrato_bia.png'`), undefined);
  assert.ok(await db.get(`SELECT 1 AS x FROM images WHERE name = 'mapa_bia.png'`));
});
