import { h } from './api.js';
import { icon } from './icons.js';

/**
 * Ditado: o jogador fala e o texto aparece na caixa de mensagem, para revisar antes de enviar.
 * Usa o reconhecimento de voz do navegador (Chrome, Edge, Safari e Android); sem ele, o botão não aparece.
 * Nada de áudio passa pelo DataDice: só o texto, quando o jogador tocar em Enviar.
 */
const Recognition = typeof window !== 'undefined' ? (window.SpeechRecognition ?? window.webkitSpeechRecognition) : null;
export const dictationSupported = Boolean(Recognition);

let active = null;

function setState(button, listening) {
  button.classList.toggle('listening', listening);
  button.setAttribute('aria-pressed', String(listening));
  button.setAttribute('aria-label', listening ? 'Parar de ditar' : 'Falar a mensagem');
  button.title = listening ? 'Toque para parar' : 'Falar em vez de digitar';
}

/** Botão de microfone ligado à caixa de texto. onError recebe mensagens para mostrar ao jogador. */
export function micButton(textarea, { onError = () => {} } = {}) {
  if (!dictationSupported) return null;
  const button = h('button', { type: 'button', class: 'mic-button' }, icon('mic', 20));
  setState(button, false);

  button.addEventListener('click', () => {
    if (active) {
      const same = active.button === button;
      active.recognition.stop();
      if (same) return;
    }
    const recognition = new Recognition();
    recognition.lang = 'pt-BR';
    recognition.interimResults = true;
    recognition.continuous = true;
    // O que já estava escrito fica; a fala entra depois, com um espaço.
    const before = textarea.value.trim();
    let finalText = '';
    recognition.onresult = (event) => {
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) finalText += `${result[0].transcript.trim()} `;
        else interim += result[0].transcript;
      }
      const spoken = `${finalText}${interim}`.trim();
      textarea.value = [before, spoken].filter(Boolean).join(' ');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    };
    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        onError('O microfone está bloqueado para este site. Toque no cadeado (ou no ícone ao lado do endereço), permita o Microfone e tente de novo.');
      } else if (event.error === 'no-speech') {
        onError('Não ouvi nada. Toque no microfone e fale perto do celular.');
      } else if (event.error === 'network') {
        onError('O ditado precisa de internet. Confira a conexão e tente de novo.');
      }
    };
    recognition.onend = () => {
      setState(button, false);
      if (active?.recognition === recognition) active = null;
      textarea.focus();
    };
    active = { recognition, button };
    setState(button, true);
    onError(null);
    recognition.start();
  });
  return button;
}

/** Para o ditado (ex.: ao enviar a mensagem). */
export function stopDictation() {
  active?.recognition.stop();
}
