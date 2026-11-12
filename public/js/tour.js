import { api, h, session, store } from './api.js';
import { icon } from './icons.js';
import { openTable } from './tables.js';

/*
 * Treinamentos guiados: navegam pelo próprio DataDice, destacam cada parte e explicam na ordem certa.
 * Nada é criado nem apagado: os passos só abrem telas e formulários, e fecham o que abriram no fim.
 */

const el = (id) => document.getElementById(id);
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function visible(node) {
  return Boolean(node) && node.getClientRects().length > 0 && !node.closest('[hidden]');
}

/** Primeiro seletor da lista que estiver visível na tela. */
function firstVisible(...selectors) {
  for (const selector of selectors) {
    const node = [...document.querySelectorAll(selector)].find(visible);
    if (node) return node;
  }
  return null;
}

async function waitFor(check, ms = 2500) {
  const start = Date.now();
  for (;;) {
    const result = check();
    if (result) return result;
    if (Date.now() - start > ms) return null;
    await wait(80);
  }
}

const click = (selector) => document.querySelector(selector)?.click();

let ctx = null;

/** Fecha a gaveta (celular) para mostrar o chat. */
async function closeSide() {
  tableTab('Jogo');
  if (el('tp-side')?.classList.contains('open')) click('#tp-side .tp-side-head button');
  await wait(200);
}

/** Abre a coluna de dados e fichas (no celular ela é uma gaveta). */
async function openSide() {
  tableTab('Jogo');
  const side = el('tp-side');
  if (side && !side.classList.contains('open') && getComputedStyle(el('tp-dice-toggle')).display !== 'none') click('#tp-dice-toggle');
  await wait(250);
}

function tableTab(label) {
  const button = [...document.querySelectorAll('#table-tabs button')].find((b) => b.textContent.includes(label));
  button?.click();
}

/** Volta para a lista de mesas (fecha mesa aberta, Meus modelos e formulários). */
async function tablesHome() {
  await ctx.showView('tables');
  if (visible(el('table-detail'))) click('#table-back');

  for (const id of ['table-create-cancel', 'table-join-cancel']) if (visible(el(id))) click(`#${id}`);
  await wait(150);
}

/** Abre uma mesa da pessoa com o papel pedido. Devolve false se ela não tiver nenhuma. */
async function openMyTable(role) {
  const tables = await api('/tables').catch(() => []);
  const table = tables.find((item) => item.role === role && item.status === 'ativo');
  ctx.hasTable = Boolean(table);
  if (!table) return false;
  await ctx.showView('tables');
  await openTable(table.id);
  await waitFor(() => visible(el('table-tabs')) && el('table-tabs').children.length > 0);
  return true;
}

// ---------- Roteiros ----------

const noTableText = (role) => (role === 'mestre'
  ? 'Para ver o resto (chat, painel, iniciativa, Biblioteca e notas), crie uma mesa e rode este treinamento de novo. Ele abre a mesa e mostra cada parte.'
  : 'Para ver o resto (chat, ficha e Biblioteca), entre numa mesa com o código do Mestre e rode este treinamento de novo.');

