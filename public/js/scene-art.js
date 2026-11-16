/*
 * Ilustrações dos ambientes (faixa no topo do chat). Desenhadas aqui mesmo, em SVG: não usam imagem,
 * chave nem internet, então valem no plano gratuito. Cada lugar é uma composição de camadas
 * (céu conforme a hora, relevo ao fundo e silhuetas na frente), sempre igual para o mesmo lugar.
 */
const SVG = 'http://www.w3.org/2000/svg';
const W = 480;
const H = 120;

export const PLACE_LABELS = {
  taverna: 'Taverna', cidade: 'Cidade', vila: 'Vila', castelo: 'Castelo', floresta: 'Floresta', estrada: 'Estrada',
  campo: 'Campo', montanha: 'Montanha', caverna: 'Caverna', masmorra: 'Masmorra', ruinas: 'Ruínas', templo: 'Templo',
  mar: 'Mar', pantano: 'Pântano', deserto: 'Deserto', acampamento: 'Acampamento',
};
export const TIME_LABELS = { amanhecer: 'Amanhecer', dia: 'Dia', entardecer: 'Entardecer', noite: 'Noite' };

const SKIES = {
  amanhecer: { top: '#34476a', bottom: '#f2b27a', light: '#ffd9a0', lightY: 92, glow: .55 },
  dia: { top: '#4f8db8', bottom: '#bcd9e4', light: '#fff3c4', lightY: 30, glow: .35 },
  entardecer: { top: '#26304d', bottom: '#f2874a', light: '#ffb36b', lightY: 88, glow: .6 },
  noite: { top: '#060d16', bottom: '#183047', light: '#f5eedd', lightY: 28, glow: .18 },
};
// Lugares fechados ignoram o céu.
const INDOOR = new Set(['caverna', 'masmorra']);

function node(tag, attrs = {}, children = []) {
  const element = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  for (const child of children) if (child) element.append(child);
  return element;
}

// Números "aleatórios" fixos por lugar: a mesma cena sempre tem o mesmo desenho.
function seeded(seed) {
  let value = seed;
  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
}

const seedOf = (text) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 2147483647, 7) || 7;

/** Relevo suave: soma de ondas a partir da linha base. */
function ridge(baseY, amp, random, fill, opacity = 1, waves = 3) {
  const phases = Array.from({ length: waves }, () => random() * Math.PI * 2);
  const freqs = Array.from({ length: waves }, (_, i) => (i + 1) * (0.008 + random() * 0.006));
  let d = `M0 ${H}`;
  for (let x = 0; x <= W; x += 12) {
    const y = baseY - phases.reduce((sum, phase, i) => sum + Math.sin(x * freqs[i] + phase) * (amp / (i + 1)), 0);
    d += ` L${x} ${y.toFixed(1)}`;
  }
  return node('path', { d: `${d} L${W} ${H} Z`, fill, opacity });
}

/** Picos pontudos (montanhas), com neve opcional. */
function peaks(baseY, count, height, random, fill, snow) {
  const group = node('g');
  let d = `M0 ${H} L0 ${baseY}`;
  const caps = [];
  for (let i = 0; i < count; i += 1) {
    const x0 = (i / count) * W;
    const x1 = ((i + 1) / count) * W;
    const top = baseY - height * (0.55 + random() * 0.45);
    const mid = x0 + (x1 - x0) * (0.35 + random() * 0.3);
    d += ` L${mid.toFixed(1)} ${top.toFixed(1)} L${x1.toFixed(1)} ${baseY - random() * 10}`;
    if (snow) caps.push(`M${mid - 9} ${top + 11} L${mid} ${top} L${mid + 9} ${top + 11} L${mid + 3} ${top + 8} L${mid - 2} ${top + 12} Z`);
  }
  group.append(node('path', { d: `${d} L${W} ${H} Z`, fill }));
  for (const cap of caps) group.append(node('path', { d: cap, fill: '#e8eef2', opacity: snow }));
  return group;
}

