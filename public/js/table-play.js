import { api, emptyState, formatText, h, session, showError, signed, store } from './api.js';
import { icon } from './icons.js';
import { openSheetView } from './sheet-view.js';
import { MONSTER_PRESETS, NPC_PRESETS } from './table-presets.js';

/*
 * Jogo dentro de uma mesa em grupo: abas Chat, Ficha (jogador) ou Painel (Mestre), Biblioteca, Notas (Mestre)
 * e Mesa. Recebe tudo em tempo real pelo canal /stream (fetch com o token, sem expor o token na URL).
 */

const el = (id) => document.getElementById(id);
const STATUS_LABELS = { active: 'Ativo', unconscious: 'Inconsciente', stable: 'Estável', dead: 'Morto' };
export const KIND_LABELS = { npc: 'NPC', monster: 'Monstro', location: 'Local' };
const MODES = [['normal', 'Normal'], ['advantage', 'Vantagem'], ['disadvantage', 'Desvantagem']];
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

let meta = null;
let table = null;
let hooks = { onTable: () => {}, onGone: () => {} };
let pane = 'chat';
let stream = null;
let shown = new Set();
let firstId = null;
let lastId = 0;
let unread = 0;
let party = [];
let initiative = { active: false, entries: [], round: 1, current_id: null };
let library = [];
let gallery = [];
let notes = [];
let libraryFilter = 'all';
let libraryEditing = null;
let rollMode = 'normal';
let secretRoll = null;
let criticalWeapon = null;
let composeKind = null;
const deferred = new Map();

const me = () => session.user?.id;
const isGm = () => table?.role === 'mestre';
const tableUrl = (path = '') => `/tables/${table.id}${path}`;
// Chat com muitas mensagens: só as últimas ficam na tela; as anteriores voltam pelo botão.
const MAX_CHAT_NODES = 400;

/**
 * Busca algo da mesa aberta. Se a pessoa trocou de mesa (ou saiu) enquanto esperava, devolve null:
 * a resposta antiga não pode ser desenhada na mesa nova.
 */
async function fetchForTable(path) {
  const id = table?.id;
  if (!id) return null;
  const data = await api(`/tables/${id}${path}`);
  return table?.id === id ? data : null;
}
const myMember = () => party.find((member) => member.user_id === me()) ?? null;

// [chave, ícone, rótulo]. "Grupo" (antes "Mesa") guarda convite, pedidos, jogadores e configurações.
// O jogo inteiro (chat, dados, fichas, iniciativa) fica em Jogo; as outras abas são de preparação.
function tabsFor() {
  return isGm()
    ? [['chat', 'dice', 'Jogo'], ['library', 'book', 'Biblioteca'], ['notes', 'note', 'Notas'], ['mesa', 'users', 'Grupo']]
    : [['chat', 'dice', 'Jogo'], ['library', 'book', 'Biblioteca'], ['mesa', 'users', 'Grupo']];
}

// ---------- Utilidades ----------

/** replaceChildren que ignora false/null (de condições como `gm && botão`), em vez de escrever "false" na tela. */
export function fill(node, ...children) {
  node.replaceChildren(...children.flat().filter((child) => child !== false && child !== null && child !== undefined && child !== ''));
}

/** Redesenha um painel, mas não enquanto a pessoa digita nele: espera ela sair do campo. */
function render(paneId, draw) {
  const container = el(paneId);
  const active = document.activeElement;
  if (container && container.contains(active) && active.matches('input, textarea, select')) {
    deferred.set(paneId, draw);
    return;
  }
  deferred.delete(paneId);
  draw();
}

function flushDeferred(event) {
  for (const [paneId, draw] of deferred) {
    if (!el(paneId)?.contains(event.relatedTarget)) {
      deferred.delete(paneId);
      draw();
    }
  }
}

function fail(err) {
  showError(el('table-error'), err);
}

const timeOf = (value) => new Date(`${String(value).replace(' ', 'T')}Z`).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const percent = (current, max) => (max > 0 ? Math.max(0, Math.min(100, Math.round((current / max) * 100))) : 0);

function hpBar(current, max) {
  const value = percent(current, max);
  return h('div', { class: `hp-bar ${value <= 30 ? 'low' : ''}`, role: 'img', 'aria-label': `${current} de ${max} pontos de vida` }, h('i', { style: `width:${value}%` }));
}

/** Reduz a imagem no aparelho e regrava em JPEG (leve e sem metadados, como a localização da foto). */
export async function shrinkImage(file, maxSide = 1600) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Use uma imagem PNG, JPG ou WebP.');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.85);
}

const d20 = () => {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return (value[0] % 20) + 1;
};
export const modOf = (score) => Math.floor(((Number(score) || 10) - 10) / 2);
const newId = (prefix) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ---------- Abas ----------

function renderTabs() {
  // Avisos nas abas: mensagens não lidas no Chat; pedidos para entrar no Grupo (só o Mestre).
  const badges = { chat: pane !== 'chat' ? unread : 0, mesa: isGm() ? table.pending?.length ?? 0 : 0 };
  el('table-tabs').replaceChildren(...tabsFor().map(([key, iconName, label]) => h('button', {
    type: 'button',
    role: 'tab',
    class: `table-tab ${pane === key ? 'active' : ''}`,
    'aria-selected': String(pane === key),
    'aria-label': badges[key] ? `${label} (${badges[key]} novo${badges[key] > 1 ? 's' : ''})` : label,
    onclick: () => showPane(key),
  },
  h('span', { class: 'table-tab-icon', 'aria-hidden': 'true' }, icon(iconName, 22)),
  h('span', { class: 'table-tab-label' }, label),
  badges[key] > 0 ? h('span', { class: 'tab-badge', 'aria-hidden': 'true' }, String(Math.min(badges[key], 99))) : null)));
}

function showPane(key) {
  if (!tabsFor().some(([name]) => name === key)) key = 'chat';
  pane = key;
  store.set('tables.pane', key);
  for (const node of document.querySelectorAll('#table-detail [data-pane]')) node.hidden = node.dataset.pane !== key;
  if (key === 'chat') {
    unread = 0;
    const log = el('tp-log');
    if (log) log.scrollTop = log.scrollHeight;
  }
  renderTabs();
  if (key === 'library') loadGallery().catch(fail);
  if (key === 'notes') loadNotes().catch(fail);
}

// ---------- Chat ----------

function privacyLabel(message) {
  const mine = message.user_id === me();
  if (message.visibility === 'gm') {
    if (mine) return isGm() ? 'Secreta: só você vê' : 'Só você e o Mestre veem';
    return 'Só o Mestre vê';
  }
  if (message.visibility === 'private') {
    if (mine) return isGm() ? `Só para ${message.recipient_name ?? 'o jogador'}` : 'Só o Mestre vê';
    return isGm() ? `Privada de ${message.sender_name}` : 'Só para você';
  }
  return null;
}

function messageNode(message) {
  const mine = message.user_id === me();
  let type = 'note';
  let who = null;
  if (message.kind === 'narracao') { type = 'gm'; who = 'Mestre'; }
  else if (message.kind === 'fala') { type = message.sender_type === 'gm' ? 'npc' : 'player'; who = message.sender_name; }
  else if (message.kind === 'ooc') { type = 'ooc'; who = `${message.sender_name} · fora do personagem`; }
  else if (message.kind === 'rolagem') { type = 'system'; }
  else if (message.kind === 'imagem') { type = 'gm'; who = 'Mestre'; }
  else if (message.visibility !== 'all') { type = 'notice'; }
  const privacy = privacyLabel(message);
  return h('div', {
    class: `msg ${type}${mine ? ' mine' : ''}${message.visibility !== 'all' ? ' private' : ''}`,
    dataset: { id: String(message.id) },
  },
  (who || privacy) && h('span', { class: 'who' }, who ?? '', privacy && h('span', { class: 'tp-private' }, icon('lock', 13), privacy)),
  message.kind === 'imagem' && message.image_url && h('a', { href: message.image_url, target: '_blank', rel: 'noopener', class: 'tp-image-link' },
    h('img', { src: message.image_url, alt: message.text || 'Imagem enviada pelo Mestre', class: 'tp-image', loading: 'lazy' })),
  message.text && h('span', { class: 'tp-text' }, formatText(message.text)),
  h('time', { class: 'tp-time', datetime: message.created_at }, timeOf(message.created_at)));
}

function addMessages(list, { prepend = false, live = false } = {}) {
  const log = el('tp-log');
  if (!log) return;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 140;
  const fresh = list.filter((message) => !shown.has(message.id));
  if (!fresh.length) return;
  log.querySelector('.empty')?.remove();
  const nodes = fresh.map((message) => {
    shown.add(message.id);
    lastId = Math.max(lastId, message.id);
    firstId = firstId === null ? message.id : Math.min(firstId, message.id);
    return messageNode(message);
  });
  if (prepend) {
    const before = log.scrollHeight;
    el('tp-older').after(...nodes);
    log.scrollTop += log.scrollHeight - before;
    return;
  }
  log.append(...nodes);
  // Tira da tela as mensagens mais antigas (continuam no servidor, voltam por "Mensagens anteriores").
  const messageNodes = log.querySelectorAll('.msg[data-id]');
  if (messageNodes.length > MAX_CHAT_NODES) {
    for (const node of [...messageNodes].slice(0, messageNodes.length - MAX_CHAT_NODES)) {
      shown.delete(Number(node.dataset.id));
      node.remove();
    }
    firstId = Number(log.querySelector('.msg[data-id]').dataset.id);
    el('tp-older').hidden = false;
  }
  const ownMessage = fresh.some((message) => message.user_id === me());
  if (atBottom || ownMessage || !live) log.scrollTop = log.scrollHeight;
  if (live && pane !== 'chat') {
    unread += fresh.length;
    renderTabs();
  }
  // Aviso do Mestre para o jogador (ficha ou PV alterados) também aparece fora do chat.
  for (const message of fresh) {
    if (live && message.kind === 'sistema' && message.visibility === 'private' && !isGm()) toast(message.text);
  }
}

