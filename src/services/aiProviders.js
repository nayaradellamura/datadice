import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { HttpError } from '../middleware/errorHandler.js';

/**
 * Outras IAs além do Gemini, com a chave de API do próprio jogador (BYOK). Todas seguem a mesma
 * interface do cliente do Gemini: { check, listModels, generateJson({ system, contents, schema }) },
 * que devolve { data, usage: { prompt, completion, total }, model }.
 * O texto vem no formato do Gemini (contents com role user/model e parts); aqui ele é traduzido.
 */

export const PROVIDERS = {
  gemini: { label: 'Gemini' },
  openai: { label: 'ChatGPT (OpenAI)', defaultModel: 'gpt-5.4-mini' },
  anthropic: {
    label: 'Claude (Anthropic)',
    defaultModel: 'claude-opus-5-5',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  },
  // Reúne vários modelos (alguns grátis). Não tem padrão: o jogador escolhe na lista.
  openrouter: { label: 'OpenRouter', defaultModel: null },
};

export const isProvider = (value) => Object.hasOwn(PROVIDERS, value);
const MODEL_PATTERN = /^[\w.:/@-]{1,120}$/;
export const cleanModel = (value) => (typeof value === 'string' && MODEL_PATTERN.test(value.trim()) ? value.trim() : null);

const TIMEOUT_MS = 120_000;
const MAX_TOKENS = 16000;

// ---------------- Formato das mensagens ----------------

const isPdf = (part) => part?.inlineData?.mimeType === 'application/pdf';

function toAnthropicMessages(contents) {
  return contents.map((turn) => ({
    role: turn.role === 'model' ? 'assistant' : 'user',
    content: (turn.parts ?? []).map((part) => (isPdf(part)
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: part.inlineData.data } }
      : { type: 'text', text: String(part.text ?? '') })),
  }));
}

function toOpenAiMessages(system, contents) {
  return [
    { role: 'system', content: system },
    ...contents.map((turn) => {
      const parts = turn.parts ?? [];
      const role = turn.role === 'model' ? 'assistant' : 'user';
      if (role === 'assistant' || !parts.some(isPdf)) return { role, content: parts.map((part) => String(part.text ?? '')).join('\n') };
      return {
        role,
        content: parts.map((part) => (isPdf(part)
          ? { type: 'file', file: { filename: 'ficha.pdf', file_data: `data:application/pdf;base64,${part.inlineData.data}` } }
          : { type: 'text', text: String(part.text ?? '') })),
      };
    }),
  ];
}

/**
 * O Claude exige additionalProperties: false em todo objeto e não aceita limites numéricos nem de tamanho.
 * Os limites continuam valendo: quem usa a resposta já confere os valores.
 */
export function strictSchema(schema) {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern'].includes(key)) continue;
    if (key === 'properties') out.properties = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, strictSchema(sub)]));
    else out[key] = strictSchema(value);
  }
  const types = [].concat(schema.type ?? []);
  if (types.includes('object')) out.additionalProperties = false;
  return out;
}

/** Lê o JSON da resposta, mesmo que o modelo tenha colocado texto ou ```json em volta. */
export function parseJsonText(text) {
  const source = String(text ?? '').trim();
  try {
    return JSON.parse(source);
  } catch {
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1));
    throw new Error('sem JSON');
  }
}

function incomplete(usage, model) {
  const failure = new HttpError(502, 'O Mestre devolveu uma resposta incompleta. Tente de novo.');
  failure.usage = usage;
  failure.model = model;
  return failure;
}

// ---------------- Erros, em português ----------------

