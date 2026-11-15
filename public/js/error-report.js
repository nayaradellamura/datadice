import { session } from './api.js';

// Avisa o admin (Painel Admin → Atividade) quando algo quebra na tela de alguém. Manda só a mensagem do
// erro, o arquivo e a linha, e a tela aberta. No máximo 5 avisos por vez que a página abre.
const sent = new Set();

function report(message, source) {
  const text = String(message ?? '').slice(0, 300);
  if (!text || !session.token || sent.size >= 5 || sent.has(text)) return;
  sent.add(text);
  const view = document.querySelector('.view:not([hidden])')?.id?.replace(/^view-/, '') ?? '';
  fetch('/api/client-error', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ message: text, source: String(source ?? '').slice(0, 200), view }),
    keepalive: true,
  }).catch(() => {});
}

const where = (file, line) => (file ? `${String(file).split('/').pop()}${line ? `:${line}` : ''}` : '');

export function initErrorReport() {
  window.addEventListener('error', (event) => {
    // Imagem ou script que não carregou não traz mensagem: ignora.
    if (!event.message) return;
    report(event.message, where(event.filename, event.lineno));
  });
  window.addEventListener('unhandledrejection', (event) => {
    const err = event.reason;
    // Erros que o servidor devolveu já ficam registrados lá.
    if (err?.status > 0) return;
    const line = /\/js\/([\w-]+\.js):(\d+)/.exec(err?.stack ?? '');
    report(err?.message ?? err, line ? `${line[1]}:${line[2]}` : '');
  });
}