export const TOURS = [
  {
    id: 'inicio',
    icon: 'compass',
    title: 'Primeiros passos',
    blurb: 'Os dois jeitos de jogar e onde fica cada coisa.',
    steps: [
      { title: 'Bem-vinda ao DataDice!', text: 'Aqui você joga RPG (D&D 5e) de dois jeitos: sozinha, com um Mestre feito por inteligência artificial, ou com amigos, numa mesa em que uma pessoa é o Mestre. Vamos ver onde fica cada coisa.' },
      { target: () => el('mode-switch'), title: 'Dois jeitos de jogar', text: 'Mestre IA: a IA narra a história para você. Mesas com amigos: um Mestre de verdade conduz, sem IA. Cada um tem o seu próprio menu logo abaixo.' },
      { target: () => firstVisible('.tab[data-view="characters"]'), title: 'Personagens servem para os dois', text: 'A mesma ficha vale no Mestre IA e nas mesas. Um personagem pode estar em várias campanhas e mesas ao mesmo tempo.' },
      { target: () => el('settings-open'), title: 'Configurações', text: 'A chave do Gemini (só para o Mestre IA) e a opção de gerar ilustrações. A chave fica salva só neste navegador. Para jogar nas mesas com amigos não precisa de chave.' },
      { target: () => el('tours-open'), title: 'Treinamentos', text: 'Sempre que quiser rever algo, toque aqui. Há treinamentos curtos para cada parte do sistema.' },
    ],
  },
  {
    id: 'personagem',
    icon: 'user',
    title: 'Criar um personagem',
    blurb: 'A ficha de D&D 5e que faz as contas por você.',
    async start() { await ctx.showView('characters'); },
    cleanup() { if (visible(el('sheet-close')) && document.getElementById('view-characters').classList.contains('is-creating')) click('#sheet-close'); },
    steps: [
      { target: () => firstVisible('#character-new', '#character-roster .empty-hero button'), title: 'Seus personagens', text: 'Aqui ficam todas as suas fichas. Para começar uma nova, use este botão.' },
      { prepare: () => click('#character-new'), target: () => firstVisible('#character-form .sheet-tabs'), title: 'A ficha tem 3 páginas', text: 'Página 1: o essencial para jogar. Página 2: aparência, história e retrato. Página 3: magias (para quem conjura).' },
      { target: () => firstVisible('#character-form [name=class]'), title: 'Raça e classe', text: 'Escolha a raça e a classe. A classe já define o dado de vida, as salvaguardas e o atributo de magia.' },
      { target: () => firstVisible('#character-form [name=str]'), title: 'Atributos', text: 'Preencha Força, Destreza, Constituição, Inteligência, Sabedoria e Carisma. Modificadores, perícias, CA e PV são calculados sozinhos.' },
      { prepare: () => click('#character-form .sheet-tabs button[data-page="2"]'), target: () => firstVisible('#portrait-preview'), title: 'Retrato', text: 'Envie uma imagem do celular ou gere com IA (a geração precisa de faturamento ativo na chave do Gemini).' },
      { prepare: () => click('#character-form .sheet-tabs button[data-page="1"]'), target: () => firstVisible('#sheet-submit'), title: 'Salvar', text: 'Salve e a ficha fica pronta para usar com o Mestre IA e nas mesas. Pode editar quando quiser.' },
    ],
  },
  {
    id: 'mestre-ia',
    icon: 'bot',
    title: 'Jogar com o Mestre IA',
    blurb: 'Criar uma campanha com IA e jogar sozinha.',
    async start() { await ctx.showView('campaigns'); },
    cleanup() { if (visible(el('campaign-close'))) click('#campaign-close'); },
    steps: [
      { target: () => firstVisible('#campaign-new', '#campaign-list .empty-hero button'), title: 'Campanhas', text: 'Uma campanha é o mundo onde a sua aventura acontece. O Mestre IA lembra de tudo o que acontece nela.' },
      { prepare: () => click('#campaign-new'), target: () => firstVisible('#campaign-mode'), title: 'Com IA ou do zero', text: 'A IA pode criar o mundo para você, ou você escreve tudo do seu jeito.' },
      { target: () => firstVisible('#campaign-themes'), title: 'Tema, tom e duração', text: 'Escolha o tema (fantasia, terror, piratas...), o tom e se é uma aventura curta ou uma campanha longa. Pode dar uma ideia também.' },
      { target: () => firstVisible('#campaign-generate'), title: 'Gerar e revisar', text: 'A IA monta um rascunho. Nada é salvo até você revisar e tocar em "Criar campanha".' },
      { prepare: async () => { click('#campaign-close'); await ctx.showView('game'); }, target: () => firstVisible('#game-campaign'), title: 'Hora de jogar', text: 'Na aba Jogo, escolha a campanha e o personagem. Na primeira vez, toque em "Entrar na campanha".' },
      { target: () => firstVisible('#session-gate', '#chat-form'), title: 'A aventura', text: 'O Mestre abre a sessão com uma introdução. Depois é só escrever o que o seu personagem faz, e a IA narra o que acontece.' },
      { target: () => firstVisible('#member-panel .card', '#member-panel'), title: 'Seu personagem e os dados', text: 'PV, armas, testes e perícias com um toque para rolar. O Mestre recebe o resultado na hora.' },
      { target: () => firstVisible('.tab[data-view="library"]'), title: 'Biblioteca', text: 'As ilustrações de NPCs, monstros e lugares que apareceram na campanha.' },
      { target: () => firstVisible('.tab[data-view="usage"]'), title: 'Consumo IA', text: 'Quanto a sua chave do Gemini gastou, por dia e por campanha.' },
    ],
  },
  {
    id: 'mesa-mestre',
    icon: 'crown',
    title: 'Mesas: sendo o Mestre',
    blurb: 'Criar a mesa, convidar e conduzir a partida.',
    async start() { await tablesHome(); },
    cleanup() { if (visible(el('table-create-cancel'))) click('#table-create-cancel'); },
    steps: [
      { target: () => firstVisible('#table-new', '#table-list .empty-hero button.primary'), title: 'Criar mesa', text: 'Quem cria a mesa é o Mestre. Não usa IA: você narra, cria os NPCs e controla tudo.' },
      { prepare: () => click('#table-new'), target: () => firstVisible('#table-create-form'), title: 'Nome e descrição', text: 'Dê um nome e conte aos jogadores do que se trata: cenário, dia e horário, regras da casa.' },
      { prepare: async () => { click('#table-create-cancel'); await wait(100); }, target: () => firstVisible('.tab[data-view="templates"]'), title: 'Modelos', text: 'Em Modelos você cadastra NPCs, monstros e locais uma vez e reutiliza em qualquer mesa. Na Biblioteca da mesa, "Começar de um modelo" traz a ficha pronta.' },
      { prepare: () => openMyTable('mestre'), skipIf: () => ctx.hasTable, fallback: true, title: 'Falta uma mesa', text: noTableText('mestre') },
      { skipIf: () => !ctx.hasTable, target: () => firstVisible('#table-tabs'), title: 'As partes da mesa', text: 'Jogo, Biblioteca, Notas e Grupo. Em Jogo está tudo da partida: chat, dados, iniciativa e jogadores. No celular, as abas ficam na barra de baixo. Tudo atualiza ao vivo para todo mundo; o "← " no alto volta para a lista de mesas.' },
      { skipIf: () => !ctx.hasTable, prepare: () => tableTab('Grupo'), target: () => firstVisible('.table-code-row', '#table-sections'), title: 'Convite', text: 'Na aba Grupo: mande este código para os jogadores (até 6). Cada pedido de entrada precisa da sua aprovação, aqui mesmo, e a aba mostra quantos estão esperando.' },
      { skipIf: () => !ctx.hasTable, prepare: closeSide, target: () => firstVisible('#tp-kind'), title: 'Narrar e dar voz aos NPCs', text: 'Narração para descrever a cena, Fala de NPC para falar como um personagem (escreva o nome dele), e conversa fora do personagem.' },
      { skipIf: () => !ctx.hasTable, target: () => firstVisible('#tp-to'), title: 'Para quem', text: 'Escolha um jogador para mandar algo só para ele: um segredo, uma visão, uma pista.' },
      { skipIf: () => !ctx.hasTable, prepare: openSide, target: () => firstVisible('#tp-dice'), title: 'Dados ao lado do chat', text: 'Tudo da partida fica nesta coluna (no celular, no botão "Dados e mesa"). Suas rolagens são secretas por padrão. Em "Rolar por", escolha um monstro ou NPC: os ataques, o dano e os testes dele aparecem prontos.' },
      { skipIf: () => !ctx.hasTable, target: () => firstVisible('#tp-image-tool'), title: 'Imagens', text: 'Mostre um mapa ou um retrato para todos ou só para um jogador. O texto da caixa vira a legenda.' },
      { skipIf: () => !ctx.hasTable, prepare: openSide, target: () => firstVisible('#tp-initiative-manager'), title: 'Combate e iniciativa', text: 'Comece o combate, adicione monstros da Biblioteca (com PV e iniciativa já rolada), esconda quem está nas sombras e passe a vez.' },
      { skipIf: () => !ctx.hasTable, target: () => firstVisible('#tp-party .tp-pc', '#tp-party'), title: 'Os jogadores', text: 'Dano, cura, condições e Inspiração. "Editar ficha" abre a ficha completa. O jogador sempre recebe um aviso do que você mudou.' },
      { skipIf: () => !ctx.hasTable, prepare: () => tableTab('Biblioteca'), target: () => firstVisible('#tp-library-tools'), title: 'Biblioteca', text: 'NPCs, monstros e locais. Tudo começa oculto e você revela quando quiser. Use os modelos prontos ou os seus.' },
      { skipIf: () => !ctx.hasTable, prepare: () => tableTab('Notas'), target: () => firstVisible('#tp-notes'), title: 'Notas do Mestre', text: 'Seus planos e segredos. Só você vê, e as notas salvam sozinhas.' },
    ],
  },
  {
    id: 'mesa-jogador',
    icon: 'shield',
    title: 'Mesas: sendo jogador',
    blurb: 'Entrar numa mesa, escolher a ficha e jogar.',
    async start() { await tablesHome(); },
    cleanup() { if (visible(el('table-join-cancel'))) click('#table-join-cancel'); },
    steps: [
      { target: () => firstVisible('#table-join-open', '#table-list .empty-hero button:nth-child(2)'), title: 'Entrar com código', text: 'Peça o código ao Mestre. Depois de enviar, o Mestre aprova a sua entrada.' },
      { prepare: () => click('#table-join-open'), target: () => firstVisible('#table-join-form'), title: 'O código', text: 'Pode digitar em letras minúsculas, com ou sem traço. A mesa aparece na lista como "Aguardando o Mestre aprovar".' },
      { prepare: async () => { click('#table-join-cancel'); await openMyTable('jogador'); }, skipIf: () => ctx.hasTable, fallback: true, title: 'Falta uma mesa', text: noTableText('jogador') },
      { skipIf: () => !ctx.hasTable, target: () => firstVisible('#table-tabs'), title: 'As partes da mesa', text: 'Jogo, Biblioteca e Grupo. Em Jogo está tudo da partida: chat, sua ficha e os dados. No celular, as abas ficam na barra de baixo. Tudo chega ao vivo.' },
      { skipIf: () => !ctx.hasTable, prepare: () => tableTab('Grupo'), target: () => firstVisible('.table-mine'), title: 'Sua ficha nesta mesa', text: 'Na aba Grupo você escolhe com qual personagem joga nesta mesa (ou cria uma ficha nova) e vê quem mais está jogando.' },
      { skipIf: () => !ctx.hasTable, prepare: closeSide, target: () => firstVisible('#tp-kind'), title: 'Falar na mesa', text: '"Em personagem" é o que o seu herói diz ou faz. "Fora do personagem" é conversa entre os jogadores.' },
      { skipIf: () => !ctx.hasTable, target: () => firstVisible('#tp-to'), title: 'Só para o Mestre', text: 'Escolha "Só o Mestre" para uma ação secreta, como esconder um item ou trair alguém.' },
      { skipIf: () => !ctx.hasTable, prepare: openSide, target: () => firstVisible('#tp-dice'), title: 'Rolar os dados', text: 'Ao lado do chat (no celular, no botão "Ficha e dados") estão os testes, perícias, salvaguardas, armas e iniciativa da sua ficha, com um toque. Ligue "Rolar só para o Mestre" quando a rolagem tiver de ser secreta.' },
      { skipIf: () => !ctx.hasTable, prepare: openSide, target: () => firstVisible('#tp-sheet'), title: 'Sua ficha', text: 'Em Minha ficha você vê e ajusta PV, condições e inventário. "Ver ficha" abre a ficha inteira só para consultar; "Editar ficha" muda o personagem.' },
      { skipIf: () => !ctx.hasTable, prepare: () => tableTab('Biblioteca'), target: () => firstVisible('#tp-library-list'), title: 'Biblioteca', text: 'Os NPCs, monstros e lugares que o Mestre revelar, e as imagens que ele mostrar.' },
    ],
  },
  {
    id: 'admin',
    icon: 'key',
    title: 'Ferramentas de admin',
    blurb: 'Caderno do Mestre, métricas e contas.',
    adminOnly: true,
    steps: [
      { target: () => firstVisible('#admin-menu-button'), title: 'Menu Admin', text: 'Só aparece para admins, nos dois tipos de jogo.' },
      { prepare: () => { if (el('admin-menu')?.hidden) click('#admin-menu-button'); }, target: () => firstVisible('#admin-menu'), title: 'O que há aqui', text: 'Caderno do Mestre: memórias das campanhas do Mestre IA. Métricas de Tokens: consumo do sistema todo. Painel Admin: contas e relatório. As mesas com amigos são privadas: nem o admin entra nelas.' },
    ],
    cleanup() { if (!el('admin-menu')?.hidden) document.body.click(); },
  },
];

