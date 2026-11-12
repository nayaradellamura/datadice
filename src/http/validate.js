import { HttpError } from '../middleware/errorHandler.js';

/*
 * Validação de entrada usada pelas rotas. Um lugar só, para as regras não divergirem entre arquivos.
 * Ids fora do intervalo de um integer do PostgreSQL dariam erro 500 no banco: aqui viram 400 ou "não existe".
 */

const MAX_INT = 2147483647;

/** Id válido ou null (para quem prefere responder 404 sem confirmar que algo existe). */
export function asId(value) {
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 && id <= MAX_INT ? id : null;
}

/** Id válido ou erro 400. */
export function positiveId(value, label) {
  const id = asId(value);
  if (id === null) throw new HttpError(400, `${label} inválido.`);
  return id;
}

/** Texto aparado, com limite de tamanho; obrigatório por padrão. */
export function cleanText(value, label, max, { required = true } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && !text) throw new HttpError(400, `${label} é obrigatório.`);
  if (text.length > max) throw new HttpError(400, `${label} deve ter até ${max} caracteres.`);
  return text;
}

/** Inteiro num intervalo; vazio usa o padrão. */
export function int(value, label, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new HttpError(400, `${label} deve ser um inteiro entre ${min} e ${max}.`);
  }
  return number;
}