function toast(text) {
  const node = h('div', { class: 'tp-toast', role: 'status' }, text);
  document.body.append(node);
  setTimeout(() => node.remove(), 6000);
}

async function loadMessages() {
  const list = await fetchForTable('/messages?limit=100');
  if (!list) return;
  shown = new Set();
  firstId = null;
  lastId = 0;
  el('tp-log').replaceChildren(h('button', { type: 'button', id: 'tp-older', class: 'small tp-older', hidden: list.length < 100, onclick: loadOlder }, 'Mensagens anteriores'));
  if (!list.length) el('tp-log').append(h('p', { class: 'empty' }, isGm() ? 'A mesa está pronta. Comece narrando a cena!' : 'Ainda não há mensagens. Diga olá para a mesa!'));
  addMessages(list);
}

async function loadOlder() {
  const list = await fetchForTable(`/messages?limit=100&before=${firstId}`);
  if (!list) return;
  addMessages(list, { prepend: true });
  el('tp-older').hidden = list.length < 100;
}

async function catchUp() {
  if (!lastId) return loadMessages();
  for (;;) {
    const list = await fetchForTable(`/messages?after=${lastId}&limit=300`);
    if (!list) return;
    addMessages(list, { live: true });
    if (list.length < 300) return;
  }
}

function composerKinds() {
  return isGm()
    ? [['narracao', 'Narração'], ['fala', 'Fala de NPC'], ['ooc', 'Fora do jogo']]
    : [['fala', 'Em personagem'], ['ooc', 'Fora do jogo']];
}

function renderComposerOptions() {
  const kinds = composerKinds();
  if (!kinds.some(([key]) => key === composeKind)) composeKind = kinds[0][0];
  el('tp-kind').replaceChildren(...kinds.map(([key, label]) => h('button', {
    type: 'button',
    role: 'radio',
    class: composeKind === key ? 'active' : '',
    'aria-checked': String(composeKind === key),
    onclick: () => { composeKind = key; renderComposerOptions(); el('tp-input').focus(); },
  }, label)));
  el('tp-as').hidden = composeKind !== 'fala' || !isGm();
  el('tp-input').placeholder = composeKind === 'narracao' ? 'Descreva a cena...' : composeKind === 'ooc' ? 'Conversa fora do jogo...' : (isGm() ? 'O que o NPC diz?' : 'O que seu personagem diz ou faz?');

  const to = el('tp-to');
  const previous = to.value;
  const options = isGm()
    ? [['all', 'Para todos'], ...table.players.map((player) => [String(player.user_id), `Só ${player.name}`])]
    : [['all', 'Para todos'], ['gm', 'Só o Mestre']];
  to.replaceChildren(...options.map(([value, label]) => h('option', { value }, label)));
  to.value = options.some(([value]) => value === previous) ? previous : 'all';
  el('tp-compose').classList.toggle('is-private', to.value !== 'all');

  el('tp-npc-names').replaceChildren(...library.filter((entry) => entry.kind !== 'location').map((entry) => h('option', { value: entry.name })));
  el('tp-image-tool').hidden = !isGm();
}

async function send(event) {
  event.preventDefault();
  const input = el('tp-input');
  const text = input.value.trim();
  if (!text) return;
  const button = el('tp-send');
  button.disabled = true;
  showError(el('table-error'), null);
  try {
    const message = await api(tableUrl('/messages'), {
      method: 'POST',
      body: { kind: composeKind, text, to: el('tp-to').value, as: el('tp-as').value },
    });
    input.value = '';
    input.style.height = '';
    addMessages([message]);
  } catch (err) {
    fail(err);
  } finally {
    button.disabled = false;
    input.focus();
  }
}

async function sendImage(file) {
  showError(el('table-error'), null);
  const status = el('tp-image-status');
  status.hidden = false;
  status.textContent = 'Enviando imagem...';
  try {
    const image = await shrinkImage(file);
    const caption = el('tp-input').value.trim();
    const message = await api(tableUrl('/images'), { method: 'POST', body: { image, caption, to: el('tp-to').value } });
    el('tp-input').value = '';
    addMessages([message]);
  } catch (err) {
    fail(err);
  } finally {
    status.hidden = true;
  }
}

// ---------- Rolagens ----------

async function roll(body) {
  showError(el('table-error'), null);
  try {
    const result = await api(tableUrl('/roll'), { method: 'POST', body: { ...body, secret: secretRoll } });
    addMessages([result]);
    if (body.kind === 'attack') criticalWeapon = result.critical ? body.index : null;
    return result;
  } catch (err) {
    fail(err);
    return null;
  }
}

async function rollD20(body) {
  const mode = rollMode;
  rollMode = 'normal';
  const result = await roll({ ...body, mode });
  renderDiceTools();
  if (!isGm()) renderSheetPane();
  return result;
}

function secretSwitch() {
  const input = h('input', {
    type: 'checkbox',
    role: 'switch',
    checked: secretRoll,
    onchange: (event) => { secretRoll = event.target.checked; store.set(`tables.secret.${table.role}`, secretRoll ? 'on' : 'off'); renderDiceTools(); if (!isGm()) renderSheetPane(); },
  });
  return h('label', { class: 'switch tp-secret' }, input, h('span', { class: 'switch-track', 'aria-hidden': 'true' }),
    h('span', {}, isGm() ? 'Rolagem secreta (só você vê)' : 'Rolar só para o Mestre'));
}

function modeSwitch(onChange) {
  return h('div', { class: 'mode-switch', role: 'group', 'aria-label': 'Modo do próximo d20' }, MODES.map(([value, label]) =>
    h('button', { type: 'button', class: rollMode === value ? 'active' : '', 'aria-pressed': String(rollMode === value), onclick: () => { rollMode = value; onChange(); } }, label)));
}

// Mestre: por quem ele está rolando (monstro ou NPC em combate, ou da Biblioteca). Vazio = dados livres.
let rollAs = '';

/** Criaturas que o Mestre pode rolar: primeiro as que estão em combate, depois a Biblioteca. */
function gmCreatures() {
  const list = [];
  for (const entry of initiative.entries ?? []) {
    if (entry.kind === 'pc') continue;
    const lib = entry.library_id ? library.find((item) => item.id === entry.library_id && item.kind === entry.library_kind) : null;
    list.push({ key: `init:${entry.id}`, group: 'Em combate', name: entry.name, lib });
  }
  for (const lib of library) if (lib.kind !== 'location') list.push({ key: `lib:${lib.kind}:${lib.id}`, group: 'Biblioteca', name: lib.name, lib });
  return list;
}

/** Ataques, dano, testes e iniciativa da criatura escolhida, já com os bônus da ficha. */
function creatureRolls(creature) {
  const stats = creature.lib?.stats ?? {};
  const attacks = stats.attacks ?? [];
  const mod = (key) => modOf(stats.abilities?.[key]);
  const base = creature.lib ? { library_kind: creature.lib.kind, library_id: creature.lib.id, label: creature.name } : null;
  return h('div', { class: 'stack tp-sheet-rolls' },
    attacks.length > 0 && h('h4', {}, 'Ataques'),
    base && attacks.map((attack, index) => h('div', { class: 'weapon-row' },
      h('div', { class: 'weapon-name' }, h('strong', {}, attack.name), h('small', { class: 'muted' }, attack.damage)),
      h('button', { type: 'button', class: 'primary', onclick: () => rollD20({ kind: 'monster_attack', index, ...base }) }, `Atacar ${attack.bonus || '+0'}`),
      attack.damage && h('button', { type: 'button', onclick: () => roll({ kind: 'monster_damage', index, ...base }) }, 'Dano'))),
    h('h4', {}, 'Testes'),
    h('div', { class: 'ability-buttons' }, meta.abilities.map((a) => h('button', {
      type: 'button',
      title: `Teste de ${a.label}`,
      onclick: () => roll({ kind: 'dice', expression: `1d20${mod(a.key) ? signed(mod(a.key)) : ''}`, label: `${creature.name} (${a.label})` }),
    }, a.short, h('b', {}, signed(mod(a.key)))))),
    h('button', {
      type: 'button',
      onclick: () => roll({ kind: 'dice', expression: `1d20${mod('dex') ? signed(mod('dex')) : ''}`, label: `${creature.name} (Iniciativa)` }),
    }, `Iniciativa ${signed(mod('dex'))}`),
    !creature.lib && h('p', { class: 'muted' }, 'Esta criatura não tem ficha na Biblioteca: os testes usam +0. Use os dados livres abaixo.'));
}

