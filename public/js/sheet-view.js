import { api, formatText, h, signed } from './api.js';

/*
 * "Ver ficha": a ficha inteira só para consultar, numa janela, sem entrar no modo de edição.
 * Usada no Jogo (Mestre IA) e nas mesas (jogador vê a sua; o Mestre vê a dos jogadores).
 */

let meta = null;
const STATUS_LABELS = { active: 'Ativo', unconscious: 'Inconsciente', stable: 'Estável', dead: 'Morto' };

function dialog() {
  let node = document.getElementById('sheet-view');
  if (node) return node;
  node = h('dialog', { id: 'sheet-view', class: 'settings-dialog sheet-view', 'aria-labelledby': 'sheet-view-title' });
  node.addEventListener('click', (event) => { if (event.target === node) node.close(); });
  document.body.append(node);
  return node;
}

// Seção sempre aberta (o essencial para jogar).
const block = (title, ...children) => {
  const content = children.flat().filter(Boolean);
  return content.length ? h('section', { class: 'sv-section' }, h('h3', {}, title), ...content) : null;
};
// Acordeão: o resto da ficha fica fechado e abre com um toque. Seções vazias nem aparecem.
const section = (title, ...children) => {
  const content = children.flat().filter(Boolean);
  return content.length
    ? h('details', { class: 'sv-section sv-accordion' }, h('summary', {}, title), h('div', { class: 'sv-accordion-body' }, ...content))
    : null;
};
const text = (label, value) => (value ? h('div', { class: 'sv-text' }, label && h('h4', {}, label), h('p', { class: 'prewrap' }, formatText(value))) : null);
const stat = (label, value) => h('div', { class: 'stat' }, h('b', {}, String(value)), h('small', {}, label));

