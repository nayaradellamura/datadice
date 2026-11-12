import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { createApp } from '../src/app.js';
import { freshDb } from './db.js';
import { addUser, authHeaders, SECRET } from './helpers.js';

let db, server, base, app;
const streams = [];

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

/** Abre o canal em tempo real e junta os eventos recebidos. */
async function openStream(user, tableId) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/tables/${tableId}/stream`, { headers: authHeaders(user.token, { key: null }), signal: controller.signal });
  const stream = { status: res.status, events: [], close: () => controller.abort() };
  streams.push(stream);
  if (res.status !== 200) return stream;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event) stream.events.push({ event, data: data ? JSON.parse(data) : null });
        }
      }
    } catch {
      // Canal fechado.
    }
  })();
  await waitFor(() => stream.events.some((e) => e.event === 'ready'));
  return stream;
}

async function waitFor(check, ms = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('tempo esgotado esperando o evento');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const texts = (messages) => messages.map((m) => m.text);

/** Mesa com Mestra, dois jogadores (com fichas) e um estranho. */
async function setupTable() {
  const gm = await addUser(db, { name: 'Mestra' });
  const ana = await addUser(db, { name: 'Ana' });
  const bia = await addUser(db, { name: 'Bia' });
  const outsider = await addUser(db, { name: 'Fora' });
  const admin = await addUser(db, { name: 'Admin', role: 'admin' });
  const table = (await call(gm, 'POST', '/api/tables', { name: 'Mesa' })).body;
  const chars = {};
  for (const [player, name] of [[ana, 'Lia'], [bia, 'Bran']]) {
    await call(player, 'POST', '/api/tables/join', { code: table.join_code });
    await call(gm, 'POST', `/api/tables/${table.id}/members/${player.id}/approve`);
    chars[name] = (await call(player, 'POST', '/api/characters', {
      name, race: 'Humana', class: 'Guerreira', con: 14, dex: 14,
      sheet: { attacks: [{ name: 'Espada', bonus: '+5', damage: '1d8+3 cortante' }] },
    })).body;
    await call(player, 'PUT', `/api/tables/${table.id}/character`, { character_id: chars[name].id });
  }
  return { gm, ana, bia, outsider, admin, table, chars, url: `/api/tables/${table.id}` };
}

beforeEach(async () => {
  for (const stream of streams.splice(0)) stream.close();
  if (server) await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  db = await freshDb();
  app = createApp({ db, jwtSecret: SECRET, llm: {}, joinLimits: { windowMs: 60_000, max: 1000 } });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  for (const stream of streams) stream.close();
  app?.locals.tableHub.closeAll();
  server?.closeAllConnections?.();
  server?.close();
});

test('chat: em personagem, fora do personagem e privado com o Mestre', async () => {
  const { gm, ana, bia, url } = await setupTable();
  const fala = await call(ana, 'POST', `${url}/messages`, { kind: 'fala', text: 'Abro a porta.' });
  assert.equal(fala.status, 201);
  assert.equal(fala.body.sender_name, 'Lia');
  assert.equal((await call(ana, 'POST', `${url}/messages`, { kind: 'ooc', text: 'volto em 5 min' })).body.sender_name, 'Ana');
  await call(ana, 'POST', `${url}/messages`, { kind: 'fala', text: 'Mestre, eu roubo a gema.', to: 'gm' });
  await call(gm, 'POST', `${url}/messages`, { kind: 'narracao', text: 'A porta range.' });
  await call(gm, 'POST', `${url}/messages`, { kind: 'fala', as: 'Taverneiro', text: 'Bem-vindos!' });
  await call(gm, 'POST', `${url}/messages`, { kind: 'narracao', text: 'Bia, você sente um frio.', to: bia.id });

  assert.equal((await call(ana, 'POST', `${url}/messages`, { kind: 'narracao', text: 'x' })).status, 400);
  assert.equal((await call(ana, 'POST', `${url}/messages`, { kind: 'fala', text: 'oi', to: bia.id })).status, 400);
  assert.equal((await call(gm, 'POST', `${url}/messages`, { kind: 'fala', text: 'sem nome' })).status, 400);
  assert.equal((await call(ana, 'POST', `${url}/messages`, { kind: 'fala', text: '   ' })).status, 400);

  const all = texts((await call(gm, 'GET', `${url}/messages`)).body);
  assert.deepEqual(all, ['Abro a porta.', 'volto em 5 min', 'Mestre, eu roubo a gema.', 'A porta range.', 'Bem-vindos!', 'Bia, você sente um frio.']);
  assert.deepEqual(texts((await call(ana, 'GET', `${url}/messages`)).body),
    ['Abro a porta.', 'volto em 5 min', 'Mestre, eu roubo a gema.', 'A porta range.', 'Bem-vindos!']);
  assert.deepEqual(texts((await call(bia, 'GET', `${url}/messages`)).body),
    ['Abro a porta.', 'volto em 5 min', 'A porta range.', 'Bem-vindos!', 'Bia, você sente um frio.']);

  // Paginação e "depois de".
  const page = (await call(gm, 'GET', `${url}/messages?limit=2`)).body;
  assert.deepEqual(texts(page), ['Bem-vindos!', 'Bia, você sente um frio.']);
  assert.deepEqual(texts((await call(gm, 'GET', `${url}/messages?before=${page[0].id}&limit=1`)).body), ['A porta range.']);
  assert.deepEqual(texts((await call(bia, 'GET', `${url}/messages?after=${page[0].id - 2}`)).body), ['A porta range.', 'Bem-vindos!', 'Bia, você sente um frio.']);
});

test('quem não é da mesa (nem o admin) não lê nem escreve; quem saiu perde o acesso', async () => {
  const { gm, ana, outsider, admin, url } = await setupTable();
  await call(gm, 'POST', `${url}/messages`, { kind: 'narracao', text: 'Segredo da mesa.' });
  for (const user of [outsider, admin]) {
    for (const path of ['/messages', '/party', '/initiative', '/library', '/gallery', '/notes']) {
      assert.equal((await call(user, 'GET', `${url}${path}`)).status, 404, `${path}`);
    }
    assert.equal((await call(user, 'POST', `${url}/messages`, { kind: 'ooc', text: 'oi' })).status, 404);
    assert.equal((await openStream(user, url.split('/').pop())).status, 404);
  }
  // As mensagens da mesa não aparecem nas rotas do Solo nem no painel admin.
  assert.equal((await call(admin, 'GET', `/api/campaigns/${url.split('/').pop()}/messages`)).status, 404);
  await call(ana, 'POST', `${url}/leave`);
  assert.equal((await call(ana, 'GET', `${url}/messages`)).status, 404);
});

test('rolagens: as do Mestre são secretas por padrão; o jogador pode rolar só para o Mestre', async () => {
  const { gm, ana, bia, url } = await setupTable();
  const secret = await call(gm, 'POST', `${url}/roll`, { kind: 'dice', expression: '1d20+3', label: 'Goblin' });
  assert.equal(secret.status, 201);
  assert.equal(secret.body.visibility, 'gm');
  assert.match(secret.body.text, /^Goblin rolou 1d20 \+ 3/);
  const open = await call(gm, 'POST', `${url}/roll`, { kind: 'plain', secret: false, mode: 'advantage' });
  assert.equal(open.body.visibility, 'all');
  assert.match(open.body.text, /com vantagem/);

  const check = await call(ana, 'POST', `${url}/roll`, { kind: 'skill', key: 'percepcao' });
  assert.match(check.body.text, /^Lia rolou Percepção/);
  const hidden = await call(ana, 'POST', `${url}/roll`, { kind: 'skill', key: 'furtividade', secret: true });
  assert.equal(hidden.body.visibility, 'gm');
  const attack = await call(ana, 'POST', `${url}/roll`, { kind: 'attack', index: 0 });
  assert.match(attack.body.text, /Lia atacou com Espada/);
  assert.equal((await call(ana, 'POST', `${url}/roll`, { kind: 'dice', expression: '9d999' })).status, 400);

  const seenBy = async (user) => (await call(user, 'GET', `${url}/messages`)).body.map((m) => m.id);
  assert.deepEqual(await seenBy(gm), [secret.body.id, open.body.id, check.body.id, hidden.body.id, attack.body.id]);
  assert.deepEqual(await seenBy(ana), [open.body.id, check.body.id, hidden.body.id, attack.body.id]);
  assert.deepEqual(await seenBy(bia), [open.body.id, check.body.id, attack.body.id]);
});

test('tempo real: cada um recebe só o que pode ver', async () => {
  const { gm, ana, bia, table, url } = await setupTable();
  const sGm = await openStream(gm, table.id);
  const sAna = await openStream(ana, table.id);
  const sBia = await openStream(bia, table.id);

  await call(gm, 'POST', `${url}/roll`, { kind: 'dice', expression: '1d6' });
  await call(ana, 'POST', `${url}/messages`, { kind: 'fala', text: 'Só para a Mestra.', to: 'gm' });
  await call(bia, 'POST', `${url}/messages`, { kind: 'fala', text: 'Para todos.' });
  await waitFor(() => sGm.events.filter((e) => e.event === 'message').length === 3);
  await waitFor(() => sBia.events.some((e) => e.data?.text === 'Para todos.'));
  await waitFor(() => sAna.events.some((e) => e.data?.text === 'Para todos.'));
  const got = (stream) => stream.events.filter((e) => e.event === 'message').map((e) => e.data.text);
  assert.deepEqual(got(sAna), ['Só para a Mestra.', 'Para todos.']);
  assert.deepEqual(got(sBia), ['Para todos.']);

  // Removida pelo Mestre: o canal dela fecha na hora.
  await call(gm, 'DELETE', `${url}/members/${bia.id}`);
  await waitFor(() => sBia.events.some((e) => e.event === 'kicked'));
  await waitFor(() => sAna.events.some((e) => e.event === 'table'));
});

test('o Mestre ajusta PV e a ficha; o jogador é avisado e só mexe no que é dele', async () => {
  const { gm, ana, bia, chars, url } = await setupTable();
  const lia = chars.Lia.id;
  // Dano gasta antes os PV temporários.
  await call(ana, 'PATCH', `${url}/party/${lia}`, { temp_hp: 3 });
  const hurt = await call(gm, 'PATCH', `${url}/party/${lia}`, { hp_delta: -5, conditions: ['Envenenada'] });
  assert.equal(hurt.status, 200);
  const liaState = hurt.body.find((m) => m.character_id === lia);
  assert.equal(liaState.temp_hp, 0);
  assert.equal(liaState.current_hp, liaState.max_hp - 2);
  assert.equal((await call(bia, 'PATCH', `${url}/party/${lia}`, { current_hp: 1 })).status, 403);

  const notice = (await call(ana, 'GET', `${url}/messages`)).body.at(-1);
  assert.equal(notice.kind, 'sistema');
  assert.match(notice.text, /O Mestre ajustou Lia: PV \d+ → \d+; PV temporários 3 → 0; condições: Envenenada/);
  assert.equal((await call(bia, 'GET', `${url}/messages`)).body.length, 0);

  // Outros jogadores veem PV e condições, mas não a ficha inteira.
  const fromBia = (await call(bia, 'GET', `${url}/party`)).body.find((m) => m.character_id === lia);
  assert.deepEqual(fromBia.conditions, ['Envenenada']);
  assert.equal(fromBia.sheet, undefined);
  assert.ok((await call(ana, 'GET', `${url}/party`)).body.find((m) => m.character_id === lia).sheet);

  // Ficha completa: só o Mestre abre a dos outros.
  assert.equal((await call(bia, 'GET', `${url}/party/${lia}/sheet`)).status, 403);
  const sheet = (await call(gm, 'GET', `${url}/party/${lia}/sheet`)).body;
  const saved = await call(gm, 'PUT', `${url}/party/${lia}/sheet`, { ...sheet, level: 3, xp: 900, sheet: { ...sheet.sheet, equipment: 'Corda' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.level, 3);
  assert.equal((await call(ana, 'GET', `/api/characters/${lia}`)).body.level, 3);
  const sheetNotice = (await call(ana, 'GET', `${url}/messages`)).body.at(-1);
  assert.match(sheetNotice.text, /O Mestre alterou a ficha de Lia: nível 1 → 3; XP 0 → 900; outros detalhes da ficha/);
});

test('iniciativa: jogadores não veem ocultos nem PV de monstros; rolar iniciativa entra na ordem', async () => {
  const { gm, ana, bia, chars, url } = await setupTable();
  const start = await call(gm, 'PUT', `${url}/initiative`, {
    entries: [
      { id: 'g1', kind: 'monster', name: 'Goblin 1', initiative: 15, max_hp: 7 },
      { id: 'g2', kind: 'monster', name: 'Assassino', initiative: 20, max_hp: 30, hidden: true },
      { id: `pc-${chars.Bran.id}`, kind: 'pc', character_id: chars.Bran.id, name: 'Bran', initiative: 10 },
    ],
  });
  assert.equal(start.status, 200);
  assert.deepEqual(start.body.entries.map((e) => e.name), ['Assassino', 'Goblin 1', 'Bran']);
  assert.equal(start.body.entries[1].hp, 7);
  assert.equal((await call(ana, 'PUT', `${url}/initiative`, { entries: [] })).status, 403);

  const forAna = (await call(ana, 'GET', `${url}/initiative`)).body;
  assert.deepEqual(forAna.entries.map((e) => e.name), ['Goblin 1', 'Bran']);
  assert.equal(forAna.entries[0].hp, undefined);
  // A vez é do oculto: o jogador não sabe de quem é.
  assert.equal(forAna.current_id, null);

  await call(ana, 'POST', `${url}/roll`, { kind: 'initiative' });
  const withLia = (await call(gm, 'GET', `${url}/initiative`)).body;
  assert.ok(withLia.entries.some((e) => e.character_id === chars.Lia.id));
  assert.equal(withLia.current_id, 'g2');

  const next = (await call(gm, 'POST', `${url}/initiative/next`)).body;
  // A iniciativa da Lia é sorteada: a próxima vez é de quem vem logo depois do Assassino na ordem.
  const after = withLia.entries.findIndex((e) => e.id === 'g2') + 1;
  assert.equal(next.current_id, withLia.entries[after % withLia.entries.length].id);
  const announce = (await call(bia, 'GET', `${url}/messages`)).body.map((m) => m.text);
  assert.ok(announce.includes('Combate! Rolem iniciativa.'));
  assert.ok(announce.some((text) => text.startsWith('Rodada 1 · vez de')));
  for (let i = 0; i < 3; i += 1) await call(gm, 'POST', `${url}/initiative/next`);
  assert.equal((await call(gm, 'GET', `${url}/initiative`)).body.round, 2);

  await call(gm, 'PUT', `${url}/initiative`, { entries: [] });
  assert.equal((await call(bia, 'GET', `${url}/initiative`)).body.active, false);
});

test('Biblioteca: começa oculta, o Mestre revela; jogadores não veem as estatísticas', async () => {
  const { gm, ana, url } = await setupTable();
  const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64')}`;
  const goblin = await call(gm, 'POST', `${url}/library`, {
    kind: 'monster', name: 'Goblin', description: 'Pequeno e cruel.', image: png,
    stats: { armor_class: 15, max_hp: 7, abilities: { dex: 14 }, attacks: [{ name: 'Cimitarra', bonus: '+4', damage: '1d6+2 cortante' }] },
  });
  assert.equal(goblin.status, 201);
  assert.equal(goblin.body.revealed, false);
  assert.match(goblin.body.image_url, /^\/images\/biblioteca_/);
  assert.equal((await call(gm, 'POST', `${url}/library`, { kind: 'monster', name: 'goblin' })).status, 409);
  assert.equal((await call(ana, 'POST', `${url}/library`, { kind: 'npc', name: 'Eu' })).status, 403);
  assert.deepEqual((await call(ana, 'GET', `${url}/library`)).body, []);

  // O Mestre rola o ataque do monstro, em segredo.
  const attack = await call(gm, 'POST', `${url}/roll`, { kind: 'monster_attack', library_kind: 'monster', library_id: goblin.body.id, index: 0 });
  assert.match(attack.body.text, /^Goblin atacou com Cimitarra/);

  await call(gm, 'PATCH', `${url}/library/monster/${goblin.body.id}`, { revealed: true });
  const seen = (await call(ana, 'GET', `${url}/library`)).body;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, 'Goblin');
  assert.equal(seen[0].stats, undefined);
  assert.ok((await call(ana, 'GET', `${url}/messages`)).body.some((m) => m.text.includes('Nova entrada na Biblioteca: Goblin (Monstro)')));

  assert.equal((await call(gm, 'DELETE', `${url}/library/monster/${goblin.body.id}`)).status, 204);
  assert.deepEqual((await call(ana, 'GET', `${url}/library`)).body, []);
});

