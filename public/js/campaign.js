import { api, h, session, showError } from './api.js';
import { icon } from './icons.js';

const el = (id) => document.getElementById(id);
let editingId = null;
let campaignCount = 0;

function openEditor({ creating = false } = {}) {
  el('view-campaigns').classList.toggle('is-creating', creating);
  if (creating) window.scrollTo({ top: 0 });
  el('campaign-editor').hidden = false;
  el('campaign-new').hidden = true;
  renderEmptyState();
  el('campaign-editor').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

function closeEditor() {
  el('view-campaigns').classList.remove('is-creating');
  resetForm();
  el('campaign-editor').hidden = true;
  el('campaign-new').hidden = !campaignCount;
  renderEmptyState();
}
let themesLoaded = false;
const choice = { theme: null, tone: 'equilibrado', length: 'longa' };

/** Mostra o criador com IA ("ai") ou o formulário ("form"), usado para escrever do zero, revisar o rascunho e editar. */
function show(panel, { tab = panel === 'ai' ? 'ai' : 'manual' } = {}) {
  el('campaign-ai').hidden = panel !== 'ai';
  el('campaign-form').hidden = panel !== 'form';
  for (const button of el('campaign-mode').children) {
    const active = button.dataset.mode === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
}

function resetForm() {
  editingId = null;
  el('campaign-form').reset();
  el('campaign-form-title').textContent = 'Nova campanha';
  el('campaign-submit').textContent = 'Criar campanha';
  el('campaign-cancel').hidden = false;
  el('campaign-draft-note').hidden = true;
  el('campaign-mode').hidden = false;
  showError(el('campaign-error'), null);
  show('ai');
}

function startEdit(campaign) {
  const { elements } = el('campaign-form');
  editingId = campaign.id;
  elements.name.value = campaign.name;
  elements.world_description.value = campaign.world_description;
  elements.system_prompt.value = campaign.system_prompt;
  el('campaign-form-title').textContent = `Editar: ${campaign.name}`;
  el('campaign-submit').textContent = 'Salvar alterações';
  el('campaign-cancel').hidden = false;
  el('campaign-draft-note').hidden = true;
  el('campaign-mode').hidden = true;
  showError(el('campaign-error'), null);
  show('form');
  openEditor();
  elements.name.focus();
}

/** Marca uma opção num grupo de botões que funciona como rádio. */
function select(group, value) {
  for (const button of group.children) {
    const active = button.dataset.value === value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
  }
}

async function loadThemes() {
  if (themesLoaded) return;
  const { themes } = await api('/campaigns/themes');
  el('campaign-themes').replaceChildren(...themes.map((theme) =>
    h('button', {
      type: 'button',
      role: 'radio',
      class: 'theme-card',
      'aria-checked': 'false',
      dataset: { value: theme.key },
      onclick: () => {
        choice.theme = theme.key;
        select(el('campaign-themes'), theme.key);
        showError(el('campaign-ai-error'), null);
      },
    },
    h('span', { class: 'theme-icon', 'aria-hidden': 'true' }, theme.icon),
    h('strong', {}, theme.title),
    h('small', {}, theme.blurb))));
  themesLoaded = true;
}

async function generate() {
  if (!choice.theme) {
    showError(el('campaign-ai-error'), new Error('Escolha um tema para começar.'));
    el('campaign-themes').scrollIntoView({ block: 'center' });
    return;
  }
  const buttons = [el('campaign-generate'), el('campaign-regenerate'), el('campaign-submit')];
  for (const button of buttons) button.disabled = true;
  el('campaign-generating').hidden = false;
  showError(el('campaign-ai-error'), null);
  showError(el('campaign-error'), null);
  try {
    const draft = await api('/campaigns/generate', {
      method: 'POST',
      body: { ...choice, idea: el('campaign-idea').value },
      gemini: true,
    });
    const { elements } = el('campaign-form');
    elements.name.value = draft.name;
    elements.world_description.value = draft.world_description;
    elements.system_prompt.value = draft.system_prompt;
    el('campaign-draft-note').hidden = false;
    show('form', { tab: 'ai' });
    el('campaign-form').scrollIntoView({ block: 'start' });
  } catch (err) {
    // Se o rascunho já está na tela, o erro aparece junto dele.
    showError(el('campaign-form').hidden ? el('campaign-ai-error') : el('campaign-error'), err);
  } finally {
    for (const button of buttons) button.disabled = false;
    el('campaign-generating').hidden = true;
  }
}

// Cor de cada cartão a partir do nome: a mesma campanha tem sempre a mesma cor.
const hueOf = (text) => [...text].reduce((sum, char) => (sum * 31 + char.codePointAt(0)) % 360, 17);

/** Primeira frase útil da descrição, sem os títulos ("Premissa:"). */
function premise(text) {
  const line = (text ?? '').split('\n').map((part) => part.trim()).find((part) => part && !/^[^:]{1,40}:$/.test(part)) ?? '';
  const clean = line.replace(/^Premissa:\s*/i, '');
  return clean.length > 220 ? `${clean.slice(0, 217).trimEnd()}...` : clean;
}

function lastPlayed(campaign) {
  if (!campaign.last_played_at) return 'Ainda não começou';
  const days = Math.floor((Date.now() - new Date(`${campaign.last_played_at.replace(' ', 'T')}Z`)) / 86400000);
  if (days <= 0) return 'Jogada hoje';
  if (days === 1) return 'Jogada ontem';
  return days < 30 ? `Jogada há ${days} dias` : `Jogada em ${new Date(`${campaign.last_played_at.replace(' ', 'T')}Z`).toLocaleDateString('pt-BR')}`;
}

function campaignCard(campaign, index) {
  const party = campaign.party_size ?? 0;
  const messages = campaign.message_count ?? 0;
  return h('article', { class: 'campaign-card', style: `--hue:${hueOf(campaign.name)};--delay:${Math.min(index, 10) * 45}ms` },
    h('div', { class: 'campaign-card-top' },
      h('span', { class: 'campaign-initial', 'aria-hidden': 'true' }, [...campaign.name.trim()][0]?.toUpperCase() ?? '?'),
      h('div', { class: 'campaign-identity' },
        h('strong', {}, campaign.name),
        h('small', {}, lastPlayed(campaign)),
        campaign.owner_name && campaign.user_id !== session.user?.id && h('small', { class: 'campaign-owner' }, `de ${campaign.owner_name}`))),
    h('p', { class: 'campaign-premise' }, premise(campaign.world_description) || 'Mundo ainda não descrito.'),
    h('div', { class: 'campaign-meta' },
      h('span', {}, `${party} ${party === 1 ? 'herói' : 'heróis'}`),
      h('span', {}, `${messages} ${messages === 1 ? 'mensagem' : 'mensagens'}`)),
    h('div', { class: 'campaign-actions' },
      h('button', { type: 'button', class: 'primary', onclick: () => document.dispatchEvent(new CustomEvent('play-campaign', { detail: campaign.id })) }, 'Jogar'),
      h('button', { type: 'button', onclick: () => startEdit(campaign) }, 'Editar')));
}

function emptyCampaigns() {
  return h('div', { class: 'empty-hero' },
    h('span', { class: 'empty-hero-icon', 'aria-hidden': 'true' }, icon('map', 56)),
    h('h2', {}, 'Seu primeiro mundo está a um toque'),
    h('p', { class: 'muted' }, 'Escolha um tema e a IA cria a campanha: o mundo, os lugares, os personagens e o começo da aventura. Depois é só revisar e jogar.'),
    h('div', { class: 'theme-preview', 'aria-hidden': 'true' }, ['Fantasia', 'Terror', 'Piratas', 'Intriga'].map((label) => h('span', {}, label))),
    h('button', { type: 'button', class: 'primary big', onclick: () => openEditor({ creating: true }) }, 'Criar minha primeira campanha'));
}

function renderEmptyState() {
  if (campaignCount) return;
  el('campaign-list').replaceChildren(...(el('campaign-editor').hidden ? [emptyCampaigns()] : []));
  el('campaign-list-title').hidden = true;
}

export async function renderCampaigns() {
  await loadThemes().catch((err) => showError(el('campaign-ai-error'), err));
  const campaigns = await api('/campaigns');
  campaignCount = campaigns.length;
  el('campaign-list-title').hidden = !campaigns.length;
  el('campaign-new').hidden = !campaigns.length || !el('campaign-editor').hidden;
  if (!campaigns.length) {
    renderEmptyState();
    return;
  }
  el('campaign-list').replaceChildren(...campaigns.map(campaignCard));
}

export function initCampaigns(onChanged) {
  for (const button of el('campaign-mode').children) {
    button.addEventListener('click', () => {
      showError(el('campaign-error'), null);
      if (button.dataset.mode === 'ai') {
        show('ai');
      } else {
        el('campaign-draft-note').hidden = true;
        show('form');
        el('campaign-form').elements.name.focus();
      }
    });
  }
  for (const [group, key] of [[el('campaign-tone'), 'tone'], [el('campaign-length'), 'length']]) {
    for (const button of group.children) {
      button.addEventListener('click', () => {
        choice[key] = button.dataset.value;
        select(group, button.dataset.value);
      });
    }
  }
  el('campaign-generate').addEventListener('click', generate);
  el('campaign-regenerate').addEventListener('click', generate);
  el('campaign-cancel').addEventListener('click', closeEditor);
  el('campaign-close').addEventListener('click', closeEditor);
  el('campaign-new').addEventListener('click', () => {
    resetForm();
    openEditor({ creating: true });
  });
  el('campaign-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const { elements } = event.target;
    try {
      await api(editingId ? `/campaigns/${editingId}` : '/campaigns', {
        method: editingId ? 'PUT' : 'POST',
        body: {
          name: elements.name.value,
          world_description: elements.world_description.value,
          system_prompt: elements.system_prompt.value,
        },
      });
      closeEditor();
      await renderCampaigns();
      await onChanged();
    } catch (err) {
      showError(el('campaign-error'), err);
    }
  });
}
