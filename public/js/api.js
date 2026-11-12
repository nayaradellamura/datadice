function readLocal(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key, value) {
  try {
    if (value === null || value === '') localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Sem armazenamento local: vale só enquanto a página estiver aberta.
  }
}

import { icon as svgIcon } from './icons.js';

/** Botão de olho: mostra ou esconde o conteúdo de um campo de senha. Devolve a função que força um estado. */
export function bindEyeToggle(button, input, noun) {
  const set = (show) => {
    input.type = show ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(show));
    const label = `${show ? 'Ocultar' : 'Mostrar'} ${noun}`;
    button.setAttribute('aria-label', label);
    button.title = label;
  };
  button.addEventListener('click', () => {
    set(input.type === 'password');
    input.focus();
  });
  set(false);
  return set;
}

/** Tira o que costuma vir junto ao copiar: espaços, quebras de linha, aspas e "GEMINI_API_KEY=". */
export function cleanKey(value) {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .replace(/^(?:GEMINI_API_KEY|API_KEY|KEY)\s*[=:]/i, '')
    .replace(/^["'`]+|["'`]+$/g, '');
}

/** Configurações do jogador, guardadas só neste navegador. */
export const settings = {
  get apiKey() { return readLocal('gemini_api_key') ?? ''; },
  set apiKey(value) { writeLocal('gemini_api_key', cleanKey(value)); },
  // Desligado por padrão: a geração de imagens do Gemini não tem cota gratuita.
  get imagesEnabled() { return readLocal('enable_image_gen') === 'true'; },
  set imagesEnabled(value) { writeLocal('enable_image_gen', value ? 'true' : 'false'); },
};

/** Sessão de login (token JWT e dados do usuário). */
export const session = {
  get token() { return readLocal('rpg.token'); },
  get user() {
    try {
      return JSON.parse(readLocal('rpg.user') ?? 'null');
    } catch {
      return null;
    }
  },
  save(token, user) {
    writeLocal('rpg.token', token);
    writeLocal('rpg.user', JSON.stringify(user));
  },
  clear() {
    writeLocal('rpg.token', null);
    writeLocal('rpg.user', null);
  },
  get isAdmin() { return this.user?.role === 'admin'; },
};

function apiError(message, code, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  // Avisa o resto da página: sessão expirada volta ao login; falta de chave abre as Configurações.
  if (code === 'auth') document.dispatchEvent(new CustomEvent('auth-expired'));
  if (code === 'gemini_key') document.dispatchEvent(new CustomEvent('need-gemini-key'));
  return error;
}

/**
 * Chamada à API. Com gemini: true, manda a chave do jogador no header x-gemini-key; sem chave salva,
 * nem chega a chamar o servidor.
 */
export async function api(path, { method = 'GET', body, gemini = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  if (gemini) {
    if (!settings.apiKey) throw apiError('Configure sua chave do Gemini em Configurações (ícone de engrenagem) para jogar.', 'gemini_key', 0);
    headers['x-gemini-key'] = settings.apiKey;
  }
  let response;
  try {
    response = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw apiError('Sem conexão com o servidor. Confira sua internet e tente de novo.', 'offline', 0);
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Resposta fora do formato esperado: tratada abaixo.
  }
  if (!response.ok) throw apiError(data?.error ?? 'Não foi possível falar com o servidor.', data?.code, response.status);
  return data;
}

/** Cria elementos sempre como texto puro, sem interpretar HTML vindo de dados. */
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
    else if (key === 'class') element.className = value;
    else if (key === 'dataset') Object.assign(element.dataset, value);
    // Como atributo, o valor inicial sobrevive a form.reset().
    else if (key === 'value' && tag === 'input') element.setAttribute('value', value);
    else if (key in element && key !== 'list') element[key] = value;
    else element.setAttribute(key, value === true ? '' : value);
  }
  element.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}

/**
 * Mostra em negrito o que estiver entre ** ou entre *, sem interpretar HTML:
 * cada parte vira texto puro, então ninguém consegue injetar código por aqui.
 */
export function formatText(text) {
  const fragment = document.createDocumentFragment();
  // Como no Markdown, o texto precisa encostar nos asteriscos: "2 * 3 * 4" continua sendo uma conta.
  const pattern = /\*\*(\S(?:[^*\n]*?\S)?)\*\*|\*(\S(?:[^*\n]*?\S)?)\*/g;
  const source = String(text ?? '');
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    const inner = match[1] ?? match[2];
    if (!inner.trim()) continue;
    fragment.append(source.slice(last, match.index), h('strong', {}, inner));
    last = match.index + match[0].length;
  }
  fragment.append(source.slice(last));
  return fragment;
}

/**
 * Estado vazio padrão (o mesmo em todas as telas): ícone, título, texto curto e as ações.
 * actions: [[rótulo, ao clicar, primária?], ...]
 */
export function emptyState({ icon, title, text, actions = [] }) {
  return h('div', { class: 'empty-state' },
    icon && h('span', { class: 'empty-state-icon', 'aria-hidden': 'true' }, svgIcon(icon, 40)),
    h('h3', {}, title),
    text && h('p', {}, text),
    actions.length > 0 && h('div', { class: 'actions' }, actions.map(([label, onclick, primary]) =>
      h('button', { type: 'button', class: primary ? 'primary' : '', onclick }, label))));
}

/** Nome da campanha; para o admin, campanhas de outros jogadores levam o nome do dono. */
export function campaignLabel(campaign) {
  const others = campaign.owner_name && campaign.user_id !== session.user?.id;
  return others ? `${campaign.name} · de ${campaign.owner_name}` : campaign.name;
}

export const signed = (value) => (value >= 0 ? `+${value}` : `${value}`);

// Limites e cobrança não são falhas do sistema: aparecem como aviso, com o próximo passo.
const NOTICE_CODES = new Set(['quota_daily', 'quota_minute', 'billing', 'gemini_key', 'gemini_busy']);

export function showError(element, error) {
  const code = error?.code ?? '';
  element.replaceChildren(error ? error.message ?? String(error) : '');
  element.classList.toggle('is-notice', NOTICE_CODES.has(code));
  if (code === 'gemini_key' || code === 'billing') {
    element.append(' ', h('button', {
      type: 'button',
      class: 'small',
      onclick: () => document.dispatchEvent(new CustomEvent('open-settings')),
    }, 'Abrir Configurações'));
  }
  element.hidden = !error;
}

export function fillSelect(select, items, { placeholder, value } = {}) {
  select.replaceChildren(
    ...(placeholder ? [h('option', { value: '' }, placeholder)] : []),
    ...items.map((item) => h('option', { value: String(item.value) }, item.label))
  );
  if (value !== undefined && [...select.options].some((option) => option.value === String(value))) {
    select.value = String(value);
  }
}

export const store = {
  get(key) {
    try {
      return localStorage.getItem(`rpg.${key}`);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`rpg.${key}`, value);
    } catch {
      // Sem armazenamento local, o jogo só não lembra a última seleção.
    }
  },
};