function pines(baseY, count, minH, maxH, random, fill, from = 0, to = W) {
  const group = node('g', { fill });
  for (let i = 0; i < count; i += 1) {
    const x = from + random() * (to - from);
    const h = minH + random() * (maxH - minH);
    const w = h * 0.42;
    group.append(node('path', { d: `M${x} ${baseY - h} L${x + w / 2} ${baseY - h * 0.45} L${x + w * 0.3} ${baseY - h * 0.45} L${x + w * 0.62} ${baseY} L${x - w * 0.62} ${baseY} L${x - w * 0.3} ${baseY - h * 0.45} L${x - w / 2} ${baseY - h * 0.45} Z` }));
  }
  return group;
}

function roundTrees(baseY, count, random, fill, from = 0, to = W) {
  const group = node('g', { fill });
  for (let i = 0; i < count; i += 1) {
    const x = from + random() * (to - from);
    const r = 7 + random() * 9;
    group.append(node('rect', { x: x - 1.5, y: baseY - r, width: 3, height: r }));
    group.append(node('circle', { cx: x, cy: baseY - r - r * 0.6, r }));
  }
  return group;
}

/** Casa com telhado e janelas (acesas à noite e ao entardecer). */
function house(x, baseY, w, h, fill, lit, random) {
  const group = node('g');
  group.append(node('rect', { x, y: baseY - h, width: w, height: h, fill }));
  group.append(node('path', { d: `M${x - 3} ${baseY - h} L${x + w / 2} ${baseY - h - w * 0.45} L${x + w + 3} ${baseY - h} Z`, fill }));
  const windows = Math.max(1, Math.floor(w / 12));
  for (let i = 0; i < windows; i += 1) {
    if (random() < 0.35) continue;
    group.append(node('rect', {
      x: x + 4 + i * ((w - 8) / windows), y: baseY - h * 0.7, width: 4, height: 5,
      fill: lit ? '#f2b52a' : '#2e4a5e', opacity: lit ? 0.95 : 0.8,
    }));
  }
  return group;
}

function tower(x, baseY, w, h, fill, lit) {
  const group = node('g', { fill });
  group.append(node('rect', { x, y: baseY - h, width: w, height: h }));
  for (let i = 0; i < 3; i += 1) group.append(node('rect', { x: x + i * (w / 3) + 1, y: baseY - h - 5, width: w / 3 - 2.5, height: 5 }));
  if (lit) group.append(node('rect', { x: x + w / 2 - 1.5, y: baseY - h * 0.7, width: 3, height: 6, fill: '#f2b52a' }));
  return group;
}

function stars(random) {
  const group = node('g', { fill: '#f5eedd' });
  for (let i = 0; i < 40; i += 1) {
    group.append(node('circle', { cx: random() * W, cy: random() * 70, r: random() < 0.15 ? 1.1 : 0.6, opacity: 0.4 + random() * 0.6 }));
  }
  return group;
}

function glow(cx, cy, r, color, opacity, id) {
  return [
    node('defs', {}, [node('radialGradient', { id }, [
      node('stop', { offset: '0', 'stop-color': color, 'stop-opacity': opacity }),
      node('stop', { offset: '1', 'stop-color': color, 'stop-opacity': 0 }),
    ])]),
    node('circle', { cx, cy, r, fill: `url(#${id})` }),
  ];
}

let uid = 0;

