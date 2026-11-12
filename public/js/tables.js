import { api, h, showError, store } from './api.js';
import { icon } from './icons.js';
import { enterTable, initTablePlay, leaveTable } from './table-play.js';

/**
 * Aba Mesas: mesas em grupo com Mestre humano (sem IA, sem chave do Gemini).
 * Lista as mesas da pessoa; ao abrir uma, mostra jogadores, ficha e, para o Mestre, convite e pedidos.
 */

const el = (id) => document.getElementById(id);
let openId = null;
let busy = false;

const hueOf = (text) => [...String(text)].reduce((sum, char) => (sum * 31 + char.codePointAt(0)) % 360, 7);
const initial = (name) => [...String(name).trim()][0]?.toUpperCase() ?? '?';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Aviso de pedidos pendentes na aba Mesas (só aparece para quem é Mestre). */
function setBadge(count) {
  const badge = el('tables-badge');
  badge.textContent = count ? String(count) : '';
  badge.hidden = !count;
  badge.setAttribute('aria-label', count ? `${plural(count, 'pedido', 'pedidos')} para aprovar` : '');
}

export async function refreshTablesBadge() {
  const tables = await api('/tables');
  setBadge(tables.reduce((sum, table) => sum + (table.pending || 0), 0));
  return tables;
}

// ---------- Formulários de criar e entrar ----------

/** Criar ou entrar numa mesa: o formulário ocupa a tela e a lista sai da frente (como em Personagens e Campanhas). */
function showForm(which) {
  el('tables-notice').hidden = true;
  el('view-tables').classList.toggle('is-creating', Boolean(which));
  el('table-create-form').hidden = which !== 'create';
  el('table-join-form').hidden = which !== 'join';
  showError(el('table-create-error'), null);
  showError(el('table-join-error'), null);
  const form = which && el(`table-${which}-form`);
  if (form) {
    form.reset();
    window.scrollTo({ top: 0 });
    form.querySelector('input').focus();
  }
}

// Acordeão padrão. Lembra o que a pessoa abriu ou fechou, mesmo quando a mesa se atualiza ao vivo.
const accordionState = new Map();
function accordion(key, title, defaultOpen, ...children) {
  const open = accordionState.get(key) ?? defaultOpen;
  return h('details', {
    class: 'accordion table-section',
    open,
    ontoggle: (event) => accordionState.set(key, event.currentTarget.open),
  }, h('summary', {}, title), h('div', { class: 'accordion-body' }, ...children));
}

// ---------- Lista ----------

function roleChip(table) {
  if (table.status === 'pendente') return h('span', { class: 'chip chip-wait' }, 'Aguardando o Mestre aprovar');
  if (table.role === 'mestre') return h('span', { class: 'chip chip-gm' }, 'Você é o Mestre');
  return h('span', { class: 'chip' }, table.my_character ? `Você joga com ${table.my_character}` : 'Você é jogador');
}

function tableCard(table, index) {
  const waiting = table.status === 'pendente';
  return h('article', { class: 'campaign-card table-card', style: `--hue:${hueOf(table.name)};--delay:${Math.min(index, 10) * 45}ms` },
    h('div', { class: 'campaign-card-top' },
      h('span', { class: 'campaign-initial', 'aria-hidden': 'true' }, initial(table.name)),
      h('div', { class: 'campaign-identity' },
        h('strong', {}, table.name),
        h('small', {}, `Mestre: ${table.gm_name}`))),
    !waiting && table.description && h('p', { class: 'campaign-premise' }, table.description),
    h('div', { class: 'campaign-meta' },
      roleChip(table),
      !waiting && h('span', {}, `${table.players}/${table.max_players} jogadores`),
      table.pending > 0 && h('span', { class: 'chip chip-alert' }, plural(table.pending, 'pedido', 'pedidos'))),
    waiting
      ? h('p', { class: 'muted' }, 'Seu pedido foi enviado. Quando o Mestre aprovar, a mesa abre aqui.')
      : null,
    h('div', { class: 'table-actions' },
      waiting
        ? h('button', { type: 'button', onclick: () => leave(table, { pending: true }) }, 'Cancelar pedido')
        : h('button', { type: 'button', class: 'primary', onclick: () => openTable(table.id) }, 'Abrir mesa')));
}

