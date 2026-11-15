// Animação do dado na tela ao rolar: o dado gira assim que a pessoa toca e para no resultado que o
// servidor sorteou (o servidor continua sendo quem rola; aqui é só a apresentação).
// Não bloqueia a tela (não recebe toques) e some sozinha. Com "reduzir movimento", só mostra o resultado.

const SVG = 'http://www.w3.org/2000/svg';
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const MIN_SPIN_MS = 750;
const SHOW_MS = 1700;

let layer = null;
let hideTimer = null;

function svg(tag, attrs) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

/** d20 visto de frente (icosaedro): hexágono com o triângulo central e as faces em volta. */
function d20Shape() {
  const box = svg('svg', { viewBox: '0 0 100 100', class: 'dice-fx-shape', 'aria-hidden': 'true' });
  const outer = [[50, 3], [91, 26.5], [91, 73.5], [50, 97], [9, 73.5], [9, 26.5]];
  const inner = [[50, 22], [75, 66], [25, 66]];
  const pts = (list) => list.map((p) => p.join(',')).join(' ');
  box.append(svg('polygon', { points: pts(outer), class: 'dice-fx-face' }));
  box.append(svg('polygon', { points: pts(inner), class: 'dice-fx-inner' }));
  for (const [a, b] of [[0, 0], [1, 0], [1, 1], [2, 1], [3, 1], [3, 2], [4, 2], [5, 2], [5, 0]]) {
    box.append(svg('line', { x1: outer[a][0], y1: outer[a][1], x2: inner[b][0], y2: inner[b][1], class: 'dice-fx-edge' }));
  }
  return box;
}

/** Outros dados: um losango arredondado, com o tipo do dado escrito embaixo. */
function genericShape() {
  const box = svg('svg', { viewBox: '0 0 100 100', class: 'dice-fx-shape', 'aria-hidden': 'true' });
  box.append(svg('rect', { x: 14, y: 14, width: 72, height: 72, rx: 14, class: 'dice-fx-face', transform: 'rotate(45 50 50)' }));
  return box;
}

/**
 * Lê o texto da rolagem ("Thalia rolou Furtividade: 17 + 0 = 17 — 20 natural!") e devolve o que mostrar:
 * o número do dado (d20) ou o total (outras rolagens), a legenda e se foi 20 ou 1 natural.
 */
export function readRoll(text, { d20 }) {
  const source = String(text ?? '');
  const trimmed = source.replace(/^.*?\s(?:rolou|atacou com)\s/, '').replace(/^o\s+/, '').replace(/\s+—\s+(?:20|1) natural!$/, '').trim();
  const caption = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  const math = source.slice(source.lastIndexOf(': ') + 2);
  const numbers = [...math.matchAll(/-?\d+/g)].map((match) => Number(match[0]));
  const total = Number(/=\s*(-?\d+)/.exec(math)?.[1] ?? numbers[0]);
  const natural = d20 ? numbers[0] : null;
  const sides = Number(/\b\d*d(\d+)\b/i.exec(source)?.[1]) || null;
  return {
    value: d20 ? natural : total,
    total,
    caption: caption.length > 70 ? `${caption.slice(0, 67)}...` : caption,
    crit: d20 && (/20 natural!/.test(source) || natural === 20),
    fumble: d20 && (/1 natural!/.test(source) || natural === 1),
    sides,
  };
}

function ensureLayer() {
  if (layer?.isConnected) return layer;
  layer = document.createElement('div');
  layer.className = 'dice-fx';
  layer.setAttribute('aria-hidden', 'true');
  document.body.append(layer);
  return layer;
}

function hide() {
  clearTimeout(hideTimer);
  layer?.classList.remove('show');
}

/**
 * Roda a animação enquanto a rolagem acontece. request: função que faz a rolagem e devolve a mensagem
 * (com message_text ou text), ou null se falhou. d20: se é um teste/ataque de d20 (mostra o número natural).
 */
/** Teste, ataque, iniciativa, salvaguarda e "d20" puro: mostra o d20 com o número natural. */
export const isD20Roll = (body) => !['damage', 'dice'].includes(body?.kind)
  || String(body?.expression ?? '').replace(/\s+/g, '').toLowerCase() === '1d20';

export async function rollWithFx(request, { d20 = true } = {}) {
  const box = ensureLayer();
  clearTimeout(hideTimer);
  const shape = d20 ? d20Shape() : genericShape();
  const number = document.createElement('b');
  number.className = 'dice-fx-number';
  const caption = document.createElement('p');
  caption.className = 'dice-fx-caption';
  const die = document.createElement('div');
  die.className = 'dice-fx-die';
  die.append(shape, number);
  box.replaceChildren(die, caption);
  box.className = `dice-fx show ${reduced() ? '' : 'spinning'}`;

  // Números trocando enquanto gira.
  const faces = d20 ? 20 : 12;
  number.textContent = String(1 + Math.floor(Math.random() * faces));
  const shuffle = reduced() ? null : setInterval(() => { number.textContent = String(1 + Math.floor(Math.random() * faces)); }, 70);
  const started = Date.now();

  let result = null;
  try {
    result = await request();
  } catch (err) {
    clearInterval(shuffle);
    hide();
    throw err;
  } finally {
    const wait = Math.max(0, MIN_SPIN_MS - (Date.now() - started));
    if (result && wait && !reduced()) await new Promise((resolve) => { setTimeout(resolve, wait); });
    clearInterval(shuffle);
  }
  if (!result) {
    hide();
    return result;
  }
  const roll = readRoll(result.message_text ?? result.text, { d20 });
  number.textContent = Number.isFinite(roll.value) ? String(roll.value) : '?';
  caption.textContent = roll.caption;
  if (!d20 && roll.sides) die.dataset.sides = `d${roll.sides}`;
  box.className = `dice-fx show landed ${roll.crit ? 'crit' : ''} ${roll.fumble ? 'fumble' : ''}`;
  hideTimer = setTimeout(hide, SHOW_MS + (roll.crit || roll.fumble ? 600 : 0));
  return result;
}