function friendlyError(err, { label, model }) {
  const status = err?.status;
  const text = String(err?.message ?? '');
  if (status === 401) return new HttpError(401, `Sua chave do ${label} foi recusada. Confira a chave em Configurações (ícone de engrenagem).`, 'gemini_key');
  if (/credit balance|insufficient_quota|billing|payment|402/i.test(text) || status === 402) {
    return new HttpError(402, `Sua conta do ${label} está sem créditos. A chave de API é cobrada à parte da assinatura do app: adicione créditos no site da ${label.includes('OpenAI') ? 'OpenAI' : label.includes('Claude') ? 'Anthropic' : 'OpenRouter'} ou use a chave do Gemini, que é grátis.`, 'ai_credits');
  }
  if (status === 403) return new HttpError(403, `Sua chave do ${label} não tem permissão para usar o modelo ${model}. Escolha outro modelo em Configurações.`, 'gemini_key');
  if (status === 404) return new HttpError(404, `O modelo "${model}" não está disponível para a sua chave do ${label}. Escolha outro em Configurações.`, 'gemini_key');
  if (status === 429) return new HttpError(429, `Sua chave do ${label} atingiu o limite de pedidos. Espere cerca de 1 minuto e envie de novo; sua mensagem não foi perdida.`, 'quota_minute');
  if (status === 529 || status === 503 || status >= 500) {
    return new HttpError(503, `Os servidores do ${label} estão sobrecarregados agora. Aguarde um pouco e envie de novo.`, 'gemini_busy');
  }
  if (err instanceof Anthropic.APIConnectionError || err instanceof OpenAI.APIConnectionError) {
    return new HttpError(503, `Não consegui falar com o ${label} agora. Tente de novo em instantes.`, 'gemini_busy');
  }
  return new HttpError(502, `Falha ao chamar o ${label}: ${text.slice(0, 300) || 'erro desconhecido'}`);
}

const keyMissing = (label) => new HttpError(401, `Configure sua chave do ${label} em Configurações.`, 'gemini_key');

async function withTimeout(promise) {
  return Promise.race([promise, new Promise((_, reject) => {
    setTimeout(() => reject(new Error('sem resposta em 15 segundos')), 15000).unref();
  })]);
}

// ---------------- Claude (Anthropic) ----------------

// Modelos com troca automática para outro modelo Claude quando a resposta é recusada pelos filtros de segurança.
const WITH_FALLBACK = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

