import { api, campaignLabel, fillSelect, formatText, h, showError } from './api.js';
import { selectedCampaign } from './game.js';

const TYPE_LABELS = { npc: 'NPC', location: 'Local', quest: 'Missão', item: 'Item', faction: 'Facção', event: 'Evento', fact: 'Fato' };
const STATUS_LABELS = { active: 'Ativo', resolved: 'Resolvido', dead: 'Morto', lost: 'Perdido' };

const el = (id) => document.getElementById(id);
let memories = [];
let editingId = null;
let confirmingDelete = null;

function resetForm() {
  editingId = null;
  el('memory-form').reset();
  el('memory-form').elements.importance.value = '3';
  el('memory-form-title').textContent = 'Nova memória';
  el('memory-cancel').hidden = true;
}

function startEdit(memory) {
  const { elements } = el('memory-form');
  editingId = memory.id;
  for (const name of ['name', 'type', 'status', 'content']) elements[name].value = memory[name];
  elements.importance.value = String(memory.importance);
  elements.pinned.checked = Boolean(memory.pinned);
  el('memory-form-title').textContent = `Editar: ${memory.name}`;
  el('memory-cancel').hidden = false;
  el('memory-form').scrollIntoView({ block: 'start' });
  elements.content.focus();
}

function renderList() {
  const filter = el('notebook-filter').value.trim().toLowerCase();
  const visible = memories.filter((memory) => !filter || `${memory.name} ${memory.content}`.toLowerCase().includes(filter));

  el('memory-list').replaceChildren(
    ...(visible.length
      ? visible.map((memory) =>
          h('article', { class: `card memory-card ${memory.pinned ? 'is-pinned' : ''}` },
            h('header', {},
              h('strong', {}, `${memory.name}${memory.pinned ? ' (fixada)' : ''}`),
              h('span', { class: 'muted' }, `${TYPE_LABELS[memory.type]} · ${STATUS_LABELS[memory.status]} · importância ${memory.importance}${memory.source === 'user' ? ' · editada por você' : ''}`)),
            h('p', { class: 'prewrap' }, formatText(memory.content)),
            h('div', { class: 'actions' },
              h('button', { type: 'button', class: 'small', onclick: () => togglePin(memory) }, memory.pinned ? 'Desafixar' : 'Fixar'),
              h('button', { type: 'button', class: 'small', onclick: () => startEdit(memory) }, 'Editar'),
              h('button', { type: 'button', class: 'small danger', onclick: () => removeMemory(memory) }, confirmingDelete === memory.id ? 'Confirmar exclusão' : 'Excluir')))
        )
      : [h('p', { class: 'empty' }, memories.length ? 'Nenhuma memória corresponde ao filtro.' : 'O Mestre registra aqui NPCs, locais e missões conforme a história avança. Você também pode adicionar os seus.')])
  );
}

async function togglePin(memory) {
  try {
    await api(`/memories/${memory.id}`, { method: 'PATCH', body: { pinned: !memory.pinned } });
    await renderNotebook();
  } catch (err) {
    showError(el('memory-error'), err);
  }
}

async function removeMemory(memory) {
  if (confirmingDelete !== memory.id) {
    confirmingDelete = memory.id;
    renderList();
    return;
  }
  confirmingDelete = null;
  try {
    await api(`/memories/${memory.id}`, { method: 'DELETE' });
    if (editingId === memory.id) resetForm();
    await renderNotebook();
  } catch (err) {
    showError(el('memory-error'), err);
  }
}

export async function renderNotebook() {
  const campaign = selectedCampaign();
  const campaigns = await api('/campaigns');
  fillSelect(el('notebook-campaign'), campaigns.map((c) => ({ value: c.id, label: campaignLabel(c) })), {
    placeholder: campaigns.length ? 'Escolha uma campanha' : 'Crie uma campanha primeiro',
    value: campaign?.id ?? '',
  });
  el('memory-form').hidden = !campaign;
  if (!campaign) {
    memories = [];
    el('chronicle-box').hidden = true;
    el('memory-list').replaceChildren();
    return;
  }
  const [list, state] = await Promise.all([api(`/campaigns/${campaign.id}/memories`), api(`/campaigns/${campaign.id}/state`)]);
  memories = list;
  el('chronicle-box').hidden = !state.chronicle;
  el('chronicle-text').replaceChildren(formatText(state.chronicle));
  renderList();
}

export function initNotebook() {
  // A campanha é uma só no sistema: trocar aqui também troca na aba Jogo.
  el('notebook-campaign').addEventListener('change', async (event) => {
    const gameSelect = el('game-campaign');
    gameSelect.value = event.target.value;
    gameSelect.dispatchEvent(new Event('change'));
    resetForm();
    await renderNotebook();
  });
  el('notebook-filter').addEventListener('input', renderList);
  el('memory-cancel').addEventListener('click', resetForm);
  el('memory-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const { elements } = event.target;
    const body = {
      name: elements.name.value,
      type: elements.type.value,
      status: elements.status.value,
      importance: Number(elements.importance.value),
      content: elements.content.value,
      pinned: elements.pinned.checked,
    };
    try {
      if (editingId) await api(`/memories/${editingId}`, { method: 'PATCH', body });
      else await api(`/campaigns/${selectedCampaign().id}/memories`, { method: 'POST', body });
      resetForm();
      showError(el('memory-error'), null);
      await renderNotebook();
    } catch (err) {
      showError(el('memory-error'), err);
    }
  });
}
