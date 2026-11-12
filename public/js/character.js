import { api, formatText, h, showError, signed } from './api.js';
import { icon as svgIcon } from './icons.js';

const ALIGNMENTS = [
  'Leal e Bom', 'Neutro e Bom', 'Caótico e Bom', 'Leal e Neutro', 'Neutro',
  'Caótico e Neutro', 'Leal e Mau', 'Neutro e Mau', 'Caótico e Mau',
];
// Raças e sub-raças jogáveis, com os nomes usados no Livro do Jogador. O campo também aceita outros valores.
const RACES = [
  'Anão da Colina', 'Anão da Montanha',
  'Alto Elfo', 'Elfo da Floresta', 'Elfo Negro (Drow)',
  'Halfling Pés Leves', 'Halfling Robusto',
  'Humano', 'Humano (traços alternativos)',
  'Draconato',
  'Gnomo da Floresta', 'Gnomo das Rochas',
  'Meio-Elfo', 'Meio-Orc', 'Tiefling',
];
const CIRCLES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

let meta;
let form;
let editingId = null;
let previewTimer;
let onSaved = () => {};
// Mestre editando a ficha de um jogador da mesa: { savePath, owner }. Salva pela rota da mesa, que avisa o jogador.
let foreign = null;
let rosterCharacters = [];
let portraitRequest = 0;
const seenCards = new Set();
const outputs = new Map();
const autoInputs = new Map();

const field = (label, name, props = {}) => h('label', {}, label, h('input', { name, ...props }));
const area = (label, name, rows = 4, placeholder) => h('label', {}, label, h('textarea', { name, rows, placeholder }));
const card = (...children) => h('div', { class: 'card' }, ...children);

function output(key, initial = '—') {
  const element = h('output', {}, initial);
  outputs.set(key, element);
  return element;
}

/** Mostra o valor calculado; se a pessoa digitar um número, ele passa a valer no lugar do cálculo. */
function autoValue(key, label, extraClass = '') {
  const element = h('input', {
    type: 'text',
    inputMode: 'numeric',
    maxLength: 4,
    name: `ov.${key}`,
    class: `auto-value ${extraClass}`,
    'aria-label': `${label} (em branco = automático)`,
    title: 'Em branco, o valor é calculado. Digite um número para fixar.',
  });
  autoInputs.set(key, element);
  return element;
}

