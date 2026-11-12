import { HttpError } from '../middleware/errorHandler.js';
import { normalizeKey } from './memory.js';

export const ABILITIES = [
  { key: 'str', label: 'Força', short: 'FOR' },
  { key: 'dex', label: 'Destreza', short: 'DES' },
  { key: 'con', label: 'Constituição', short: 'CON' },
  { key: 'int', label: 'Inteligência', short: 'INT' },
  { key: 'wis', label: 'Sabedoria', short: 'SAB' },
  { key: 'cha', label: 'Carisma', short: 'CAR' },
];

export const SKILLS = [
  { key: 'acrobacia', label: 'Acrobacia', ability: 'dex' },
  { key: 'arcanismo', label: 'Arcanismo', ability: 'int' },
  { key: 'atletismo', label: 'Atletismo', ability: 'str' },
  { key: 'atuacao', label: 'Atuação', ability: 'cha' },
  { key: 'enganacao', label: 'Enganação', ability: 'cha' },
  { key: 'furtividade', label: 'Furtividade', ability: 'dex' },
  { key: 'historia', label: 'História', ability: 'int' },
  { key: 'intimidacao', label: 'Intimidação', ability: 'cha' },
  { key: 'intuicao', label: 'Intuição', ability: 'wis' },
  { key: 'investigacao', label: 'Investigação', ability: 'int' },
  { key: 'lidar_animais', label: 'Lidar com Animais', ability: 'wis' },
  { key: 'medicina', label: 'Medicina', ability: 'wis' },
  { key: 'natureza', label: 'Natureza', ability: 'int' },
  { key: 'percepcao', label: 'Percepção', ability: 'wis' },
  { key: 'persuasao', label: 'Persuasão', ability: 'cha' },
  { key: 'prestidigitacao', label: 'Prestidigitação', ability: 'dex' },
  { key: 'religiao', label: 'Religião', ability: 'int' },
  { key: 'sobrevivencia', label: 'Sobrevivência', ability: 'wis' },
];

export const CLASSES = [
  { name: 'Bárbaro', stem: 'barbar', hitDie: 12, saves: ['str', 'con'], spell: null },
  { name: 'Bardo', stem: 'bard', hitDie: 8, saves: ['dex', 'cha'], spell: 'cha' },
  { name: 'Bruxo', stem: 'brux', hitDie: 8, saves: ['wis', 'cha'], spell: 'cha' },
  { name: 'Clérigo', stem: 'cleri', hitDie: 8, saves: ['wis', 'cha'], spell: 'wis' },
  { name: 'Druida', stem: 'druid', hitDie: 8, saves: ['int', 'wis'], spell: 'wis' },
  { name: 'Feiticeiro', stem: 'feitic', hitDie: 6, saves: ['con', 'cha'], spell: 'cha' },
  { name: 'Guerreiro', stem: 'guerreir', hitDie: 10, saves: ['str', 'con'], spell: null },
  { name: 'Ladino', stem: 'ladin', hitDie: 8, saves: ['dex', 'int'], spell: null },
  { name: 'Mago', stem: 'mag', hitDie: 6, saves: ['int', 'wis'], spell: 'int' },
  { name: 'Monge', stem: 'mong', hitDie: 8, saves: ['str', 'dex'], spell: null },
  { name: 'Paladino', stem: 'paladin', hitDie: 10, saves: ['wis', 'cha'], spell: 'cha' },
  { name: 'Patrulheiro', stem: 'patrulh', hitDie: 10, saves: ['str', 'dex'], spell: 'wis' },
];

export const COINS = ['pc', 'pp', 'pe', 'po', 'pl'];
const HIT_DICE = [6, 8, 10, 12];

const LONG_TEXT_FIELDS = [
  'personality', 'ideals', 'bonds', 'flaws', 'proficiencies_languages', 'features', 'attack_notes',
  'equipment', 'appearance', 'allies', 'additional_features', 'treasure',
];
const SHORT_TEXT_FIELDS = ['age', 'height', 'weight', 'eyes', 'skin', 'hair', 'organization', 'spell_class'];

