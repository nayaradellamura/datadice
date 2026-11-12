import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { createApp } from '../src/app.js';
import { createTableHub } from '../src/services/tableHub.js';
import { freshDb } from './db.js';
import { addUser, authHeaders, SECRET } from './helpers.js';

// Correções da revisão antes de publicar: concorrência, limites, imagens e permissões.

let db, server, base, app;
const PNG = (n) => `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n]).toString('base64')}`;

async function call(user, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: authHeaders(user.token, { key: null }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function setupTable(players = 2) {
  const gm = await addUser(db, { name: 'Mestra' });
  const table = (await call(gm, 'POST', '/api/tables', { name: 'Mesa' })).body;
  const list = [];
  for (let i = 0; i < players; i += 1) {
    const user = await addUser(db, { name: `Jogador ${i + 1}` });
    await call(user, 'POST', '/api/tables/join', { code: table.join_code });
    await call(gm, 'POST', `/api/tables/${table.id}/members/${user.id}/approve`);
    const character = (await call(user, 'POST', '/api/characters', { name: `Heroi ${i + 1}`, race: 'Humano', class: 'Guerreiro', con: 14, dex: 12 })).body;
    await call(user, 'PUT', `/api/tables/${table.id}/character`, { character_id: character.id });
    list.push({ user, character });
  }
  return { gm, table, players: list, url: `/api/tables/${table.id}` };
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

test('vários jogadores rolando iniciativa ao mesmo tempo: ninguém some da ordem', async () => {
  const { gm, players, url } = await setupTable(5);
  await call(gm, 'PUT', `${url}/initiative`, { entries: [{ id: 'g1', kind: 'monster', name: 'Goblin', initiative: 12, max_hp: 7 }] });
  await Promise.all(players.map(({ user }) => call(user, 'POST', `${url}/roll`, { kind: 'initiative' })));
  const state = (await call(gm, 'GET', `${url}/initiative`)).body;
  assert.equal(state.entries.length, 6);
  for (const { character } of players) assert.ok(state.entries.some((e) => e.character_id === character.id));
});

test('o Mestre editando uma ordem antiga recebe 409 em vez de apagar a rolagem de alguém', async () => {
  const { gm, players, url } = await setupTable(1);
  const seen = (await call(gm, 'PUT', `${url}/initiative`, { entries: [{ id: 'g1', kind: 'monster', name: 'Goblin', initiative: 12, max_hp: 7 }] })).body;
  await call(players[0].user, 'POST', `${url}/roll`, { kind: 'initiative' });
  const stale = await call(gm, 'PUT', `${url}/initiative`, { version: seen.version, entries: seen.entries });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'stale');
  const fresh = (await call(gm, 'GET', `${url}/initiative`)).body;
  assert.equal(fresh.entries.length, 2);
  assert.equal((await call(gm, 'PUT', `${url}/initiative`, { version: fresh.version, entries: fresh.entries })).status, 200);
  // Jogadores não recebem o vínculo com a Biblioteca (revelaria fichas ocultas).
  await call(gm, 'PUT', `${url}/initiative`, { entries: [{ id: 'm1', kind: 'monster', name: 'X', initiative: 3, library_id: 99, library_kind: 'monster' }] });
  const asPlayer = (await call(players[0].user, 'GET', `${url}/initiative`)).body;
  assert.equal(asPlayer.entries[0].library_id, undefined);
});

test('dano do Mestre e cura do jogador ao mesmo tempo: os dois valem', async () => {
  const { gm, players, url } = await setupTable(1);
  const { user, character } = players[0];
  await call(gm, 'PATCH', `${url}/party/${character.id}`, { hp_delta: -6 });
  const before = (await call(gm, 'GET', `${url}/party`)).body[0].current_hp;
  await Promise.all([
    call(gm, 'PATCH', `${url}/party/${character.id}`, { hp_delta: -3 }),
    call(user, 'PATCH', `${url}/party/${character.id}`, { hp_delta: 2 }),
  ]);
  assert.equal((await call(gm, 'GET', `${url}/party`)).body[0].current_hp, before - 3 + 2);
  // O Mestre fica sabendo do que o jogador mudou (só ele vê).
  const gmSees = (await call(gm, 'GET', `${url}/messages`)).body.filter((m) => m.visibility === 'gm' && m.kind === 'sistema');
  assert.ok(gmSees.some((m) => m.text.includes('ajustou Heroi 1')));
});

test('entradas inválidas viram 400, não erro do servidor', async () => {
  const { gm, players, url } = await setupTable(1);
  for (const to of ['abc', 1.5, 1e12, '1e12']) {
    assert.equal((await call(gm, 'POST', `${url}/messages`, { kind: 'narracao', text: 'oi', to })).status, 400, String(to));
  }
  assert.equal((await call(gm, 'POST', '/api/templates/from-library', { table_id: 999, kind: 'npc', id: 1e12 })).status, 404);
  const table = url.split('/').pop();
  assert.equal((await call(gm, 'POST', '/api/templates/from-library', { table_id: table, kind: 'npc', id: 1e12 })).status, 400);
  assert.equal((await call(gm, 'PATCH', `${url}/library/constructor/1`, { name: 'x' })).status, 400);
  assert.equal((await call(players[0].user, 'POST', `${url}/roll`, { kind: 'death' })).status, 400);
});

test('o Mestre não troca retrato nem história, e os PV mudam só na mesa dele', async () => {
  const { gm, players, url } = await setupTable(1);
  const { user, character } = players[0];
  const solo = (await call(user, 'POST', '/api/campaigns', { name: 'Solo' })).body;
  await call(user, 'POST', '/api/campaigns/join', { campaign_id: solo.id, character_id: character.id });
  const soloHp = async () => (await db.get('SELECT max_hp FROM campaign_characters WHERE campaign_id = ?', solo.id)).max_hp;
  const hpBefore = await soloHp();
  const sheet = (await call(gm, 'GET', `${url}/party/${character.id}/sheet`)).body;
  const saved = await call(gm, 'PUT', `${url}/party/${character.id}/sheet`, { ...sheet, level: 5, max_hp: sheet.max_hp + 10, backstory: 'Escrito pelo Mestre', avatar_url: null });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.backstory, character.backstory);
  assert.equal(saved.body.avatar_url, character.avatar_url);
  assert.equal(await soloHp(), hpBefore);
  assert.ok((await db.get('SELECT max_hp FROM campaign_characters WHERE campaign_id = ?', Number(url.split('/').pop()))).max_hp > hpBefore);
});

test('retrato só daqui: endereço de outro site é recusado', async () => {
  const user = await addUser(db);
  const res = await call(user, 'POST', '/api/characters', { name: 'Lia', race: 'Elfa', class: 'Maga', avatar_url: 'https://rastreador.example/pixel.png' });
  assert.equal(res.status, 400);
});

test('imagens: cota por conta, e imagem trocada, recusada ou excluída sai do banco', async () => {
  const { gm, url } = await setupTable(0);
  const count = async () => (await db.get('SELECT COUNT(*) AS n FROM images')).n;

  const goblin = (await call(gm, 'POST', `${url}/library`, { kind: 'monster', name: 'Goblin', image: PNG(1) })).body;
  assert.equal(await count(), 1);
  // Nome repetido: a ficha não é criada e a imagem enviada não fica perdida.
  assert.equal((await call(gm, 'POST', `${url}/library`, { kind: 'monster', name: 'goblin', image: PNG(2) })).status, 409);
  assert.equal(await count(), 1);
  // Trocar a imagem apaga a antiga.
  await call(gm, 'PATCH', `${url}/library/monster/${goblin.id}`, { image: PNG(3) });
  assert.equal(await count(), 1);
  await call(gm, 'DELETE', `${url}/library/monster/${goblin.id}`);
  assert.equal(await count(), 0);

  const template = (await call(gm, 'POST', '/api/templates', { kind: 'npc', name: 'Rhea', image: PNG(4) })).body;
  assert.equal(await count(), 1);
  await call(gm, 'DELETE', `/api/templates/${template.id}`);
  assert.equal(await count(), 0);

  // Cota: com a conta cheia, o envio é recusado.
  await db.run(`INSERT INTO images (name, user_id, mime, size, data) VALUES ('enorme.png', ?, 'image/png', ?, '\\x00')`, gm.id, 200 * 1024 * 1024);
  const full = await call(gm, 'POST', `${url}/library`, { kind: 'npc', name: 'Outro', image: PNG(5) });
  assert.equal(full.status, 413);
});

test('limite de mesas por conta vale mesmo com pedidos ao mesmo tempo', async () => {
  const gm = await addUser(db);
  for (let i = 0; i < 18; i += 1) await db.tx(async (t) => {
    const { id } = await t.run(`INSERT INTO campaigns (user_id, mode, name, join_code) VALUES (?, 'grupo', ?, ?) RETURNING id`, gm.id, `M${i}`, `CODE${i}XYZ`);
    await t.run(`INSERT INTO campaign_members (campaign_id, user_id, role, status) VALUES (?, ?, 'mestre', 'ativo')`, id, gm.id);
  });
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => call(gm, 'POST', '/api/tables', { name: `Nova ${i}` })));
  assert.equal(results.filter((r) => r.status === 201).length, 2);
});