function emptyTables() {
  return h('div', { class: 'empty-hero' },
    h('span', { class: 'empty-hero-icon', 'aria-hidden': 'true' }, icon('dice', 56)),
    h('h2', {}, 'Jogue com seus amigos'),
    h('p', { class: 'muted' }, 'Numa mesa em grupo, uma pessoa é o Mestre e conduz a história. Não usa IA nem precisa de chave do Gemini.'),
    h('ul', { class: 'empty-steps' },
      h('li', {}, h('span', { class: 'step-icon', 'aria-hidden': 'true' }, icon('crown', 26)),
        h('div', {}, h('strong', {}, 'Vai mestrar?'), h('small', {}, 'Crie uma mesa e mande o código para até 6 jogadores.'))),
      h('li', {}, h('span', { class: 'step-icon', 'aria-hidden': 'true' }, icon('shield', 26)),
        h('div', {}, h('strong', {}, 'Vai jogar?'), h('small', {}, 'Peça o código ao Mestre, entre e escolha sua ficha.')))),
    h('div', { class: 'empty-actions' },
      h('button', { type: 'button', class: 'primary big', onclick: () => showForm('create') }, 'Criar mesa'),
      h('button', { type: 'button', class: 'big', onclick: () => showForm('join') }, 'Entrar com código'),
      h('button', { type: 'button', class: 'big', onclick: () => document.dispatchEvent(new CustomEvent('show-view', { detail: 'templates' })) }, 'Meus modelos de NPCs e monstros')));
}

async function renderList() {
  const tables = await refreshTablesBadge();
  el('tables-list-head').hidden = !tables.length;
  el('table-list').replaceChildren(...(tables.length ? tables.map(tableCard) : [emptyTables()]));
}

// ---------- Mesa aberta ----------

function avatar(character, fallback) {
  return character?.avatar_url
    ? h('img', { class: 'table-avatar', src: character.avatar_url, alt: '' })
    : h('span', { class: 'table-avatar', 'aria-hidden': 'true' }, initial(character?.name ?? fallback));
}

function characterLine(character, { withName = true } = {}) {
  if (!character) return h('small', { class: 'muted' }, 'Ainda sem ficha nesta mesa');
  const details = `${character.race} ${character.class}, nível ${character.level}`;
  return h('small', {}, withName ? `${character.name} · ${details}` : details);
}

function playerRow(table, player) {
  const gm = table.role === 'mestre';
  return h('li', { class: 'table-person' },
    avatar(player.character, player.name),
    h('div', { class: 'table-person-text' }, h('strong', {}, player.name), characterLine(player.character)),
    gm && h('button', {
      type: 'button',
      class: 'small danger',
      onclick: () => act(
        () => api(`/tables/${table.id}/members/${player.user_id}`, { method: 'DELETE' }),
        { confirm: `Remover ${player.name} da mesa? A ficha sai da mesa, mas continua na conta da pessoa.` },
      ),
    }, 'Remover'));
}

function pendingRow(table, request) {
  return h('li', { class: 'table-person' },
    h('span', { class: 'table-avatar', 'aria-hidden': 'true' }, initial(request.name)),
    h('div', { class: 'table-person-text' }, h('strong', {}, request.name), h('small', { class: 'muted' }, 'Quer entrar na mesa')),
    h('div', { class: 'table-person-actions' },
      h('button', {
        type: 'button',
        class: 'small primary',
        onclick: () => act(() => api(`/tables/${table.id}/members/${request.user_id}/approve`, { method: 'POST' })),
      }, 'Aprovar'),
      h('button', {
        type: 'button',
        class: 'small',
        onclick: () => act(
          () => api(`/tables/${table.id}/members/${request.user_id}`, { method: 'DELETE' }),
          { confirm: `Recusar o pedido de ${request.name}?` },
        ),
      }, 'Recusar')));
}