function buildPageOne() {
  const abilityColumn = h('div', { class: 'sheet-column ability-column' },
    meta.abilities.map(({ key, label }) =>
      h('div', { class: 'ability-box' }, label, autoValue(`mod.${key}`, `Modificador de ${label}`, 'ability-mod'), h('input', { type: 'number', name: key, min: 1, max: 30, value: 10, 'aria-label': `Valor de ${label}` }))
    )
  );

  const saves = card(h('h4', {}, 'Salvaguardas'),
    meta.abilities.map(({ key, label }) =>
      h('div', { class: 'prof-row' }, h('input', { type: 'checkbox', name: 'save', value: key, 'aria-label': `Proficiente em salvaguarda de ${label}` }), autoValue(`save.${key}`, `Salvaguarda de ${label}`), label)
    )
  );

  const shortAbility = Object.fromEntries(meta.abilities.map((a) => [a.key, a.short]));
  const skills = card(h('h4', {}, 'Perícias'),
    meta.skills.map(({ key, label, ability }) =>
      h('div', { class: 'prof-row' }, h('input', { type: 'checkbox', name: 'skill', value: key, 'aria-label': `Proficiente em ${label}` }), autoValue(`skill.${key}`, label), h('span', {}, `${label} `, h('small', {}, `(${shortAbility[ability]})`)))
    )
  );

  const attacks = h('div', { id: 'attack-rows' });
  const coinInputs = meta.coins.map((coin) => h('label', {}, coin, h('input', { type: 'number', name: `coin.${coin}`, min: 0, value: 0 })));

  return h('div', { class: 'sheet-page', dataset: { page: '1' } },
    h('div', { class: 'sheet-header' },
      field('Nome do personagem', 'name', { required: true, maxLength: 100 }),
      field('Classe', 'class', { required: true, list: 'class-options', maxLength: 100 }),
      field('Nível', 'level', { type: 'number', min: 1, max: 20, value: 1 }),
      field('Antecedente', 'background', { maxLength: 100 }),
      field('Nome do jogador', 'player_name', { maxLength: 100 }),
      field('Raça', 'race', { required: true, list: 'race-options', maxLength: 100 }),
      h('label', {}, 'Alinhamento', h('select', { name: 'alignment' }, h('option', { value: '' }, '—'), ALIGNMENTS.map((a) => h('option', {}, a)))),
      field('Pontos de experiência', 'xp', { type: 'number', min: 0, value: 0 }),
    ),
    h('datalist', { id: 'class-options' }, meta.classes.map((c) => h('option', { value: c.name }))),
    h('datalist', { id: 'race-options' }, RACES.map((r) => h('option', { value: r }))),
    h('div', { class: 'sheet-grid' },
      abilityColumn,
      h('div', { class: 'sheet-column' },
        card(
          h('div', { class: 'readout' }, autoValue('prof', 'Bônus de proficiência'), 'Bônus de proficiência'),
          h('div', { class: 'readout' }, autoValue('passive', 'Sabedoria passiva'), 'Sabedoria passiva (Percepção)'),
          h('p', { class: 'muted auto-hint' }, 'Os números são calculados. Para usar outro valor, digite por cima; apague para voltar ao automático.')),
        saves,
        skills,
      ),
      h('div', { class: 'sheet-column wide' },
        card(
          h('div', { class: 'vitals' },
            field('Classe de Armadura', 'armor_class', { type: 'number', min: 1, max: 50 }),
            h('label', {}, 'Iniciativa', autoValue('initiative', 'Iniciativa')),
            field('Deslocamento', 'speed', { maxLength: 30, placeholder: '9 m' }),
            field('PV máximos', 'max_hp', { type: 'number', min: 1, max: 1000 }),
            h('label', {}, 'Dado de vida', h('select', { name: 'hit_die' }, [6, 8, 10, 12].map((d) => h('option', { value: d }, `d${d}`)))),
          ),
          h('p', { class: 'muted' }, 'CA e PV em branco são calculados pela regra: CA 10 + DES; PV pelo dado de vida, nível e CON.'),
        ),
        card(h('h4', {}, 'Ataques e conjuração'), attacks,
          h('button', { type: 'button', class: 'small', onclick: () => addAttack() }, 'Adicionar ataque'),
          area('Anotações', 'attack_notes', 2)),
        card(h('h4', {}, 'Equipamento'), area('Um item por linha', 'equipment', 5), h('div', { class: 'coin-row' }, coinInputs)),
      ),
      h('div', { class: 'sheet-column wide' },
        card(area('Traços de personalidade', 'personality', 2), area('Ideais', 'ideals', 2), area('Vínculos', 'bonds', 2), area('Fraquezas', 'flaws', 2)),
        card(area('Características e talentos', 'features', 7)),
        card(area('Outras proficiências e idiomas', 'proficiencies_languages', 4)),
      ),
    ),
  );
}

// O Stable Diffusion entende melhor inglês; a raça e a classe são traduzidas no prompt automático.
const RACE_EN = [
  ['anao', 'dwarf'], ['alto elfo', 'high elf'], ['elfo da floresta', 'wood elf'], ['elfo negro', 'drow dark elf'], ['elf', 'elf'],
  ['halfling', 'halfling'], ['human', 'human'], ['draconato', 'dragonborn'], ['gnomo', 'gnome'],
  ['meio-elf', 'half-elf'], ['meio-orc', 'half-orc'], ['tiefling', 'tiefling'],
];
const CLASS_EN = [
  ['barbar', 'barbarian'], ['bard', 'bard'], ['brux', 'warlock'], ['cleri', 'cleric'], ['druid', 'druid'], ['feitic', 'sorcerer'],
  ['guerreir', 'fighter'], ['ladin', 'rogue'], ['mag', 'wizard'], ['mong', 'monk'], ['paladin', 'paladin'], ['patrulh', 'ranger'],
];
const translate = (table, text) => table.find(([stem]) => plain(text).trim().startsWith(stem))?.[1] ?? text.trim();

function automaticPrompt() {
  const details = [
    translate(RACE_EN, value('race')),
    translate(CLASS_EN, value('class')),
    value('eyes') && `olhos ${value('eyes')}`,
    value('skin') && `pele ${value('skin')}`,
    value('hair') && `cabelo ${value('hair')}`,
    value('appearance'),
    !value('appearance') && value('backstory').slice(0, 300),
  ].filter(Boolean);
  return `fantasy RPG character portrait, detailed face, upper body, ${details.join(', ')}`;
}

