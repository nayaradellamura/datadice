import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createApp } from '../src/app.js';
import { freshDb } from './db.js';
import { addUser, authHeaders, SECRET } from './helpers.js';

const usage = { prompt: 10, completion: 5, total: 15 };
let db, server, base, app, llm, ctx, user;

const turn = (overrides = {}) => ({
  data: { narration: 'A cena continua.', state_changes: [], memory_updates: [], illustrations: [], ...overrides },
  usage,
  model: 'fake',
});

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: authHeaders(user.token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const open = () => api('POST', `/api/campaigns/${ctx.campaign.id}/session`, { character_id: ctx.character.id, enable_image_gen: true });
const say = (message) => api('POST', '/api/chat', { campaign_id: ctx.campaign.id, character_id: ctx.character.id, message });
const state = async () => (await api('GET', `/api/campaigns/${ctx.campaign.id}/state`)).body;
const messages = async () => (await api('GET', `/api/campaigns/${ctx.campaign.id}/messages`)).body;
const age = (hours) => db.run('UPDATE messages SET created_at = now() - make_interval(secs => ?)', hours * 3600);
const lastPrompt = () => JSON.stringify(llm.calls.at(-1).contents.at(-1));

beforeEach(async () => {
  llm = { calls: [], responder: () => turn(), async generateJson(prompt) { this.calls.push(prompt); return this.responder(prompt); } };
  db = await freshDb();
  user = await addUser(db, { role: 'admin' });
  app = createApp({ db, llm, jwtSecret: SECRET, onBackgroundError: () => {} });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const character = (await api('POST', '/api/characters', { name: 'Lia', race: 'Elfo', class: 'Mago' })).body;
  const campaign = (await api('POST', '/api/campaigns', { name: 'Vale' })).body;
  await api('POST', '/api/campaigns/join', { campaign_id: campaign.id, character_id: character.id });
  ctx = { character, campaign };
});

afterEach(async () => {
  await app.locals.visuals.waitForIdle();
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

test('campanha nova pede introdução; o Mestre fala primeiro e orienta o jogador', async () => {
  assert.equal((await state()).session.status, 'new');
  llm.responder = () => turn({ narration: 'Bem-vinda ao Vale. O que você faz?' });

  const { status, body } = await open();
  assert.equal(status, 201);
  assert.equal(body.narration, 'Bem-vinda ao Vale. O que você faz?');
  assert.equal(body.session.status, 'active');
  assert.match(lastPrompt(), /abertura da campanha/);
  assert.match(lastPrompt(), /como jogar/);

  const history = await messages();
  assert.deepEqual(history.map((m) => m.sender_type), ['gm'], 'não cria mensagem falsa do jogador');
  assert.deepEqual(history[0].session, { kind: 'intro', number: 1 });
});

test('a introdução pode criar memória e arte, e não repete', async () => {
  llm.responder = () => turn({
    memory_updates: [{ type: 'location', name: 'Vila', content: 'Vila inicial.', importance: 3, status: 'active' }],
  });
  await open();
  assert.equal((await api('GET', `/api/campaigns/${ctx.campaign.id}/memories`)).body.length, 1);
  assert.equal((await open()).status, 409);
  assert.equal(llm.calls.length, 1);
});

test('sem abertura válida, nada fica salvo e dá para tentar de novo', async () => {
  llm.responder = () => turn({ narration: '' });
  assert.equal((await open()).status, 502);
  assert.equal((await messages()).length, 0);
  assert.equal((await state()).session.status, 'new');
  llm.responder = () => turn();
  assert.equal((await open()).status, 201);
});

test('personagem de fora não abre a sessão', async () => {
  const other = (await api('POST', '/api/characters', { name: 'Bo', race: 'Anão', class: 'Guerreiro' })).body;
  const res = await api('POST', `/api/campaigns/${ctx.campaign.id}/session`, { character_id: other.id });
  assert.equal(res.status, 400);
  assert.equal(llm.calls.length, 0);
});

test('recarregar durante o jogo não gera resumo; depois de 1 hora, gera', async () => {
  await open();
  await say('Falo com o ferreiro');
  assert.equal((await state()).session.status, 'active');
  assert.equal((await open()).status, 409);

  await age(0.5);
  assert.equal((await state()).session.status, 'active', 'meia hora ainda é a mesma sessão');
  await age(2);
  assert.equal((await state()).session.status, 'returning');
});

test('o resumo cobre a última sessão, não as anteriores', async () => {
  await open();
  await say('Primeira sessão: encontro o dragão');
  await age(2);
  await open();
  await say('Segunda sessão: compro uma espada');
  await age(2);

  llm.responder = () => turn({ narration: 'Na última sessão, você comprou uma espada.' });
  const { status, body } = await open();
  assert.equal(status, 201);
  assert.equal(body.narration, 'Na última sessão, você comprou uma espada.');

  const directive = lastPrompt();
  const transcript = directive.slice(directive.indexOf('TRANSCRIÇÃO'));
  assert.match(transcript, /Segunda sessão: compro uma espada/);
  assert.doesNotMatch(transcript, /Primeira sessão/);

  const markers = (await messages()).filter((m) => m.session).map((m) => m.session);
  assert.deepEqual(markers, [{ kind: 'intro', number: 1 }, { kind: 'recap', number: 2 }, { kind: 'recap', number: 3 }]);
});

test('o resumo não altera o jogo, mesmo se o modelo tentar', async () => {
  await open();
  await say('Sigo em frente');
  await age(2);
  const hpBefore = (await state()).party[0].current_hp;
  llm.responder = () => turn({
    narration: 'Na última sessão...',
    gm_rolls: [{ label: 'x', dice: '1d20' }],
    rule_queries: ['ogro'],
    state_changes: [{ character_id: ctx.character.id, hp_delta: -5, inventory_add: ['Ouro'] }],
    memory_updates: [{ type: 'fact', name: 'Inventado', content: 'x', importance: 5, status: 'active' }],
    illustrations: [{ kind: 'npc', name: 'Falso', description: 'x', image_prompt_en: 'x' }],
  });
  const before = llm.calls.length;
  const { body } = await open();

  assert.equal(llm.calls.length - before, 1, 'uma chamada só, sem rodadas de consulta');
  assert.equal(body.party[0].current_hp, hpBefore);
  assert.deepEqual(body.party[0].inventory, []);
  assert.deepEqual(body.memory_changes, []);
  assert.deepEqual(body.illustrations, []);
  assert.deepEqual(body.rolls.length, 0);
  assert.equal((await api('GET', `/api/campaigns/${ctx.campaign.id}/memories`)).body.length, 0);
  assert.equal((await api('GET', `/api/campaigns/${ctx.campaign.id}/visuals`)).body.length, 0);
});

test('encerrar a sessão pede resumo na hora, e o jogo continua depois', async () => {
  const end = () => api('POST', `/api/campaigns/${ctx.campaign.id}/session/end`, {});
  assert.equal((await end()).status, 409, 'campanha que não começou');

  await open();
  await say('Abro a porta');
  const ended = await end();
  assert.equal(ended.status, 200);
  assert.equal(ended.body.session.status, 'returning');

  assert.equal((await open()).status, 201);
  assert.equal((await state()).session.status, 'active');
  await say('Entro na sala');
  assert.equal((await state()).session.status, 'active');
});

test('campanha antiga, sem sessões registradas, também recebe resumo', async () => {
  await say('Conversa de antes da mudança');
  assert.equal((await state()).session.status, 'active');
  await age(3);
  assert.equal((await state()).session.status, 'returning');
  await open();
  assert.match(lastPrompt(), /Conversa de antes da mudança/);

  const fresh = (await api('POST', '/api/campaigns', { name: 'Outra' })).body;
  await api('POST', '/api/campaigns/join', { campaign_id: fresh.id, character_id: ctx.character.id });
  ctx = { ...ctx, campaign: fresh };
  await say('Sem abertura');
  const end = await api('POST', `/api/campaigns/${fresh.id}/session/end`, {});
  assert.equal(end.body.session.status, 'returning');
});

test('se a última sessão só teve o resumo, usa o que foi jogado antes', async () => {
  await open();
  await say('Encontro o tesouro');
  await age(2);
  await open();
  await age(2);
  await open();
  assert.match(lastPrompt(), /Encontro o tesouro/);
});

test('o resumo não entra na crônica', async () => {
  await open();
  await say('Sigo');
  await age(2);
  llm.responder = () => turn({ narration: 'RESUMO-MARCADOR' });
  await open();
  llm.responder = (prompt) => prompt.schema.properties.summary
    ? { data: { summary: 'Crônica.', memory_updates: [] }, usage, model: 'fake' }
    : turn();
  for (let i = 0; i < 25; i += 1) {
    await say(`Ação ${i}`);
    await app.locals.gameMaster.waitForBackground();
  }
  const summaries = llm.calls.filter((call) => call.schema.properties.summary);
  assert.ok(summaries.length > 0);
  assert.ok(!summaries.some((call) => JSON.stringify(call.contents).includes('RESUMO-MARCADOR')));
});

test('o Mestre orienta o jogador, mas não oferece opções de ação', async () => {
  await open();
  assert.doesNotMatch(lastPrompt(), /sugest/i, 'introdução');
  assert.match(lastPrompt(), /sem listar opções de ação/);

  await say('Oi');
  const { system } = llm.calls.at(-1);
  assert.match(system, /ORIENTE SEMPRE O JOGADOR/);
  assert.match(system, /Nunca ofereça uma lista/);
  assert.doesNotMatch(system, /sugira 2 ou 3/);

  await age(2);
  await open();
  assert.doesNotMatch(lastPrompt(), /sugest/i, 'resumo');
});
