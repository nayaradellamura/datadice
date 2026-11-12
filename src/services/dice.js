import { randomInt } from 'node:crypto';
import { HttpError } from '../middleware/errorHandler.js';
import { ABILITIES, SKILLS } from './sheet.js';

const DICE = [4, 6, 8, 10, 12, 20, 100];
const die = (sides) => randomInt(1, sides + 1);
const withSign = (value) => (value >= 0 ? `+ ${value}` : `- ${Math.abs(value)}`);

function rollD20(mode) {
  if (mode === 'advantage' || mode === 'disadvantage') {
    const pair = [die(20), die(20)];
    const kept = mode === 'advantage' ? Math.max(...pair) : Math.min(...pair);
    const label = mode === 'advantage' ? 'com vantagem' : 'com desvantagem';
    return { kept, note: ` (${label}: ${pair.join(' e ')})` };
  }
  return { kept: die(20), note: '' };
}

function checkTarget(member, kind, key) {
  const { derived } = member;
  const ability = ABILITIES.find((entry) => entry.key === key);
  const skill = SKILLS.find((entry) => entry.key === key);
  switch (kind) {
    case 'attribute':
      if (!ability) throw new HttpError(400, 'Atributo inválido.');
      return { label: ability.label, bonus: derived.modifiers[key] };
    case 'save':
      if (!ability) throw new HttpError(400, 'Atributo inválido.');
      return { label: `Salvaguarda de ${ability.label}`, bonus: derived.saves[key] };
    case 'skill':
      if (!skill) throw new HttpError(400, 'Perícia inválida.');
      return { label: skill.label, bonus: derived.skills[key] };
    case 'initiative':
      return { label: 'Iniciativa', bonus: derived.initiative };
    case 'plain':
      return { label: 'd20', bonus: 0 };
    default:
      throw new HttpError(400, 'Tipo de rolagem inválido.');
  }
}

/** Teste de d20 com o total, para quem precisa do número (ex.: iniciativa da mesa). */
export function rollCheckDetailed(member, { kind, key, mode }) {
  const { label, bonus } = checkTarget(member, kind, key);
  const { kept, note } = rollD20(mode);
  const natural = kept === 20 ? ' — 20 natural!' : kept === 1 ? ' — 1 natural!' : '';
  const math = bonus === 0 ? `${kept}` : `${kept} ${withSign(bonus)} = ${kept + bonus}`;
  return { text: `${member.name} rolou ${label}${note}: ${math}${natural}`, total: kept + bonus };
}

const rollCheck = (member, request) => rollCheckDetailed(member, request).text;

const TERM = String.raw`(?:\d{1,2}d\d{1,3}|\d{1,3})`;
const FORMULA = new RegExp(String.raw`^[+-]?${TERM}(?:[+-]${TERM}){0,7}$`, 'i');
const LOOSE_TERM = String.raw`(?:\d{1,2}\s*d\s*\d{1,3}|\d{1,3})`;
const FORMULA_PREFIX = new RegExp(String.raw`^\s*(${LOOSE_TERM}(?:\s*[+-]\s*${LOOSE_TERM})*)`, 'i');

/** Lê fórmulas como 1d8+1d6+3. Devolve os grupos de dados e o bônus fixo, ou null se for inválida. */
export function parseFormula(expression) {
  const text = String(expression ?? '').replace(/\s+/g, '').toLowerCase();
  if (!FORMULA.test(text)) return null;
  const groups = [];
  let bonus = 0;
  for (const [, sign, term] of text.matchAll(/([+-]?)(\d+d\d+|\d+)/g)) {
    const factor = sign === '-' ? -1 : 1;
    if (term.includes('d')) {
      const [count, sides] = term.split('d').map(Number);
      if (count < 1 || !DICE.includes(sides)) return null;
      groups.push({ count, sides, sign: factor });
    } else {
      bonus += factor * Number(term);
    }
  }
  const totalDice = groups.reduce((sum, group) => sum + group.count, 0);
  if (!groups.length || totalDice > 40) return null;
  return { groups, bonus };
}

const formulaText = ({ groups, bonus }) =>
  groups.map((g, i) => `${g.sign < 0 ? (i ? ' - ' : '-') : i ? ' + ' : ''}${g.count}d${g.sides}`).join('') + (bonus ? ` ${withSign(bonus)}` : '');

/** Rola a fórmula e monta o texto "[3, 5] + [2] + 4 = 14". */
function rollFormula(formula) {
  let total = formula.bonus;
  const parts = formula.groups.map((group, index) => {
    const rolls = Array.from({ length: group.count }, () => die(group.sides));
    total += group.sign * rolls.reduce((sum, value) => sum + value, 0);
    const list = `[${rolls.join(', ')}]`;
    return index === 0 ? (group.sign < 0 ? `- ${list}` : list) : `${group.sign < 0 ? '-' : '+'} ${list}`;
  });
  const suffix = formula.bonus ? ` ${withSign(formula.bonus)}` : '';
  return { total, detail: `${parts.join(' ')}${suffix} = ${total}` };
}

function parseDice(expression) {
  const formula = parseFormula(expression);
  if (!formula || formula.groups.length !== 1 || formula.groups[0].sign < 0) return null;
  return { ...formula.groups[0], bonus: formula.bonus };
}