function setPortrait(url) {
  form.elements.avatar_url.value = url ?? '';
  const preview = form.querySelector('#portrait-preview');
  const loading = preview.querySelector('.portrait-loading');
  preview.classList.toggle('has-image', Boolean(url));
  preview.replaceChildren(
    url ? h('img', { src: url, alt: `Retrato de ${value('name') || 'personagem'}` }) : 'Nenhum retrato ainda',
    ...(loading ? [loading] : [])
  );
  form.querySelector('#portrait-remove').hidden = !url;
}

function setGenerating(active, message = 'Gerando retrato...') {
  const uploading = message !== 'Gerando retrato...';
  form.querySelector('#portrait-generate').disabled = active;
  form.querySelector('#portrait-generate').textContent = active && !uploading ? 'Gerando...' : 'Gerar Retrato com IA';
  form.querySelector('#portrait-upload').disabled = active;
  form.querySelector('#sheet-submit').disabled = active;
  const preview = form.querySelector('#portrait-preview');
  preview.querySelector('.portrait-loading')?.remove();
  if (active) {
    preview.append(h('div', { class: 'portrait-loading', role: 'status' }, h('div', { class: 'spinner' }), message));
  }
}

const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_SIDE = 1024;

/** Reduz a imagem no próprio aparelho e regrava em JPEG: fica leve e sem metadados (como localização da foto). */
async function shrinkImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.88);
}

async function uploadPortrait(event) {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  const error = form.querySelector('#portrait-error');
  showError(error, null);
  if (!UPLOAD_TYPES.includes(file.type)) {
    showError(error, new Error('Use uma imagem PNG, JPG ou WebP.'));
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    showError(error, new Error('A imagem passa de 20 MB. Escolha uma menor.'));
    return;
  }
  const token = ++portraitRequest;
  setGenerating(true, 'Enviando imagem...');
  try {
    const { url } = await api('/portraits', { method: 'POST', body: { image: await shrinkImage(file) } });
    if (token === portraitRequest) setPortrait(url);
  } catch (err) {
    if (token === portraitRequest) showError(error, err.message ? err : new Error('Não consegui ler essa imagem. Tente outra.'));
  } finally {
    if (token === portraitRequest) setGenerating(false);
  }
}

async function generatePortrait() {
  const token = ++portraitRequest;
  const error = form.querySelector('#portrait-error');
  showError(error, null);
  setGenerating(true);
  try {
    const prompt = value('image_prompt').trim() || automaticPrompt();
    const { url } = await api('/generate-image', { method: 'POST', body: { prompt }, gemini: true });
    // Se outra ficha foi aberta durante a geração, o retrato não pertence a ela.
    if (token === portraitRequest) setPortrait(url);
  } catch (err) {
    if (token === portraitRequest) showError(error, err);
  } finally {
    if (token === portraitRequest) setGenerating(false);
  }
}

function buildPortraitCard() {
  return h('div', { class: 'card portrait-card' },
    h('h4', {}, 'Retrato'),
    h('input', { type: 'hidden', name: 'avatar_url' }),
    h('div', { class: 'portrait-preview', id: 'portrait-preview' }, 'Nenhum retrato ainda'),
    area('Descrição da imagem (opcional, de preferência em inglês)', 'image_prompt', 3, 'Em branco, usa raça, classe, aparência e história da ficha.'),
    h('input', { type: 'file', id: 'portrait-file', accept: UPLOAD_TYPES.join(','), hidden: true, onchange: uploadPortrait }),
    h('div', { class: 'portrait-actions' },
      h('button', { type: 'button', id: 'portrait-upload', onclick: () => form.querySelector('#portrait-file').click() }, 'Enviar imagem'),
      h('button', { type: 'button', class: 'primary', id: 'portrait-generate', onclick: generatePortrait }, 'Gerar Retrato com IA'),
      h('button', { type: 'button', class: 'link-button', id: 'portrait-remove', hidden: true, onclick: () => setPortrait('') }, 'Remover retrato')),
    h('details', { class: 'more' },
      h('summary', {}, 'Saiba mais'),
      h('ul', {},
        h('li', {}, 'Enviar imagem: PNG, JPG ou WebP. Ela é reduzida no seu aparelho antes de subir.'),
        h('li', {}, 'Gerar com IA usa o Gemini com a sua chave; o plano gratuito do Google não inclui imagens.'))),
    h('p', { class: 'error', id: 'portrait-error', role: 'alert', hidden: true }),
  );
}

