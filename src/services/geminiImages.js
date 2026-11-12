import { GoogleGenAI } from '@google/genai';
import { HttpError } from '../middleware/errorHandler.js';
import { friendlyError, generateWithRetry, noFreeTier } from './gemini.js';

// O modelo de imagem mais barato do Gemini (cerca de US$ 0,034 por imagem). Não tem plano gratuito.
export const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-lite-image';

const SIGNATURES = [
  { extension: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { extension: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { extension: 'webp', bytes: [0x52, 0x49, 0x46, 0x46] },
];

/** Confere pelos primeiros bytes que é mesmo uma imagem antes de gravar e servir o arquivo. */
export function decodeImage(base64) {
  if (typeof base64 !== 'string' || !base64) throw new HttpError(502, 'O Gemini não devolveu nenhuma imagem.');
  const buffer = Buffer.from(base64.replace(/^data:[^,]*,/, ''), 'base64');
  const format = SIGNATURES.find(({ bytes }) => bytes.every((byte, index) => buffer[index] === byte));
  if (!format) throw new HttpError(502, 'O Gemini devolveu um arquivo que não é uma imagem válida.');
  return { buffer, extension: format.extension };
}

export const NO_FREE_TIER =
  'Imagem não gerada: sua chave do Gemini está no plano gratuito, e o Google não inclui geração de imagens nele. O jogo continua normalmente, só sem imagens. Para tê-las, ative o faturamento da chave no Google AI Studio (cerca de US$ 0,03 por imagem) ou desligue "Gerar ilustrações" em Configurações para não ver mais este aviso.';

function imageError(err, model) {
  if (noFreeTier(err)) return new HttpError(402, NO_FREE_TIER, 'billing');
  const failure = friendlyError(err, model);
  if (failure.code === 'quota_daily' || failure.code === 'quota_minute') failure.message = `Imagem não gerada. ${failure.message}`;
  return failure;
}

/**
 * Gera a imagem com a chave do jogador. store({ buffer, extension, prefix, campaignId }) guarda a imagem
 * (no banco, em imageStore.js) e devolve a URL pública.
 */
export function createGeminiImageClient({ apiKey, model = DEFAULT_IMAGE_MODEL, store, client, retryDelays }) {
  const ai = client ?? new GoogleGenAI({ apiKey });

  return {
    async generate(prompt, { aspectRatio = '2:3', filePrefix = 'retrato', campaignId = null } = {}) {
      let response;
      try {
        response = await generateWithRetry(ai, {
          model,
          contents: prompt,
          config: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio } },
        }, retryDelays);
      } catch (err) {
        throw imageError(err, model);
      }
      const part = response?.candidates?.[0]?.content?.parts?.find((item) => item?.inlineData?.data);
      if (!part) {
        throw new HttpError(502, 'O Gemini não devolveu a imagem; às vezes o filtro de segurança do Google bloqueia a descrição. Tente outra descrição.');
      }
      const { buffer, extension } = decodeImage(part.inlineData.data);
      return store({ buffer, extension, prefix: filePrefix, campaignId });
    },
  };
}
