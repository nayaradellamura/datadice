import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { createApp } from '../src/app.js';
import { freshDb } from './db.js';
import { addUser, authHeaders, SECRET } from './helpers.js';

// Personagem que morre: a história continua com outro, nos dois modos.

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

const hero = (user, name, cls = 'Guerreiro') => call(user, 'POST', '/api/characters', { name, race: 'Humano', class: cls, con: 14 }).then((r) => r.body);

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

async function tableWithPlayer() {
  const gm = await addUser(db, { name: 'Mestra' });
  const ana = await addUser(db, { name: 'Ana' });
  const table = (await call(gm, 'POST', '/api/tables', { name: 'Mesa' })).body;
  await call(ana, 'POST', '/api/tables/join', { code: table.join_code });
  await call(gm, 'POST', `/api/tables/${table.id}/members/${ana.id}/approve`);
  const kael = await hero(ana, 'Kael');
  await call(ana, 'PUT', `/api/tables/${table.id}/character`, { character_id: kael.id });
  return { gm, ana, table, kael, url: `/api/tables/${table.id}` };
}

const texts = async (user, url) => (await call(user, 'GET', `${url}/messages`)).body.messages?.map((m) => m.text)
  ?? (await call(user, 'GET', `${url}/messages`)).body.map((m) => m.text);

test('mesa: o Mestre marca a morte, a mesa sabe, e o jogador continua com outra ficha', async () => {
  const { gm, ana, kael, url } = await tableWithPlayer();

  // Só o Mestre decide morte e volta à vida.
  assert.equal((await call(ana, 'PATCH', `${url}/party/${kael.id}`, { status: 'dead' })).status, 403);
  assert.equal((await call(gm, 'PATCH', `${url}/party/${kael.id}`, { status: 'dead', current_hp: 0 })).status, 200);
  assert.ok((await texts(ana, url)).includes('Kael morreu.'));

  // Morto não rola pela ficha; dados livres continuam, em nome da jogadora.
  const check = await call(ana, 'POST', `${url}/roll`, { kind: 'attribute', key: 'str' });
  assert.equal(check.status, 400);
  assert.equal(check.body.code, 'character_dead');
  const free = await call(ana, 'POST', `${url}/roll`, { kind: 'dice', expression: '1d6' });
  assert.equal(free.status, 201);
  assert.match(free.body.text, /^Ana/);

  // O Mestre traz de volta, e marca de novo.
  await call(gm, 'PATCH', `${url}/party/${kael.id}`, { status: 'active', current_hp: 1 });
  assert.ok((await texts(ana, url)).includes('Kael voltou à vida.'));
  const alive = (await call(gm, 'GET', `${url}/party`)).body.find((m) => m.character_id === kael.id);
  assert.deepEqual([alive.status, alive.current_hp], ['active', 1]);
  await call(gm, 'PATCH', `${url}/party/${kael.id}`, { status: 'dead', current_hp: 0 });

  // A lista de Personagens mostra onde a ficha morreu.
  const mine = (await call(ana, 'GET', '/api/characters')).body.find((c) => c.id === kael.id);
  assert.deepEqual(mine.fallen_in, ['Mesa']);

  // Troca de ficha: a mesa fica sabendo do porquê.
  const lyra = await hero(ana, 'Lyra', 'Mago');
  assert.equal((await call(ana, 'PUT', `${url}/character`, { character_id: lyra.id })).status, 200);
  assert.ok((await texts(gm, url)).some((t) => t === 'Kael morreu. Ana continua a aventura com Lyra (Humano, Mago 1).'));
  assert.equal((await call(ana, 'POST', `${url}/roll`, { kind: 'attribute', key: 'int' })).status, 201);
});

test('Mestre IA: personagem novo depois de uma morte avisa o Mestre na história', async () => {
  const ana = await addUser(db, { name: 'Ana' });
  const campaign = (await call(ana, 'POST', '/api/campaigns', { name: 'Vale Sombrio', world_description: 'Um vale.', system_prompt: '' })).body;
  const kael = await hero(ana, 'Kael');
  assert.equal((await call(ana, 'POST', '/api/campaigns/join', { campaign_id: campaign.id, character_id: kael.id })).status, 201);
  // Campanha ainda sem mensagens: entrar não gera aviso.
  assert.equal(await db.get('SELECT 1 AS x FROM messages WHERE campaign_id = ?', campaign.id), undefined);

  await db.run(`INSERT INTO messages (campaign_id, sender_type, sender_name, message_text) VALUES (?, 'gm', 'Mestre', 'O dragão ataca.')`, campaign.id);
  await call(ana, 'PATCH', `/api/campaigns/${campaign.id}/characters/${kael.id}`, { status: 'dead', current_hp: 0 });

  const lyra = await hero(ana, 'Lyra', 'Mago');
  assert.equal((await call(ana, 'POST', '/api/campaigns/join', { campaign_id: campaign.id, character_id: lyra.id })).status, 201);
  const notice = await db.get(`SELECT sender_type, message_text FROM messages WHERE campaign_id = ? AND sender_type = 'system'`, campaign.id);
  assert.deepEqual({ ...notice }, { sender_type: 'system', message_text: 'Novo personagem no grupo depois da morte de Kael: Lyra (Humano, Mago 1).' });
});