function renderDiceTools() {
  const box = el('tp-dice');
  if (!box) return;
  const gm = isGm();
  const creatures = gm ? gmCreatures() : [];
  const creature = creatures.find((item) => item.key === rollAs) ?? null;
  if (gm && rollAs && !creature) rollAs = '';
  const label = h('input', { id: 'tp-roll-label', placeholder: 'Nome na rolagem (ex.: Armadilha)', maxlength: 60, value: el('tp-roll-label')?.value ?? '', 'aria-label': 'Nome na rolagem' });
  const expression = h('input', { placeholder: 'Ex.: 2d6+3', 'aria-label': 'Outra rolagem' });
  const asLabel = () => (gm ? (creature?.name ?? label.value) : undefined);
  const groups = [...new Set(creatures.map((item) => item.group))];
  const picker = gm && h('label', { class: 'tp-roll-as' }, 'Rolar por',
    h('select', { onchange: (event) => { rollAs = event.target.value; renderDiceTools(); } },
      h('option', { value: '', selected: !rollAs }, 'Mestre (dados livres)'),
      groups.map((group) => h('optgroup', { label: group }, creatures.filter((item) => item.group === group).map((item) =>
        h('option', { value: item.key, selected: item.key === rollAs }, item.name))))));
  // Jogador com ficha: os testes, perícias, armas e iniciativa dela aparecem aqui mesmo, no chat.
  const member = gm ? null : myMember();
  fill(box,

    secretSwitch(),
    picker,
    gm && !creature && label,
    modeSwitch(renderDiceTools),
    creature && creatureRolls(creature),
    member && sheetRolls(member, { compact: true }),
    (member || creature) && h('h4', {}, 'Outros dados'),
    !isGm() && !member && h('p', { class: 'muted' }, 'Escolha sua ficha na aba Mesa para rolar testes, perícias e ataques daqui.'),
    h('div', { class: 'die-row' }, [4, 6, 8, 10, 12, 20, 100].map((sides) => h('button', {
      type: 'button',
      onclick: () => (sides === 20
        ? (isGm() ? rollD20({ kind: 'plain', label: asLabel() }) : (myMember() ? rollD20({ kind: 'plain' }) : roll({ kind: 'dice', expression: '1d20' })))
        : roll({ kind: 'dice', expression: `1d${sides}`, label: asLabel() })),
    }, `d${sides}`))),
    h('form', { class: 'roll-row', onsubmit: (event) => { event.preventDefault(); roll({ kind: 'dice', expression: expression.value, label: asLabel() }); } },
      expression, h('button', {}, 'Rolar')),
  );
}

// ---------- Iniciativa (faixa no chat, para todos) ----------

function renderInitiativeBanner() {
  const box = el('tp-initiative');
  if (!box) return;
  box.hidden = !initiative.active;
  if (!initiative.active) return;
  fill(box,
    h('strong', {}, `Rodada ${initiative.round}`),
    h('ol', { class: 'tp-order' }, initiative.entries.map((entry) => h('li', {
      class: `${entry.id === initiative.current_id ? 'current' : ''} ${entry.kind}`,
      'aria-current': entry.id === initiative.current_id ? 'true' : undefined,
    }, h('b', {}, String(entry.initiative)), ` ${entry.name}`, entry.hidden ? ' (oculto)' : ''))),
  );
}

// ---------- Ficha do jogador ----------

function stateEditor(member) {
  const number = (value, props = {}) => h('input', { type: 'number', min: 0, value, inputmode: 'numeric', ...props });
  const hp = number(member.current_hp, { max: member.max_hp });
  const temp = number(member.temp_hp);
  const inspiration = h('input', { type: 'checkbox', checked: Boolean(member.inspiration) });
  const conditions = h('textarea', { rows: 2 }, member.conditions.join('\n'));
  const inventory = h('textarea', { rows: 4 }, member.inventory.join('\n'));
  const lines = (input) => input.value.split('\n').map((line) => line.trim()).filter(Boolean);
  return h('details', { class: 'tp-state' },
    h('summary', { class: 'muted' }, 'Ajustar PV, condições e inventário'),
    h('form', {
      class: 'manual-form stack',
      onsubmit: async (event) => {
        event.preventDefault();
        await patchParty(member.character_id, {
          current_hp: Number(hp.value), temp_hp: Number(temp.value), inspiration: inspiration.checked,
          conditions: lines(conditions), inventory: lines(inventory),
        });
      },
    },
    h('div', { class: 'row' }, h('label', {}, 'PV', hp), h('label', {}, 'PV temp.', temp)),
    h('label', { class: 'check' }, inspiration, 'Inspiração'),
    h('label', {}, 'Condições (uma por linha)', conditions),
    h('label', {}, 'Inventário (um item por linha)', inventory),
    h('button', { class: 'primary' }, 'Salvar')));
}

function sheetRolls(member, { compact = false } = {}) {
  const { derived, sheet } = member;
  const skillProf = new Set(sheet.skill_proficiencies ?? []);
  const saveProf = new Set(sheet.save_proficiencies ?? []);
  const testButton = (label, value, body, proficient) =>
    h('button', { type: 'button', class: `test-btn${proficient ? ' prof' : ''}`, onclick: () => rollD20(body) }, h('span', {}, label), h('b', {}, signed(value)));
  const damageFormula = (text) => /^\s*(\d{1,2}\s*d\s*\d{1,3}(?:\s*[+-]\s*(?:\d{1,2}\s*d\s*\d{1,3}|\d{1,3}))*)/i.exec(text ?? '')?.[1].replace(/\s+/g, '') ?? null;
  // compact: dentro do painel de dados do chat (que já tem o "só para o Mestre" e o modo do d20).
  return h('div', { class: compact ? 'stack tp-sheet-rolls' : 'card dice-card stack' },
    !compact && h('h3', {}, 'Rolar'),
    !compact && secretSwitch(),
    !compact && modeSwitch(renderSheetPane),
    (sheet.attacks ?? []).length > 0 && h('h4', {}, 'Armas'),
    (sheet.attacks ?? []).map((attack, index) => {
      const formula = damageFormula(attack.damage);
      const crit = criticalWeapon === index;
      return h('div', { class: 'weapon-row' },
        h('div', { class: 'weapon-name' }, h('strong', {}, attack.name), h('small', { class: 'muted' }, attack.damage)),
        h('button', { type: 'button', class: 'primary', onclick: () => rollD20({ kind: 'attack', index }) }, `Atacar ${attack.bonus || '+0'}`),
        formula && h('button', { type: 'button', class: crit ? 'crit' : '', onclick: async () => { criticalWeapon = null; await roll({ kind: 'damage', index, critical: crit }); renderSheetPane(); } },
          crit ? 'Dano crítico' : `Dano ${formula}`));
    }),
    h('h4', {}, 'Testes'),
    h('div', { class: 'ability-buttons' }, meta.abilities.map((a) =>
      h('button', { type: 'button', title: `Teste de ${a.label}`, onclick: () => rollD20({ kind: 'attribute', key: a.key }) }, a.short, h('b', {}, signed(derived.modifiers[a.key]))))),
    h('button', { type: 'button', class: 'primary', onclick: () => rollD20({ kind: 'initiative' }) }, `Iniciativa ${signed(derived.initiative)}`),
    h('details', { class: 'roll-group' }, h('summary', {}, 'Perícias'),
      h('div', { class: 'test-grid' }, meta.skills.map((s) => testButton(s.label, derived.skills[s.key], { kind: 'skill', key: s.key }, skillProf.has(s.key))))),
    h('details', { class: 'roll-group' }, h('summary', {}, 'Salvaguardas'),
      h('div', { class: 'test-grid' }, meta.abilities.map((a) => testButton(a.label, derived.saves[a.key], { kind: 'save', key: a.key }, saveProf.has(a.key))))),
    member.current_hp === 0 && member.status === 'unconscious' &&
      h('button', { type: 'button', class: 'danger', onclick: () => roll({ kind: 'death' }) }, 'Salvaguarda contra a morte'));
}

