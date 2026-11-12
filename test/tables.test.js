import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { createApp } from '../src/app.js';
import { normalizeJoinCode } from '../src/services/tables.js';
import { freshDb } from './db.js';
import { addUser, authHeaders, SECRET } from './helpers.js';

let db, server, base;

// Mesas não usam IA: as chamadas vão sem chave do Gemini.
async function call(user, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: authHeaders(user.token, { key: null }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const newCharacter = async (user, name = 'Lia') =>
  (await call(user, 'POST', '/api/characters', { name, race: 'Elfa', class: 'Ladina', con: 14 })).body;

async function tableWithPlayer() {
  const gm = await addUser(db, { name: 'Mestra' });
  const player = await addUser(db, { name: 'Jogadora' });
  const table = (await call(gm, 'POST', '/api/tables', { name: 'Mesa de sexta', description: 'Masmorras.' })).body;
  await call(player, 'POST', '/api/tables/join', { code: table.join_code });
  await call(gm, 'POST', `/api/tables/${table.id}/members/${player.id}/approve`);
  return { gm, player, table };
}

beforeEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db = await freshDb();
  const app = createApp({ db, jwtSecret: SECRET, llm: {}, joinLimits: { windowMs: 60_000, max: 1000 } });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

test('criar mesa: quem cria é o Mestre e recebe um código de convite', async () => {
  const gm = await addUser(db);
  assert.equal((await call(gm, 'POST', '/api/tables', { name: '  ' })).status, 400);
  const res = await call(gm, 'POST', '/api/tables', { name: 'Mesa de sexta', description: 'Masmorras.' });
  assert.equal(res.status, 201);
  assert.equal(res.body.role, 'mestre');
  assert.match(res.body.join_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(res.body.join_open, true);
  assert.deepEqual(res.body.players, []);

  const list = (await call(gm, 'GET', '/api/tables')).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].role, 'mestre');
  // A mesa não aparece entre as campanhas Solo.
  assert.deepEqual((await call(gm, 'GET', '/api/campaigns')).body, []);
});

test('o código aceita minúsculas, espaços e sem traço', () => {
  assert.equal(normalizeJoinCode(' k7qf-m2xa '), 'K7QFM2XA');
  assert.equal(normalizeJoinCode('K7QF M2XA'), 'K7QFM2XA');
  assert.equal(normalizeJoinCode(42), '');
});

test('pedido de entrada: espera aprovação, e só então a mesa abre', async () => {
  const gm = await addUser(db, { name: 'Mestra' });
  const player = await addUser(db, { name: 'Jogadora', email: 'segredo@teste.dev' });
  const table = (await call(gm, 'POST', '/api/tables', { name: 'Mesa', description: 'Segredos da mesa.' })).body;

  assert.equal((await call(player, 'POST', '/api/tables/join', { code: 'ZZZZ-ZZZZ' })).status, 404);
  const join = await call(player, 'POST', '/api/tables/join', { code: table.join_code.toLowerCase() });
  assert.equal(join.status, 201);
  assert.equal(join.body.status, 'pendente');
  // Pedir de novo não duplica.
  assert.equal((await call(player, 'POST', '/api/tables/join', { code: table.join_code })).status, 201);

  // Pendente: vê o pedido na lista, mas não abre a mesa nem lê a descrição.
  const mine = (await call(player, 'GET', '/api/tables')).body;
  assert.equal(mine[0].status, 'pendente');
  assert.equal(mine[0].description, '');
  assert.equal(mine[0].gm_name, 'Mestra');
  assert.equal((await call(player, 'GET', `/api/tables/${table.id}`)).status, 404);

  // O Mestre vê o pedido (sem e-mail de ninguém).
  const view = (await call(gm, 'GET', `/api/tables/${table.id}`)).body;
  assert.deepEqual(view.pending.map((p) => p.name), ['Jogadora']);
  assert.ok(!JSON.stringify(view).includes('segredo@teste.dev'));
  assert.equal((await call(gm, 'GET', '/api/tables')).body[0].pending, 1);

  const approved = await call(gm, 'POST', `/api/tables/${table.id}/members/${player.id}/approve`);
  assert.equal(approved.status, 200);
  assert.deepEqual(approved.body.pending, []);
  assert.deepEqual(approved.body.players.map((p) => p.name), ['Jogadora']);

  const asPlayer = (await call(player, 'GET', `/api/tables/${table.id}`)).body;
  assert.equal(asPlayer.role, 'jogador');
  assert.equal(asPlayer.description, 'Segredos da mesa.');
  // Código e pedidos são só do Mestre.
  assert.equal(asPlayer.join_code, undefined);
  assert.equal(asPlayer.pending, undefined);
  assert.equal((await call(player, 'POST', '/api/tables/join', { code: table.join_code })).status, 409);
  assert.equal((await call(gm, 'POST', '/api/tables/join', { code: table.join_code })).status, 409);
});

test('só o Mestre aprova, remove, muda o código e exclui; ninguém de fora vê a mesa', async () => {
  const { gm, player, table } = await tableWithPlayer();
  const outsider = await addUser(db);
  const admin = await addUser(db, { role: 'admin' });

  for (const user of [outsider, admin]) {
    assert.equal((await call(user, 'GET', `/api/tables/${table.id}`)).status, 404);
    assert.equal((await call(user, 'DELETE', `/api/tables/${table.id}`)).status, 404);
    // A mesa também não abre pelas rotas do Solo (nem para o admin).
    assert.equal((await call(user, 'GET', `/api/campaigns/${table.id}/messages`)).status, 404);
  }
  assert.equal((await call(gm, 'GET', `/api/campaigns/${table.id}/state`)).status, 404);
  assert.equal((await call(player, 'PATCH', `/api/tables/${table.id}`, { name: 'Minha' })).status, 403);
  assert.equal((await call(player, 'POST', `/api/tables/${table.id}/code`)).status, 403);
  assert.equal((await call(player, 'DELETE', `/api/tables/${table.id}/members/${gm.id}`)).status, 403);
  assert.equal((await call(player, 'DELETE', `/api/tables/${table.id}`)).status, 403);
  // O Mestre não se remove.
  assert.equal((await call(gm, 'DELETE', `/api/tables/${table.id}/members/${gm.id}`)).status, 404);

  const renewed = (await call(gm, 'POST', `/api/tables/${table.id}/code`)).body;
  assert.notEqual(renewed.join_code, table.join_code);
  assert.equal((await call(outsider, 'POST', '/api/tables/join', { code: table.join_code })).status, 404);

  const closed = (await call(gm, 'PATCH', `/api/tables/${table.id}`, { join_open: false, name: 'Mesa nova' })).body;
  assert.equal(closed.join_open, false);
  assert.equal(closed.name, 'Mesa nova');
  assert.equal((await call(outsider, 'POST', '/api/tables/join', { code: renewed.join_code })).status, 404);

  assert.equal((await call(gm, 'DELETE', `/api/tables/${table.id}`)).status, 204);
  assert.deepEqual((await call(player, 'GET', '/api/tables')).body, []);
});

test('ficha na mesa: o jogador escolhe uma das suas, pode trocar, e ela sai quando ele sai', async () => {
  const { gm, player, table } = await tableWithPlayer();
  const lia = await newCharacter(player, 'Lia');
  const bran = await newCharacter(player, 'Bran');
  const othersCharacter = await newCharacter(gm, 'Do Mestre');

  assert.equal((await call(player, 'PUT', `/api/tables/${table.id}/character`, { character_id: othersCharacter.id })).status, 404);
  assert.equal((await call(gm, 'PUT', `/api/tables/${table.id}/character`, { character_id: othersCharacter.id })).status, 400);

  let view = (await call(player, 'PUT', `/api/tables/${table.id}/character`, { character_id: lia.id })).body;
  assert.equal(view.my_character_id, lia.id);
  assert.equal(view.players[0].character.name, 'Lia');
  // O mesmo personagem pode estar numa campanha Solo e em outra mesa ao mesmo tempo.
  const solo = (await call(player, 'POST', '/api/campaigns', { name: 'Solo' })).body;
  assert.equal((await call(player, 'POST', '/api/campaigns/join', { campaign_id: solo.id, character_id: lia.id })).status, 201);

  view = (await call(player, 'PUT', `/api/tables/${table.id}/character`, { character_id: bran.id })).body;
  assert.equal(view.players[0].character.name, 'Bran');
  const linked = await db.all('SELECT character_id FROM campaign_characters WHERE campaign_id = ?', table.id);
  assert.deepEqual(linked.map((row) => row.character_id), [bran.id]);
  assert.equal((await call(gm, 'GET', `/api/tables/${table.id}`)).body.players[0].character.name, 'Bran');

  assert.equal((await call(gm, 'POST', `/api/tables/${table.id}/leave`)).status, 400);
  assert.equal((await call(player, 'POST', `/api/tables/${table.id}/leave`)).status, 204);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM campaign_characters WHERE campaign_id = ?', table.id)).n, 0);
  // A ficha continua na conta, e a campanha Solo não é afetada.
  assert.equal((await call(player, 'GET', `/api/characters/${bran.id}`)).status, 200);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM campaign_characters WHERE campaign_id = ?', solo.id)).n, 1);
});

test('remover jogador tira a ficha dele; recusar pedido deixa pedir de novo', async () => {
  const { gm, player, table } = await tableWithPlayer();
  const lia = await newCharacter(player);
  await call(player, 'PUT', `/api/tables/${table.id}/character`, { character_id: lia.id });

  const removed = (await call(gm, 'DELETE', `/api/tables/${table.id}/members/${player.id}`)).body;
  assert.deepEqual(removed.players, []);
  assert.equal((await call(player, 'GET', `/api/tables/${table.id}`)).status, 404);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM campaign_characters WHERE campaign_id = ?', table.id)).n, 0);

  // Pede de novo e o Mestre recusa: o pedido some.
  assert.equal((await call(player, 'POST', '/api/tables/join', { code: table.join_code })).status, 201);
  const refused = (await call(gm, 'DELETE', `/api/tables/${table.id}/members/${player.id}`)).body;
  assert.deepEqual(refused.pending, []);
  assert.deepEqual((await call(player, 'GET', '/api/tables')).body, []);
  assert.equal((await call(gm, 'POST', `/api/tables/${table.id}/members/${player.id}/approve`)).status, 404);
});

test('limite de 6 jogadores, mesmo com aprovações ao mesmo tempo', async () => {
  const gm = await addUser(db);
  const table = (await call(gm, 'POST', '/api/tables', { name: 'Cheia' })).body;
  const players = [];
  for (let i = 0; i < 8; i += 1) {
    const player = await addUser(db);
    await call(player, 'POST', '/api/tables/join', { code: table.join_code });
    players.push(player);
  }
  const results = await Promise.all(players.map((p) => call(gm, 'POST', `/api/tables/${table.id}/members/${p.id}/approve`)));
  assert.equal(results.filter((r) => r.status === 200).length, 6);
  assert.equal(results.filter((r) => r.status === 409).length, 2);
  const view = (await call(gm, 'GET', `/api/tables/${table.id}`)).body;
  assert.equal(view.players.length, 6);
  assert.equal(view.pending.length, 2);
});

test('mesa em grupo não precisa de chave do Gemini nem usa as rotas de IA', async () => {
  const { gm, player, table } = await tableWithPlayer();
  const lia = await newCharacter(player);
  // Sem chave, tudo da mesa funciona.
  assert.equal((await call(player, 'PUT', `/api/tables/${table.id}/character`, { character_id: lia.id })).status, 200);
  // As rotas do Mestre IA não aceitam a mesa.
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: authHeaders(gm.token),
    body: JSON.stringify({ campaign_id: table.id, character_id: lia.id, message: 'oi' }),
  });
  assert.equal(res.status, 404);
});

test('tentativas de código em excesso são freadas', async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  const app = createApp({ db, jwtSecret: SECRET, llm: {}, joinLimits: { windowMs: 60_000, max: 3 } });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const user = await addUser(db);
  const statuses = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await call(user, 'POST', '/api/tables/join', { code: `AAAA-AAA${i + 2}` })).status);
  assert.deepEqual(statuses, [404, 404, 404, 429, 429]);
});

test('HSTS só quando ligado (hospedagem com HTTPS)', async () => {
  const off = await fetch(`${base}/healthz`);
  assert.equal(off.headers.get('strict-transport-security'), null);
  const secure = createApp({ db, jwtSecret: SECRET, llm: {}, hsts: true });
  const other = await new Promise((resolve) => { const s = secure.listen(0, '127.0.0.1', () => resolve(s)); });
  const on = await fetch(`http://127.0.0.1:${other.address().port}/healthz`);
  other.close();
  assert.match(on.headers.get('strict-transport-security'), /max-age=31536000/);
});