// ---------- Motor ----------

// O aviso "Falta uma mesa" substitui os passos de dentro da mesa: não entra na contagem.
const counted = (tour) => tour.steps.filter((step) => !step.fallback).length;

let running = null;

function doneSet() {
  try { return new Set(JSON.parse(store.get('tours.done') ?? '[]')); } catch { return new Set(); }
}

function markDone(id) {
  const done = doneSet();
  done.add(id);
  store.set('tours.done', JSON.stringify([...done]));
}

function placeCard(card, spot, target) {
  const margin = 12;
  const phone = window.innerWidth < 640;
  card.style.left = card.style.right = card.style.top = card.style.bottom = '';
  if (!target) {
    spot.hidden = true;
    card.classList.add('centered');
    return;
  }
  card.classList.remove('centered');
  const rect = target.getBoundingClientRect();
  const pad = 6;
  spot.hidden = false;
  Object.assign(spot.style, {
    top: `${rect.top - pad}px`, left: `${rect.left - pad}px`, width: `${rect.width + pad * 2}px`, height: `${rect.height + pad * 2}px`,
  });
  const cardHeight = card.offsetHeight;
  const below = window.innerHeight - rect.bottom;
  if (phone) {
    // Celular: o cartão fica preso embaixo (ou em cima, se o destaque estiver embaixo).
    card.style.left = `${margin}px`;
    card.style.right = `${margin}px`;
    if (rect.top + rect.height / 2 > window.innerHeight * 0.55) card.style.top = `${margin}px`;
    else card.style.bottom = `${margin}px`;
    return;
  }
  const width = card.offsetWidth;
  card.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`;
  if (below > cardHeight + 24) card.style.top = `${rect.bottom + 14}px`;
  else if (rect.top > cardHeight + 24) card.style.top = `${rect.top - cardHeight - 14}px`;
  else card.style.bottom = `${margin}px`;
}

async function runTour(tour) {
  if (running) return;
  ctx.hasTable = false;
  const layer = h('div', { class: 'tour-layer' });
  const spot = h('div', { class: 'tour-spot', hidden: true });
  const card = h('div', { class: 'tour-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tour-title' });
  layer.append(spot, card);
  document.body.append(layer);
  const state = { index: 0, target: null, busy: false };
  running = state;

  const reposition = () => placeCard(card, spot, state.target && visible(state.target) ? state.target : null);
  const onKey = (event) => {
    if (event.key === 'Escape') finish(false);
    if (event.key === 'ArrowRight') go(1);
    if (event.key === 'ArrowLeft') go(-1);
  };
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);
  document.addEventListener('keydown', onKey);

  const steps = tour.steps;
  function finish(completed) {
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
    document.removeEventListener('keydown', onKey);
    layer.remove();
    running = null;
    try { tour.cleanup?.(); } catch { /* nada a desfazer */ }
    if (completed) markDone(tour.id);
    el('tours-open')?.focus();
  }

  async function show(index, direction) {
    state.busy = true;
    let i = index;
    for (;;) {
      if (i < 0 || i >= steps.length) { state.busy = false; finish(i >= steps.length); return; }
      const step = steps[i];
      card.replaceChildren(h('p', { class: 'tour-progress' }, 'Carregando...'));
      try { await step.prepare?.(); } catch { /* segue com o que der */ }
      if (step.skipIf?.()) { i += direction; continue; }
      break;
    }
    state.index = i;
    const step = steps[i];
    const target = step.target ? await waitFor(() => step.target()) : null;
    state.target = target;
    if (target) {
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
      await wait(120);
    }
    const last = i === steps.length - 1;
    card.replaceChildren(
      h('p', { class: 'tour-progress' }, `${tour.title} · ${steps.slice(0, i + 1).filter((s) => !s.fallback).length || 1} de ${counted(tour)}`),
      h('h3', { id: 'tour-title' }, step.title),
      h('p', { class: 'tour-text' }, step.text),
      h('div', { class: 'tour-actions' },
        h('button', { type: 'button', class: 'small tour-exit', onclick: () => finish(false) }, 'Sair'),
        i > 0 && h('button', { type: 'button', onclick: () => go(-1) }, 'Voltar'),
        h('button', { type: 'button', class: 'primary tour-next', onclick: () => go(1) }, last ? 'Concluir ✓' : 'Próximo')));
    reposition();
    card.querySelector('.tour-next').focus();
    state.busy = false;
  }

  function go(step) {
    if (state.busy) return;
    show(state.index + step, step);
  }

  try { await tour.start?.(); } catch { /* segue */ }
  await show(0, 1);
}

// ---------- Lista de treinamentos ----------

function tourList() {
  const done = doneSet();
  const admin = session.user?.role === 'admin';
  return TOURS.filter((tour) => !tour.adminOnly || admin).map((tour) => h('li', {},
    h('button', {
      type: 'button',
      class: 'tour-item',
      onclick: () => { el('tours-dialog').close(); runTour(tour); },
    },
    h('span', { class: 'tour-icon', 'aria-hidden': 'true' }, icon(tour.icon, 24)),
    h('span', { class: 'tour-item-text' }, h('strong', {}, tour.title), h('small', {}, `${tour.blurb} · ${counted(tour)} passos`)),
    done.has(tour.id) ? h('span', { class: 'tour-done', title: 'Concluído' }, '✓') : h('span', { class: 'tour-go', 'aria-hidden': 'true' }, '›'))));
}

export function openTours() {
  el('tours-list').replaceChildren(...tourList());
  el('tours-dialog').showModal();
}

export function initTours({ showView }) {
  ctx = { showView, hasTable: false };
  el('tours-open').addEventListener('click', openTours);
  // Primeiro acesso: oferece os treinamentos uma vez (depois de fechar as Configurações, se estiverem abertas).
  if (!store.get('tours.offered')) {
    store.set('tours.offered', '1');
    const settings = el('settings-dialog');
    if (settings?.open) settings.addEventListener('close', () => setTimeout(openTours, 200), { once: true });
    else setTimeout(openTours, 400);
  }
}