async function copyCode(code, button) {
  try {
    await navigator.clipboard.writeText(code);
    button.textContent = 'Copiado!';
  } catch {
    button.textContent = 'Selecione e copie';
    const range = document.createRange();
    range.selectNodeContents(el('table-code'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }
  setTimeout(() => { button.textContent = 'Copiar código'; }, 2000);
}

function inviteSection(table) {
  const full = table.players.length >= table.max_players;
  const toggle = h('input', {
    type: 'checkbox',
    role: 'switch',
    checked: table.join_open,
    onchange: (event) => act(() => api(`/tables/${table.id}`, { method: 'PATCH', body: { join_open: event.target.checked } })),
  });
  return accordion('convite', 'Convite', true,
    h('p', { class: 'muted' }, 'Mande este código para os jogadores. Cada pedido de entrada precisa da sua aprovação.'),
    h('div', { class: 'table-code-row' },
      h('code', { id: 'table-code', class: 'table-code' }, table.join_code),
      h('button', { type: 'button', class: 'primary', onclick: (event) => copyCode(table.join_code, event.currentTarget) }, 'Copiar código')),
    h('label', { class: 'switch' }, toggle, h('span', { class: 'switch-track', 'aria-hidden': 'true' }), h('span', {}, 'Aceitando novos pedidos')),
    full && h('p', { class: 'muted' }, `A mesa já tem ${table.max_players} jogadores: para aprovar alguém, remova outro antes.`),
    h('button', {
      type: 'button',
      class: 'small',
      onclick: () => act(
        () => api(`/tables/${table.id}/code`, { method: 'POST' }),
        { confirm: 'Gerar um código novo? O código atual para de funcionar. Quem já está na mesa continua nela.' },
      ),
    }, 'Gerar código novo'));
}

// Só aparece quando há alguém esperando (a aba Grupo mostra o número).
function pendingSection(table) {
  if (!table.pending.length) return null;
  return accordion('pedidos', `Pedidos para entrar (${table.pending.length})`, true,
    h('ul', { class: 'table-people' }, table.pending.map((request) => pendingRow(table, request))));
}

function playersSection(table) {
  return accordion('jogadores', `Jogadores (${table.players.length}/${table.max_players})`, true,
    table.players.length
      ? h('ul', { class: 'table-people' }, table.players.map((player) => playerRow(table, player)))
      : h('p', { class: 'muted' }, table.role === 'mestre' ? 'Ninguém entrou ainda. Mande o código do convite.' : 'Ninguém por aqui ainda.'));
}

async function characterSection(table) {
  const characters = await api('/characters');
  const current = characters.find((character) => character.id === table.my_character_id);
  const select = h('select', { id: 'table-character', 'aria-label': 'Escolha sua ficha' },
    h('option', { value: '' }, characters.length ? 'Escolha uma ficha' : 'Você ainda não tem fichas'),
    characters.map((character) => h('option', { value: String(character.id), selected: character.id === table.my_character_id },
      `${character.name} · ${character.race} ${character.class}, nível ${character.level}`)));
  const createNew = () => {
    store.set('tables.return', String(table.id));
    document.dispatchEvent(new CustomEvent('new-character'));
  };
  return h('details', { class: 'accordion table-section table-mine', open: accordionState.get('ficha') ?? true, ontoggle: (event) => accordionState.set('ficha', event.currentTarget.open) },
    h('summary', {}, 'Sua ficha nesta mesa'), h('div', { class: 'accordion-body' },
    current
      ? h('div', { class: 'table-person' }, avatar(current, current.name),
        h('div', { class: 'table-person-text' }, h('strong', {}, current.name), characterLine(current, { withName: false })))
      : h('p', { class: 'muted' }, 'Escolha com qual personagem você vai jogar. A mesma ficha pode estar em outras mesas.'),
    // Com uma ficha só e já escolhida, não há o que trocar.
    characters.length > (current ? 1 : 0) && h('div', { class: 'row' },
      h('label', {}, current ? 'Trocar por' : 'Ficha', select),
      h('button', {
        type: 'button',
        class: 'primary',
        onclick: () => {
          if (!select.value) return showError(el('table-error'), new Error('Escolha uma ficha na lista.'));
          return act(() => api(`/tables/${table.id}/character`, { method: 'PUT', body: { character_id: Number(select.value) } }));
        },
      }, current ? 'Trocar ficha' : 'Usar esta ficha')),
    h('button', { type: 'button', class: characters.length ? 'small' : 'primary', onclick: createNew }, 'Criar ficha nova'),
    current && h('button', {
      type: 'button',
      class: 'small',
      onclick: () => act(() => api(`/tables/${table.id}/character`, { method: 'DELETE' })),
    }, 'Tirar minha ficha da mesa')));
}

function settingsSection(table) {
  const form = h('form', { class: 'stack' },
    h('label', {}, 'Nome da mesa', h('input', { name: 'name', required: true, maxlength: 100, value: table.name })),
    h('label', {}, 'Descrição para os jogadores', h('textarea', { name: 'description', rows: 4, maxlength: 4000 }, table.description)),
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'primary' }, 'Salvar')));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    act(() => api(`/tables/${table.id}`, {
      method: 'PATCH',
      body: { name: form.elements.name.value, description: form.elements.description.value },
    }));
  });
  return accordion('config', 'Configurações da mesa', false,
    h('div', { class: 'stack table-settings' },
      form,
      h('hr'),
      h('button', {
        type: 'button',
        class: 'danger',
        onclick: () => act(async () => {
          await api(`/tables/${table.id}`, { method: 'DELETE' });
          closeTable();
          return null;
        }, { confirm: `Excluir a mesa "${table.name}" para todos? Isso não pode ser desfeito. As fichas dos jogadores continuam nas contas deles.` }),
      }, 'Excluir mesa')));
}

