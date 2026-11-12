import { api, settings, store } from './api.js';
import { initAdmin, renderAdmin, renderMetrics } from './admin.js';
import { initCampaigns, renderCampaigns } from './campaign.js';
import { initCharacterForm, openCharacter, openForeignCharacter, refreshRoster } from './character.js';
import { initGame, refreshGameSelectors, refreshIllustrations } from './game.js';
import { initLibrary, renderLibrary } from './library.js';
import { logout, requireLogin } from './login.js';
import { initNotebook, renderNotebook } from './notebook.js';
import { initTables, renderTables, returnToTable, tableToReturn } from './tables.js';
import { initTemplates, openTemplates } from './templates.js';
import { initTours } from './tour.js';
import { initSettings, openSettings } from './settings.js';
import { initUsage, renderUsage } from './usage.js';

const PLAYER_VIEWS = ['game', 'characters', 'campaigns', 'tables', 'templates', 'library', 'usage'];
const ADMIN_VIEWS = ['notebook', 'metrics', 'admin'];

const user = await requireLogin();
const admin = user.role === 'admin';
const VIEWS = admin ? [...PLAYER_VIEWS, ...ADMIN_VIEWS] : PLAYER_VIEWS;

document.body.dataset.auth = 'in';
document.getElementById('user-name').textContent = user.name;
// Abas restritas nem aparecem para jogadores (o servidor também bloqueia as rotas).
for (const tab of document.querySelectorAll('[data-admin]')) tab.hidden = !admin;
for (const view of ADMIN_VIEWS) if (!admin) document.getElementById(`view-${view}`).remove();
if (!admin) document.getElementById('admin-menu').remove();

// Dois tipos de jogo, cada um com o seu menu: Mestre IA (Jogo, Campanhas, Biblioteca, Consumo IA) e
// Mesas com amigos (Mesas). Personagens e o menu Admin aparecem nos dois.
const VIEW_MODES = { game: 'ia', campaigns: 'ia', library: 'ia', usage: 'ia', tables: 'mesa', templates: 'mesa' };
const HOME = { ia: 'game', mesa: 'tables' };
let mode = store.get('mode') === 'mesa' ? 'mesa' : 'ia';

