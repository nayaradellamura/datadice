export class HttpError extends Error {
  /** code ajuda o navegador a reagir: 'auth' pede login, 'gemini_key' abre as Configurações. */
  constructor(status, message, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

export function notFoundApi(_req, _res, next) {
  next(new HttpError(404, 'Rota não encontrada.'));
}

export function errorHandler(err, _req, res, _next) {
  // JSON malformado e corpo grande demais chegam do express.json com status próprio.
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  // Erros previstos (os nossos, como "Gemini fora do ar") viram uma linha; os inesperados mostram tudo.
  if (status >= 500) {
    if (err instanceof HttpError) console.error(`Erro ${status}: ${err.message}${err.cause ? ` (causa: ${err.cause.message ?? err.cause})` : ''}`);
    else console.error(err);
  }
  const ours = err instanceof HttpError;
  const message = status === 500 ? 'Erro interno do servidor.' : ours || err.expose ? err.message : 'Requisição inválida.';
  res.status(status).json({ error: message, ...(ours && err.code ? { code: err.code } : {}) });
}