function buildPageTwo() {
  return h('div', { class: 'sheet-page', dataset: { page: '2' }, hidden: true },
    h('div', { class: 'detail-grid' },
      field('Idade', 'age'), field('Altura', 'height'), field('Peso', 'weight'),
      field('Cor dos olhos', 'eyes'), field('Cor da pele', 'skin'), field('Cor do cabelo', 'hair'),
    ),
    h('div', { class: 'page-grid' },
      h('div', { class: 'stack' },
        buildPortraitCard(),
        card(area('Aparência do personagem', 'appearance', 7)),
        card(area('História do personagem', 'backstory', 12)),
      ),
      h('div', { class: 'stack' },
        card(area('Aliados e organizações', 'allies', 6), field('Organização (nome)', 'organization')),
        card(area('Características e talentos adicionais', 'additional_features', 7)),
        card(area('Tesouros', 'treasure', 5)),
      ),
    ),
  );
}

function buildPageThree() {
  return h('div', { class: 'sheet-page', dataset: { page: '3' }, hidden: true },
    h('div', { class: 'spell-head' },
      field('Classe conjuradora', 'spell_class'),
      h('label', {}, 'Atributo de conjuração', h('select', { name: 'spell_ability' }, h('option', { value: '' }, 'Nenhum'), meta.abilities.map((a) => h('option', { value: a.key }, a.label)))),
      h('div', { class: 'card readout' }, output('spell_dc'), 'CD para evitar suas magias'),
      h('div', { class: 'card readout' }, output('spell_attack'), 'Modificador de ataque mágico'),
    ),
    h('p', { class: 'muted', style: 'margin-bottom:.6rem' }, 'Uma magia por linha. Comece com * para marcar como preparada.'),
    h('div', { class: 'spell-grid' },
      CIRCLES.map((circle) =>
        card(
          h('h4', {}, circle === 0 ? 'Truques' : `${circle}º círculo`),
          circle > 0 && field('Total de espaços', `slots.${circle}`, { type: 'number', min: 0, max: 20, value: 0 }),
          h('textarea', { name: `spells.${circle}`, rows: 4, 'aria-label': `Magias do círculo ${circle}` }),
        )
      )
    ),
  );
}

// Textos longos aparecem formatados (com negrito); ao clicar, viram campo de edição.
const FORMATTED_FIELDS = [
  'personality', 'ideals', 'bonds', 'flaws', 'features', 'proficiencies_languages', 'attack_notes', 'equipment',
  'appearance', 'backstory', 'allies', 'additional_features', 'treasure',
];
const textViews = [];

function showFormatted(textarea, view) {
  const hasText = Boolean(textarea.value.trim());
  view.replaceChildren(formatText(textarea.value));
  view.hidden = !hasText;
  textarea.hidden = hasText;
}

function enableFormattedView(textarea) {
  const view = h('div', {
    class: 'text-view prewrap',
    tabIndex: 0,
    role: 'button',
    title: 'Clique para editar',
    'aria-label': `Editar: ${textarea.closest('label')?.firstChild?.textContent ?? 'texto'}`,
    hidden: true,
  });
  const edit = () => {
    view.hidden = true;
    textarea.hidden = false;
    textarea.focus();
  };
  view.addEventListener('click', edit);
  view.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      edit();
    }
  });
  textarea.addEventListener('blur', () => showFormatted(textarea, view));
  textarea.after(view);
  textViews.push([textarea, view]);
}

function refreshTextViews() {
  for (const [textarea, view] of textViews) showFormatted(textarea, view);
}

function addAttack(attack = {}) {
  const row = h('div', { class: 'attack-row' },
    h('input', { name: 'attack.name', placeholder: 'Nome', value: attack.name ?? '', 'aria-label': 'Nome do ataque' }),
    h('input', { name: 'attack.bonus', placeholder: 'Bônus', value: attack.bonus ?? '', 'aria-label': 'Bônus de ataque' }),
    h('input', { name: 'attack.damage', placeholder: 'Dano/tipo', value: attack.damage ?? '', 'aria-label': 'Dano e tipo' }),
    h('button', { type: 'button', class: 'small', 'aria-label': 'Remover ataque', onclick: () => { row.remove(); schedulePreview(); } }, '×'),
  );
  form.querySelector('#attack-rows').append(row);
}

