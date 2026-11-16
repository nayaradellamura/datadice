/**
 * Leva o chat até a última mensagem. Repete por alguns segundos porque a altura ainda muda depois
 * (fontes, imagens, a tela que estava escondida aparecendo), a não ser que o jogador mexa no chat.
 */
const STICK_MS = 4000;

export function scrollToEnd(log) {
  if (!log) return;
  const until = Date.now() + STICK_MS;
  let touched = false;
  const stop = () => { touched = true; };
  log.addEventListener('wheel', stop, { once: true, passive: true });
  log.addEventListener('touchstart', stop, { once: true, passive: true });
  log.addEventListener('keydown', stop, { once: true });

  const go = () => {
    if (!touched && Date.now() < until) log.scrollTop = log.scrollHeight;
  };
  go();
  requestAnimationFrame(() => { go(); requestAnimationFrame(go); });
  document.fonts?.ready.then(go);
  for (const image of log.querySelectorAll('img')) {
    if (!image.complete) image.addEventListener('load', go, { once: true });
  }
  // Mudanças de tamanho (ex.: a tela do jogo deixou de estar escondida).
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(go);
    observer.observe(log);
    setTimeout(() => observer.disconnect(), STICK_MS);
  }
}