export function createAnthropicClient({ apiKey, model = PROVIDERS.anthropic.defaultModel, client }) {
  const label = PROVIDERS.anthropic.label;
  const ai = client ?? (apiKey ? new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 2 }) : null);

  return {
    async check() {
      if (!ai) return { ok: false, message: keyMissing(label).message };
      try {
        await withTimeout(ai.models.retrieve(model));
        return { ok: true, message: `Chave válida e modelo ${model} disponível.` };
      } catch (err) {
        return { ok: false, message: friendlyError(err, { label, model }).message };
      }
    },

    async listModels() {
      return PROVIDERS.anthropic.models.map((id) => ({ id }));
    },

    async generateJson({ system, contents, schema }) {
      if (!ai) throw keyMissing(label);
      const request = {
        model,
        max_tokens: MAX_TOKENS,
        system,
        messages: toAnthropicMessages(contents),
        // Conversa de jogo: resposta rápida vale mais que raciocínio longo.
        output_config: { effort: 'low', format: { type: 'json_schema', schema: strictSchema(schema) } },
      };
      let response;
      try {
        response = WITH_FALLBACK.has(model)
          ? await ai.beta.messages.create({ ...request, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
          : await ai.messages.create(request);
      } catch (err) {
        throw friendlyError(err, { label, model });
      }
      const input = (response.usage?.input_tokens ?? 0) + (response.usage?.cache_read_input_tokens ?? 0) + (response.usage?.cache_creation_input_tokens ?? 0);
      const output = response.usage?.output_tokens ?? 0;
      const usage = { prompt: input, completion: output, total: input + output };
      const used = response.model ?? model;
      if (response.stop_reason === 'refusal') {
        const failure = new HttpError(502, 'O Claude se recusou a continuar esta cena. Tente reformular a ação.');
        failure.usage = usage;
        failure.model = used;
        throw failure;
      }
      const text = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
      try {
        return { data: JSON.parse(text), usage, model: used };
      } catch {
        throw incomplete(usage, used);
      }
    },
  };
}

// ---------------- ChatGPT (OpenAI) e OpenRouter ----------------

const OPENROUTER_URL = 'https://openrouter.ai/api/v1';

export function createOpenAiClient({ apiKey, model, provider = 'openai', client }) {
  const { label, defaultModel } = PROVIDERS[provider];
  const chosen = model ?? defaultModel;
  const router = provider === 'openrouter';
  const ai = client ?? (apiKey ? new OpenAI({
    apiKey,
    timeout: TIMEOUT_MS,
    maxRetries: 2,
    ...(router ? { baseURL: OPENROUTER_URL, defaultHeaders: { 'X-Title': 'DataDice' } } : {}),
  }) : null);

  async function listModels() {
    const ids = [];
    for await (const item of ai.models.list()) ids.push(item.id);
    if (router) {
      // Os grátis primeiro.
      return ids.sort((a, b) => Number(b.endsWith(':free')) - Number(a.endsWith(':free')) || a.localeCompare(b))
        .map((id) => ({ id, free: id.endsWith(':free') }));
    }
    // Só os modelos de conversa (tira voz, imagem, embeddings...).
    return ids.filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/audio|realtime|transcribe|tts|image|search|embedding/.test(id))
      .sort().map((id) => ({ id }));
  }

  return {
    async check() {
      if (!ai) return { ok: false, message: keyMissing(label).message };
      if (!chosen) return { ok: false, message: 'Escolha um modelo da lista para usar o OpenRouter.' };
      try {
        if (router) {
          const models = await withTimeout(listModels());
          if (!models.some((item) => item.id === chosen)) return { ok: false, message: `O modelo "${chosen}" não existe no OpenRouter. Escolha outro da lista.` };
          // A lista de modelos é pública; a chave só é conferida numa chamada de verdade.
          await withTimeout(ai.chat.completions.create({ model: chosen, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }));
        } else {
          await withTimeout(ai.models.retrieve(chosen));
        }
        return { ok: true, message: `Chave válida e modelo ${chosen} disponível.` };
      } catch (err) {
        return { ok: false, message: friendlyError(err, { label, model: chosen }).message };
      }
    },

    async listModels() {
      if (!ai) throw keyMissing(label);
      try {
        return await listModels();
      } catch (err) {
        throw friendlyError(err, { label, model: chosen });
      }
    },

    async generateJson({ system, contents, schema }) {
      if (!ai) throw keyMissing(label);
      if (!chosen) throw new HttpError(400, 'Escolha um modelo do OpenRouter em Configurações.', 'gemini_key');
      // No OpenRouter, muitos modelos não aceitam formato obrigatório: o formato vai nas instruções.
      const instructions = router
        ? `${system}\n\nResponda somente com um objeto JSON válido, sem texto antes ou depois, seguindo este JSON Schema:\n${JSON.stringify(schema)}`
        : system;
      let response;
      try {
        response = await ai.chat.completions.create({
          model: chosen,
          messages: toOpenAiMessages(instructions, contents),
          ...(router ? {} : { response_format: { type: 'json_schema', json_schema: { name: 'resposta', schema, strict: false } } }),
        });
      } catch (err) {
        throw friendlyError(err, { label, model: chosen });
      }
      const usage = {
        prompt: response.usage?.prompt_tokens ?? 0,
        completion: response.usage?.completion_tokens ?? 0,
        total: response.usage?.total_tokens ?? (response.usage?.prompt_tokens ?? 0) + (response.usage?.completion_tokens ?? 0),
      };
      const used = response.model ?? chosen;
      try {
        return { data: parseJsonText(response.choices?.[0]?.message?.content), usage, model: used };
      } catch {
        throw incomplete(usage, used);
      }
    },
  };
}
