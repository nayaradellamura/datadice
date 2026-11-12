import { formatText, h } from './api.js';

export const KIND_LABELS = { npc: 'NPC', monster: 'Monstro', location: 'Local' };

let dialog;

/** Mostra a arte ampliada. O <dialog> nativo cuida do foco e fecha com Esc. */
export function openImage(visual) {
  if (!dialog) {
    dialog = h('dialog', {
      class: 'image-dialog',
      onclick: (event) => { if (event.target === dialog) dialog.close(); },
    });
    document.body.append(dialog);
  }
  dialog.replaceChildren(
    h('img', { src: visual.image_url, alt: visual.description || visual.name }),
    h('div', { class: 'image-dialog-info' },
      h('div', {},
        h('strong', {}, visual.name),
        h('span', { class: 'muted' }, ` · ${KIND_LABELS[visual.kind]}`),
        visual.description && h('p', { class: 'muted' }, formatText(visual.description))),
      h('button', { type: 'button', onclick: () => dialog.close() }, 'Fechar')),
  );
  dialog.showModal();
}

const TOAST_SECONDS = 20;

const shownFailures = new Set();

/** Avisa, em qualquer aba, que uma arte terminou. O aviso some sozinho, mas a arte fica na bolha e na Biblioteca. */
export function notifyVisualFinished(visual) {
  // Várias imagens do mesmo turno costumam falhar pelo mesmo motivo (ex.: plano gratuito): um aviso basta.
  if (visual.image_status !== 'ready' && visual.image_error) {
    if (shownFailures.has(visual.image_error)) return;
    shownFailures.add(visual.image_error);
    setTimeout(() => shownFailures.delete(visual.image_error), TOAST_SECONDS * 1000);
  }
  let area = document.getElementById('toast-area');
  if (!area) {
    area = h('div', { id: 'toast-area', class: 'toast-area', role: 'status', 'aria-live': 'polite' });
    document.body.append(area);
  }

  const ready = visual.image_status === 'ready';
  const close = () => { clearTimeout(timer); toast.remove(); };
  const toast = h('div', { class: `toast ${ready ? '' : 'is-failed'}` },
    ready && h('img', { src: visual.image_url, alt: '' }),
    h('div', { class: 'toast-body' },
      h('strong', {}, ready ? 'Imagem pronta' : 'Imagem não gerada'),
      h('p', { class: 'muted' }, `${KIND_LABELS[visual.kind]}: ${visual.name}`),
      !ready && visual.image_error && h('p', { class: 'toast-reason' }, visual.image_error),
      h('div', { class: 'toast-actions' },
        ready
          ? h('button', { type: 'button', class: 'small primary toast-view', onclick: () => { close(); openImage(visual); } }, 'Ver imagem')
          : h('button', { type: 'button', class: 'small primary toast-library', onclick: () => { close(); document.querySelector('.tab[data-view="library"]').click(); } }, 'Abrir Biblioteca'),
        !ready && h('button', { type: 'button', class: 'small', onclick: () => { close(); document.dispatchEvent(new CustomEvent('open-settings')); } }, 'Configurações'),
        h('button', { type: 'button', class: 'small toast-close', onclick: close }, 'Fechar'))),
  );
  const timer = setTimeout(close, TOAST_SECONDS * 1000);
  area.append(toast);
}

/** A imagem em si, ou o estado dela enquanto não está pronta. */
export function visualImage(visual) {
  if (visual.image_status === 'ready' && visual.image_url) {
    return h('button', {
      type: 'button',
      class: 'visual-open',
      'aria-label': `Ampliar imagem: ${visual.name}`,
      onclick: () => openImage(visual),
    }, h('img', { src: visual.image_url, alt: visual.description || visual.name, loading: 'lazy' }));
  }
  if (visual.image_status === 'pending') {
    return h('div', { class: 'visual-placeholder', role: 'status' }, h('div', { class: 'spinner' }), `Ilustrando ${visual.name}...`);
  }
  return h('div', { class: 'visual-placeholder is-failed' },
    h('strong', {}, `Não foi possível ilustrar ${visual.name}.`),
    visual.image_error && h('span', {}, visual.image_error));
}

/** Imagem dentro da bolha do chat. */
export function illustrationFigure(visual) {
  return h('figure', {
    class: `illustration kind-${visual.kind} status-${visual.image_status}`,
    dataset: { key: `${visual.kind}:${visual.id}` },
  },
    visualImage(visual),
    h('figcaption', {}, `${KIND_LABELS[visual.kind]}: ${visual.name}`));
}
