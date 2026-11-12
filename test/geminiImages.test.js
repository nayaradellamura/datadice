import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createApp } from '../src/app.js';
import { freshDb } from './db.js';
import { createGeminiImageClient, DEFAULT_IMAGE_MODEL } from '../src/services/geminiImages.js';
import { addUser, authHeaders, SECRET } from './helpers.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
// Onde o cliente entrega a imagem pronta (no app de verdade, o banco).
let stored;

function fakeGemini(respond) {
  const calls = [];
  return { calls, models: { async generateContent(request) { calls.push(request); return respond(request); } } };
}
const imageResponse = (data = PNG.toString('base64')) => ({
  candidates: [{ content: { parts: [{ text: 'aqui está' }, { inlineData: { mimeType: 'image/png', data } }] } }],
});
const failing = (status, message = 'falha') => fakeGemini(() => { throw Object.assign(new Error(message), { status }); });
const store = async (image) => {
  stored.push(image);
  return `/images/${image.prefix}_1.${image.extension}`;
};
const generate = (client, options) =>
  createGeminiImageClient({ client, store, retryDelays: [0, 0] }).generate('a dwarf paladin', options);

beforeEach(() => { stored = []; });

test('gera a imagem com o modelo de imagem mais barato, no formato pedido, e entrega para guardar', async () => {
  const client = fakeGemini(() => imageResponse());
  const url = await generate(client, { aspectRatio: '3:2', filePrefix: 'local', campaignId: 7 });

  assert.equal(url, '/images/local_1.png');
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].buffer, PNG);
  assert.deepEqual([stored[0].extension, stored[0].prefix, stored[0].campaignId], ['png', 'local', 7]);
  const [request] = client.calls;
  assert.equal(request.model, DEFAULT_IMAGE_MODEL);
  assert.equal(DEFAULT_IMAGE_MODEL, 'gemini-3.1-flash-lite-image');
  assert.deepEqual(request.config, { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '3:2' } });
});

test('chave do plano gratuito: mensagem específica, sem novas tentativas e sem arquivo', async () => {
  const client = failing(429, 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-3.1-flash-lite-image');
  await assert.rejects(generate(client), (err) =>
    err.status === 402 && err.code === 'billing'
    && /plano gratuito/.test(err.message) && /faturamento/.test(err.message) && /desligue "Gerar ilustrações"/.test(err.message));
  assert.equal(client.calls.length, 1);
  assert.deepEqual(stored, []);
});

test('limite diário e por minuto na imagem dizem que foi a imagem que não saiu', async () => {
  const daily = JSON.stringify({ error: { details: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel', quotaValue: '100' }, { retryDelay: '60s' }] } });
  await assert.rejects(generate(failing(429, daily)), (err) => err.code === 'quota_daily' && /^Imagem não gerada\./.test(err.message));
  await assert.rejects(generate(failing(429, 'RESOURCE_EXHAUSTED per minute')), (err) => err.code === 'quota_minute' && /1 minuto/.test(err.message));
});

test('chave recusada pelo Google vira 401 com code gemini_key', async () => {
  await assert.rejects(generate(failing(400, 'API key not valid. Please pass a valid API key. [API_KEY_INVALID]')), (err) =>
    err.status === 401 && err.code === 'gemini_key' && /Configurações/.test(err.message));
});

test('resposta sem imagem (filtro de segurança) e bytes que não são imagem são recusados', async () => {
  const blocked = fakeGemini(() => ({ candidates: [{ content: { parts: [{ text: 'não posso' }] } }] }));
  await assert.rejects(generate(blocked), (err) => err.status === 502 && /outra descrição/.test(err.message));
  const garbage = fakeGemini(() => imageResponse(Buffer.from('<script>alert(1)</script>').toString('base64')));
  await assert.rejects(generate(garbage), (err) => err.status === 502 && /não é uma imagem/.test(err.message));
  assert.deepEqual(stored, []);
});

test('sobrecarga momentânea do Google é repetida sozinha', async () => {
  let attempts = 0;
  const client = fakeGemini(() => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('ocupado'), { status: 503 });
    return imageResponse();
  });
  await generate(client);
  assert.equal(stored.length, 1);
  assert.equal(attempts, 3);
});

test('rota do retrato: usa a chave do jogador, salva na ficha e recusa caminhos fora de /images', async () => {
  const db = await freshDb();
  const images = { calls: [], async generate(prompt, options) { this.calls.push({ prompt, options }); return '/images/retrato_1.png'; } };
  const app = createApp({ db, images, llm: {}, jwtSecret: SECRET });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const user = await addUser(db);
  const post = async (path, body, method = 'POST') => {
    const res = await fetch(base + path, { method, headers: authHeaders(user.token), body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    assert.equal((await post('/api/generate-image', { prompt: '' })).status, 400);
    assert.equal((await post('/api/generate-image', { prompt: 'x'.repeat(2001) })).status, 400);
    assert.equal(images.calls.length, 0);

    const { body: image } = await post('/api/generate-image', { prompt: 'dwarf paladin' });
    assert.deepEqual(images.calls[0].options, { aspectRatio: '2:3', filePrefix: 'retrato' });

    const character = { name: 'Thalia', race: 'Anão da Montanha', class: 'Paladino' };
    const created = await post('/api/characters', { ...character, avatar_url: image.url });
    assert.equal(created.body.avatar_url, image.url);
    for (const avatar_url of ['/images/../../index.js', '/secreto.png', 'javascript:alert(1)']) {
      assert.equal((await post('/api/characters', { ...character, avatar_url })).status, 400, avatar_url);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