function renderSheetPane() {
  if (isGm() || !el('tp-sheet')) return;
  render('tp-sheet', () => {
    const member = myMember();
    if (!member) {
      el('tp-sheet').replaceChildren(h('div', { class: 'card stack' },
        h('h3', {}, 'Escolha sua ficha'),
        h('p', { class: 'muted' }, 'Para rolar testes e ataques, escolha com qual personagem você joga nesta mesa.'),
        h('button', { type: 'button', class: 'primary', onclick: () => showPane('mesa') }, 'Escolher ficha')));
      return;
    }
    const { derived } = member;
    fill(el('tp-sheet'),
      h('div', { class: 'card stack' },
        h('div', { class: 'member-head' },
          member.avatar_url && h('img', { src: member.avatar_url, alt: `Retrato de ${member.name}` }),
          h('div', {}, h('div', { class: 'member-name' }, member.name), h('p', { class: 'muted' }, `${member.race}, ${member.class} ${member.level}`))),
        h('span', { class: `status-badge ${member.status}` }, STATUS_LABELS[member.status] ?? member.status),
        hpBar(member.current_hp, member.max_hp),
        h('p', {}, `PV ${member.current_hp}/${member.max_hp}${member.temp_hp ? ` + ${member.temp_hp} temp.` : ''}`),
        member.current_hp === 0 && h('p', { class: 'muted' }, `Contra a morte: ${member.death_successes} sucesso(s), ${member.death_failures} falha(s)`),
        h('div', { class: 'stat-grid' },
          [['CA', member.armor_class], ['Iniciativa', signed(derived.initiative)], ['Desloc.', member.speed],
            ['Proficiência', signed(derived.proficiency_bonus)], ['Perc. passiva', derived.passive_perception], ['Inspiração', member.inspiration ? 'Sim' : '—']]
            .map(([label, value]) => h('div', { class: 'stat' }, h('b', {}, String(value)), h('small', {}, label)))),
        member.conditions.length > 0 && h('div', { class: 'chips' }, member.conditions.map((c) => h('span', { class: 'chip condition' }, c))),
        stateEditor(member),
        h('button', {
          type: 'button',
          onclick: () => openSheetView(member, { state: member }),
        }, 'Ver ficha'),
        h('button', {
          type: 'button',
          onclick: () => {
            store.set('tables.return', String(table.id));
            document.dispatchEvent(new CustomEvent('open-character', { detail: member.character_id }));
          },
        }, 'Editar ficha')));
  });
}

// ---------- Painel do Mestre ----------

async function patchParty(characterId, body) {
  showError(el('table-error'), null);
  try {
    party = await api(tableUrl(`/party/${characterId}`), { method: 'PATCH', body });
    renderParty();
    return true;
  } catch (err) {
    fail(err);
    return false;
  }
}

function gmPartyCard(member) {
  const amount = h('input', { type: 'number', min: 1, max: 9999, inputmode: 'numeric', placeholder: 'Qtd.', 'aria-label': `Dano ou cura em ${member.name}` });
  const apply = (sign) => {
    const value = Number(amount.value);
    if (!Number.isInteger(value) || value <= 0) return fail(new Error('Digite quanto de dano ou cura.'));
    return patchParty(member.character_id, { hp_delta: sign * value });
  };
  const conditions = h('input', { value: member.conditions.join(', '), placeholder: 'Ex.: Envenenado, Caído', 'aria-label': `Condições de ${member.name}` });
  return h('article', { class: 'card tp-pc' },
    h('div', { class: 'member-head' },
      member.avatar_url ? h('img', { src: member.avatar_url, alt: '' }) : h('span', { class: 'table-avatar', 'aria-hidden': 'true' }, member.name[0]),
      h('div', {}, h('div', { class: 'member-name' }, member.name),
        h('p', { class: 'muted' }, `${member.owner_name} · ${member.race}, ${member.class} ${member.level} · CA ${member.armor_class}`))),
    hpBar(member.current_hp, member.max_hp),
    h('p', {}, h('strong', {}, `PV ${member.current_hp}/${member.max_hp}`), member.temp_hp ? ` + ${member.temp_hp} temp.` : '',
      ` · ${STATUS_LABELS[member.status] ?? member.status}`, member.inspiration ? ' · Inspiração' : ''),
    h('div', { class: 'tp-hp-row' }, amount,
      h('button', { type: 'button', class: 'danger', onclick: () => apply(-1) }, 'Dano'),
      h('button', { type: 'button', onclick: () => apply(1) }, 'Cura')),
    member.conditions.length > 0 && h('div', { class: 'chips' }, member.conditions.map((c) => h('span', { class: 'chip condition' }, c))),
    // O uso mais comum (dano e cura) fica à vista; o resto, num acordeão.
    h('details', { class: 'tp-more', open: partyOpen.has(member.character_id), ontoggle: (event) => { if (event.currentTarget.open) partyOpen.add(member.character_id); else partyOpen.delete(member.character_id); } },
      h('summary', {}, 'Condições, Inspiração e ficha'),
      h('div', { class: 'stack tp-more-body' },
        h('form', { class: 'tp-cond-row', onsubmit: (event) => { event.preventDefault(); patchParty(member.character_id, { conditions: conditions.value.split(',').map((c) => c.trim()).filter(Boolean) }); } },
          h('label', {}, 'Condições (separe por vírgula)', conditions), h('button', {}, 'Salvar')),
        h('div', { class: 'tp-pc-actions' },
          h('button', { type: 'button', class: 'small', onclick: () => patchParty(member.character_id, { inspiration: !member.inspiration }) }, member.inspiration ? 'Tirar Inspiração' : 'Dar Inspiração'),
          h('button', { type: 'button', class: 'small', onclick: () => openSheetView(member, { state: member }) }, 'Ver ficha'),
          h('button', {
            type: 'button',
            class: 'small',
            onclick: () => document.dispatchEvent(new CustomEvent('edit-foreign-character', { detail: { tableId: table.id, characterId: member.character_id, owner: member.owner_name } })),
          }, 'Editar ficha')))));
}
// Cartões de jogador com o acordeão aberto (continua aberto quando o painel se atualiza ao vivo).
const partyOpen = new Set();

function renderParty() {
  if (isGm()) {
    render('tp-side', () => {
      el('tp-party').replaceChildren(...(party.length
        ? party.map(gmPartyCard)
        : [emptyState({ icon: 'users', title: 'Ninguém na mesa ainda', text: 'Mande o código do convite (aba Grupo). Quem entrar escolhe a ficha e aparece aqui.', actions: [['Ver o convite', () => showPane('mesa'), true]] })]));
      renderInitiativeManager();
    });
  } else {
    renderSheetPane();
    // O painel de dados do chat também usa a ficha (testes e armas).
    render('tp-dice', renderDiceTools);
  }
}

async function saveInitiative(entries, extra = {}) {
  showError(el('table-error'), null);
  try {
    // A versão que estou vendo: se um jogador rolou nesse meio-tempo, o servidor recusa em vez de apagar a rolagem.
    initiative = await api(tableUrl('/initiative'), {
      method: 'PUT',
      body: { entries, round: initiative.round, current_id: initiative.current_id, version: initiative.version, ...extra },
    });
    renderInitiativeBanner();
    renderInitiativeManager();
  } catch (err) {
    if (err.code === 'stale') await loadInitiative().catch(() => {});
    fail(err);
  }
}

const entriesNow = () => initiative.entries.map((entry) => ({ ...entry }));

function startCombat() {
  const entries = party.map((member) => ({ id: `pc-${member.character_id}`, kind: 'pc', character_id: member.character_id, name: member.name, initiative: 0 }));
  saveInitiative(entries.length ? entries : [{ id: newId('x'), kind: 'npc', name: 'Aliado', initiative: 0, max_hp: 0 }], { round: 1 });
}

function addFromLibrary(entryKey, quantity) {
  const entry = library.find((item) => `${item.kind}:${item.id}` === entryKey);
  if (!entry) return fail(new Error('Escolha uma ficha da Biblioteca.'));
  const entries = entriesNow();
  const count = Math.max(1, Math.min(10, Number(quantity) || 1));
  const same = entries.filter((item) => item.library_id === entry.id && item.library_kind === entry.kind).length;
  for (let i = 0; i < count; i += 1) {
    const number = same + i + 1;
    entries.push({
      id: newId('m'),
      kind: entry.kind === 'npc' ? 'npc' : 'monster',
      name: count + same > 1 ? `${entry.name} ${number}` : entry.name,
      initiative: d20() + modOf(entry.stats?.abilities?.dex),
      max_hp: entry.stats?.max_hp ?? 0,
      hp: entry.stats?.max_hp ?? 0,
      library_id: entry.id,
      library_kind: entry.kind,
      hidden: !entry.revealed,
    });
  }
  return saveInitiative(entries);
}

function initiativeRow(entry) {
  const entries = entriesNow();
  const update = (changes) => saveInitiative(entries.map((item) => (item.id === entry.id ? { ...item, ...changes } : item)));
  const init = h('input', { type: 'number', value: entry.initiative, min: -10, max: 60, class: 'tp-init', 'aria-label': `Iniciativa de ${entry.name}`, onchange: (event) => update({ initiative: Number(event.target.value) }) });
  const pc = entry.kind === 'pc' ? party.find((member) => member.character_id === entry.character_id) : null;
  const libraryEntry = entry.library_id ? library.find((item) => item.id === entry.library_id && item.kind === entry.library_kind) : null;
  const hpInput = h('input', { type: 'number', min: 1, inputmode: 'numeric', placeholder: 'Qtd.', class: 'tp-hp-amount', 'aria-label': `Dano ou cura em ${entry.name}` });
  const changeHp = (sign) => {
    const value = Number(hpInput.value);
    if (!Number.isInteger(value) || value <= 0) return fail(new Error('Digite quanto de dano ou cura.'));
    return update({ hp: Math.max(0, Math.min(entry.max_hp || 9999, (entry.hp ?? 0) + sign * value)) });
  };
  return h('li', { class: `tp-init-row ${entry.id === initiative.current_id ? 'current' : ''} ${entry.hp === 0 && entry.kind !== 'pc' ? 'down' : ''}` },
    init,
    h('div', { class: 'tp-init-name' },
      h('strong', {}, entry.name),
      pc && h('small', {}, `PV ${pc.current_hp}/${pc.max_hp}`),
      entry.kind !== 'pc' && h('small', {}, `PV ${entry.hp}/${entry.max_hp}${entry.hp === 0 ? ' · caído' : ''}`),
      entry.kind !== 'pc' && entry.max_hp > 0 && hpBar(entry.hp, entry.max_hp)),
    h('div', { class: 'tp-init-tools' },
      entry.kind !== 'pc' && h('div', { class: 'tp-hp-row' }, hpInput,
        h('button', { type: 'button', class: 'small danger', onclick: () => changeHp(-1) }, 'Dano'),
        h('button', { type: 'button', class: 'small', onclick: () => changeHp(1) }, 'Cura')),
      libraryEntry?.stats?.attacks?.length > 0 && h('div', { class: 'tp-attack-buttons' }, libraryEntry.stats.attacks.map((attack, index) =>
        h('button', { type: 'button', class: 'small', title: `${attack.damage}`, onclick: () => roll({ kind: 'monster_attack', library_kind: libraryEntry.kind, library_id: libraryEntry.id, index, label: entry.name }) }, `Atacar: ${attack.name}`))),
      h('div', { class: 'tp-init-actions' },
        h('button', { type: 'button', class: 'small', 'aria-pressed': String(Boolean(entry.hidden)), title: entry.hidden ? 'Oculto para os jogadores' : 'Visível para os jogadores', onclick: () => update({ hidden: !entry.hidden }) }, entry.hidden ? 'Oculto' : 'Visível'),
        h('button', { type: 'button', class: 'small', 'aria-label': `Tirar ${entry.name} da iniciativa`, onclick: () => saveInitiative(entries.filter((item) => item.id !== entry.id)) }, '✕'))));
}

