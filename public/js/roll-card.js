import { h } from './api.js';
import { icon } from './icons.js';

/**
 * As rolagens chegam como texto ("Mestre rolou Dano da adaga: 1d4 + 2: [3] + 2 = 5"). Aqui elas viram um
 * cartão compacto: quem rolou, o quê, a conta em letra menor e o total em destaque.
 */
const FORMULA_AT_END = /^(.*): ((?:\d+d\d+|\d+)(?: [+-] (?:\d+d\d+|\d+))*)$/;

export function parseRoll(text) {
  const match = /^(.+?) (rolou|atacou com) (.+)$/s.exec(String(text ?? '').trim());
  if (!match) return null;
  const [, who, verb] = match;
  let rest = match[3];
  let flag = '';
  const dash = rest.lastIndexOf(' — ');
  if (dash >= 0) {
    flag = rest.slice(dash + 3).replace(/[!.]$/, '');
    rest = rest.slice(0, dash);
  }
  const colon = rest.lastIndexOf(': ');
  if (colon < 0) return null;
  let label = rest.slice(0, colon);
  let math = rest.slice(colon + 2);

  let total;
  let extra = '';
  const equals = /=\s*(-?\d+)\s*(.*)$/.exec(math);
  if (equals) {
    [, total, extra] = equals;
    math = math.slice(0, equals.index).trim();
  } else {
    const single = /^(-?\d+)\s*(.*)$/.exec(math);
    if (!single) return null;
    [, total, extra] = single;
    math = '';
  }

  let formula = '';
  const inLabel = FORMULA_AT_END.exec(label);
  if (inLabel) [, label, formula] = inLabel;
  if (verb === 'atacou com') label = `Ataque: ${label}`;
  label = label.replace(/^o dano de /, 'Dano de ');
  label = label.charAt(0).toUpperCase() + label.slice(1);

  const notes = `${flag} ${extra}`;
  const critical = /20 natural|crític/i.test(notes);
  const fumble = /\b1 natural|falha/i.test(notes) && !critical;
  return {
    who, label, formula, math, total, critical, fumble,
    note: [flag, extra.replace(/^\((.*)\)$/, '$1')].filter(Boolean).join(' · '),
  };
}

/** Cartão da rolagem, ou null se o texto não for uma rolagem conhecida. */
export function rollCard(text, { className = '', extra = [] } = {}) {
  const roll = parseRoll(text);
  if (!roll) return null;
  const byGm = roll.who === 'Mestre';
  const detail = [roll.formula, roll.math && roll.math !== roll.total ? roll.math : ''].filter(Boolean).join(' → ');
  return h('div', {
    class: `msg roll${byGm ? ' by-gm' : ''}${roll.critical ? ' crit' : ''}${roll.fumble ? ' fumble' : ''} ${className}`.trim(),
    title: text,
  },
  h('span', { class: 'roll-die', 'aria-hidden': 'true' }, icon('dice', 18)),
  h('span', { class: 'roll-main' },
    h('span', { class: 'roll-label' }, h('strong', {}, roll.who), ` · ${roll.label}`),
    detail && h('span', { class: 'roll-math' }, detail),
    roll.note && h('span', { class: 'roll-note' }, roll.note)),
  h('span', { class: 'roll-total' }, roll.total),
  ...extra);
}

/**
 * Aviso de XP ("Kael ganhou 50 XP · Missão concluída · 350/900 XP · pode subir para o nível 2!")
 * vira um cartão com barra de progresso e, quando der, um botão para subir de nível.
 */
const XP_NOTICE = /^(.+?) ganhou (\d+) XP(?: · (.+?))?(?: · (\d+)(?:\/(\d+))? XP)(?: · pode subir para o nível (\d+)!)?$/;

export function parseXp(text) {
  const match = XP_NOTICE.exec(String(text ?? '').trim());
  if (!match) return null;
  const [, who, gain, reason = '', xp, next, newLevel] = match;
  return { who, gain: Number(gain), reason, xp: Number(xp), next: next ? Number(next) : null, newLevel: newLevel ? Number(newLevel) : null };
}

export function xpCard(text, { onLevelUp = null } = {}) {
  const info = parseXp(text);
  if (!info) return null;
  const percent = info.next ? Math.min(100, Math.round((info.xp / info.next) * 100)) : 100;
  return h('div', { class: `msg xp-card${info.newLevel ? ' can-level' : ''}`, title: text },
    h('span', { class: 'roll-die xp-icon', 'aria-hidden': 'true' }, icon('crown', 18)),
    h('span', { class: 'roll-main' },
      h('span', { class: 'roll-label' }, h('strong', {}, info.who), info.reason ? ` · ${info.reason}` : ' · Experiência'),
      h('span', { class: 'xp-bar', role: 'img', 'aria-label': info.next ? `${info.xp} de ${info.next} XP para o próximo nível` : `${info.xp} XP` },
        h('i', { style: `width:${percent}%` })),
      h('span', { class: 'roll-math' }, info.next ? `${info.xp} / ${info.next} XP` : `${info.xp} XP`),
      info.newLevel && h('span', { class: 'xp-level' },
        `Pode subir para o nível ${info.newLevel}!`,
        onLevelUp && h('button', { type: 'button', class: 'small primary', onclick: () => onLevelUp(info.who) }, 'Subir de nível'))),
    h('span', { class: 'roll-total xp-gain' }, `+${info.gain}`));
}