test('tempo real: limite de conexões por pessoa e contagem volta a zero ao fechar', async () => {
  const hub = createTableHub({ maxPerUser: 2, maxTotal: 3 });
  const fakeReq = () => { const handlers = {}; return { destroyed: false, on: (e, fn) => { handlers[e] = fn; }, handlers }; };
  const fakeRes = () => {
    const res = { writableEnded: false, destroyed: false, chunks: [], handlers: {} };
    Object.assign(res, {
      status: () => res, set: () => res, flushHeaders: () => {}, write: (chunk) => res.chunks.push(chunk),
      end: () => { res.writableEnded = true; res.handlers.close?.(); }, on: (e, fn) => { res.handlers[e] = fn; },
    });
    return res;
  };
  const open = (campaign, userId) => { const res = fakeRes(); hub.subscribe(campaign, { userId, role: 'jogador' }, fakeReq(), res); return res; };
  const a1 = open(1, 7);
  open(2, 7);
  open(1, 7); // terceira da mesma pessoa: a mais antiga fecha
  assert.equal(a1.writableEnded, true);
  assert.equal(hub.count(), 2);
  open(1, 8);
  assert.throws(() => open(1, 9), /servidor está cheio/);
  hub.kick(1);
  assert.equal(hub.count(1), 0);
  hub.closeAll();
  assert.equal(hub.count(), 0);
});