function renderInitiativeManager() {
  const box = el('tp-initiative-manager');
  if (!box) return;
  if (!initiative.active) {
    box.replaceChildren(

      h('p', { class: 'muted' }, 'Ao começar o combate, os jogadores entram na ordem e rolam a iniciativa pelos Dados do chat. Monstros entram pela Biblioteca, já com a iniciativa rolada.'),
      h('button', { type: 'button', class: 'primary', onclick: startCombat }, 'Começar combate'));
    return;
  }
  const monsters = library.filter((entry) => entry.kind !== 'location');
  const pick = h('select', { 'aria-label': 'Ficha da Biblioteca' },
    h('option', { value: '' }, monsters.length ? 'Escolha um monstro ou NPC' : 'Crie fichas na Biblioteca'),
    monsters.map((entry) => h('option', { value: `${entry.kind}:${entry.id}` }, `${entry.name} (${KIND_LABELS[entry.kind]})`)));
  const quantity = h('input', { type: 'number', min: 1, max: 10, value: 1, 'aria-label': 'Quantidade', class: 'tp-qty' });
  const quickName = h('input', { placeholder: 'Nome', maxlength: 60, 'aria-label': 'Nome' });
  const quickInit = h('input', { type: 'number', placeholder: 'Inic.', 'aria-label': 'Iniciativa', class: 'tp-qty' });
  const quickHp = h('input', { type: 'number', placeholder: 'PV', min: 0, 'aria-label': 'PV', class: 'tp-qty' });
  const missing = party.filter((member) => !initiative.entries.some((entry) => entry.character_id === member.character_id));
  fill(box,
    h('div', { class: 'tp-init-head' }, h('strong', {}, `Rodada ${initiative.round}`),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'small', onclick: () => api(tableUrl('/initiative/next'), { method: 'POST', body: { back: true } }).then((state) => { initiative = state; renderInitiativeBanner(); renderInitiativeManager(); }, fail) }, 'Turno anterior'),
        h('button', { type: 'button', class: 'primary', onclick: () => api(tableUrl('/initiative/next'), { method: 'POST', body: {} }).then((state) => { initiative = state; renderInitiativeBanner(); renderInitiativeManager(); }, fail) }, 'Próximo turno'))),
    h('ol', { class: 'tp-init-list' }, initiative.entries.map(initiativeRow)),
    missing.length > 0 && h('button', {
      type: 'button',
      class: 'small',
      onclick: () => saveInitiative([...entriesNow(), ...missing.map((member) => ({ id: `pc-${member.character_id}`, kind: 'pc', character_id: member.character_id, name: member.name, initiative: 0 }))]),
    }, `Adicionar ${missing.length === 1 ? missing[0].name : 'jogadores que faltam'}`),
    h('form', { class: 'tp-add-row', onsubmit: (event) => { event.preventDefault(); addFromLibrary(pick.value, quantity.value); } },
      pick, quantity, h('button', {}, 'Adicionar')),
    h('form', {
      class: 'tp-add-row',
      onsubmit: (event) => {
        event.preventDefault();
        if (!quickName.value.trim()) return fail(new Error('Dê um nome.'));
        const hp = Number(quickHp.value) || 0;
        return saveInitiative([...entriesNow(), { id: newId('q'), kind: 'monster', name: quickName.value.trim(), initiative: Number(quickInit.value) || d20(), max_hp: hp, hp }]);
      },
    }, quickName, quickInit, quickHp, h('button', {}, 'Rápido')),
    h('button', { type: 'button', class: 'danger small', onclick: () => { if (window.confirm('Encerrar o combate? A ordem de iniciativa será apagada.')) saveInitiative([]); } }, 'Encerrar combate'));
}

// ---------- Biblioteca ----------

export function statsFields(stats = {}) {
  const field = (name, label, value, props = {}) => h('label', {}, label, h('input', { name, value: value ?? '', ...props }));
  const attacks = h('div', { class: 'stack tp-attacks' });
  const addAttack = (attack = {}) => attacks.append(h('div', { class: 'tp-attack' },
    h('input', { name: 'attack_name', placeholder: 'Ataque (ex.: Cimitarra)', value: attack.name ?? '', maxlength: 60, 'aria-label': 'Nome do ataque' }),
    h('input', { name: 'attack_bonus', placeholder: '+4', value: attack.bonus ?? '', maxlength: 10, 'aria-label': 'Bônus de ataque' }),
    h('input', { name: 'attack_damage', placeholder: '1d6+2 cortante', value: attack.damage ?? '', maxlength: 60, 'aria-label': 'Dano' }),
    h('button', { type: 'button', class: 'small', 'aria-label': 'Remover ataque', onclick: (event) => event.currentTarget.parentElement.remove() }, '✕')));
  for (const attack of stats.attacks ?? []) addAttack(attack);
  if (!(stats.attacks ?? []).length) addAttack();
  return h('fieldset', { class: 'tp-stats stack' },
    h('legend', {}, 'Estatísticas'),
    h('div', { class: 'tp-stat-grid' },
      field('armor_class', 'CA', stats.armor_class ?? 10, { type: 'number', min: 0, max: 40 }),
      field('max_hp', 'PV', stats.max_hp ?? 10, { type: 'number', min: 1, max: 9999 }),
      field('speed', 'Desloc.', stats.speed ?? '9 m', { maxlength: 40 }),
      field('challenge', 'ND', stats.challenge ?? '', { maxlength: 20 })),
    h('div', { class: 'tp-ability-grid' }, meta.abilities.map((a) => field(`ab_${a.key}`, a.short, stats.abilities?.[a.key] ?? 10, { type: 'number', min: 1, max: 30 }))),
    h('div', { class: 'tp-attacks-head' }, h('strong', {}, 'Ataques'), h('button', { type: 'button', class: 'small', onclick: () => addAttack() }, '+ Ataque')),
    attacks,
    h('label', {}, 'Anotações (habilidades, táticas)', h('textarea', { name: 'notes', rows: 3, maxlength: 4000 }, stats.notes ?? '')));
}

export function readStats(form) {
  const value = (name) => form.elements[name]?.value;
  const names = [...form.querySelectorAll('[name=attack_name]')];
  return {
    armor_class: Number(value('armor_class')),
    max_hp: Number(value('max_hp')),
    speed: value('speed'),
    challenge: value('challenge'),
    abilities: Object.fromEntries(meta.abilities.map((a) => [a.key, Number(value(`ab_${a.key}`))])),
    attacks: names.map((input) => {
      const row = input.parentElement;
      return { name: input.value.trim(), bonus: row.querySelector('[name=attack_bonus]').value.trim(), damage: row.querySelector('[name=attack_damage]').value.trim() };
    }).filter((attack) => attack.name),
    notes: value('notes'),
  };
}

/**
 * Formulário de NPC, monstro ou local. Serve para a Biblioteca da mesa (mode 'library') e para
 * "Meus modelos" (mode 'template'). onSubmit(body, { saveAsTemplate }) grava; onClose fecha.
 */
