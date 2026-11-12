import { api, campaignLabel, emptyState, fillSelect, formatText, h, showError } from './api.js';
import { selectedCampaign } from './game.js';
import { KIND_LABELS, visualImage } from './visual.js';

// Mesmos nomes e ordem da Biblioteca das mesas.
const FILTERS = [['all', 'Tudo'], ['npc', 'NPCs'], ['monster', 'Monstros'], ['location', 'Locais']];

const el = (id) => document.getElementById(id);
let visuals = [];
let filter = 'all';
let pollTimer = null;

async function retry(visual) {
  try {
    await api(`/visuals/${visual.kind}/${visual.id}/retry`, { method: 'POST', body: {}, gemini: true });
    showError(el('library-error'), null);
    await renderLibrary();
  } catch (err) {
    showError(el('library-error'), err);
  }
}

function card(visual) {
  return h('article', { class: `library-card kind-${visual.kind}` },
    h('div', { class: 'library-image' }, visualImage(visual)),
    h('div', { class: 'library-info' },
      h('strong', {}, visual.name),
      h('span', { class: 'library-kind' }, KIND_LABELS[visual.kind]),
      visual.description && h('p', { class: 'muted' }, formatText(visual.description)),
      visual.image_status === 'failed' &&
        h('button', { type: 'button', class: 'small', onclick: () => retry(visual) }, 'Tentar de novo')));
}

function renderList() {
  for (const button of el('library-filters').children) {
    const active = button.dataset.filter === filter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  const visible = visuals.filter((visual) => filter === 'all' || visual.kind === filter);
  // Sem nenhuma arte, os filtros não servem para nada: somem, e fica um convite explicando o que fazer.
  el('library-filters').hidden = !visuals.length;
  const goTo = (view) => document.dispatchEvent(new CustomEvent('show-view', { detail: view }));
  el('library-grid').replaceChildren(
    ...(visible.length
      ? visible.map(card)
      : visuals.length
        ? [h('p', { class: 'empty library-empty' }, 'Nenhuma arte deste tipo ainda.')]
        : selectedCampaign()
          ? [emptyState({
            icon: 'image',
            title: 'As artes da campanha aparecem aqui',
            text: 'Quando o Mestre IA ilustra um NPC, monstro ou lugar marcante, a imagem fica guardada aqui. Para isso, ligue "Gerar ilustrações" em Configurações (precisa de faturamento ativo na chave do Gemini).',
            actions: [['Abrir Configurações', () => document.dispatchEvent(new CustomEvent('open-settings')), true], ['Ir para o Jogo', () => goTo('game')]],
          })]
          : [emptyState({ icon: 'map', title: 'Escolha uma campanha', text: 'A Biblioteca mostra as artes de uma campanha por vez.', actions: [['Ver campanhas', () => goTo('campaigns'), true]] })]),
  );
}

export async function renderLibrary() {
  clearTimeout(pollTimer);
  const campaign = selectedCampaign();
  const campaigns = await api('/campaigns');
  fillSelect(el('library-campaign'), campaigns.map((c) => ({ value: c.id, label: campaignLabel(c) })), {
    placeholder: campaigns.length ? 'Escolha uma campanha' : 'Crie uma campanha primeiro',
    value: campaign?.id ?? '',
  });
  visuals = campaign ? await api(`/campaigns/${campaign.id}/visuals`) : [];
  renderList();

  // Enquanto houver arte em geração e a aba estiver aberta, atualiza sozinha.
  if (visuals.some((visual) => visual.image_status === 'pending')) {
    pollTimer = setTimeout(() => {
      if (!el('view-library').hidden) renderLibrary().catch((err) => showError(el('library-error'), err));
    }, 3000);
  }
}

export function initLibrary() {
  el('library-filters').append(...FILTERS.map(([value, label]) =>
    h('button', {
      type: 'button',
      class: 'small',
      dataset: { filter: value },
      onclick: () => { filter = value; renderList(); },
    }, label)));

  el('library-campaign').addEventListener('change', async (event) => {
    const gameSelect = el('game-campaign');
    gameSelect.value = event.target.value;
    gameSelect.dispatchEvent(new Event('change'));
    await renderLibrary();
  });
}
