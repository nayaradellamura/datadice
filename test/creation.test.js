import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createApp } from '../src/app.js';
import { freshDb } from './db.js';
import { addUser, authHeaders, SECRET } from './helpers.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
let db, server, base, user, llm, dir;

async function call(method, path, body, headers = authHeaders(user.token)) {
  const res = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'datadice-criacao-'));
  db = await freshDb();
  llm = {
    calls: [],
    data: {
      name: '"As Brumas de Valdoria"',
      world_description: 'Premissa:\nUm vale coberto de névoa.\nComo a aventura começa:\nNuma taverna.',
      system_prompt: 'Tom sombrio, ritmo lento.',
    },
    async generateJson(prompt) {
      this.calls.push(prompt);
      return { data: this.data, usage: { prompt: 300, completion: 500, total: 800 }, model: 'gemini-3.5-flash-lite' };
    },
  };
  const app = createApp({ db, llm, jwtSecret: SECRET, imagesDir: dir });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  user = await addUser(db);
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('temas: lista os temas prontos, sem os textos internos da IA', async () => {
  const { body } = await call('GET', '/api/campaigns/themes');
  assert.ok(body.themes.length >= 6);
  assert.deepEqual(Object.keys(body.themes[0]).sort(), ['blurb', 'icon', 'key', 'title']);
  assert.deepEqual(body.tones, ['leve', 'equilibrado', 'sombrio']);
});

test('gerar campanha: devolve um rascunho limpo, não salva nada e registra o consumo', async () => {
  const res = await call('POST', '/api/campaigns/generate', { theme: 'gotico', tone: 'sombrio', length: 'curta', idea: 'um dragão bonzinho' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    name: 'As Brumas de Valdoria',
    world_description: 'Premissa:\nUm vale coberto de névoa.\nComo a aventura começa:\nNuma taverna.',
    system_prompt: 'Tom sombrio, ritmo lento.',
  });
  const prompt = JSON.stringify(llm.calls[0].contents);
  assert.match(prompt, /horror gótico/);
  assert.match(prompt, /sombria/);
  assert.match(prompt, /1 ou 2 sessões/);
  assert.match(prompt, /um dragão bonzinho/);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM campaigns')).n, 0, 'só salva quando o jogador confirmar');

  const mine = (await call('GET', '/api/tokens/mine?period=all')).body;
  assert.equal(mine.by_kind[0].label, 'Criação de campanha');
  assert.equal(mine.totals.total_tokens, 800);
});

test('gerar campanha: tema, tom ou duração inválidos e resposta incompleta da IA', async () => {
  assert.equal((await call('POST', '/api/campaigns/generate', { theme: 'nao-existe' })).status, 400);
  assert.equal((await call('POST', '/api/campaigns/generate', { theme: 'gotico', tone: 'x' })).status, 400);
  assert.equal((await call('POST', '/api/campaigns/generate', { theme: 'gotico', length: 'x' })).status, 400);
  assert.equal(llm.calls.length, 0);

  llm.data = { name: '', world_description: '', system_prompt: '' };
  const res = await call('POST', '/api/campaigns/generate', { theme: 'gotico' });
  assert.equal(res.status, 502);
  assert.match(res.body.error, /incompleta/);
});

test('gerar campanha exige a chave do Gemini', async () => {
  const res = await call('POST', '/api/campaigns/generate', { theme: 'gotico' }, authHeaders(user.token, { key: null }));
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'gemini_key');
});

test('lista de campanhas traz grupo, mensagens e última jogada', async () => {
  const campaign = (await call('POST', '/api/campaigns', { name: 'Vale' })).body;
  const character = (await call('POST', '/api/characters', { name: 'Lia', race: 'Elfo', class: 'Mago' })).body;
  await call('POST', '/api/campaigns/join', { campaign_id: campaign.id, character_id: character.id });
  await call('POST', `/api/campaigns/${campaign.id}/roll`, { character_id: character.id, kind: 'dice', expression: '1d20' });
  const [listed] = (await call('GET', '/api/campaigns')).body;
  assert.equal(listed.party_size, 1);
  assert.equal(listed.message_count, 1);
  assert.ok(listed.last_played_at);
});

test('enviar retrato: grava a imagem com nome imprevisível e ela pode ir para a ficha', async () => {
  const res = await call('POST', '/api/portraits', { image: `data:image/png;base64,${PNG.toString('base64')}` });
  assert.equal(res.status, 201);
  assert.match(res.body.url, /^\/images\/retrato_enviado_\d+_[0-9a-f]{24}\.png$/);
  // A imagem fica no banco, em nome de quem enviou, e é servida pela mesma URL.
  const stored = await db.get('SELECT user_id, mime, data FROM images');
  assert.deepEqual([stored.user_id, stored.mime], [user.id, 'image/png']);
  assert.deepEqual(stored.data, PNG);
  const served = await fetch(base + res.body.url);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);
  assert.equal((await fetch(`${base}/images/retrato_enviado_1_${'0'.repeat(24)}.png`)).status, 404);

  const created = await call('POST', '/api/characters', { name: 'Lia', race: 'Elfo', class: 'Mago', avatar_url: res.body.url });
  assert.equal(created.body.avatar_url, res.body.url);
});

test('enviar retrato: recusa o que não é imagem, imagem grande demais e quem não está logado', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
  for (const image of ['', 'nada', `data:image/svg+xml;base64,${svg}`]) {
    const res = await call('POST', '/api/portraits', { image });
    assert.equal(res.status, 400, image.slice(0, 30));
  }
  const big = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]).toString('base64');
  const tooBig = await call('POST', '/api/portraits', { image: big });
  assert.ok([413].includes(tooBig.status), `status ${tooBig.status}`);

  const anonymous = await call('POST', '/api/portraits', { image: PNG.toString('base64') }, { 'content-type': 'application/json' });
  assert.equal(anonymous.status, 401);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM images')).n, 0);
  assert.deepEqual(readdirSync(dir), [], 'nada vai para a pasta');
});

test('o limite maior de tamanho vale só para o envio de retrato', async () => {
  const res = await call('POST', '/api/campaigns', { name: 'x', world_description: 'a'.repeat(300 * 1024) });
  assert.equal(res.status, 413);
});

test('admin vê as campanhas de todos com o nome do dono, e o Caderno do Mestre de cada uma', async () => {
  const campaign = (await call('POST', '/api/campaigns', { name: 'Vale' })).body;
  (await db.run(`INSERT INTO campaign_memories (campaign_id, type, name, name_key, content) VALUES (?, 'npc', 'Mira', 'mira', 'Segredo da Bia.')`, campaign.id));
  const admin = await addUser(db, { role: 'admin', name: 'Nayara' });
  (await db.run('UPDATE users SET name = ? WHERE id = ?', 'Bia', user.id));

  const [listed] = (await call('GET', '/api/campaigns', undefined, authHeaders(admin.token))).body;
  assert.equal(listed.owner_name, 'Bia');
  const memories = await call('GET', `/api/campaigns/${campaign.id}/memories`, undefined, authHeaders(admin.token));
  assert.equal(memories.status, 200);
  assert.equal(memories.body[0].content, 'Segredo da Bia.');
  // O próprio jogador continua sem acesso ao caderno.
  assert.equal((await call('GET', `/api/campaigns/${campaign.id}/memories`)).status, 403);
});