export function rollDiceExpression(member, expression) {
  const formula = parseFormula(expression);
  if (!formula) throw new HttpError(400, 'Use uma expressão como 2d6+3 ou 1d8+1d6+2, com dados d4, d6, d8, d10, d12, d20 ou d100.');
  return `${member.name} rolou ${formulaText(formula)}: ${rollFormula(formula).detail}`;
}

function attackAt(member, index) {
  const attack = member.sheet?.attacks?.[Number(index)];
  if (!Number.isInteger(Number(index)) || !attack) throw new HttpError(400, 'Esta arma não está na ficha do personagem.');
  return attack;
}

/** Separa "1d6+4 Perfurante" em fórmula e tipo de dano. */
export function attackDamage(attack) {
  const match = FORMULA_PREFIX.exec(attack.damage ?? '');
  const formula = match && parseFormula(match[1]);
  if (!formula) return null;
  const type = attack.damage.slice(match[0].length).trim();
  return { formula, type };
}

export const attackBonus = (attack) => Number(/[+-]?\s*\d+/.exec(attack.bonus ?? '')?.[0].replace(/\s+/g, '')) || 0;

/** Ataque com uma arma da ficha: d20 + bônus de ataque anotado nela. */
export function rollAttack(member, index, mode) {
  const attack = attackAt(member, index);
  const bonus = attackBonus(attack);
  const { kept, note } = rollD20(mode);
  const natural = kept === 20 ? ' — 20 natural, acerto crítico!' : kept === 1 ? ' — 1 natural, erro automático.' : '';
  const math = bonus === 0 ? `${kept}` : `${kept} ${withSign(bonus)} = ${kept + bonus}`;
  return { text: `${member.name} atacou com ${attack.name}${note}: ${math}${natural}`, critical: kept === 20 };
}

/** Dano da arma; no crítico, os dados dobram (o bônus fixo não). */
export function rollDamage(member, index, critical = false) {
  const attack = attackAt(member, index);
  const damage = attackDamage(attack);
  if (!damage) throw new HttpError(400, `O dano de ${attack.name} não está no formato 1d8+3. Ajuste na ficha.`);
  const formula = critical
    ? { ...damage.formula, groups: damage.formula.groups.map((g) => ({ ...g, count: g.count * 2 })) }
    : damage.formula;
  const label = critical ? ' (crítico)' : '';
  const type = damage.type ? ` de dano ${damage.type.toLowerCase()}` : ' de dano';
  return `${member.name} rolou o dano de ${attack.name}${label}: ${formulaText(formula)}: ${rollFormula(formula).detail}${type}`;
}

/** Rolagem pedida pelo Mestre. O resultado vem daqui, nunca do modelo. */
export function rollForGm(request) {
  const label = String(request?.label ?? '').trim().slice(0, 120) || 'Rolagem do Mestre';
  const dice = parseDice(request?.dice);
  if (!dice) return { label, error: `Expressão inválida: "${request?.dice}". Use o formato 1d20+4.` };

  const { count, sides, bonus } = dice;
  const suffix = bonus ? ` ${withSign(bonus)}` : '';
  const isSingleD20 = count === 1 && sides === 20;
  if (isSingleD20) {
    const { kept, note } = rollD20(request.mode);
    const natural = kept === 20 ? ' (20 natural)' : kept === 1 ? ' (1 natural)' : '';
    return { label, total: kept + bonus, text: `Mestre rolou ${label}${note}: ${kept}${suffix} = ${kept + bonus}${natural}` };
  }
  const rolls = Array.from({ length: count }, () => die(sides));
  const total = rolls.reduce((sum, value) => sum + value, 0) + bonus;
  return { label, total, text: `Mestre rolou ${label}: ${count}d${sides}${suffix}: [${rolls.join(', ')}]${suffix} = ${total}` };
}

/** Salvaguarda contra a morte, seguindo as regras do Livro do Jogador. */
export function rollDeathSave(member) {
  if (member.current_hp > 0 || member.status === 'dead' || member.status === 'stable') {
    throw new HttpError(400, 'A salvaguarda contra a morte só vale com 0 PV, antes de estabilizar ou morrer.');
  }
  const value = die(20);
  let successes = member.death_successes;
  let failures = member.death_failures;
  let hp = 0;
  let { status } = member;
  let outcome;

  if (value === 20) {
    hp = 1;
    successes = 0;
    failures = 0;
    status = 'active';
    outcome = 'volta com 1 PV!';
  } else {
    if (value === 1) failures += 2;
    else if (value < 10) failures += 1;
    else successes += 1;

    if (failures >= 3) {
      status = 'dead';
      outcome = 'morreu.';
    } else if (successes >= 3) {
      status = 'stable';
      outcome = 'estabilizou.';
    } else {
      outcome = `${successes} sucesso(s), ${failures} falha(s).`;
    }
  }

  return {
    text: `${member.name} rolou salvaguarda contra a morte: ${value} — ${outcome}`,
    update: { hp, successes: Math.min(3, successes), failures: Math.min(3, failures), status },
  };
}

export { rollCheck };
