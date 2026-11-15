import { h } from './api.js';
import { icon } from './icons.js';

/**
 * Narração em voz alta com a voz do próprio aparelho (Web Speech API): grátis, sem chave e sem enviar o
 * texto para ninguém. A qualidade da voz depende do celular ou do navegador.
 */

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
export const narrationSupported = Boolean(synth && window.SpeechSynthesisUtterance);

function readLocal(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Sem armazenamento: vale só enquanto a página estiver aberta.
  }
}

export const narration = {
  get auto() { return readLocal('narration_auto') === 'true'; },
  set auto(value) { writeLocal('narration_auto', value ? 'true' : 'false'); },
  get voice() { return readLocal('narration_voice') ?? ''; },
  set voice(value) { writeLocal('narration_voice', value); },
  get rate() {
    const value = Number(readLocal('narration_rate'));
    return value >= 0.5 && value <= 2.5 ? value : 1;
  },
  set rate(value) { writeLocal('narration_rate', String(value)); },
};

/** Vozes em português; as do Brasil e as mais naturais (Google, Microsoft "Online/Natural") primeiro. */
export function portugueseVoices() {
  if (!narrationSupported) return [];
  const score = (voice) => (/^pt[-_]BR/i.test(voice.lang) ? 2 : 0) + (/natural|online|google|neural/i.test(voice.name) ? 1 : 0);
  return synth.getVoices()
    .filter((voice) => /^pt/i.test(voice.lang))
    .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
}

function chosenVoice() {
  const voices = portugueseVoices();
  return voices.find((voice) => voice.name === narration.voice) ?? voices[0] ?? null;
}

/** Tira a formatação (negrito, títulos, links) para a voz não ler símbolos. */
export function speakable(text) {
  return String(text ?? '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_#`>~|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Alguns navegadores cortam falas longas: o texto vai em pedaços de até ~220 caracteres, por frase.
function chunks(text) {
  const sentences = text.match(/[^.!?…]+[.!?…]+["”»)]*\s*|[^.!?…]+$/g) ?? [text];
  const out = [];
  let current = '';
  for (const sentence of sentences) {
    if ((current + sentence).length > 220 && current) {
      out.push(current.trim());
      current = '';
    }
    current += sentence;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

let activeButton = null;
let token = 0;

function setButton(button, speaking) {
  if (!button) return;
  button.classList.toggle('speaking', speaking);
  button.setAttribute('aria-pressed', String(speaking));
  // Botão "Ouvir" das falas: só o ícone. O de exemplo (Configurações) mantém o texto.
  const label = speaking ? 'Parar' : 'Ouvir';
  button.setAttribute('aria-label', label);
  button.title = speaking ? 'Parar a narração' : 'Ouvir a narração';
  button.replaceChildren(icon(speaking ? 'stop' : 'volume', 15), ...(button.classList.contains('msg-listen') ? [] : [label]));
}

export function stopNarration() {
  if (!narrationSupported) return;
  token += 1;
  synth.cancel();
  setButton(activeButton, false);
  activeButton = null;
}

/** Lê o texto em voz alta. Tocar de novo no mesmo botão para a leitura. */
export function speak(text, button = null) {
  if (!narrationSupported) return;
  const same = button && button === activeButton;
  stopNarration();
  if (same) return;
  const parts = chunks(speakable(text));
  if (!parts.length) return;
  const mine = ++token;
  activeButton = button;
  setButton(button, true);
  const voice = chosenVoice();
  parts.forEach((part, index) => {
    const utterance = new SpeechSynthesisUtterance(part);
    utterance.lang = voice?.lang ?? 'pt-BR';
    if (voice) utterance.voice = voice;
    utterance.rate = narration.rate;
    if (index === parts.length - 1) {
      utterance.onend = () => {
        if (mine !== token) return;
        setButton(button, false);
        activeButton = null;
      };
    }
    utterance.onerror = () => {
      if (mine !== token) return;
      setButton(button, false);
      activeButton = null;
    };
    synth.speak(utterance);
  });
}

/**
 * No celular, a voz só pode começar a partir de um toque. Chamar no toque de "Enviar" libera a leitura
 * automática da resposta, que chega segundos depois.
 */
export function primeNarration() {
  if (!narrationSupported || !narration.auto) return;
  const silent = new SpeechSynthesisUtterance(' ');
  silent.volume = 0;
  synth.speak(silent);
}

/** Botão "Ouvir" de uma fala do Mestre. */
export function listenButton(text) {
  if (!narrationSupported) return null;
  const button = h('button', { type: 'button', class: 'msg-listen', 'aria-pressed': 'false', title: 'Ouvir a narração' });
  setButton(button, false);
  button.addEventListener('click', () => speak(text, button));
  return button;
}

if (narrationSupported) {
  // As vozes chegam depois que a página abre (Chrome e Android).
  synth.addEventListener?.('voiceschanged', () => document.dispatchEvent(new CustomEvent('voices-changed')));
  // Saiu da página ou trocou de aba no celular: para de falar.
  window.addEventListener('pagehide', () => synth.cancel());
}