export function entityForm({ entry = null, mode = 'library', templates = [], onSubmit, onClose }) {
  let kind = entry?.kind ?? 'monster';
  let image = null;
  // Imagem herdada de um dos meus modelos (o servidor copia, sem precisar enviar de novo).
  let imageFrom = null;
  const form = h('form', { class: 'card stack tp-library-form' });
  const library = mode === 'library';

  const draw = (preset = null) => {
    const source = preset ?? entry ?? {};
    const stats = preset?.stats ?? entry?.stats ?? {};
    const builtIn = kind === 'monster' ? MONSTER_PRESETS : kind === 'npc' ? NPC_PRESETS : [];
    const mine = library ? templates.filter((item) => item.kind === kind) : [];
    const choices = [...mine.map((item) => ({ group: 'mine', item })), ...builtIn.map((item) => ({ group: 'srd', item }))];
    const presetSelect = !entry && choices.length > 0 && h('label', {}, 'Começar de um modelo (opcional)', h('select', {
      onchange: (event) => {
        const chosen = choices[Number(event.target.value)];
        if (!chosen) return;
        image = null;
        imageFrom = chosen.group === 'mine' ? chosen.item.image_url : null;
        draw(chosen.item);
      },
    },
    h('option', { value: '' }, 'Escolha para preencher a ficha'),
    mine.length > 0 && h('optgroup', { label: 'Meus modelos' }, choices.map((choice, index) => (choice.group === 'mine' ? h('option', { value: String(index) }, choice.item.name) : null))),
    builtIn.length > 0 && h('optgroup', { label: 'Modelos prontos (D&D 5e, regras básicas)' }, choices.map((choice, index) => (choice.group === 'srd' ? h('option', { value: String(index) }, choice.item.name) : null)))));
    const preview = image ?? imageFrom ?? entry?.image_url;
    fill(form,
      h('div', { class: 'editor-head' },
        h('h3', {}, entry ? `Editar ${entry.name}` : library ? 'Nova ficha na Biblioteca' : 'Novo modelo'),
        h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Fechar', onclick: onClose }, '✕')),
      !entry && h('div', { class: 'segmented small-seg', role: 'radiogroup', 'aria-label': 'Tipo' }, Object.entries(KIND_LABELS).map(([key, label]) =>
        h('button', { type: 'button', role: 'radio', class: kind === key ? 'active' : '', 'aria-checked': String(kind === key), onclick: () => { kind = key; image = null; imageFrom = null; draw(); } }, label))),
      presetSelect,
      h('label', {}, 'Nome', h('input', { name: 'name', required: true, maxlength: 100, value: source.name ?? '' })),
      h('label', {}, kind === 'location' || !library ? 'Descrição' : 'Descrição (o que os jogadores veem quando você revelar)', h('textarea', { name: 'description', rows: 3, maxlength: 4000 }, source.description ?? '')),
      h('div', { class: 'tp-image-pick' },
        preview && h('img', { src: preview, alt: '', class: 'tp-thumb' }),
        h('label', { class: 'button-like' }, preview ? 'Trocar imagem' : 'Escolher imagem',
          h('input', {
            type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true,
            onchange: async (event) => {
              const [file] = event.target.files;
              if (!file) return;
              try { image = await shrinkImage(file, 1024); imageFrom = null; draw(readCurrent()); } catch (err) { showError(form.querySelector('.tp-form-error'), err); }
            },
          }))),
      kind !== 'location' && statsFields(stats),
      library && !entry && h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'revealed' }), 'Já mostrar para os jogadores'),
      library && !entry && h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'save_template' }), 'Guardar também em Meus modelos (para usar em outras mesas)'),
      h('button', { class: 'primary big' }, entry ? 'Salvar' : library ? 'Criar ficha' : 'Guardar modelo'),
      h('p', { class: 'error tp-form-error', role: 'alert', hidden: true }),
    );
  };
  // Mantém o que já foi digitado quando a tela redesenha (ex.: depois de escolher a imagem).
  const readCurrent = () => ({
    name: form.elements.name?.value, description: form.elements.description?.value,
    stats: kind === 'location' ? {} : readStats(form),
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = {
      kind,
      name: form.elements.name.value,
      description: form.elements.description.value,
      ...(kind === 'location' ? {} : { stats: readStats(form) }),
      ...(image ? { image } : imageFrom ? { image_from: imageFrom } : {}),
      ...(library && !entry ? { revealed: form.elements.revealed.checked } : {}),
    };
    const button = form.querySelector('button.primary.big');
    button.disabled = true;
    try {
      await onSubmit(body, { saveAsTemplate: Boolean(form.elements.save_template?.checked) });
    } catch (err) {
      showError(form.querySelector('.tp-form-error'), err);
    } finally {
      button.disabled = false;
    }
  });
  draw();
  return form;
}

let myTemplates = [];

async function loadTemplates() {
  myTemplates = await api('/templates');
  return myTemplates;
}

function libraryForm(entry = null) {
  return entityForm({
    entry,
    mode: 'library',
    templates: myTemplates,
    onClose: closeLibraryForm,
    onSubmit: async (body, { saveAsTemplate }) => {
      if (entry) {
        await api(tableUrl(`/library/${entry.kind}/${entry.id}`), { method: 'PATCH', body });
      } else {
        const created = await api(tableUrl('/library'), { method: 'POST', body });
        if (saveAsTemplate) {
          await api('/templates/from-library', { method: 'POST', body: { table_id: table.id, kind: created.kind, id: created.id } })
            .then(loadTemplates)
            .catch((err) => toast(`A ficha foi criada, mas não entrou em Meus modelos: ${err.message}`));
        }
      }
      closeLibraryForm();
      await loadLibrary();
    },
  });
}

async function saveEntryAsTemplate(entry) {
  try {
    await api('/templates/from-library', { method: 'POST', body: { table_id: table.id, kind: entry.kind, id: entry.id } });
    await loadTemplates();
    toast(`${entry.name} foi guardado em Meus modelos. Use em qualquer mesa pela opção "Começar de um modelo".`);
  } catch (err) {
    fail(err);
  }
}

/** Criar ou editar ficha da Biblioteca: o formulário ocupa a aba e a lista sai da frente. */
async function openLibraryForm(entry = null) {
  libraryEditing = entry ?? 'new';
  await loadTemplates().catch(() => {});
  const holder = el('tp-library-form');
  holder.replaceChildren(libraryForm(entry));
  holder.hidden = false;
  el('table-pane-library').classList.add('is-editing');
  window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
  holder.querySelector('input[name=name]')?.focus();
}

function closeLibraryForm() {
  libraryEditing = null;
  el('table-pane-library').classList.remove('is-editing');
  el('tp-library-form').hidden = true;
  el('tp-library-form').replaceChildren();
}

async function duplicateEntry(entry) {
  let name = `${entry.name} (cópia)`;
  for (let n = 2; library.some((item) => item.kind === entry.kind && item.name.toLowerCase() === name.toLowerCase()); n += 1) name = `${entry.name} (cópia ${n})`;
  try {
    await api(tableUrl('/library'), { method: 'POST', body: { kind: entry.kind, name, description: entry.description, stats: entry.stats } });
    await loadLibrary();
  } catch (err) {
    fail(err);
  }
}

function libraryCard(entry) {
  const gm = isGm();
  const stats = entry.stats ?? {};
  return h('article', { class: `card tp-library-card ${gm && !entry.revealed ? 'is-hidden' : ''}` },
    entry.image_url && h('a', { href: entry.image_url, target: '_blank', rel: 'noopener' }, h('img', { src: entry.image_url, alt: '', class: 'tp-library-image', loading: 'lazy' })),
    h('div', { class: 'stack tp-library-body' },
      h('div', {},
        h('strong', { class: 'tp-library-name' }, entry.name),
        h('small', { class: 'muted' }, ` ${KIND_LABELS[entry.kind]}`),
        gm && h('span', { class: `chip ${entry.revealed ? 'chip-shown' : 'chip-hidden'}` }, entry.revealed ? 'Revelado' : 'Oculto')),
      entry.description && h('p', { class: 'prewrap tp-library-desc' }, entry.description),
      gm && entry.kind !== 'location' && h('p', { class: 'muted' },
        `CA ${stats.armor_class ?? '—'} · PV ${stats.max_hp ?? '—'} · ${stats.speed ?? ''}${stats.challenge ? ` · ND ${stats.challenge}` : ''}`),
      gm && entry.kind !== 'location' && h('p', { class: 'muted tp-abilities' }, meta.abilities.map((a) => `${a.short} ${stats.abilities?.[a.key] ?? 10} (${signed(modOf(stats.abilities?.[a.key]))})`).join(' · ')),
      gm && (stats.attacks ?? []).length > 0 && h('div', { class: 'tp-attack-buttons' }, stats.attacks.map((attack, index) => h('div', { class: 'tp-attack-line' },
        h('span', {}, `${attack.name} ${attack.bonus || ''} · ${attack.damage}`),
        h('button', { type: 'button', class: 'small', onclick: () => roll({ kind: 'monster_attack', library_kind: entry.kind, library_id: entry.id, index }) }, 'Atacar'),
        attack.damage && h('button', { type: 'button', class: 'small', onclick: () => roll({ kind: 'monster_damage', library_kind: entry.kind, library_id: entry.id, index }) }, 'Dano')))),
      gm && stats.notes && h('details', {}, h('summary', { class: 'muted' }, 'Anotações'), h('p', { class: 'prewrap' }, stats.notes)),
      // Ações: a principal fica à vista (Revelar/Ocultar e, para criaturas, pôr na iniciativa); o resto em "⋯ Mais".
      gm && h('div', { class: 'tp-library-actions' },
        h('button', {
          type: 'button',
          class: entry.revealed ? 'small' : 'small primary',
          onclick: () => api(tableUrl(`/library/${entry.kind}/${entry.id}`), { method: 'PATCH', body: { revealed: !entry.revealed } }).then(loadLibrary, fail),
        }, entry.revealed ? 'Ocultar' : 'Revelar'),
        entry.kind !== 'location' && h('button', {
          type: 'button',
          class: 'small',
          onclick: async () => {
            if (!initiative.active) await saveInitiative(party.map((m) => ({ id: `pc-${m.character_id}`, kind: 'pc', character_id: m.character_id, name: m.name, initiative: 0 })), { round: 1 });
            await addFromLibrary(`${entry.kind}:${entry.id}`, 1);
            // Volta para o Jogo, onde a iniciativa fica ao lado do chat.
            showPane('chat');
            toggleSide(true);
          },
        }, 'Pôr na iniciativa'),
        moreMenu(`Mais ações para ${entry.name}`, [
          ['Editar', () => openLibraryForm(entry)],
          ['Duplicar', () => duplicateEntry(entry)],
          ['Guardar em Meus modelos', () => saveEntryAsTemplate(entry)],
          ['Excluir', () => {
            if (!window.confirm(`Excluir ${entry.name} da Biblioteca?`)) return;
            api(tableUrl(`/library/${entry.kind}/${entry.id}`), { method: 'DELETE' }).then(loadLibrary, fail);
          }, 'danger'],
        ]))));
}