test('imagens do Mestre: para todos ou para um jogador; notas só do Mestre', async () => {
  const { gm, ana, bia, url } = await setupTable();
  const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64')}`;
  const toAll = await call(gm, 'POST', `${url}/images`, { image: png, caption: 'O mapa' });
  assert.equal(toAll.status, 201);
  const toBia = await call(gm, 'POST', `${url}/images`, { image: png, caption: 'Só você vê', to: bia.id });
  assert.equal((await call(gm, 'POST', `${url}/images`, { image: 'data:text/plain;base64,aGVsbG8=' })).status, 400);
  assert.equal((await call(ana, 'POST', `${url}/images`, { image: png })).status, 403);

  assert.deepEqual((await call(ana, 'GET', `${url}/gallery`)).body.map((m) => m.text), ['O mapa']);
  assert.deepEqual((await call(bia, 'GET', `${url}/gallery`)).body.map((m) => m.text), ['Só você vê', 'O mapa']);
  const image = await fetch(base + toBia.body.image_url);
  assert.equal(image.headers.get('content-type'), 'image/png');

  const note = await call(gm, 'POST', `${url}/notes`, { title: 'Plano', body: 'O taverneiro é o vilão.' });
  assert.equal(note.status, 201);
  assert.equal((await call(ana, 'GET', `${url}/notes`)).status, 403);
  await call(gm, 'PATCH', `${url}/notes/${note.body.id}`, { body: 'Mudei de ideia.' });
  assert.equal((await call(gm, 'GET', `${url}/notes`)).body[0].body, 'Mudei de ideia.');
  assert.equal((await call(gm, 'DELETE', `${url}/notes/${note.body.id}`)).status, 204);
});
