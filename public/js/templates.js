import { api, h, showError } from './api.js';
import { icon } from './icons.js';
import { entityForm, fill, KIND_LABELS, loadMeta, modOf } from './table-play.js';

/*
 * "Meus modelos": NPCs, monstros e locais guardados na conta do Mestre. Na Biblioteca de qualquer mesa,
 * "Começar de um modelo" traz a ficha pronta. Lista e formulário nunca aparecem juntos.
 */

const el = (id) => document.getElementById(id);
let templates = [];
let filter = 'all';
let meta = null;

const signed = (value) => (value >= 0 ? `+${value}` : `${value}`);

function templateCard(template) {
  const stats = template.stats ?? {};
  return h('article', { class: 'card tp-library-card' },
    template.image_url && h('img', { src: template.image_url, alt: '', class: 'tp-library-image', loading: 'lazy' }),
    h('div', { class: 'stack tp-library-body' },
      h('div', {}, h('strong', { class: 'tp-library-name' }, template.name), h('small', { class: 'muted' }, ` ${KIND_LABELS[template.kind]}`)),
      template.description && h('p', { class: 'prewrap tp-library-desc' }, template.description),
      template.kind !== 'location' && h('p', { class: 'muted' },
        `CA ${stats.armor_class ?? '—'} · PV ${stats.max_hp ?? '—'} · ${stats.speed ?? ''}${stats.challenge ? ` · ND ${stats.challenge}` : ''}`),
      template.kind !== 'location' && stats.abilities && h('p', { class: 'muted tp-abilities' },
        meta.abilities.map((a) => `${a.short} ${stats.abilities[a.key] ?? 10} (${signed(modOf(stats.abilities[a.key]))})`).join(' · ')),
      (stats.attacks ?? []).length > 0 && h('p', { class: 'muted' }, stats.attacks.map((a) => `${a.name} ${a.bonus} · ${a.damage}`).join(' | ')),
      h('div', { class: 'tp-library-actions' },
        h('button', { type: 'button', class: 'small', onclick: () => openForm(template) }, 'Editar'),
        h('button', {
          type: 'button',
          class: 'small danger',
          onclick: async () => {
            if (!window.confirm(`Excluir o modelo ${template.name}? As mesas que já usaram esta ficha não mudam.`)) return;
            try {
              await api(`/templates/${template.id}`, { method: 'DELETE' });
              await renderList();
            } catch (err) {
              showError(el('templates-error'), err);
            }
          },
        }, 'Excluir'))));
}

async function renderList() {
  templates = await api('/templates');
  const visible = templates.filter((item) => filter === 'all' || item.kind === filter);
  fill(el('templates-filters'),
    [['all', 'Tudo'], ['npc', 'NPCs'], ['monster', 'Monstros'], ['location', 'Locais']].map(([key, label]) =>
      h('button', { type: 'button', class: `small ${filter === key ? 'active' : ''}`, 'aria-pressed': String(filter === key), onclick: () => { filter = key; renderList(); } }, label)));
  // Sem nenhum modelo: o mesmo convite grande das outras telas vazias (Personagens, Campanhas, Mesas).
  el('templates-view').classList.toggle('is-empty', !templates.length);
  fill(el('templates-list'), visible.length
    ? visible.map(templateCard)
    : templates.length
      ? h('p', { class: 'muted tp-empty' }, 'Nenhum modelo deste tipo.')
      : emptyTemplates());
}

function emptyTemplates() {
  return h('div', { class: 'empty-hero' },
    h('span', { class: 'empty-hero-icon', 'aria-hidden': 'true' }, icon('book', 56)),
    h('h2', {}, 'Seus NPCs e monstros, prontos para qualquer mesa'),
    h('p', { class: 'muted' }, 'Cadastre uma vez e use em todas as suas mesas: na Biblioteca da mesa, escolha "Começar de um modelo".'),
    h('ul', { class: 'empty-steps' },
      h('li', {}, h('span', { class: 'step-icon', 'aria-hidden': 'true' }, icon('user', 26)), h('div', {}, h('strong', {}, 'NPCs'), h('small', {}, 'Taverneiros, vilões, aliados.'))),
      h('li', {}, h('span', { class: 'step-icon', 'aria-hidden': 'true' }, icon('sword', 26)), h('div', {}, h('strong', {}, 'Monstros'), h('small', {}, 'Com CA, PV, atributos e ataques prontos para rolar.'))),
      h('li', {}, h('span', { class: 'step-icon', 'aria-hidden': 'true' }, icon('map', 26)), h('div', {}, h('strong', {}, 'Locais'), h('small', {}, 'Com descrição e imagem.')))),
    h('button', { type: 'button', class: 'primary big', onclick: () => openForm() }, 'Criar meu primeiro modelo'));
}

function openForm(template = null) {
  el('templates-view').classList.add('is-editing');
  showError(el('templates-error'), null);
  const close = () => {
    el('templates-view').classList.remove('is-editing');
    el('templates-form').hidden = true;
    el('templates-form').replaceChildren();
    renderList().catch((err) => showError(el('templates-error'), err));
  };
  el('templates-form').replaceChildren(entityForm({
    entry: template,
    mode: 'template',
    onClose: close,
    onSubmit: async (body) => {
      if (template) await api(`/templates/${template.id}`, { method: 'PATCH', body });
      else await api('/templates', { method: 'POST', body });
      close();
    },
  }));
  el('templates-form').hidden = false;
  window.scrollTo({ top: 0 });
  el('templates-form').querySelector('input[name=name]')?.focus();
}

/** Abre a tela "Meus modelos" (item Modelos do menu de Mesas com amigos). */
export async function openTemplates() {
  meta = await loadMeta();
  el('templates-view').classList.remove('is-editing');
  el('templates-form').hidden = true;
  el('templates-form').replaceChildren();
  await renderList();
}

export function initTemplates() {
  el('template-new').addEventListener('click', () => openForm());
}