async function renderTable(table) {
  const gm = table.role === 'mestre';
  el('table-detail-title').textContent = table.name;
  el('table-detail-sub').textContent = gm ? 'Você é o Mestre' : `Mestre: ${table.gm_name}`;
  document.body.classList.add('in-table');
  const sections = [
    ...(gm
      ? [pendingSection(table), inviteSection(table), playersSection(table),
        table.description && accordion('sobre', 'Sobre a mesa', false, h('p', { class: 'prewrap' }, table.description)), settingsSection(table)]
      : [await characterSection(table), playersSection(table),
        table.description && accordion('sobre', 'Sobre a mesa', false, h('p', { class: 'prewrap' }, table.description)),
        h('button', { type: 'button', class: 'danger table-leave', onclick: () => leave(table) }, 'Sair da mesa')]),
  ].filter(Boolean);
  el('table-sections').replaceChildren(...sections);
  await enterTable(table, {
    onTable: () => reloadTable({ fromEvent: true }),
    onGone: () => {
      closeTable();
      showError(el('tables-error'), new Error('Você não está mais nesta mesa (o Mestre removeu você ou excluiu a mesa).'));
    },
  });
}

/** Roda uma ação da mesa e redesenha com a resposta (o servidor devolve a mesa atualizada). */
async function act(action, { confirm: question } = {}) {
  if (busy) return;
  if (question && !window.confirm(question)) {
    if (openId) await reloadTable();
    return;
  }
  busy = true;
  showError(el('table-error'), null);
  try {
    const table = await action();
    if (table && openId) await renderTable(table);
    await refreshTablesBadge().catch(() => {});
  } catch (err) {
    showError(el('table-error'), err);
    // Algo mudou por outro lado (ex.: o jogador saiu): mostra o estado atual.
    if (openId) await reloadTable();
  } finally {
    busy = false;
  }
}

async function leave(table, { pending = false } = {}) {
  const question = pending ? `Cancelar o pedido para entrar em "${table.name}"?` : `Sair da mesa "${table.name}"? Sua ficha sai da mesa, mas continua na sua conta.`;
  if (!window.confirm(question)) return;
  try {
    await api(`/tables/${table.id}/leave`, { method: 'POST' });
    if (openId) closeTable();
    else await renderList();
  } catch (err) {
    showError(el(openId ? 'table-error' : 'tables-error'), err);
  }
}

async function reloadTable({ fromEvent = false, restoring = false } = {}) {
  // Aviso em tempo real enquanto a pessoa digita na aba Mesa: deixa para a próxima.
  const active = document.activeElement;
  if (fromEvent && el('table-sections').contains(active) && active.matches('input, textarea, select')) return;
  // Só a própria mesa respondendo "não encontrada" quer dizer que ela sumiu para esta pessoa.
  let view;
  try {
    view = await api(`/tables/${openId}`);
  } catch (err) {
    if (err.status === 404) {
      closeTable();
      // Reabrindo sozinha a última mesa (de outra sessão) que não existe mais: só mostra a lista.
      if (!restoring) showError(el('tables-error'), new Error('Essa mesa não está mais disponível para você (o Mestre removeu você ou excluiu a mesa).'));
    } else {
      showError(el('table-error'), err);
    }
    return;
  }
  // Falha ao carregar uma parte da mesa (chat, ficha, Biblioteca...): mostra o erro de verdade, sem fechar a mesa.
  try {
    await renderTable(view);
  } catch (err) {
    showError(el('table-error'), new Error(`Parte da mesa não carregou: ${err.message}`));
  }
}