export const modifier = (score) => Math.floor((score - 10) / 2);
export const proficiencyBonus = (level) => 2 + Math.floor((level - 1) / 4);
export const signed = (value) => (value >= 0 ? `+${value}` : `${value}`);

export function findClass(name) {
  const key = normalizeKey(name);
  return CLASSES.find((entry) => key.startsWith(entry.stem)) ?? null;
}

/** 1º nível: valor máximo do dado + CON. Demais níveis: média fixa do dado + CON. */
export function defaultMaxHp(hitDie, level, con) {
  const mod = modifier(con);
  const total = hitDie + mod + (level - 1) * (hitDie / 2 + 1 + mod);
  return Math.max(level, total);
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function requiredText(value, label) {
  const clean = text(value, 100);
  if (!clean) throw new HttpError(400, `Informe ${label}.`);
  return clean;
}

function integer(value, label, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new HttpError(400, `${label} deve ser um inteiro entre ${min} e ${max}.`);
  }
  return number;
}

// Só retratos guardados aqui (enviados ou gerados). Um endereço de outro site deixaria o dono daquele
// site ver o IP de todos na mesa quando o retrato carregasse.
function avatarUrl(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && /^\/images\/[\w-]{1,120}\.(png|jpg|webp)$/.test(value)) return value;
  throw new HttpError(400, 'O retrato precisa ser enviado ou gerado aqui no DataDice.');
}

function keysFrom(value, allowed) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value)].filter((key) => allowed.includes(key));
}

/**
 * Valores digitados à mão, que substituem o cálculo automático: Especialização, itens mágicos,
 * talentos ou uma ficha já preenchida. Campo vazio continua automático.
 */
function parseOverrides(input = {}) {
  const pick = (value, label, min, max) => integer(value, label, min, max, undefined);
  const group = (source, list, label, min, max) => {
    const result = {};
    for (const { key, label: name } of list) {
      const value = pick(source?.[key], `${label} de ${name}`, min, max);
      if (value !== undefined) result[key] = value;
    }
    return result;
  };
  const overrides = {
    modifiers: group(input.modifiers, ABILITIES, 'O modificador', -10, 15),
    saves: group(input.saves, ABILITIES, 'A salvaguarda', -10, 30),
    skills: group(input.skills, SKILLS, 'A perícia', -10, 30),
  };
  for (const [key, label, min, max] of [
    ['proficiency_bonus', 'O bônus de proficiência', 0, 10],
    ['initiative', 'A iniciativa', -10, 30],
    ['passive_perception', 'A Sabedoria passiva', 0, 50],
  ]) {
    const value = pick(input[key], label, min, max);
    if (value !== undefined) overrides[key] = value;
  }
  return overrides;
}