const value = (name) => form.elements[name]?.value ?? '';
const numberOrUndefined = (name) => (value(name) === '' ? undefined : Number(value(name)));
const checked = (name) => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);

const OVERRIDE_PATHS = {
  mod: ['modifiers'], save: ['saves'], skill: ['skills'],
  prof: 'proficiency_bonus', passive: 'passive_perception', initiative: 'initiative',
};

function readOverrides() {
  const overrides = { modifiers: {}, saves: {}, skills: {} };
  for (const [key, input] of autoInputs) {
    const raw = input.value.trim();
    if (!raw) continue;
    // Envia o texto como está; o servidor recusa o que não for número e explica o motivo.
    const [group, item] = key.split('.');
    const path = OVERRIDE_PATHS[group];
    if (Array.isArray(path)) overrides[path[0]][item] = raw;
    else overrides[path] = raw;
  }
  return overrides;
}

function fillOverrides(overrides = {}) {
  for (const [key, input] of autoInputs) {
    const [group, item] = key.split('.');
    const path = OVERRIDE_PATHS[group];
    const stored = Array.isArray(path) ? overrides[path[0]]?.[item] : overrides[path];
    input.value = stored === undefined || stored === null ? '' : (group === 'passive' ? String(stored) : signed(stored));
  }
}

function readForm() {
  const sheet = {};
  for (const name of ['personality', 'ideals', 'bonds', 'flaws', 'proficiencies_languages', 'features', 'attack_notes', 'equipment',
    'appearance', 'allies', 'additional_features', 'treasure', 'age', 'height', 'weight', 'eyes', 'skin', 'hair', 'organization', 'spell_class', 'spell_ability']) {
    sheet[name] = value(name);
  }
  sheet.save_proficiencies = checked('save');
  sheet.skill_proficiencies = checked('skill');
  sheet.overrides = readOverrides();
  sheet.coins = Object.fromEntries(meta.coins.map((coin) => [coin, numberOrUndefined(`coin.${coin}`)]));
  sheet.attacks = [...form.querySelectorAll('.attack-row')].map((row) => ({
    name: row.querySelector('[name="attack.name"]').value,
    bonus: row.querySelector('[name="attack.bonus"]').value,
    damage: row.querySelector('[name="attack.damage"]').value,
  }));
  sheet.spells = {};
  sheet.spell_slots = {};
  for (const circle of CIRCLES) {
    sheet.spells[circle] = value(`spells.${circle}`)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ name: line.replace(/^\*\s*/, ''), prepared: line.startsWith('*') }));
    if (circle > 0) sheet.spell_slots[circle] = numberOrUndefined(`slots.${circle}`);
  }

  const body = {
    name: value('name'), race: value('race'), class: value('class'), level: numberOrUndefined('level'),
    background: value('background'), alignment: value('alignment'), player_name: value('player_name'),
    xp: numberOrUndefined('xp'), armor_class: numberOrUndefined('armor_class'), speed: value('speed'),
    hit_die: numberOrUndefined('hit_die'), max_hp: numberOrUndefined('max_hp'), backstory: value('backstory'),
    avatar_url: value('avatar_url') || null, sheet,
  };
  for (const { key } of meta.abilities) body[key] = numberOrUndefined(key);
  return body;
}

function renderDerived(data) {
  const { derived } = data;
  // O campo vazio mostra o valor que será usado, já considerando o que foi digitado em outros campos.
  const automatic = derived;
  for (const { key } of meta.abilities) {
    autoInputs.get(`mod.${key}`).placeholder = signed(automatic.modifiers[key]);
    autoInputs.get(`save.${key}`).placeholder = signed(automatic.saves[key]);
  }
  for (const { key } of meta.skills) autoInputs.get(`skill.${key}`).placeholder = signed(automatic.skills[key]);
  autoInputs.get('prof').placeholder = signed(automatic.proficiency_bonus);
  autoInputs.get('passive').placeholder = String(automatic.passive_perception);
  autoInputs.get('initiative').placeholder = signed(automatic.initiative);
  outputs.get('spell_dc').textContent = derived.spell_save_dc ?? '—';
  outputs.get('spell_attack').textContent = derived.spell_attack === null ? '—' : signed(derived.spell_attack);
  form.elements.armor_class.placeholder = String(data.armor_class);
  form.elements.max_hp.placeholder = String(data.max_hp);
}

