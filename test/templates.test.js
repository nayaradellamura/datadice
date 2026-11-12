import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { createApp } from '../src/app.js';
import { freshDb } from './db.js';
import { addUser, authHeaders, SECRET } from './helpers.js';

let db, server, base, app;
const PNG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]).toString('base64')}`;

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
  app = createApp({ db, jwtSecret: SECRET, llm: {} });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  app?.locals.tableHub.closeAll();
  server?.closeAllConnections?.();
  server?.close();
});

test('meus modelos: cada um vê e mexe só nos seus', async () => {
  const ana = await addUser(db, { name: 'Ana' });
  const bia = await addUser(db, { name: 'Bia' });
  const created = await call(ana, 'POST', '/api/templates', {
    kind: 'monster', name: 'Lobo das Cinzas', description: 'Uiva no vulcão.', image: PNG,
    stats: { armor_class: 14, max_hp: 30, attacks: [{ name: 'Mordida', bonus: '+5', damage: '2d6+3 perfurante' }] },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.stats.max_hp, 30);
  assert.match(created.body.image_url, /^\/images\/modelo_/);
  assert.equal((await call(ana, 'POST', '/api/templates', { kind: 'monster', name: 'lobo das cinzas' })).status, 409);
  // Mesmo nome em outro tipo pode.
  assert.equal((await call(ana, 'POST', '/api/templates', { kind: 'npc', name: 'Lobo das Cinzas' })).status, 201);
  assert.equal((await call(ana, 'POST', '/api/templates', { kind: 'dragao', name: 'X' })).status, 400);

  assert.deepEqual((await call(bia, 'GET', '/api/templates')).body, []);
  assert.equal((await call(bia, 'PATCH', `/api/templates/${created.body.id}`, { name: 'Meu' })).status, 404);
  assert.equal((await call(bia, 'DELETE', `/api/templates/${created.body.id}`)).status, 404);

  const edited = await call(ana, 'PATCH', `/api/templates/${created.body.id}`, { name: 'Lobo Cinzento', stats: { max_hp: 35 } });
  assert.equal(edited.body.name, 'Lobo Cinzento');
  assert.equal(edited.body.stats.max_hp, 35);
  assert.equal((await call(ana, 'GET', '/api/templates')).body.length, 2);
  assert.equal((await call(ana, 'DELETE', `/api/templates/${created.body.id}`)).status, 204);
});

test('modelo vai para a mesa e volta da mesa; a imagem do modelo sobrevive à mesa excluída', async () => {
  const gm = await addUser(db, { name: 'Mestra' });
  const other = await addUser(db, { name: 'Outra' });
  const template = (await call(gm, 'POST', '/api/templates', { kind: 'npc', name: 'Capitã Rhea', image: PNG, stats: { max_hp: 20 } })).body;
  const table = (await call(gm, 'POST', '/api/tables', { name: 'Mesa A' })).body;

  // Usar o modelo numa mesa: a imagem é copiada para a mesa.
  const entry = await call(gm, 'POST', `/api/tables/${table.id}/library`, {
    kind: 'npc', name: template.name, stats: template.stats, image_from: template.image_url,
  });
  assert.equal(entry.status, 201);
  assert.match(entry.body.image_url, /^\/images\/biblioteca_/);
  assert.notEqual(entry.body.image_url, template.image_url);
  // Imagem de outra pessoa não pode ser "emprestada".
  const stolen = await call(other, 'POST', '/api/tables', { name: 'Mesa B' });
  const attempt = await call(other, 'POST', `/api/tables/${stolen.body.id}/library`, { kind: 'npc', name: 'X', image_from: template.image_url });
  assert.equal(attempt.body.image_url, null);

  // Guardar nos modelos uma ficha da Biblioteca (só o Mestre daquela mesa).
  await call(gm, 'POST', `/api/tables/${table.id}/library`, { kind: 'monster', name: 'Kraken', image: PNG, stats: { max_hp: 99 } });
  const kraken = (await call(gm, 'GET', `/api/tables/${table.id}/library`)).body.find((item) => item.name === 'Kraken');
  assert.equal((await call(other, 'POST', '/api/templates/from-library', { table_id: table.id, kind: 'monster', id: kraken.id })).status, 404);
  const saved = await call(gm, 'POST', '/api/templates/from-library', { table_id: table.id, kind: 'monster', id: kraken.id });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.stats.max_hp, 99);

  // A mesa some, mas a imagem do modelo continua.
  await call(gm, 'DELETE', `/api/tables/${table.id}`);
  assert.equal((await fetch(base + saved.body.image_url)).status, 200);
  assert.equal((await fetch(base + template.image_url)).status, 200);
});
