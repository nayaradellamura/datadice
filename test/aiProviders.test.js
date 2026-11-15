import assert from 'node:assert/strict';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient, createOpenAiClient, parseJsonText, strictSchema } from '../src/services/aiProviders.js';
import { TURN_SCHEMA } from '../src/services/promptBuilder.js';

// Outras IAs com a chave do jogador: o formato do Gemini é traduzido e a resposta volta igual.

const contents = [
  { role: 'user', parts: [{ text: 'Olá' }] },
  { role: 'model', parts: [{ text: '{"narration":"Oi"}' }] },
  { role: 'user', parts: [{ inlineData: { mimeType: 'application/pdf', data: 'QUJD' } }, { text: 'Leia a ficha' }] },
];

test('Claude: traduz mensagens e PDF, usa formato JSON, troca automática e esforço baixo', async () => {
  let sent;
  const reply = { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"narration":"A porta range."}' }], usage: { input_tokens: 100, output_tokens: 20 } };
  const client = { beta: { messages: { create: async (body) => { sent = body; return reply; } } }, messages: { create: async () => assert.fail('devia usar o beta') } };
  const result = await createAnthropicClient({ client }).generateJson({ system: 'Mestre', contents, schema: TURN_SCHEMA });
  assert.deepEqual(result, { data: { narration: 'A porta range.' }, usage: { prompt: 100, completion: 20, total: 120 }, model: 'claude-opus-5-5' });
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.equal(sent.system, 'Mestre');
  assert.deepEqual(sent.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(sent.fallbacks, 'default');
  assert.equal(sent.output_config.effort, 'low');
  assert.deepEqual(sent.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.deepEqual(sent.messages[2].content[0], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'QUJD' } });
  // Todo objeto fechado e sem limites numéricos.
  const schema = sent.output_config.format.schema;
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.memory_updates.items.additionalProperties, false);
  assert.equal(schema.properties.memory_updates.items.properties.importance.minimum, undefined);
  assert.equal(schema.properties.state_changes.items.properties.coins_delta.additionalProperties, false);
});

test('Claude Haiku vai sem troca automática; recusa e chave inválida viram mensagens claras', async () => {
  let plain = false;
  const client = { messages: { create: async () => { plain = true; return { stop_reason: 'refusal', content: [], usage: { input_tokens: 5, output_tokens: 0 } }; } } };
  await assert.rejects(createAnthropicClient({ client, model: 'claude-haiku-5-5' }).generateJson({ system: 's', contents, schema: { type: 'object' } }), /recusou/);
  assert.ok(plain);

  const denied = { messages: { create: async () => { throw new Anthropic.AuthenticationError(401, { error: {} }, 'invalid x-api-key', new Headers()); } } };
  await assert.rejects(
    createAnthropicClient({ client: denied, model: 'claude-haiku-5-5' }).generateJson({ system: 's', contents, schema: { type: 'object' } }),
    (err) => err.status === 401 && err.code === 'gemini_key' && /Claude/.test(err.message),
  );
  const broke = { messages: { create: async () => { const err = new Error('Your credit balance is too low to access the Anthropic API.'); err.status = 400; throw err; } } };
  await assert.rejects(
    createAnthropicClient({ client: broke, model: 'claude-haiku-5-5' }).generateJson({ system: 's', contents, schema: { type: 'object' } }),
    (err) => err.code === 'ai_credits' && /sem créditos/.test(err.message),
  );
});

test('ChatGPT: mensagem de sistema, PDF como arquivo e formato JSON', async () => {
  let sent;
  const client = { chat: { completions: { create: async (body) => { sent = body; return { model: 'gpt-5.4-mini', choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } }; } } } };
  const result = await createOpenAiClient({ client }).generateJson({ system: 'Mestre', contents, schema: { type: 'object' } });
  assert.deepEqual(result, { data: { ok: true }, usage: { prompt: 50, completion: 5, total: 55 }, model: 'gpt-5.4-mini' });
  assert.equal(sent.model, 'gpt-5.4-mini');
  assert.deepEqual(sent.messages[0], { role: 'system', content: 'Mestre' });
  assert.deepEqual(sent.messages[2], { role: 'assistant', content: '{"narration":"Oi"}' });
  assert.equal(sent.messages[3].content[0].type, 'file');
  assert.equal(sent.response_format.type, 'json_schema');
});

test('OpenRouter: exige modelo, manda o formato nas instruções e aceita JSON com texto em volta', async () => {
  await assert.rejects(createOpenAiClient({ provider: 'openrouter', client: {} }).generateJson({ system: 's', contents, schema: { type: 'object' } }), /Escolha um modelo/);
  let sent;
  const client = { chat: { completions: { create: async (body) => { sent = body; return { choices: [{ message: { content: 'Claro!\n```json\n{"a":1}\n```' } }], usage: {} }; } } } };
  const result = await createOpenAiClient({ provider: 'openrouter', model: 'algum/modelo:free', client }).generateJson({ system: 's', contents, schema: { type: 'object' } });
  assert.deepEqual(result.data, { a: 1 });
  assert.equal(sent.response_format, undefined);
  assert.match(sent.messages[0].content, /JSON Schema/);
});

test('utilitários', () => {
  assert.deepEqual(parseJsonText(' {"x": 2} '), { x: 2 });
  assert.throws(() => parseJsonText('nada'));
  assert.deepEqual(strictSchema({ type: ['integer', 'null'], minimum: 0 }), { type: ['integer', 'null'] });
});

test('rotas: escolhe a IA pelos headers e explica o que falta', async () => {
  const { createApp } = await import('../src/app.js');
  const { freshDb } = await import('./db.js');
  const { addUser, SECRET } = await import('./helpers.js');
  const db = await freshDb();
  const app = createApp({ db, jwtSecret: SECRET });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ana = await addUser(db, { name: 'Ana' });
    const post = (path, headers) => fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${ana.token}`, 'content-type': 'application/json', ...headers }, body: '{}' })
      .then(async (res) => ({ status: res.status, body: await res.json() }));
    const noKey = await post('/api/config/test-key', { 'x-ai-provider': 'openai' });
    assert.equal(noKey.status, 401);
    assert.match(noKey.body.error, /ChatGPT/);
    const badKey = await post('/api/config/test-key', { 'x-ai-provider': 'anthropic', 'x-ai-key': 'chave com espaço' });
    assert.match(badKey.body.error, /Claude/);
    // OpenRouter sem modelo: avisa antes de chamar qualquer serviço.
    const noModel = await post('/api/config/test-key', { 'x-ai-provider': 'openrouter', 'x-ai-key': 'sk-or-v1-chavefalsa0123456789' });
    assert.equal(noModel.status, 400);
    assert.match(noModel.body.message, /Escolha um modelo/);
    // Provedor desconhecido cai no Gemini.
    const unknown = await post('/api/config/test-key', { 'x-ai-provider': 'outra' });
    assert.match(unknown.body.error, /Gemini/);
    // Gerar imagem com outra IA e sem chave do Gemini: explica.
    const image = await fetch(`${base}/api/generate-image`, { method: 'POST', headers: { authorization: `Bearer ${ana.token}`, 'content-type': 'application/json', 'x-ai-provider': 'anthropic', 'x-ai-key': 'sk-ant-chavefalsa0123456789' }, body: JSON.stringify({ prompt: 'um elfo' }) });
    assert.equal(image.status, 400);
    assert.match((await image.json()).error, /chave do Gemini ou da OpenAI/);
  } finally {
    app.locals.tableHub.closeAll();
    server.closeAllConnections?.();
    server.close();
  }
});