function applyMode(next) {
  mode = next;
  store.set('mode', next);
  document.body.dataset.mode = next;
  for (const tab of document.querySelectorAll('.tab[data-mode]')) tab.hidden = tab.dataset.mode !== next;
  for (const button of document.querySelectorAll('#mode-switch button')) {
    const active = button.dataset.mode === next;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

async function showView(view) {
  if (VIEW_MODES[view] && VIEW_MODES[view] !== mode) applyMode(VIEW_MODES[view]);
  for (const name of VIEWS) document.getElementById(`view-${name}`).hidden = name !== view;
  // Nas telas de administração, quem fica marcada é a aba "Admin".
  const adminButton = document.getElementById('admin-menu-button');
  adminButton.classList.toggle('active', ADMIN_VIEWS.includes(view));
  for (const item of document.querySelectorAll('#admin-menu .menu-item')) {
    if (item.dataset.view === view) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  for (const tab of document.querySelectorAll('.tab[data-view]')) {
    const active = tab.dataset.view === view;
    tab.classList.toggle('active', active);
    if (active) {
      tab.setAttribute('aria-current', 'page');
      tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } else {
      tab.removeAttribute('aria-current');
    }
  }
  store.set('view', view);
  // Saiu da mesa para criar uma ficha e foi para outro lugar: esquece a volta.
  if (view !== 'characters' && view !== 'tables') store.set('tables.return', '');
  updateTableReturn();
  if (view === 'characters') await refreshRoster();
  if (view === 'campaigns') await renderCampaigns();
  if (view === 'tables') await renderTables();
  if (view === 'templates') await openTemplates();
  // Dentro de uma mesa aberta, o menu do app se recolhe (no celular): ver tables.js.
  if (view !== 'tables') document.body.classList.remove('in-table');
  if (view === 'notebook') await renderNotebook();
  if (view === 'library') await renderLibrary();
  if (view === 'usage') await renderUsage();
  if (view === 'metrics') await renderMetrics();
  if (view === 'admin') await renderAdmin();
  // Uma nova tentativa feita na Biblioteca precisa aparecer também nas bolhas.
  if (view === 'game') await refreshIllustrations().catch(() => {});
}

// Se algo falhar ao abrir uma aba (servidor fora do ar ou desatualizado), avisa em vez de ficar parado.
function viewFailed(err) {
  const note = document.createElement('div');
  note.className = 'tp-toast';
  note.setAttribute('role', 'alert');
  note.textContent = `Não foi possível abrir esta parte: ${err?.message ?? err}. Se o DataDice acabou de ser atualizado, use Fechar DataDice e depois Abrir DataDice.`;
  document.body.append(note);
  setTimeout(() => note.remove(), 9000);
}

for (const tab of document.querySelectorAll('.tab[data-view]')) {
  tab.addEventListener('click', () => showView(tab.dataset.view).catch(viewFailed));
}
for (const button of document.querySelectorAll('#mode-switch button')) {
  button.addEventListener('click', () => {
    applyMode(button.dataset.mode);
    showView(HOME[button.dataset.mode]).catch(viewFailed);
  });
}
// O aviso de pedidos para aprovar também aparece no botão "Mesas com amigos" quando se está no Mestre IA.
new MutationObserver(() => {
  const badge = document.getElementById('tables-badge');
  const modeBadge = document.getElementById('mode-badge');
  modeBadge.textContent = badge.textContent;
  modeBadge.hidden = badge.hidden;
}).observe(document.getElementById('tables-badge'), { attributes: true, childList: true, characterData: true, subtree: true });

// Criar ficha a partir de uma mesa (ou o Mestre editando a de um jogador): aviso no topo de Personagens
// com o caminho de volta.
let savedForTable = null;
let editingForeign = null;
function updateTableReturn() {
  const banner = document.getElementById('table-return');
  banner.hidden = !tableToReturn();
  if (!tableToReturn()) {
    savedForTable = null;
    editingForeign = null;
  }
  document.getElementById('table-return-text').textContent = editingForeign
    ? `Você está editando a ficha de ${editingForeign} como Mestre. Ao salvar, o jogador é avisado do que mudou.`
    : savedForTable
      ? `Ficha de ${savedForTable.name} salva!`
      : 'Criando ou ajustando uma ficha para a sua mesa. Depois de salvar, volte por aqui.';
  document.getElementById('table-return-button').textContent = savedForTable && !editingForeign ? 'Usar esta ficha na mesa' : 'Voltar para a mesa';
}
document.getElementById('table-return-button').addEventListener('click', () => returnToTable(editingForeign ? null : savedForTable?.id));
document.addEventListener('edit-foreign-character', async ({ detail }) => {
  try {
    const character = await api(`/tables/${detail.tableId}/party/${detail.characterId}/sheet`);
    store.set('tables.return', String(detail.tableId));
    savedForTable = null;
    editingForeign = detail.owner;
    await showView('characters');
    updateTableReturn();
    await openForeignCharacter(character, { savePath: `/tables/${detail.tableId}/party/${detail.characterId}/sheet`, owner: detail.owner });
  } catch (err) {
    window.alert(err.message);
  }
});
document.addEventListener('new-character', async () => {
  savedForTable = null;
  await showView('characters');
  document.getElementById('character-new').click();
});
document.addEventListener('show-view', (event) => showView(event.detail).catch(viewFailed));

// Menu Admin: abre embaixo da aba (fora da barra, que rola para o lado no celular).
function initAdminMenu() {
  const button = document.getElementById('admin-menu-button');
  const menu = document.getElementById('admin-menu');
  const items = [...menu.querySelectorAll('.menu-item')];

  function place() {
    const rect = button.getBoundingClientRect();
    const width = Math.min(300, window.innerWidth - 16);
    menu.style.width = `${width}px`;
    menu.style.top = `${rect.bottom + 6}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
  }
  function close({ focus = false } = {}) {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (focus) button.focus();
  }
  function open() {
    openedAt = performance.now();
    button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    place();
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    (items.find((item) => item.hasAttribute('aria-current')) ?? items[0]).focus();
  }

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (menu.hidden) open();
    else close();
  });
  for (const item of items) {
    item.addEventListener('click', () => {
      close();
      showView(item.dataset.view);
    });
  }
  menu.addEventListener('keydown', (event) => {
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') close({ focus: true });
    if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length].focus(); }
    if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length].focus(); }
    if (event.key === 'Tab') close();
  });
  document.addEventListener('click', (event) => { if (!menu.contains(event.target)) close(); });
  // Rolagem e mudança de tamanho logo após abrir vêm do próprio scrollIntoView (ou da barra do navegador no celular): ignora.
  let openedAt = 0;
  const closeIfSettled = () => { if (performance.now() - openedAt > 500) close(); };
  window.addEventListener('resize', closeIfSettled);
  document.querySelector('.topbar nav').addEventListener('scroll', closeIfSettled, { passive: true });
}
if (admin) initAdminMenu();

document.addEventListener('open-character', async (event) => {
  editingForeign = null;
  await showView('characters');
  await openCharacter(event.detail);
});
// "Jogar" num cartão de campanha: abre o jogo já com ela escolhida.
document.addEventListener('play-campaign', async (event) => {
  const select = document.getElementById('game-campaign');
  if (![...select.options].some((option) => option.value === String(event.detail))) await refreshGameSelectors();
  select.value = String(event.detail);
  select.dispatchEvent(new Event('change'));
  await showView('game');
});
document.addEventListener('auth-expired', logout, { once: true });
document.getElementById('logout').addEventListener('click', logout);

initSettings();
await initGame();
await initCharacterForm(async (character) => {
  await refreshGameSelectors(character);
  if (tableToReturn()) {
    savedForTable = character;
    updateTableReturn();
    document.getElementById('table-return').scrollIntoView({ block: 'nearest' });
  }
});
initCampaigns(refreshGameSelectors);
if (admin) {
  initNotebook();
  initAdmin();
}
initLibrary();
initTables();
initTemplates();
initUsage();

applyMode(mode);
const requested = new URLSearchParams(location.search).get('view');
const initial = VIEWS.includes(requested) ? requested : store.get('view');
await showView(VIEWS.includes(initial) ? initial : HOME[mode]);

// Primeiro acesso: sem chave, o Mestre IA não funciona; já abre as Configurações explicando.
// Quem só joga em mesas com Mestre humano pode fechar: lá não precisa de chave.
if (!settings.apiKey && mode === 'ia') {
  openSettings({ reason: 'Bem-vindo! Para jogar com o Mestre IA, cole sua chave do Gemini. Não tem? Toque em "Obter chave gratuita no Google". Vai jogar só em mesas com Mestre humano (aba Mesas)? Pode fechar: lá não precisa de chave.' });
}

// Treinamentos guiados (botão 🎓). No primeiro acesso, a lista abre sozinha uma vez.
initTours({ showView });