/** Botão "⋯ Mais" com uma lista curta de ações (fecha ao escolher, ao clicar fora ou com Esc). */
function moreMenu(label, items) {
  const menu = h('details', { class: 'more-menu' },
    h('summary', { class: 'button-like small', 'aria-label': label, title: label }, '⋯ Mais'),
    h('div', { class: 'more-menu-list', role: 'menu' }, items.map(([text, action, className]) => h('button', {
      type: 'button',
      role: 'menuitem',
      class: `menu-item ${className ?? ''}`,
      onclick: () => { menu.open = false; action(); },
    }, text))));
  menu.addEventListener('keydown', (event) => { if (event.key === 'Escape') { menu.open = false; menu.querySelector('summary').focus(); } });
  return menu;
}
document.addEventListener('click', (event) => {
  for (const menu of document.querySelectorAll('.more-menu[open]')) if (!menu.contains(event.target)) menu.open = false;
});

function renderLibrary() {
  render('table-pane-library', () => {
    const gm = isGm();
    const visible = library.filter((entry) => libraryFilter === 'all' || entry.kind === libraryFilter);
    fill(el('tp-library-tools'),
      library.length > 0 && h('div', { class: 'library-filters', role: 'group', 'aria-label': 'Filtrar' }, [['all', 'Tudo'], ['npc', 'NPCs'], ['monster', 'Monstros'], ['location', 'Locais']].map(([key, label]) =>
        h('button', { type: 'button', class: `small ${libraryFilter === key ? 'active' : ''}`, 'aria-pressed': String(libraryFilter === key), onclick: () => { libraryFilter = key; renderLibrary(); } }, label))),
      gm && library.length > 0 && h('div', { class: 'row' },
        h('button', { type: 'button', class: 'small', onclick: () => document.dispatchEvent(new CustomEvent('show-view', { detail: 'templates' })) }, 'Meus modelos'),
        h('button', { type: 'button', class: 'primary', onclick: () => openLibraryForm() }, '+ Nova ficha')));
    el('tp-library-list').replaceChildren(...(visible.length
      ? visible.map(libraryCard)
      : [library.length
        ? h('p', { class: 'muted tp-empty' }, 'Nada deste tipo por aqui.')
        : gm
          ? emptyState({
            icon: 'book',
            title: 'Monte a Biblioteca da mesa',
            text: 'NPCs, monstros e locais da sua história. Tudo começa oculto e você revela aos jogadores quando quiser.',
            actions: [['Criar primeira ficha', () => openLibraryForm(), true],
              ['Meus modelos', () => document.dispatchEvent(new CustomEvent('show-view', { detail: 'templates' }))]],
          })
          : emptyState({ icon: 'book', title: 'Nada revelado ainda', text: 'Os NPCs, monstros e lugares que o Mestre mostrar aparecem aqui.' })]));
  });
}

function renderGallery() {
  const box = el('tp-gallery');
  if (!box) return;
  box.hidden = !gallery.length;
  if (!gallery.length) return;
  fill(box,
    h('h3', {}, 'Imagens da mesa'),
    gallery.length
      ? h('div', { class: 'tp-gallery-grid' }, gallery.map((message) => h('figure', {},
        h('a', { href: message.image_url, target: '_blank', rel: 'noopener' }, h('img', { src: message.image_url, alt: message.text || 'Imagem da mesa', loading: 'lazy' })),
        h('figcaption', {}, message.text || '', message.visibility !== 'all' && h('small', { class: 'tp-private' }, ` ${privacyLabel(message)}`)))))
      : null);
}

// ---------- Notas do Mestre ----------

function noteCard(note) {
  const title = h('input', { value: note.title, maxlength: 120, placeholder: 'Título', 'aria-label': 'Título da nota' });
  const body = h('textarea', { rows: 6, maxlength: 20000, placeholder: 'Planos, segredos, ganchos...' }, note.body);
  const status = h('small', { class: 'muted', role: 'status' });
  let timer = null;
  const save = async () => {
    clearTimeout(timer);
    // Saiu da mesa (ou foi removido) antes de salvar: não há mais onde gravar.
    if (!table) return;
    if (title.value === note.title && body.value === note.body) return;
    try {
      Object.assign(note, await api(tableUrl(`/notes/${note.id}`), { method: 'PATCH', body: { title: title.value, body: body.value } }));
      status.textContent = 'Salvo.';
    } catch (err) {
      fail(err);
    }
  };
  const later = () => { status.textContent = ''; clearTimeout(timer); timer = setTimeout(save, 1500); };
  title.addEventListener('input', later);
  body.addEventListener('input', later);
  title.addEventListener('blur', save);
  body.addEventListener('blur', save);
  return h('article', { class: 'card stack tp-note' }, title, body,
    h('div', { class: 'row' }, status, h('button', {
      type: 'button',
      class: 'small danger',
      onclick: () => {
        if (!window.confirm('Apagar esta nota?')) return;
        api(tableUrl(`/notes/${note.id}`), { method: 'DELETE' }).then(loadNotes, fail);
      },
    }, 'Apagar')));
}

function renderNotes() {
  if (!el('tp-notes')) return;
  const create = () => api(tableUrl('/notes'), { method: 'POST', body: { title: 'Nova nota' } }).then(loadNotes, fail);
  if (!notes.length) {
    fill(el('tp-notes'), emptyState({
      icon: 'note', title: 'Suas anotações de Mestre', text: 'Planos, segredos e ganchos da história. Só você vê, e as notas salvam sozinhas.',
      actions: [['Criar primeira nota', create, true]],
    }));
    return;
  }
  fill(el('tp-notes'),
    h('div', { class: 'section-head' }, h('p', { class: 'muted' }, 'Só você vê estas notas. Elas salvam sozinhas.'),
      h('button', { type: 'button', class: 'primary', onclick: create }, '+ Nova nota')),
    h('div', { class: 'tp-notes-grid' }, notes.map(noteCard)));
}

// ---------- Carregamento ----------

async function loadParty() {
  const data = await fetchForTable('/party');
  if (!data) return;
  party = data;
  renderParty();
}

async function loadInitiative() {
  const data = await fetchForTable('/initiative');
  if (!data) return;
  initiative = data;
  renderInitiativeBanner();
  renderInitiativeManager();
  if (isGm()) render('tp-dice', renderDiceTools);
}

async function loadLibrary() {
  const data = await fetchForTable('/library');
  if (!data) return;
  library = data;
  renderLibrary();
  // A lista "Rolar por" do Mestre usa a Biblioteca.
  if (isGm()) render('tp-dice', renderDiceTools);
  renderComposerOptions();
  if (isGm()) renderInitiativeManager();
}

async function loadGallery() {
  const data = await fetchForTable('/gallery');
  if (!data) return;
  gallery = data;
  renderGallery();
}

async function loadNotes() {
  if (!isGm()) return;
  const data = await fetchForTable('/notes');
  if (!data) return;
  notes = data;
  renderNotes();
}

// ---------- Tempo real ----------

function setLive(state) {
  const badge = el('tp-live');
  if (!badge) return;
  badge.dataset.state = state;
  badge.textContent = state === 'on' ? '● ao vivo' : state === 'connecting' ? '○ conectando...' : '○ sem conexão, tentando de novo...';
}

function handleEvent(event, data) {
  if (event === 'message') addMessages([data], { live: true });
  else if (event === 'party') loadParty().catch(() => {});
  else if (event === 'initiative') { initiative = data; renderInitiativeBanner(); renderInitiativeManager(); if (isGm()) render('tp-dice', renderDiceTools); }
  else if (event === 'library') { loadLibrary().catch(() => {}); if (pane === 'library') loadGallery().catch(() => {}); }
  else if (event === 'table') hooks.onTable();
  else if (event === 'kicked') { stopStream(); hooks.onGone(); }
  // O login venceu: volta para a tela de entrar.
  else if (event === 'expired') { stopStream(); document.dispatchEvent(new CustomEvent('auth-expired')); }
}

