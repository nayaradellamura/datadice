/*
 * Ícones padrão do DataDice: traço simples (como a engrenagem do topo), na cor do texto. Substituem os emoji
 * em botões, abas e telas vazias. Montados com createElementNS (nada de HTML vindo de texto).
 */
const SVG = 'http://www.w3.org/2000/svg';

const ICONS = {
  chat: [['path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }]],
  shield: [['path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' }]],
  book: [['path', { d: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20' }], ['path', { d: 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z' }]],
  note: [['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }], ['path', { d: 'M14 2v6h6M16 13H8M16 17H8M10 9H8' }]],
  users: [['path', { d: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' }], ['circle', { cx: 9, cy: 7, r: 4 }], ['path', { d: 'M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75' }]],
  dice: [['rect', { x: 3, y: 3, width: 18, height: 18, rx: 3 }], ['circle', { cx: 8, cy: 8, r: 1.4, fill: 'currentColor' }], ['circle', { cx: 12, cy: 12, r: 1.4, fill: 'currentColor' }], ['circle', { cx: 16, cy: 16, r: 1.4, fill: 'currentColor' }]],
  image: [['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }], ['circle', { cx: 8.5, cy: 8.5, r: 1.5 }], ['path', { d: 'M21 15l-5-5L5 21' }]],
  bot: [['rect', { x: 3, y: 8, width: 18, height: 12, rx: 2 }], ['path', { d: 'M12 8V4M8 13h.01M16 13h.01M9 17h6' }]],
  lock: [['rect', { x: 5, y: 11, width: 14, height: 10, rx: 2 }], ['path', { d: 'M8 11V7a4 4 0 0 1 8 0v4' }]],
  back: [['path', { d: 'M19 12H5M12 19l-7-7 7-7' }]],
  help: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01' }]],
  map: [['path', { d: 'M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z' }], ['path', { d: 'M8 2v16M16 6v16' }]],
  crown: [['path', { d: 'M2 18h20M3 7l5 5 4-7 4 7 5-5-2 11H5z' }]],
  user: [['path', { d: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2' }], ['circle', { cx: 12, cy: 7, r: 4 }]],
  sword: [['path', { d: 'M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2' }]],
  compass: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M16.2 7.8l-2.1 6.3-6.3 2.1 2.1-6.3z' }]],
  key: [['circle', { cx: 7.5, cy: 15.5, r: 5.5 }], ['path', { d: 'M21 2l-9.6 9.6M15.5 7.5l3 3L22 7l-3-3' }]],
  pen: [['path', { d: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z' }]],
};

/** Ícone SVG (decorativo: aria-hidden). size em px. */
export function icon(name, size = 20) {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
    'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'icon',
  })) svg.setAttribute(key, String(value));
  for (const [tag, attrs] of ICONS[name] ?? []) {
    const node = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    svg.append(node);
  }
  return svg;
}