/** SVG da cena. place: um dos PLACE_LABELS; time: amanhecer, dia, entardecer ou noite. */
export function sceneArt(place, time = 'dia') {
  const id = `sc${uid += 1}`;
  const random = seeded(seedOf(place));
  const sky = SKIES[time] ?? SKIES.dia;
  const lit = time === 'noite' || time === 'entardecer';
  // À noite o céu já é escuro: as silhuetas clareiam um pouco para continuarem visíveis.
  const far = time === 'noite' ? 'rgb(52 82 108 / .55)' : 'rgb(10 22 33 / .38)';
  const mid = time === 'noite' ? 'rgb(30 52 72 / .9)' : 'rgb(10 22 33 / .66)';
  const near = '#0b1824';
  const svg = node('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMax slice', class: 'scene-art', 'aria-hidden': 'true' });
  const layers = [];

  if (INDOOR.has(place)) {
    layers.push(node('defs', {}, [node('linearGradient', { id: `${id}g`, x1: 0, y1: 0, x2: 0, y2: 1 }, [
      node('stop', { offset: '0', 'stop-color': place === 'caverna' ? '#141b22' : '#1b1712' }),
      node('stop', { offset: '1', 'stop-color': place === 'caverna' ? '#22313b' : '#2b2118' }),
    ])]));
    layers.push(node('rect', { width: W, height: H, fill: `url(#${id}g)` }));
  } else {
    layers.push(node('defs', {}, [node('linearGradient', { id: `${id}g`, x1: 0, y1: 0, x2: 0, y2: 1 }, [
      node('stop', { offset: '0', 'stop-color': sky.top }),
      node('stop', { offset: '1', 'stop-color': place === 'deserto' && time === 'dia' ? '#f0d9a8' : sky.bottom }),
    ])]));
    layers.push(node('rect', { width: W, height: H, fill: `url(#${id}g)` }));
    if (time === 'noite') layers.push(stars(random));
    const lightX = time === 'amanhecer' ? 90 : time === 'entardecer' ? 380 : 360;
    layers.push(...glow(lightX, sky.lightY, 60, sky.light, sky.glow, `${id}l`));
    layers.push(node('circle', { cx: lightX, cy: sky.lightY, r: time === 'noite' ? 9 : 12, fill: sky.light, opacity: 0.95 }));
    if (time === 'noite') layers.push(node('circle', { cx: lightX + 4, cy: sky.lightY - 3, r: 8, fill: sky.top }));
  }

  switch (place) {
    case 'floresta':
      layers.push(ridge(78, 10, random, far), pines(96, 26, 22, 40, random, mid), pines(H + 4, 18, 36, 62, random, near));
      break;
    case 'campo':
      layers.push(ridge(84, 8, random, far), ridge(98, 6, random, mid), roundTrees(104, 4, random, near), ridge(112, 4, random, near));
      break;
    case 'estrada':
      layers.push(peaks(80, 5, 30, random, far, 0), ridge(96, 8, random, mid), ridge(110, 5, random, near),
        node('path', { d: 'M180 120 C210 108 250 104 262 98 C272 93 290 92 300 91 L304 92 C290 95 282 98 274 102 C256 110 236 114 226 120 Z', fill: '#c9b48a', opacity: 0.35 }),
        pines(112, 5, 20, 34, random, near, 0, 150), pines(112, 4, 20, 34, random, near, 340, 480));
      break;
    case 'montanha':
      layers.push(peaks(96, 4, 80, random, 'rgb(10 22 33 / .45)', 0.85), peaks(108, 6, 42, random, mid, 0.6), ridge(116, 4, random, near));
      break;
    case 'cidade': {
      layers.push(ridge(86, 6, random, far));
      const g = node('g');
      for (let x = 20; x < W - 20; x += 26 + random() * 14) g.append(house(x, 104, 20 + random() * 12, 14 + random() * 18, mid, lit, random));
      g.append(tower(150, 104, 14, 52, mid, lit), tower(320, 104, 12, 44, mid, lit));
      layers.push(g);
      const wall = node('g', { fill: near });
      wall.append(node('rect', { x: 0, y: 104, width: W, height: 16 }));
      for (let x = 0; x < W; x += 12) wall.append(node('rect', { x, y: 99, width: 7, height: 6 }));
      layers.push(wall);
      break;
    }
    case 'vila': {
      layers.push(ridge(84, 8, random, far), ridge(104, 4, random, mid));
      const g = node('g');
      for (const x of [70, 120, 250, 300, 380]) g.append(house(x + random() * 10, 108, 22 + random() * 8, 14 + random() * 6, near, lit, random));
      layers.push(roundTrees(108, 6, random, near), g, ridge(116, 3, random, near));
      break;
    }
    case 'castelo': {
      layers.push(ridge(88, 8, random, far));
      const c = node('g');
      const hill = ridge(100, 10, random, mid);
      c.append(hill);
      for (const [x, w, h] of [[190, 18, 58], [212, 60, 34], [274, 18, 66], [296, 40, 30], [338, 16, 50]]) c.append(tower(x, 96, w, h, mid, lit));
      c.append(node('path', { d: 'M283 26 L283 16 L295 20 L283 23', fill: '#f26b3a' }));
      layers.push(c, ridge(114, 4, random, near), pines(118, 6, 18, 30, random, near, 0, 160));
      break;
    }
    case 'taverna': {
      layers.push(ridge(88, 6, random, far), roundTrees(104, 4, random, mid));
      const g = node('g', { fill: near });
      g.append(node('rect', { x: 170, y: 64, width: 150, height: 56 }));
      g.append(node('path', { d: 'M160 66 L245 30 L330 66 Z' }));
      g.append(node('rect', { x: 286, y: 30, width: 12, height: 26 }));
      layers.push(g);
      for (const [x, y] of [[186, 78], [214, 78], [272, 78], [298, 78]]) layers.push(node('rect', { x, y, width: 14, height: 12, fill: '#f2b52a', opacity: lit ? 0.95 : 0.55 }));
      layers.push(node('rect', { x: 236, y: 90, width: 18, height: 30, fill: '#3a2a1a' }));
      layers.push(node('path', { d: 'M330 74 L352 74 M342 74 L342 82', stroke: near, 'stroke-width': 3 }));
      layers.push(node('rect', { x: 333, y: 82, width: 20, height: 13, rx: 2, fill: '#3a2a1a', stroke: '#f2b52a', 'stroke-width': 1 }));
      layers.push(ridge(118, 2, random, near));
      break;
    }
    case 'caverna': {
      layers.push(...glow(240, 92, 120, '#f26b3a', 0.22, `${id}c`));
      const rock = node('g', { fill: '#070d13' });
      let d = `M0 0 L${W} 0 L${W} ${H} L420 ${H} C410 70 360 34 240 30 C120 34 70 70 60 ${H} L0 ${H} Z`;
      rock.append(node('path', { d }));
      for (let x = 110; x < 380; x += 18 + random() * 14) {
        const len = 8 + random() * 18;
        rock.append(node('path', { d: `M${x - 5} ${34 + random() * 6} L${x} ${40 + len} L${x + 5} ${34 + random() * 6} Z` }));
      }
      layers.push(rock, ridge(118, 3, random, '#070d13'));
      break;
    }
    case 'masmorra': {
      const bricks = node('g', { stroke: 'rgb(0 0 0 / .35)', 'stroke-width': 1 });
      for (let y = 0; y < H; y += 12) {
        for (let x = (y / 12) % 2 ? -14 : 0; x < W; x += 28) bricks.append(node('rect', { x, y, width: 28, height: 12, fill: 'none' }));
      }
      layers.push(bricks);
      layers.push(node('path', { d: 'M200 120 L200 62 C200 40 280 40 280 62 L280 120 Z', fill: '#05090d' }));
      for (const x of [150, 330]) {
        layers.push(...glow(x, 52, 46, '#f2a03a', 0.5, `${id}t${x}`));
        layers.push(node('rect', { x: x - 2, y: 56, width: 4, height: 14, fill: '#2a1d12' }));
        layers.push(node('path', { d: `M${x} 40 C${x + 6} 48 ${x + 4} 55 ${x} 56 C${x - 4} 55 ${x - 6} 48 ${x} 40 Z`, fill: '#f2b52a' }));
      }
      break;
    }
    case 'ruinas': {
      layers.push(ridge(90, 8, random, far), ridge(108, 5, random, mid));
      const g = node('g', { fill: near });
      for (const [x, h] of [[120, 46], [150, 30], [300, 54], [330, 22], [360, 40]]) {
        g.append(node('rect', { x, y: 112 - h, width: 12, height: h }));
        g.append(node('path', { d: `M${x - 2} ${112 - h} L${x + 5} ${112 - h - 6} L${x + 14} ${112 - h + 2} Z` }));
      }
      g.append(node('path', { d: 'M296 58 C300 40 340 36 352 50 L346 54 C336 44 310 46 306 60 Z' }));
      layers.push(g, ridge(116, 3, random, near));
      break;
    }
    case 'templo': {
      layers.push(ridge(88, 8, random, far));
      const g = node('g', { fill: mid });
      g.append(node('rect', { x: 170, y: 92, width: 140, height: 8 }));
      for (let x = 178; x < 300; x += 22) g.append(node('rect', { x, y: 56, width: 9, height: 36 }));
      g.append(node('path', { d: 'M164 56 L240 30 L316 56 Z' }));
      layers.push(ridge(104, 4, random, mid), g, ridge(116, 3, random, near));
      break;
    }
    case 'mar': {
      layers.push(ridge(84, 6, random, far, 1, 2));
      layers.push(node('rect', { x: 0, y: 88, width: W, height: 32, fill: 'rgb(10 22 33 / .55)' }));
      const waves = node('g', { stroke: 'rgb(245 238 221 / .25)', 'stroke-width': 1.2, fill: 'none' });
      for (let y = 94; y < H; y += 7) waves.append(node('path', { d: `M${random() * 40} ${y} q 10 -3 20 0 t 20 0 M${200 + random() * 80} ${y + 2} q 10 -3 20 0 t 20 0` }));
      layers.push(waves);
      const ship = node('g', { fill: near });
      ship.append(node('path', { d: 'M300 90 L370 90 L360 100 L310 100 Z' }));
      ship.append(node('rect', { x: 333, y: 48, width: 3, height: 42 }));
      ship.append(node('path', { d: 'M337 50 L364 74 L337 80 Z M331 54 L306 78 L331 82 Z' }));
      layers.push(ship);
      break;
    }
    case 'pantano': {
      layers.push(ridge(90, 4, random, far), node('rect', { x: 0, y: 100, width: W, height: 20, fill: 'rgb(30 46 40 / .7)' }));
      const g = node('g', { stroke: near, 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round' });
      for (const x of [80, 200, 330, 420]) {
        g.append(node('path', { d: `M${x} 104 L${x + 2} 60 M${x + 1} 74 L${x + 16} 62 M${x + 2} 66 L${x - 12} 54 M${x + 2} 84 L${x + 12} 78` }));
      }
      layers.push(g, node('rect', { x: 0, y: 92, width: W, height: 10, fill: '#cfd8d3', opacity: 0.12 }));
      break;
    }
    case 'deserto':
      layers.push(ridge(90, 6, random, 'rgb(120 80 40 / .35)', 1, 2), ridge(104, 8, random, 'rgb(90 60 30 / .55)', 1, 2), ridge(116, 5, random, near, 1, 2));
      break;
    case 'acampamento': {
      layers.push(ridge(84, 8, random, far), pines(100, 14, 20, 34, random, mid));
      layers.push(...glow(250, 100, 60, '#f2a03a', 0.55, `${id}f`));
      layers.push(node('path', { d: 'M170 112 L205 70 L240 112 Z', fill: near }), node('path', { d: 'M205 112 L205 82 L214 112 Z', fill: '#3a2a1a' }));
      layers.push(node('path', { d: 'M250 92 C256 100 256 106 250 108 C244 106 244 100 250 92 Z', fill: '#f2b52a' }));
      layers.push(ridge(116, 3, random, near));
      break;
    }
    default:
      layers.push(ridge(86, 8, random, far), ridge(104, 6, random, mid), ridge(116, 4, random, near));
  }

  // Escurece a base para o texto do nome ficar legível.
  layers.push(node('defs', {}, [node('linearGradient', { id: `${id}s`, x1: 0, y1: 0, x2: 0, y2: 1 }, [
    node('stop', { offset: '.35', 'stop-color': '#0a1621', 'stop-opacity': 0 }),
    node('stop', { offset: '1', 'stop-color': '#0a1621', 'stop-opacity': 0.75 }),
  ])]));
  layers.push(node('rect', { width: W, height: H, fill: `url(#${id}s)` }));
  for (const layer of layers) svg.append(layer);
  return svg;
}
