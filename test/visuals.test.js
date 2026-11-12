import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createApp } from '../src/app.js';
import { freshDb } from './db.js';
import { HttpError } from '../src/middleware/errorHandler.js';
import { addUser, authHeaders, SECRET } from './helpers.js';

const usage = { prompt: 10, completion: 5, total: 15 };
const ogre = { kind: 'monster', name: 'Ogro', description: 'Um ogro cinzento.', image_prompt_en: 'gray ogre with a club' };
const forge = { kind: 'location', name: 'Forja de Rurik', description: 'Uma forja antiga.', image_prompt_en: 'old forge at night' };

let db, server, base, app, llm, images, errors, user;

const turn = (illustrations = [], overrides = {}) => ({
  data: { narration: 'A cena continua.', state_changes: [], memory_updates: [], illustrations, ...overrides },
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

async function setup(name = 'Vale') {
  const character = (await api('POST', '/api/characters', { name: 'Lia', race: 'Elfo', class: 'Mago' })).body;
  const campaign = (await api('POST', '/api/campaigns', { name })).body;
  await api('POST', '/api/campaigns/join', { campaign_id: campaign.id, character_id: character.id });
  return { character, campaign };
}

const say = (ctx, message = 'Sigo') =>
  api('POST', '/api/chat', { campaign_id: ctx.campaign.id, character_id: ctx.character.id, message, enable_image_gen: true });
const idle = () => app.locals.visuals.waitForIdle();

beforeEach(async () => {
  errors = [];
  llm = { calls: [], responder: () => turn(), async generateJson(prompt) { this.calls.push(prompt); return this.responder(prompt); } };
  images = {
    calls: [],
    respond: async (call) => `/images/${call.options.filePrefix}_${images.calls.length}.png`,
    async generate(prompt, options) {
      const call = { prompt, options };
      this.calls.push(call);
      return this.respond(call);
    },
  };
  db = await freshDb();
  user = await addUser(db);
  app = createApp({ db, llm, images, jwtSecret: SECRET, onBackgroundError: (err) => errors.push(err) });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await idle();
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

test('cena comum não gera imagem', async () => {
  const ctx = await setup();
  const { body } = await say(ctx);
  assert.deepEqual(body.illustrations, []);
  await idle();
  assert.equal(images.calls.length, 0);
  assert.deepEqual((await api('GET', `/api/campaigns/${ctx.campaign.id}/visuals`)).body, []);
});

test('elemento novo: a resposta não espera a imagem, que fica pronta depois', async () => {
  const ctx = await setup();
  let finish;
  images.respond = () => new Promise((resolve) => { finish = resolve; });
  llm.responder = () => turn([ogre]);

  const { status, body } = await say(ctx);
  assert.equal(status, 200, 'o chat responde com a geração ainda em andamento');
  assert.equal(body.illustrations[0].image_status, 'pending');
  assert.equal(body.illustrations[0].image_url, null);

  await new Promise((resolve) => setImmediate(resolve));
  finish('/images/monstro_1.png');
  await idle();

  const [saved] = (await api('GET', `/api/campaigns/${ctx.campaign.id}/visuals`)).body;
  assert.equal(saved.image_status, 'ready');
  assert.equal(saved.image_url, '/images/monstro_1.png');
  assert.equal(saved.name, 'Ogro');
});

test('o prompt em inglês leva o estilo e o formato de cada tipo', async () => {
  const ctx = await setup();
  llm.responder = () => turn([ogre, forge, { kind: 'npc', name: 'Rurik', description: 'Ferreiro.', image_prompt_en: 'one-eyed blacksmith' }]);
  await say(ctx);
  await idle();
  // As três imagens são geradas ao mesmo tempo; a ordem em que começam não importa.
  const byPrefix = (prefix) => images.calls.find((call) => call.options.filePrefix === prefix);
  const [monster, location, npc] = [byPrefix('monstro'), byPrefix('local'), byPrefix('npc')];

  assert.match(monster.prompt, /creature illustration.*gray ogre with a club/);
  assert.deepEqual([monster.options.aspectRatio, monster.options.filePrefix], ['2:3', 'monstro']);
  assert.match(location.prompt, /environment concept art.*old forge at night/);
  assert.deepEqual([location.options.aspectRatio, location.options.filePrefix], ['3:2', 'local']);
  assert.match(npc.prompt, /character portrait.*one-eyed blacksmith/);
  assert.equal(npc.options.filePrefix, 'npc');
});

test('elemento que já existe reutiliza a imagem, mesmo com acento e maiúscula diferentes', async () => {
  const ctx = await setup();
  llm.responder = () => turn([{ ...forge, name: 'Forja de Rúrik' }]);
  await say(ctx);
  await idle();

  llm.responder = () => turn([{ ...forge, name: ' forja DE rurik ', description: 'Outro texto.' }]);
  const { body } = await say(ctx);
  await idle();

  assert.equal(images.calls.length, 1, 'não gera de novo');
  assert.equal(body.illustrations[0].image_status, 'ready');
  assert.match(body.illustrations[0].image_url, /^\/images\/local_1\.png$/);
  assert.equal(body.illustrations[0].description, 'Uma forja antiga.');
  assert.equal((await api('GET', `/api/campaigns/${ctx.campaign.id}/visuals`)).body.length, 1);
});

test('o mesmo nome em tipos diferentes e em outra campanha gera imagens separadas', async () => {
  const first = await setup('A');
  const second = await setup('B');
  llm.responder = () => turn([ogre, { ...ogre, kind: 'npc' }]);
  await say(first);
  llm.responder = () => turn([ogre]);
  await say(second);
  await idle();
  assert.equal(images.calls.length, 3);
  assert.equal((await api('GET', `/api/campaigns/${first.campaign.id}/visuals`)).body.length, 2);
  assert.equal((await api('GET', `/api/campaigns/${second.campaign.id}/visuals`)).body.length, 1);
});

test('as imagens ficam ligadas à mensagem e voltam ao recarregar', async () => {
  const ctx = await setup();
  llm.responder = () => turn([ogre]);
  await say(ctx);
  llm.responder = () => turn();
  await say(ctx);
  await idle();
  const messages = (await api('GET', `/api/campaigns/${ctx.campaign.id}/messages`)).body;
  assert.deepEqual(messages.map((m) => m.illustrations.length), [0, 1, 0, 0]);
  assert.equal(messages[1].illustrations[0].image_status, 'ready');
  assert.equal(messages[1].illustrations[0].image_prompt, undefined);
});

test('limite de 3 por turno, entradas inválidas ignoradas e sem duplicar na mesma mensagem', async () => {
  const ctx = await setup();
  llm.responder = () =>
    turn([
      null, { kind: 'alien', name: 'X', image_prompt_en: 'y' }, { kind: 'constructor', name: 'X', image_prompt_en: 'y' },
      { kind: 'npc', name: '  ', image_prompt_en: 'y' }, { kind: 'npc', name: 'Sem prompt' },
      ogre, ogre, forge,
      { kind: 'npc', name: 'A', image_prompt_en: 'a' }, { kind: 'npc', name: 'B', image_prompt_en: 'b' },
    ]);
  const { status, body } = await say(ctx);
  assert.equal(status, 200);
  assert.deepEqual(body.illustrations.map((v) => v.name), ['Ogro', 'Forja de Rurik', 'A']);
  await idle();
  assert.equal(images.calls.length, 3);
});

test('sem prompt em inglês, usa a descrição', async () => {
  const ctx = await setup();
  llm.responder = () => turn([{ kind: 'npc', name: 'Mira', description: 'Moça de capa vermelha.' }]);
  await say(ctx);
  await idle();
  assert.match(images.calls[0].prompt, /Moça de capa vermelha/);
});

test('as imagens do turno são geradas juntas, e esperar termina só quando todas acabam', async () => {
  const ctx = await setup();
  let active = 0;
  let peak = 0;
  images.respond = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return '/images/x.png';
  };
  llm.responder = () => turn([ogre, forge]);
  await say(ctx);
  await idle();
  assert.equal(peak, 2, 'no Gemini não há placa de vídeo para disputar');
  assert.equal(images.calls.length, 2);
  assert.equal((await db.get(`SELECT image_status FROM monsters`)).image_status, 'ready');
});

test('ilustrações desligadas: o Mestre nem é instruído a pedir, e nada é gerado', async () => {
  const ctx = await setup();
  llm.responder = () => turn([ogre]);
  const { body } = await api('POST', '/api/chat', { campaign_id: ctx.campaign.id, character_id: ctx.character.id, message: 'Olho em volta', enable_image_gen: false });
  await idle();
  assert.deepEqual(body.illustrations, []);
  assert.equal(images.calls.length, 0);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM monsters')).n, 0);
  const prompt = llm.calls.at(-1);
  assert.ok(!prompt.system.includes('ILLUSTRATIONS'), 'sem as instruções de imagem');
  assert.ok(prompt.system.includes('MEMORY_UPDATES'), 'o resto das regras continua');
  assert.ok(!('illustrations' in prompt.schema.properties));
});

test('o motivo da falha fica salvo para o jogador ler, e some ao tentar de novo', async () => {
  const ctx = await setup();
  images.respond = async () => { throw new HttpError(402, 'Imagem não gerada: plano gratuito.', 'billing'); };
  llm.responder = () => turn([ogre]);
  await say(ctx);
  await idle();
  let [visual] = (await api('GET', `/api/campaigns/${ctx.campaign.id}/visuals`)).body;
  assert.equal(visual.image_status, 'failed');
  assert.equal(visual.image_error, 'Imagem não gerada: plano gratuito.');

  images.respond = async () => { throw new Error('detalhe interno com caminho C:\\segredo'); };
  await api('POST', `/api/visuals/monster/${visual.id}/retry`, {});
  await idle();
  [visual] = (await api('GET', `/api/campaigns/${ctx.campaign.id}/visuals`)).body;
  assert.equal(visual.image_error, 'Não foi possível gerar a imagem. Tente de novo.', 'erro interno não vaza para a tela');
});

test('falha na imagem não atrapalha o jogo; dá para tentar de novo', async () => {
  const ctx = await setup();
  images.respond = async () => { throw new Error('WebUI fechado'); };
  llm.responder = () => turn([ogre, forge]);
  const { status } = await say(ctx);
  assert.equal(status, 200);
  await idle();

  let saved = (await api('GET', `/api/campaigns/${ctx.campaign.id}/visuals`)).body;
  assert.deepEqual(saved.map((v) => v.image_status), ['failed', 'failed']);
  assert.equal(errors.length, 2, 'uma falha não impede a seguinte');

  images.respond = async () => '/images/certo.png';
  const target = saved.find((v) => v.kind === 'monster');
  const retry = await api('POST', `/api/visuals/monster/${target.id}/retry`);
  assert.equal(retry.status, 202);
  assert.equal(retry.body.image_status, 'pending');
  await idle();

  saved = (await api('GET', `/api/campaigns/${ctx.campaign.id}/visuals`)).body;
  assert.equal(saved.find((v) => v.kind === 'monster').image_url, '/images/certo.png');
  assert.equal(saved.find((v) => v.kind === 'location').image_status, 'failed');
  assert.equal((await api('POST', `/api/visuals/monster/${target.id}/retry`)).status, 409);
  assert.equal((await api('POST', '/api/visuals/monster/999/retry')).status, 404);
  assert.equal((await api('POST', '/api/visuals/constructor/1/retry')).status, 400);
});

test('imagem que falhou tenta de novo quando o elemento volta à cena', async () => {
  const ctx = await setup();
  images.respond = async () => { throw new Error('fora do ar'); };
  llm.responder = () => turn([ogre]);
  await say(ctx);
  await idle();
  images.respond = async () => '/images/ogro.png';
  const { body } = await say(ctx);
  assert.equal(body.illustrations[0].image_status, 'pending');
  await idle();
  assert.equal(images.calls.length, 2);
});

test('pedidos em rodadas de consulta são ignorados; vale só a resposta final', async () => {
  const ctx = await setup();
  let round = 0;
  llm.responder = () => {
    round += 1;
    return round === 1 ? turn([ogre], { narration: '', gm_rolls: [{ label: 'Teste', dice: '1d20' }] }) : turn([forge]);
  };
  const { body } = await say(ctx);
  assert.deepEqual(body.illustrations.map((v) => v.name), ['Forja de Rurik']);
});

test('falha do Mestre não cria imagem', async () => {
  const ctx = await setup();
  llm.responder = () => turn([ogre], { narration: '' });
  assert.equal((await say(ctx)).status, 502);
  await idle();
  assert.equal(images.calls.length, 0);
  assert.deepEqual((await api('GET', `/api/campaigns/${ctx.campaign.id}/visuals`)).body, []);
});

test('o Mestre recebe a lista do que já tem imagem', async () => {
  const ctx = await setup();
  llm.responder = () => turn([ogre]);
  await say(ctx);
  await idle();
  llm.responder = () => turn();
  await say(ctx);
  assert.match(llm.calls.at(-1).system, /JÁ ILUSTRADOS[^\n]*\nmonster: Ogro/);
});

test('ao reiniciar, o que ficou pela metade vira "tentar de novo" (a chave de quem pediu não fica guardada)', async () => {
  const ctx = await setup();
  (await db.run(`INSERT INTO npcs (campaign_id, name, name_key, image_prompt) VALUES (?, 'Mira', 'mira', 'girl in red cape')`, ctx.campaign.id));
  await app.locals.visuals.failInterrupted();
  await idle();
  assert.equal(images.calls.length, 0);
  const row = (await db.get('SELECT image_status, image_error FROM npcs'));
  assert.equal(row.image_status, 'failed');
  assert.match(row.image_error, /servidor reiniciou/);
});