function previewBody(body) {
  // Sem nome ou raça o servidor recusaria; a prévia só precisa dos números.
  return { ...body, name: body.name || '-', race: body.race || '-', class: body.class || '-' };
}

async function refreshPreview() {
  try {
    renderDerived(await api('/characters/preview', { method: 'POST', body: previewBody(readForm()) }));
    showError(form.querySelector('#sheet-error'), null);
  } catch (err) {
    showError(form.querySelector('#sheet-error'), err);
  }
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 200);
}

/** Ao escolher uma classe conhecida, preenche o que o livro define para ela. */
function applyClassDefaults() {
  const known = meta.classes.find((entry) => entry.name.toLowerCase() === value('class').trim().toLowerCase());
  if (!known) return;
  form.elements.hit_die.value = String(known.hitDie);
  form.elements.spell_ability.value = known.spell ?? '';
  for (const input of form.querySelectorAll('input[name="save"]')) input.checked = known.saves.includes(input.value);
  if (known.spell && !value('spell_class')) form.elements.spell_class.value = known.name;
}

function showPage(page) {
  for (const section of form.querySelectorAll('.sheet-page')) section.hidden = section.dataset.page !== page;
  for (const button of form.querySelectorAll('.sheet-tabs button')) button.classList.toggle('active', button.dataset.page === page);
}

function setForm(character) {
  foreign = null;
  portraitRequest += 1;
  setGenerating(false);
  showError(form.querySelector('#portrait-error'), null);
  form.reset();
  form.querySelector('#attack-rows').replaceChildren();
  editingId = character?.id ?? null;
  document.getElementById('sheet-title').textContent = character ? `Ficha de ${character.name}` : 'Novo personagem';
  form.querySelector('#sheet-submit').textContent = character ? 'Salvar alterações' : 'Criar personagem';
  showPage('1');
  applyClassDefaults();

  if (!character) {
    setPortrait('');
    addAttack();
    refreshTextViews();
    return;
  }
  const { sheet } = character;
  for (const name of ['name', 'race', 'class', 'level', 'background', 'alignment', 'player_name', 'xp', 'speed', 'hit_die', 'backstory', 'armor_class', 'max_hp',
    ...meta.abilities.map((a) => a.key)]) {
    form.elements[name].value = character[name] ?? '';
  }
  for (const [name, content] of Object.entries(sheet)) {
    if (typeof content === 'string' && form.elements[name]) form.elements[name].value = content;
  }
  form.elements.spell_ability.value = sheet.spell_ability ?? '';
  for (const input of form.querySelectorAll('input[name="save"]')) input.checked = sheet.save_proficiencies?.includes(input.value) ?? false;
  for (const input of form.querySelectorAll('input[name="skill"]')) input.checked = sheet.skill_proficiencies?.includes(input.value) ?? false;
  fillOverrides(sheet.overrides);
  for (const coin of meta.coins) form.elements[`coin.${coin}`].value = sheet.coins?.[coin] ?? 0;
  for (const attack of sheet.attacks ?? []) addAttack(attack);
  for (const circle of CIRCLES) {
    form.elements[`spells.${circle}`].value = (sheet.spells?.[circle] ?? [])
      .map((spell) => `${spell.prepared ? '* ' : ''}${spell.name}`)
      .join('\n');
    if (circle > 0) form.elements[`slots.${circle}`].value = sheet.spell_slots?.[circle] ?? 0;
  }
  setPortrait(character.avatar_url);
  refreshTextViews();
}

/** CA e PV que seguem a regra ficam em branco, para continuarem automáticos ao subir de nível. */
async function clearAutomaticValues(character) {
  const body = readForm();
  delete body.armor_class;
  delete body.max_hp;
  const automatic = await api('/characters/preview', { method: 'POST', body });
  if (automatic.armor_class === character.armor_class) form.elements.armor_class.value = '';
  if (automatic.max_hp === character.max_hp) form.elements.max_hp.value = '';
}

