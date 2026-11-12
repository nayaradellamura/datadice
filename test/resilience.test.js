import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGeminiClient } from '../src/services/gemini.js';

function fakeGemini(failures) {
  const calls = [];
  return {
    calls,
    models: {
      async generateContent(request) {
        calls.push(request);
        const failure = failures.shift();
        if (failure) throw Object.assign(new Error('falha'), { status: failure });
        return { text: '{"narration":"ok"}', usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } };
      },
    },
  };
}

test('Gemini sobrecarregado: tenta de novo sozinho e o jogador nem percebe', async () => {
  const client = fakeGemini([503, 429]);
  const gemini = createGeminiClient({ client, retryDelays: [0, 0] });
  const result = await gemini.generateJson({ system: 's', contents: [], schema: {} });
  assert.equal(result.data.narration, 'ok');
  assert.equal(client.calls.length, 3);
});

test('Gemini sobrecarregado demais: desiste após 3 tentativas com mensagem clara', async () => {
  const client = fakeGemini([503, 503, 503, 503]);
  const gemini = createGeminiClient({ client, retryDelays: [0, 0] });
  await assert.rejects(gemini.generateJson({ system: 's', contents: [], schema: {} }), (err) => err.status === 503 && /Google/.test(err.message));
  assert.equal(client.calls.length, 3);
});

test('limite diário: não tenta de novo e diz quando volta', async () => {
  const quotaMessage = JSON.stringify({ error: { details: [
    { quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '20' },
    { retryDelay: '3600s' },
  ] } });
  const calls = [];
  const client = { models: { async generateContent(request) {
    calls.push(request);
    throw Object.assign(new Error(quotaMessage), { status: 429 });
  } } };
  const gemini = createGeminiClient({ client, retryDelays: [0, 0] });
  // Sempre no horário de Brasília, mesmo com o servidor hospedado em outro fuso.
  const expected = new Date(Date.now() + 3600 * 1000)
    .toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  await assert.rejects(gemini.generateJson({ system: 's', contents: [], schema: {} }), (err) =>
    err.status === 429 && err.code === 'quota_daily' && /limite diário do plano gratuito/.test(err.message)
    && /20 pedidos por dia/.test(err.message) && err.message.includes(`${expected} (horário de Brasília)`)
    && /campanha está salva/.test(err.message));
  assert.equal(calls.length, 1, 'uma tentativa só');
});

test('erro de chave ou de pedido não é repetido', async () => {
  const client = fakeGemini([400]);
  const gemini = createGeminiClient({ client, retryDelays: [0, 0] });
  await assert.rejects(gemini.generateJson({ system: 's', contents: [], schema: {} }));
  assert.equal(client.calls.length, 1);
});

test('limite por minuto do plano gratuito é repetido; limite zero (sem plano gratuito) não', async () => {
  let attempts = 0;
  const perMinute = { models: { async generateContent() {
    attempts += 1;
    if (attempts < 2) throw Object.assign(new Error('Quota exceeded for metric: generate_content_free_tier_requests, limit: 15'), { status: 429 });
    return { text: '{"narration":"ok"}', usageMetadata: {} };
  } } };
  const result = await createGeminiClient({ client: perMinute, retryDelays: [0, 0] }).generateJson({ system: 's', contents: [], schema: {} });
  assert.equal(result.data.narration, 'ok');
  assert.equal(attempts, 2);

  const zero = fakeGemini([]);
  zero.models.generateContent = async () => {
    zero.calls.push(1);
    throw Object.assign(new Error('Quota exceeded for metric: generate_content_free_tier_requests, limit: 0'), { status: 429 });
  };
  await assert.rejects(createGeminiClient({ client: zero, retryDelays: [0, 0] }).generateJson({ system: 's', contents: [], schema: {} }));
  assert.equal(zero.calls.length, 1);
});

test('chave recusada pelo Google: 401 com code gemini_key, sem repetir', async () => {
  const client = fakeGemini([]);
  client.models.generateContent = async () => {
    client.calls.push(1);
    throw Object.assign(new Error('API key not valid. Please pass a valid API key. [API_KEY_INVALID]'), { status: 400 });
  };
  await assert.rejects(createGeminiClient({ client, retryDelays: [0, 0] }).generateJson({ system: 's', contents: [], schema: {} }),
    (err) => err.status === 401 && err.code === 'gemini_key' && /recusada/.test(err.message));
  assert.equal(client.calls.length, 1);
});