/** Valida o corpo da requisição e devolve as colunas prontas para gravar. */
export function parseCharacter(body = {}) {
  const className = requiredText(body.class, 'a classe');
  const known = findClass(className);
  const level = integer(body.level, 'O nível', 1, 20, 1);
  const scores = Object.fromEntries(
    ABILITIES.map(({ key, label }) => [key, integer(body[key], label, 1, 30, 10)])
  );

  const hitDie = integer(body.hit_die, 'O dado de vida', 6, 12, known?.hitDie ?? 8);
  if (!HIT_DICE.includes(hitDie)) throw new HttpError(400, 'O dado de vida deve ser d6, d8, d10 ou d12.');

  const input = body.sheet ?? {};
  const sheet = {};
  for (const field of LONG_TEXT_FIELDS) sheet[field] = text(input[field], 5000);
  for (const field of SHORT_TEXT_FIELDS) sheet[field] = text(input[field], 100);

  sheet.save_proficiencies = keysFrom(input.save_proficiencies, ABILITIES.map((a) => a.key)) ?? known?.saves ?? [];
  sheet.skill_proficiencies = keysFrom(input.skill_proficiencies, SKILLS.map((s) => s.key)) ?? [];
  sheet.attacks = (Array.isArray(input.attacks) ? input.attacks : [])
    .slice(0, 20)
    .map((attack) => ({
      name: text(attack?.name, 100),
      bonus: text(attack?.bonus, 20),
      damage: text(attack?.damage, 100),
    }))
    .filter((attack) => attack.name);

  sheet.coins = Object.fromEntries(COINS.map((coin) => [coin, integer(input.coins?.[coin], `Moedas (${coin})`, 0, 10000000, 0)]));
  sheet.overrides = parseOverrides(input.overrides);

  const spellAbility = input.spell_ability || known?.spell || null;
  if (spellAbility && !ABILITIES.some((a) => a.key === spellAbility)) {
    throw new HttpError(400, 'Atributo de conjuração inválido.');
  }
  sheet.spell_ability = spellAbility;

  sheet.spell_slots = {};
  sheet.spells = {};
  for (let circle = 0; circle <= 9; circle += 1) {
    const list = Array.isArray(input.spells?.[circle]) ? input.spells[circle] : [];
    sheet.spells[circle] = list
      .slice(0, 40)
      .map((spell) => ({ name: text(spell?.name, 100), prepared: Boolean(spell?.prepared) }))
      .filter((spell) => spell.name);
    if (circle > 0) sheet.spell_slots[circle] = integer(input.spell_slots?.[circle], `Espaços do ${circle}º círculo`, 0, 20, 0);
  }

  return {
    name: requiredText(body.name, 'o nome'),
    race: requiredText(body.race, 'a raça'),
    class: className,
    level,
    ...scores,
    background: text(body.background, 100),
    alignment: text(body.alignment, 100),
    player_name: text(body.player_name, 100),
    xp: integer(body.xp, 'A experiência', 0, 10000000, 0),
    armor_class: integer(body.armor_class, 'A Classe de Armadura', 1, 50, 10 + modifier(scores.dex)),
    speed: text(body.speed, 30) || '9 m',
    hit_die: hitDie,
    max_hp: integer(body.max_hp, 'Os pontos de vida máximos', 1, 1000, defaultMaxHp(hitDie, level, scores.con)),
    backstory: text(body.backstory, 10000),
    avatar_url: avatarUrl(body.avatar_url),
    sheet_json: JSON.stringify(sheet),
  };
}

/** Tudo o que a ficha calcula a partir dos atributos, em um único lugar. */
export function deriveSheet(character, sheet) {
  const manual = sheet.overrides ?? {};
  const prof = manual.proficiency_bonus ?? proficiencyBonus(character.level);
  const mods = Object.fromEntries(ABILITIES.map(({ key }) => [key, manual.modifiers?.[key] ?? modifier(character[key])]));
  const saves = Object.fromEntries(
    ABILITIES.map(({ key }) => [key, manual.saves?.[key] ?? mods[key] + (sheet.save_proficiencies?.includes(key) ? prof : 0)])
  );
  const skills = Object.fromEntries(
    SKILLS.map(({ key, ability }) => [key, manual.skills?.[key] ?? mods[ability] + (sheet.skill_proficiencies?.includes(key) ? prof : 0)])
  );
  const spellMod = sheet.spell_ability ? mods[sheet.spell_ability] : null;
  return {
    proficiency_bonus: prof,
    modifiers: mods,
    saves,
    skills,
    initiative: manual.initiative ?? mods.dex,
    passive_perception: manual.passive_perception ?? 10 + skills.percepcao,
    spell_save_dc: spellMod === null ? null : 8 + prof + spellMod,
    spell_attack: spellMod === null ? null : prof + spellMod,
  };
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value) ?? fallback;
  } catch {
    return fallback;
  }
}

export function publicCharacter(row) {
  const { sheet_json, ...character } = row;
  const sheet = parseJson(sheet_json, {});
  return { ...character, sheet, derived: deriveSheet(row, sheet) };
}

export function publicPartyMember(row) {
  const { inventory_json, coins_json, spell_slots_used_json, conditions_json, ...rest } = row;
  return {
    ...publicCharacter(rest),
    inventory: parseJson(inventory_json, []),
    coins: parseJson(coins_json, {}),
    spell_slots_used: parseJson(spell_slots_used_json, {}),
    conditions: parseJson(conditions_json, []),
  };
}