const plain = (text) => String(text).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// Cor de cada classe no card. Classes fora do livro usam azul.
const CLASS_HUES = [
  ['barbar', 5], ['bard', 330], ['brux', 280], ['cleri', 190], ['druid', 130], ['feitic', 15],
  ['guerreir', 215], ['ladin', 255], ['mag', 235], ['mong', 170], ['paladin', 200], ['patrulh', 150],
];
const classHue = (name) => CLASS_HUES.find(([stem]) => plain(name).trim().startsWith(stem))?.[1] ?? 222;

function initials(name) {
  const words = name.trim().split(/\s+/).filter((word) => word.length > 2 || name.trim().split(/\s+/).length === 1);
  const picked = words.length > 1 ? [words[0], words.at(-1)] : [words[0] ?? name];
  return picked.map((word) => [...word][0]?.toUpperCase() ?? '').join('');
}

function characterCard(character, index) {
  const { derived } = character;
  const best = Math.max(...meta.abilities.map(({ key }) => character[key]));
  const isNew = !seenCards.has(character.id);
  seenCards.add(character.id);
  const label = `${character.id === editingId ? 'Ficha aberta' : 'Editar ficha'}`;

  return h('button', {
    type: 'button',
    class: `roster-card ${character.id === editingId ? 'is-open' : ''} ${isNew ? 'is-new' : ''}`,
    style: `--hue:${classHue(character.class)};--delay:${Math.min(index, 10) * 45}ms`,
    'aria-label': `${label}: ${character.name}, ${character.race}, ${character.class} nível ${character.level}`,
    'aria-current': character.id === editingId ? 'true' : undefined,
    onclick: () => openCharacter(character.id),
  },
    h('span', { class: 'card-top' },
      h('span', { class: 'avatar', 'aria-hidden': 'true' },
        character.avatar_url ? h('img', { src: character.avatar_url, alt: '' }) : initials(character.name),
        h('span', { class: 'level-badge' }, String(character.level))),
      h('span', { class: 'card-identity' },
        h('strong', {}, character.name),
        h('span', { class: 'class-name' }, `${character.class}, nível ${character.level}`),
        h('span', { class: 'race-name' }, character.race))),
    h('span', { class: 'card-stats' },
      [['CA', character.armor_class], ['PV', character.max_hp], ['Inic.', signed(derived.initiative)]].map(([name, value]) =>
        h('span', {}, h('b', {}, String(value)), h('small', {}, name)))),
    h('span', { class: 'card-abilities' },
      meta.abilities.map(({ key, short }) =>
        h('span', { class: character[key] === best ? 'best' : '' }, h('small', {}, short), h('b', {}, signed(derived.modifiers[key]))))),
    h('span', { class: 'card-action' }, label),
  );
}

function emptyRoster() {
  const steps = [
    ['user', 'Raça e classe', 'Você escolhe.'],
    ['dice', 'Atributos', 'O resto é calculado sozinho.'],
    ['image', 'Retrato', 'Envie ou gere com IA.'],
  ];
  return h('div', { class: 'empty-hero' },
    h('img', { src: 'img/logo.png', alt: '', class: 'empty-hero-art' }),
    h('h2', {}, 'Crie seu primeiro herói'),
    h('p', { class: 'muted' }, 'A ficha de D&D 5e que faz as contas por você.'),
    h('ol', { class: 'empty-steps' }, steps.map(([name, title, text]) =>
      h('li', {}, h('span', { class: 'step-icon', 'aria-hidden': 'true' }, svgIcon(name, 26)), h('div', {}, h('strong', {}, title), h('small', {}, text))))),
    h('button', { type: 'button', class: 'primary big', onclick: () => document.getElementById('character-new').click() }, 'Criar personagem'));
}

function renderRoster() {
  const roster = document.getElementById('character-roster');
  const filterInput = document.getElementById('character-filter');
  const empty = !rosterCharacters.length;
  document.getElementById('roster-title').hidden = empty;
  // Sem personagens, o convite ocupa a tela e já tem o botão de criar.
  document.getElementById('character-new').hidden = empty && form.hidden;
  filterInput.hidden = rosterCharacters.length < 5;
  const query = filterInput.hidden ? '' : plain(filterInput.value.trim());
  const visible = rosterCharacters.filter((c) => plain(`${c.name} ${c.race} ${c.class}`).includes(query));

  if (empty) {
    roster.replaceChildren(...(form.hidden ? [emptyRoster()] : []));
  } else if (!visible.length) {
    roster.replaceChildren(h('p', { class: 'muted' }, 'Nenhum personagem encontrado nessa busca.'));
  } else {
    roster.replaceChildren(...visible.map(characterCard));
  }
}