/** Abre a ficha. character: ficha completa (com sheet e derived). state: estado na campanha/mesa, se houver. */
export async function openSheetView(character, { state = null } = {}) {
  meta ??= await api('/characters/meta');
  const { sheet = {}, derived = {} } = character;
  const saves = new Set(sheet.save_proficiencies ?? []);
  const skills = new Set(sheet.skill_proficiencies ?? []);
  const coins = state?.coins ?? sheet.coins ?? {};
  const coinText = meta.coins.filter((coin) => coins[coin]).map((coin) => `${coins[coin]} ${coin.toUpperCase()}`).join(' · ');
  const spells = Object.entries(sheet.spells ?? {}).filter(([, list]) => list?.length);
  const details = [['Idade', sheet.age], ['Altura', sheet.height], ['Peso', sheet.weight], ['Olhos', sheet.eyes], ['Pele', sheet.skin], ['Cabelo', sheet.hair]]
    .filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join(' · ');

  const node = dialog();
  node.replaceChildren(
    h('form', { method: 'dialog', class: 'settings-head' },
      h('h2', { id: 'sheet-view-title' }, `Ficha de ${character.name}`),
      h('button', { class: 'icon-button', value: 'close', 'aria-label': 'Fechar' }, '✕')),
    h('div', { class: 'sv-body' },
      h('div', { class: 'sv-toggle-all' }, h('button', {
        type: 'button',
        class: 'small',
        onclick: (event) => {
          const all = [...node.querySelectorAll('.sv-accordion')];
          const open = all.some((item) => !item.open);
          for (const item of all) item.open = open;
          event.currentTarget.textContent = open ? 'Fechar tudo' : 'Abrir tudo';
        },
      }, 'Abrir tudo')),
      h('div', { class: 'member-head sv-head' },
        character.avatar_url && h('img', { src: character.avatar_url, alt: `Retrato de ${character.name}` }),
        h('div', {},
          h('div', { class: 'member-name' }, character.name),
          h('p', { class: 'muted' }, `${character.race}, ${character.class} ${character.level}${character.background ? ` · ${character.background}` : ''}${character.alignment ? ` · ${character.alignment}` : ''}`),
          h('p', { class: 'muted' }, `XP ${character.xp}${character.player_name ? ` · Jogador(a): ${character.player_name}` : ''}`))),
      state && h('p', { class: 'sv-state' },
        h('strong', {}, `PV ${state.current_hp}/${state.max_hp}`), state.temp_hp ? ` + ${state.temp_hp} temp.` : '',
        ` · ${STATUS_LABELS[state.status] ?? state.status}`, state.inspiration ? ' · Inspiração' : '',
        state.conditions?.length ? ` · Condições: ${state.conditions.join(', ')}` : ''),
      h('div', { class: 'stat-grid sv-combat' },
        stat('CA', character.armor_class), stat('PV máx.', character.max_hp), stat('Iniciativa', signed(derived.initiative ?? 0)),
        stat('Desloc.', character.speed), stat('Proficiência', signed(derived.proficiency_bonus ?? 2)), stat('Perc. passiva', derived.passive_perception ?? 10),
        stat('Dado de vida', `d${character.hit_die}`)),
      block('Atributos',
        h('div', { class: 'card-abilities sv-abilities' }, meta.abilities.map((a) => h('span', {},
          h('small', {}, a.short), h('b', {}, signed(derived.modifiers?.[a.key] ?? 0)), h('small', {}, String(character[a.key])))))),
      section('Salvaguardas', h('ul', { class: 'sv-list' }, meta.abilities.map((a) =>
        h('li', { class: saves.has(a.key) ? 'prof' : '' }, h('span', {}, a.label), h('b', {}, signed(derived.saves?.[a.key] ?? 0)))))),
      section('Perícias', h('ul', { class: 'sv-list sv-columns' }, meta.skills.map((s) =>
        h('li', { class: skills.has(s.key) ? 'prof' : '' }, h('span', {}, s.label), h('b', {}, signed(derived.skills?.[s.key] ?? 0)))))),
      section('Ataques',
        (sheet.attacks ?? []).length > 0 && h('ul', { class: 'sv-list' }, sheet.attacks.map((attack) =>
          h('li', {}, h('span', {}, attack.name), h('b', {}, `${attack.bonus || '+0'} · ${attack.damage || '—'}`)))),
        text('Anotações', sheet.attack_notes)),
      section('Equipamento',
        (state?.inventory?.length ? h('p', { class: 'prewrap' }, state.inventory.join('\n')) : text('', sheet.equipment)),
        coinText && h('p', {}, h('strong', {}, 'Moedas: '), coinText),
        text('Tesouro', sheet.treasure)),
      section('Características e talentos', text('', sheet.features), text('Outras', sheet.additional_features)),
      section('Proficiências e idiomas', text('', sheet.proficiencies_languages)),
      section('Personalidade', text('Traços', sheet.personality), text('Ideais', sheet.ideals), text('Vínculos', sheet.bonds), text('Fraquezas', sheet.flaws)),
      sheet.spell_ability && section('Magias',
        h('p', { class: 'muted' }, `CD ${derived.spell_save_dc} · ataque ${signed(derived.spell_attack ?? 0)}`),
        Object.entries(sheet.spell_slots ?? {}).filter(([, total]) => total > 0).map(([circle, total]) =>
          h('p', {}, `${circle}º círculo: ${total - (state?.spell_slots_used?.[circle] ?? 0)}/${total} espaços`)),
        spells.map(([circle, list]) => h('p', {}, h('strong', {}, `${circle === '0' ? 'Truques' : `${circle}º`}: `),
          list.map((spell) => `${spell.prepared ? '★ ' : ''}${spell.name}`).join(', ')))),
      section('Aparência e história', details && h('p', { class: 'muted' }, details), text('Aparência', sheet.appearance),
        text('Aliados e organizações', [sheet.organization, sheet.allies].filter(Boolean).join('\n')), text('História', character.backstory))));
  if (!node.open) node.showModal();
  node.querySelector('.settings-head button').focus();
}