function startStream() {
  stopStream();
  const current = { controller: new AbortController(), alive: true, retry: 0, tableId: table.id, attempt: 0 };
  stream = current;

  // Cada tentativa tem um número: uma tentativa antiga (cancelada ao voltar do bolso) não agenda outra,
  // senão duas conexões ficariam abertas ao mesmo tempo.
  const connect = async () => {
    if (!current.alive) return;
    const attempt = ++current.attempt;
    const stillMine = () => current.alive && attempt === current.attempt;
    setLive('connecting');
    try {
      const res = await fetch(`/api/tables/${current.tableId}/stream`, {
        headers: { authorization: `Bearer ${session.token}` },
        signal: current.controller.signal,
        cache: 'no-store',
      });
      if (res.status === 401) { document.dispatchEvent(new CustomEvent('auth-expired')); return; }
      if (res.status === 404) { stopStream(); hooks.onGone(); return; }
      if (!res.ok || !res.body) throw new Error('canal');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let first = true;
      for (;;) {
        const { value, done } = await reader.read();
        if (done || !stillMine()) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const name = /^event: (.*)$/m.exec(block)?.[1];
          const raw = /^data: (.*)$/m.exec(block)?.[1];
          if (!name) continue;
          if (name === 'ready') {
            current.retry = 0;
            setLive('on');
            // Ao reconectar, busca o que chegou enquanto estava fora.
            if (!first || lastId) Promise.all([catchUp(), loadParty(), loadInitiative(), loadLibrary()]).catch(() => {});
            first = false;
            continue;
          }
          handleEvent(name, raw ? JSON.parse(raw) : null);
        }
      }
    } catch {
      // Caiu (rede do celular, servidor reiniciando): tenta de novo abaixo.
    }
    if (!stillMine()) return;
    setLive('off');
    current.retry = Math.min(current.retry + 1, 6);
    current.timer = setTimeout(connect, 1000 * 2 ** (current.retry - 1));
  };
  current.reconnectNow = () => { clearTimeout(current.timer); current.controller.abort(); current.controller = new AbortController(); connect(); };
  connect();
}

function stopStream() {
  if (!stream) return;
  stream.alive = false;
  clearTimeout(stream.timer);
  stream.controller.abort();
  stream = null;
}

// Celular volta do bolso: reconecta na hora em vez de esperar o próximo intervalo.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && stream?.alive && el('tp-live')?.dataset.state !== 'on') stream.reconnectNow();
});

// ---------- Montagem ----------

function buildPanes() {
  const gm = isGm();
  const fileInput = h('input', {
    type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true,
    onchange: (event) => { const [file] = event.target.files; event.target.value = ''; if (file) sendImage(file); },
  });
  // Seções da coluna lateral (acordeões). Tudo que se usa durante a partida fica aqui, ao lado do chat.
  const sideSection = (key, title, open, body) => h('details', {
    class: 'accordion tp-side-section',
    open: sideOpen.get(key) ?? open,
    ontoggle: (event) => sideOpen.set(key, event.currentTarget.open),
  }, h('summary', {}, title), h('div', { class: 'accordion-body' }, body));
  const side = h('aside', { id: 'tp-side', class: 'tp-side', 'aria-label': gm ? 'Dados, iniciativa e jogadores' : 'Minha ficha e dados' },
    h('div', { class: 'tp-side-head' },
      h('strong', {}, gm ? 'Dados e mesa' : 'Ficha e dados'),
      h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Fechar', onclick: () => toggleSide(false) }, '✕')),
    ...(gm
      ? [sideSection('dados', 'Dados', true, h('div', { id: 'tp-dice', class: 'tp-dice stack' })),
        sideSection('iniciativa', 'Iniciativa', true, h('div', { id: 'tp-initiative-manager', class: 'stack tp-initiative-manager' })),
        sideSection('jogadores', 'Jogadores', true, h('div', { id: 'tp-party', class: 'tp-party' }))]
      : [sideSection('ficha', 'Minha ficha', true, h('div', { id: 'tp-sheet', class: 'tp-sheet' })),
        sideSection('dados', 'Dados', true, h('div', { id: 'tp-dice', class: 'tp-dice stack' }))]));

  el('table-pane-chat').replaceChildren(
    h('div', { id: 'tp-initiative', class: 'tp-initiative', hidden: true }),
    h('div', { class: 'tp-play' },
      h('div', { class: 'tp-main' },
        h('div', { id: 'tp-log', class: 'chat-log tp-log', role: 'log', 'aria-live': 'polite' }),
        h('form', { id: 'tp-compose', class: 'tp-compose', onsubmit: send },
          h('div', { class: 'tp-compose-top' },
            h('div', { id: 'tp-kind', class: 'segmented small-seg', role: 'radiogroup', 'aria-label': 'Tipo de mensagem' }),
            h('select', { id: 'tp-to', class: 'tp-to', 'aria-label': 'Para quem', title: 'Para quem vai a mensagem', onchange: (event) => el('tp-compose').classList.toggle('is-private', event.target.value !== 'all') })),
          h('input', { id: 'tp-as', list: 'tp-npc-names', maxlength: 60, placeholder: 'Quem fala? (ex.: Taverneiro)', 'aria-label': 'Quem fala', hidden: true }),
          h('datalist', { id: 'tp-npc-names' }),
          h('div', { class: 'chat-form' },
            h('textarea', {
              id: 'tp-input', rows: 1, maxlength: 4000, 'aria-label': 'Mensagem',
              // Cresce com o texto (até umas 5 linhas) em vez de ocupar espaço fixo.
              oninput: (event) => { const box = event.currentTarget; box.style.height = 'auto'; box.style.height = `${Math.min(box.scrollHeight, 140)}px`; },
              onkeydown: (event) => {
                if (event.key === 'Enter' && !event.shiftKey && !matchMedia('(pointer: coarse)').matches) { event.preventDefault(); el('tp-compose').requestSubmit(); }
              },
            }),
            h('button', { class: 'primary', id: 'tp-send' }, 'Enviar')),
          h('div', { class: 'tp-tools' },
            // No celular abre a gaveta com dados e fichas; no computador ela já fica aberta ao lado.
            h('button', { type: 'button', id: 'tp-dice-toggle', class: 'tp-side-toggle', 'aria-expanded': 'false', 'aria-controls': 'tp-side', onclick: () => toggleSide() },
              icon('dice', 18), gm ? 'Dados e mesa' : 'Ficha e dados'),
            h('label', { id: 'tp-image-tool', class: 'button-like', title: 'Enviar imagem para quem estiver em "Para". O texto da caixa vira a legenda.' }, icon('image', 18), 'Imagem', fileInput),
            h('span', { id: 'tp-image-status', class: 'muted', hidden: true })))),
      side));

  el('table-pane-sheet').replaceChildren();
  el('table-pane-panel').replaceChildren();
  el('table-pane-library').classList.remove('is-editing');
  el('table-pane-library').replaceChildren(
    h('div', { id: 'tp-library-tools', class: 'tp-library-tools' }),
    h('div', { id: 'tp-library-form', hidden: true }),
    h('div', { id: 'tp-library-list', class: 'tp-library-list' }),
    h('section', { id: 'tp-gallery', class: 'tp-gallery', hidden: true }));
  el('table-pane-notes').replaceChildren(h('div', { id: 'tp-notes' }));
}

// Quais seções da coluna lateral estão abertas (continua igual quando a mesa se atualiza).
const sideOpen = new Map();

/** Celular: abre ou fecha a gaveta de dados e fichas (no computador ela fica sempre à vista). */
function toggleSide(open) {
  const side = el('tp-side');
  if (!side) return;
  const next = open ?? !side.classList.contains('open');
  side.classList.toggle('open', next);
  document.body.classList.toggle('side-open', next);
  el('tp-dice-toggle')?.setAttribute('aria-expanded', String(next));
}

/** Atributos e perícias do sistema (carregados uma vez). */
export async function loadMeta() {
  meta ??= await api('/characters/meta');
  return meta;
}

/** Entra (ou atualiza) a mesa aberta. tableView vem de GET /tables/:id. */
export async function enterTable(tableView, nextHooks) {
  hooks = nextHooks;
  await loadMeta();
  const same = table?.id === tableView.id && stream?.alive;
  table = tableView;
  if (!same) {
    stopStream();
    secretRoll = (store.get(`tables.secret.${table.role}`) ?? (isGm() ? 'on' : 'off')) === 'on';
    composeKind = null;
    unread = 0;
    libraryFilter = 'all';
    libraryEditing = null;
    buildPanes();
    renderComposerOptions();
    renderDiceTools();
    await Promise.all([loadMessages(), loadParty(), loadInitiative(), loadLibrary(), loadNotes()]);
    // Trocou de mesa enquanto esta carregava: quem abre o canal é a mesa nova.
    if (table?.id !== tableView.id) return;
    startStream();
  } else {
    renderComposerOptions();
    renderParty();
  }
  showPane(store.get('tables.pane') || 'chat');
}

export function leaveTable() {
  stopStream();
  table = null;
  for (const id of ['table-pane-chat', 'table-pane-sheet', 'table-pane-panel', 'table-pane-library', 'table-pane-notes']) el(id)?.replaceChildren();
}

export function initTablePlay() {
  el('table-detail').addEventListener('focusout', flushDeferred);
}