export async function refreshRoster() {
  rosterCharacters = await api('/characters');
  renderRoster();
}

/** Enquanto um personagem novo é criado, a lista sai da frente. */
function setCreating(active) {
  document.getElementById('view-characters').classList.toggle('is-creating', active);
}

function showSheet(visible) {
  if (!visible) setCreating(false);
  form.hidden = !visible;
  document.getElementById('sheet-title').hidden = !visible;
  renderRoster();
}

function markForeign() {
  document.getElementById('sheet-title').textContent = `Ficha de ${form.elements.name.value} · de ${foreign.owner} (você está editando como Mestre)`;
}

/** O Mestre abre a ficha de um jogador da mesa. */
export async function openForeignCharacter(character, { savePath, owner }) {
  setCreating(false);
  setForm(character);
  foreign = { savePath, owner };
  markForeign();
  showSheet(true);
  await clearAutomaticValues(character);
  await refreshPreview();
  document.getElementById('sheet-title').scrollIntoView({ block: 'start' });
}

export async function openCharacter(id) {
  const character = await api(`/characters/${id}`);
  setCreating(false);
  setForm(character);
  showSheet(true);
  await clearAutomaticValues(character);
  await refreshPreview();
  await refreshRoster();
  document.getElementById('sheet-title').scrollIntoView({ block: 'start' });
}

export async function initCharacterForm(saved) {
  onSaved = saved;
  meta = await api('/characters/meta');
  form = document.getElementById('character-form');
  form.append(
    h('div', { class: 'sheet-tabs' },
      [['1', 'Página 1: Personagem'], ['2', 'Página 2: Detalhes'], ['3', 'Página 3: Magias']].map(([page, label]) =>
        h('button', { type: 'button', dataset: { page }, onclick: () => showPage(page) }, label))),
    buildPageOne(),
    buildPageTwo(),
    buildPageThree(),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'primary', id: 'sheet-submit', type: 'submit' }, 'Criar personagem'),
      h('button', {
        type: 'button',
        id: 'sheet-close',
        onclick: async () => {
          setForm(null);
          showSheet(false);
          await refreshRoster();
        },
      }, 'Fechar'),
      h('p', { class: 'error', id: 'sheet-error', role: 'alert', hidden: true }),
      h('p', { class: 'muted', id: 'sheet-saved', role: 'status' }),
    ),
  );

  for (const name of FORMATTED_FIELDS) enableFormattedView(form.elements[name]);

  form.addEventListener('input', (event) => {
    if (event.target.name === 'class') applyClassDefaults();
    form.querySelector('#sheet-saved').textContent = '';
    schedulePreview();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('#sheet-submit');
    submit.disabled = true;
    try {
      const body = readForm();
      const editingForeign = foreign;
      const character = editingForeign
        ? await api(editingForeign.savePath, { method: 'PUT', body })
        : await api(editingId ? `/characters/${editingId}` : '/characters', { method: editingId ? 'PUT' : 'POST', body });
      if (editingForeign) {
        showError(form.querySelector('#sheet-error'), null);
        setForm(character);
        foreign = editingForeign;
        markForeign();
        await clearAutomaticValues(character);
        await refreshPreview();
        form.querySelector('#sheet-saved').textContent = `Ficha salva. ${editingForeign.owner} foi avisado(a) do que mudou.`;
        return;
      }
      showError(form.querySelector('#sheet-error'), null);
      setForm(character);
      setCreating(false);
      await refreshRoster();
      await clearAutomaticValues(character);
      await refreshPreview();
      form.querySelector('#sheet-saved').textContent = 'Ficha salva.';
      await onSaved(character);
    } catch (err) {
      showError(form.querySelector('#sheet-error'), err);
    } finally {
      submit.disabled = false;
    }
  });

  document.getElementById('character-new').addEventListener('click', async () => {
    setForm(null);
    setCreating(true);
    showSheet(true);
    window.scrollTo({ top: 0 });
    await refreshPreview();
    await refreshRoster();
    form.elements.name.focus();
  });

  document.getElementById('character-filter').addEventListener('input', renderRoster);

  setForm(null);
  showSheet(false);
  await refreshRoster();
  await refreshPreview();
}
