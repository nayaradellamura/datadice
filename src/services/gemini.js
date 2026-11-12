import { GoogleGenAI } from '@google/genai';
import { HttpError } from '../middleware/errorHandler.js';

// Modelo estável e barato; o gemini-2.5-flash é desligado em 1º/12/2026 e redirecionado para este.
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

function readUsage(meta = {}) {
  const prompt = meta.promptTokenCount ?? 0;
  const completion = (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0);
  return { prompt, completion, total: meta.totalTokenCount ?? prompt + completion };
}

/** Identifica o limite diário do plano gratuito e quando ele volta, a partir do erro do Google. */
export function dailyQuota(err) {
  const text = String(err?.message ?? '');
  if (err?.status !== 429 || !/PerDay/i.test(text)) return null;
  const limit = Number(/"quotaValue"\s*:\s*"(\d+)"/.exec(text)?.[1]) || null;
  const seconds = Number(/"retryDelay"\s*:\s*"(\d+)(?:\.\d+)?s"/.exec(text)?.[1]);
  const backAt = Number.isFinite(seconds) ? new Date(Date.now() + seconds * 1000) : null;
  return { limit, backAt };
}

const KEY_REJECTED = 'Sua chave do Gemini foi recusada pelo Google. Confira a chave em Configurações (ícone de engrenagem).';

/** Chave inválida, revogada ou de outro projeto. O Google devolve 400 com API_KEY_INVALID. */
const isKeyRejected = (err) =>
  err?.status === 401 || /API_KEY_INVALID|API key not valid|API key expired/i.test(String(err?.message ?? ''));

// O servidor pode estar hospedado em outro fuso; o jogador está no Brasil.
const brasiliaTime = (date) =>
  date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });

/**
 * Mensagens específicas para o jogador: o que aconteceu, quando volta e o que fazer.
 * O code deixa o navegador mostrar o aviso certo (ex.: abrir as Configurações).
 */
export function friendlyError(err, model) {
  if (isKeyRejected(err)) return new HttpError(401, KEY_REJECTED, 'gemini_key');
  const daily = dailyQuota(err);
  if (daily) {
    const when = daily.backAt
      ? `O limite volta por volta das ${brasiliaTime(daily.backAt)} (horário de Brasília).`
      : 'O limite volta todo dia por volta das 5h (horário de Brasília), quando o Google zera a contagem.';
    const limit = daily.limit ? `: ${daily.limit} pedidos por dia` : '';
    return new HttpError(
      429,
      `Sua chave do Gemini atingiu o limite diário do plano gratuito${limit}. Cada mensagem ao Mestre usa um ou mais pedidos. ${when} Sua campanha está salva; é só voltar depois. Para jogar sem esse limite, ative o faturamento da chave no Google AI Studio.`,
      'quota_daily',
    );
  }
  if (err?.status === 429) {
    return new HttpError(
      429,
      'Sua chave do Gemini atingiu o limite de pedidos por minuto do plano gratuito. Espere cerca de 1 minuto e envie de novo; sua mensagem não foi perdida.',
      'quota_minute',
    );
  }
  const messages = {
    400: 'O Gemini recusou a requisição. Tente de novo; se continuar, avise o administrador.',
    403: 'Sua chave do Gemini não tem permissão para usar este modelo. Confira se a chave foi criada no Google AI Studio e se a API Gemini está ativa no projeto dela.',
    404: `O modelo "${model}" não está disponível para a sua chave. Avise o administrador.`,
    503: 'Os servidores do Gemini estão sobrecarregados agora (o problema é do Google, não da sua chave). Tentei 3 vezes; aguarde um pouco e envie de novo.',
  };
  const text = messages[err?.status] ?? `Falha ao chamar o Gemini: ${String(err?.message ?? 'erro desconhecido').slice(0, 300)}`;
  return new HttpError(err?.status === 503 ? 503 : 502, text, err?.status === 503 ? 'gemini_busy' : undefined);
}

/**
 * Cliente do modelo. A interface { generateJson } permite trocar o Gemini
 * por um substituto nos testes.
 */
// Sobrecarga e limite momentâneo costumam passar em segundos; esses erros não consomem tokens.
const RETRYABLE = new Set([429, 500, 503]);
const RETRY_DELAYS_MS = [2000, 6000];

export async function generateWithRetry(ai, request, retryDelays = RETRY_DELAYS_MS) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await ai.models.generateContent(request);
    } catch (err) {
      // O limite diário e a falta de cota não voltam em segundos; tentar de novo só adiaria a resposta.
      if (!RETRYABLE.has(err.status) || dailyQuota(err) || noFreeTier(err) || attempt >= retryDelays.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
    }
  }
}

/**
 * Modelos sem plano gratuito (como os de imagem) respondem 429 com limite zero. Só "free_tier" não
 * basta: o limite por minuto do plano gratuito também cita free_tier e deve ser tentado de novo.
 */
export const noFreeTier = (err) =>
  err?.status === 429 && /limit:\s*0\b|"quotaValue"\s*:\s*"0"/i.test(String(err?.message ?? ''));

export function createGeminiClient({ apiKey, model = DEFAULT_MODEL, client, retryDelays = RETRY_DELAYS_MS }) {
  const ai = client ?? (apiKey ? new GoogleGenAI({ apiKey }) : null);

  return {
    /** Confere a chave e o modelo sem gerar texto, portanto sem consumir tokens. */
    async check() {
      if (!ai) return { ok: false, message: 'Nenhuma chave do Gemini informada.' };
      try {
        await Promise.race([
          ai.models.get({ model }),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('sem resposta em 15 segundos')), 15000).unref();
          }),
        ]);
        return { ok: true, message: `Chave válida e modelo ${model} disponível.` };
      } catch (err) {
        return { ok: false, message: friendlyError(err, model).message };
      }
    },

    async generateJson({ system, contents, schema }) {
      if (!ai) throw new HttpError(401, 'Configure sua chave do Gemini em Configurações.', 'gemini_key');

      let response;
      try {
        response = await generateWithRetry(ai, {
          model,
          contents,
          config: {
            systemInstruction: system,
            responseMimeType: 'application/json',
            responseJsonSchema: schema,
          },
        }, retryDelays);
      } catch (err) {
        throw friendlyError(err, model);
      }

      const usage = readUsage(response.usageMetadata);
      try {
        return { data: JSON.parse(response.text), usage, model };
      } catch {
        const failure = new HttpError(502, 'O Mestre devolveu uma resposta incompleta. Tente de novo.');
        failure.usage = usage;
        failure.model = model;
        throw failure;
      }
    },
  };
}