export async function openTable(id) {
  openId = id;
  store.set('tables.open', String(id));
  showForm(null);
  showError(el('table-error'), null);
  showError(el('tables-error'), null);
  el('tables-home').hidden = true;
  el('table-detail').hidden = false;
  window.scrollTo({ top: 0 });
  await reloadTable();
}

function closeTable() {
  openId = null;
  document.body.classList.remove('in-table');
  leaveTable();
  store.set('tables.open', '');
  el('table-detail').hidden = true;
  el('tables-home').hidden = false;
  renderList().catch((err) => showError(el('tables-error'), err));
}

export async function renderTables() {
  // Voltando da criação de ficha: reabre a mesa de onde a pessoa saiu.
  const back = store.get('tables.return');
  if (back) store.set('tables.return', '');
  const target = Number(back || store.get('tables.open')) || null;
  if (target) {
    openId = target;
    el('tables-home').hidden = true;
    el('table-detail').hidden = false;
    await reloadTable({ restoring: !back });
    return;
  }
  el('table-detail').hidden = true;
  el('tables-home').hidden = false;
  document.body.classList.remove('in-table');
  await renderList();
}

/** Mesa de onde a pessoa saiu para criar uma ficha (ou null). */
export const tableToReturn = () => Number(store.get('tables.return')) || null;

/** Volta para a mesa; com characterId, já usa essa ficha nela. */
export async function returnToTable(characterId) {
  const id = tableToReturn();
  if (id && characterId) {
    await api(`/tables/${id}/character`, { method: 'PUT', body: { character_id: characterId } }).catch(() => {});
  }
  document.dispatchEvent(new CustomEvent('show-view', { detail: 'tables' }));
}

// Enquanto a aba está aberta, confere de tempos em tempos se chegou pedido ou se alguém entrou.
// (O tempo real de verdade chega com o chat da mesa.)
function startPolling() {
  setInterval(async () => {
    if (document.hidden || busy) return;
    const visible = !el('view-tables').hidden;
    try {
      if (!visible) {
        await refreshTablesBadge();
        return;
      }
      // A mesa aberta se atualiza sozinha pelo canal em tempo real.
      if (openId) {
        return;
      } else if (el('table-create-form').hidden && el('table-join-form').hidden) {
        await renderList();
      } else {
        await refreshTablesBadge();
      }
    } catch {
      // Sem conexão agora: tenta de novo na próxima volta.
    }
  }, 20000);
}

export function initTables() {
  el('table-new').addEventListener('click', () => showForm('create'));
  el('table-join-open').addEventListener('click', () => showForm('join'));
  for (const id of ['table-create-cancel', 'table-join-cancel']) el(id).addEventListener('click', () => showForm(null));
  el('table-back').addEventListener('click', closeTable);

  el('table-create-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const { elements } = event.target;
    try {
      const table = await api('/tables', { method: 'POST', body: { name: elements.name.value, description: elements.description.value } });
      showForm(null);
      // Mesa nova: abre direto na aba Mesa, onde está o código para convidar os jogadores.
      store.set('tables.pane', 'mesa');
      await openTable(table.id);
    } catch (err) {
      showError(el('table-create-error'), err);
    }
  });

  el('table-join-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const result = await api('/tables/join', { method: 'POST', body: { code: event.target.elements.code.value } });
      showForm(null);
      await renderList();
      el('tables-notice').textContent = `Pedido enviado para "${result.name}". Assim que o Mestre aprovar, a mesa abre aqui.`;
      el('tables-notice').hidden = false;
    } catch (err) {
      showError(el('table-join-error'), err);
    }
  });

  initTablePlay();
  refreshTablesBadge().catch(() => {});
  startPolling();
}
