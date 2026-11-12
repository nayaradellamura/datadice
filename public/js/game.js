import { api, campaignLabel, fillSelect, formatText, h, settings, showError, signed, store } from './api.js';
import { icon } from './icons.js';
import { openSheetView } from './sheet-view.js';
import { illustrationFigure, notifyVisualFinished } from './visual.js';

const STATUS_LABELS = { active: 'Ativo', unconscious: 'Inconsciente', stable: 'Estável', dead: 'Morto' };

const el = (id) => document.getElementById(id);
let meta;
let party = [];
let sending = false;
let manualOpen = false;
let showManualSaved = false;
let illustrationTimer = null;
let session = null;
let openingSession = false;

const campaignId = () => Number(el('game-campaign').value) || null;
const characterId = () => Number(el('game-character').value) || null;
const currentMember = () => party.find((member) => member.character_id === characterId()) ?? null;

function addMessage(type, who, text) {
  const log = el('chat-log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  const node = h('div', { class: `msg ${type}` }, who && h('span', { class: 'who' }, who), formatText(text));
  log.append(node);
  if (atBottom || type === 'player') log.scrollTop = log.scrollHeight;
  return node;
}

function attachIllustrations(node, illustrations) {
  if (!illustrations?.length) return;
  node.append(h('div', { class: 'illustrations' }, illustrations.map(illustrationFigure)));
  watchPendingIllustrations();
}

/** Troca nas bolhas as imagens cujo estado mudou. */
export async function refreshIllustrations() {
  const figures = el('chat-log').querySelectorAll('.illustration:not(.status-ready)');
  if (!figures.length || !campaignId()) return;
  const visuals = await api(`/campaigns/${campaignId()}/visuals`);
  const byKey = new Map(visuals.map((visual) => [`${visual.kind}:${visual.id}`, visual]));
  const notified = new Set();
  for (const figure of figures) {
    const visual = byKey.get(figure.dataset.key);
    if (visual && !figure.classList.contains(`status-${visual.image_status}`)) {
      const wasPending = figure.classList.contains('status-pending');
      figure.replaceWith(illustrationFigure(visual));
      if (wasPending && visual.image_status !== 'pending' && !notified.has(figure.dataset.key)) {
        notified.add(figure.dataset.key);
        notifyVisualFinished(visual);
      }
    }
  }
}

function watchPendingIllustrations() {
  if (illustrationTimer || !el('chat-log').querySelector('.illustration.status-pending')) return;
  illustrationTimer = setTimeout(async () => {
    illustrationTimer = null;
    try {
      await refreshIllustrations();
    } catch {
      // Sem conexão com o servidor agora: tenta de novo no próximo ciclo.
    }
    watchPendingIllustrations();
  }, 3000);
}

function renderHistory(messages) {
  el('chat-log').replaceChildren();
  if (!messages.length && !campaignId()) {
    el('chat-log').append(h('p', { class: 'empty' }, 'Crie uma campanha e um personagem para começar.'));
  }
  for (const message of messages) {
    if (message.session) {
      const label = message.session.kind === 'intro' ? 'Introdução' : 'Resumo da última sessão';
      el('chat-log').append(h('div', { class: 'session-divider' }, `Sessão ${message.session.number} · ${label}`));
    }
    const type = message.sender_type === 'gm' ? 'gm' : message.sender_type === 'system' ? 'system' : 'player';
    const node = addMessage(type, type === 'system' ? null : message.sender_name, message.message_text);
    attachIllustrations(node, message.illustrations);
  }
  el('chat-log').scrollTop = el('chat-log').scrollHeight;
}

const gmReactsToRolls = () => store.get('gmReactsToRolls') !== 'off';

// No celular o painel de dados fica abaixo do chat: um botão flutuante leva de um ao outro.
const phone = matchMedia('(max-width: 860px)');
let chatInView = true;
const smooth = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

function updateJumpButton() {
  const button = el('jump-dice');
  button.hidden = !phone.matches || !document.querySelector('.dice-card');
  el('jump-dice-label').textContent = chatInView ? 'Dados' : 'Chat';
  el('jump-dice-icon').replaceChildren(icon(chatInView ? 'dice' : 'chat'));
  button.setAttribute('aria-label', chatInView ? 'Ir para Rolar dados' : 'Voltar ao chat');
}

function scrollToChat() {
  el('chat-form').scrollIntoView({ behavior: smooth(), block: 'end' });
}

function initJumpButton() {
  new IntersectionObserver(([entry]) => {
    chatInView = entry.isIntersecting;
    updateJumpButton();
  }).observe(el('chat-form'));
  phone.addEventListener('change', updateJumpButton);
  el('jump-dice').addEventListener('click', () => {
    if (chatInView) document.querySelector('.dice-card')?.scrollIntoView({ behavior: smooth(), block: 'start' });
    else scrollToChat();
  });
}

async function roll(body) {
  showError(el('chat-error'), null);
  try {
    const result = await api(`/campaigns/${campaignId()}/roll`, { method: 'POST', body: { character_id: characterId(), ...body } });
    el('chat-log').querySelector('.empty')?.remove();
    addMessage('system', null, result.message_text);
    el('chat-log').scrollTop = el('chat-log').scrollHeight;
    party = result.party;
    if (body.kind === 'attack') criticalWeapon = result.critical ? body.index : null;
    renderMember();
    // No celular, volta ao chat para o jogador ver o resultado e a resposta do Mestre.
    if (phone.matches) scrollToChat();
    // O Mestre recebe a rolagem na hora, sem o jogador precisar escrever o resultado no chat.
    if (gmReactsToRolls() && session?.status === 'active' && !sending) {
      await playGmTurn({ roll_id: result.id });
    }
  } catch (err) {
    showError(el('chat-error'), err);
  }
}

async function patchMember(body) {
  showError(el('chat-error'), null);
  try {
    const result = await api(`/campaigns/${campaignId()}/characters/${characterId()}`, { method: 'PATCH', body });
    party = result.party;
    return true;
  } catch (err) {
    showError(el('chat-error'), err);
    return false;
  }
}

function chips(items, className = '') {
  return items.length
    ? h('div', { class: 'chips' }, items.map((item) => h('span', { class: `chip ${className}` }, item)))
    : h('p', { class: 'muted' }, 'Nada ainda.');
}

// Vantagem/desvantagem vale para a próxima rolagem de d20 e depois volta ao normal.
let rollMode = 'normal';
// Arma que tirou 20 natural: o próximo dano dela dobra os dados.
let criticalWeapon = null;
const MODES = [['normal', 'Normal'], ['advantage', 'Vantagem'], ['disadvantage', 'Desvantagem']];

async function rollD20(body) {
  const mode = rollMode;
  rollMode = 'normal';
  await roll({ ...body, mode });
}

/** Dano "1d6+4 Perfurante": separa a fórmula do tipo para mostrar no botão. */
function damageFormula(text) {
  return /^\s*(\d{1,2}\s*d\s*\d{1,3}(?:\s*[+-]\s*(?:\d{1,2}\s*d\s*\d{1,3}|\d{1,3}))*)/i.exec(text ?? '')?.[1].replace(/\s+/g, '') ?? null;
}

function rollControls(member) {
  const { derived, sheet } = member;
  const attacks = sheet.attacks ?? [];
  const expression = h('input', { placeholder: 'Ex.: 2d6+3', 'aria-label': 'Outra rolagem' });
  const skillProf = new Set(sheet.skill_proficiencies ?? []);
  const saveProf = new Set(sheet.save_proficiencies ?? []);
  const testButton = (label, value, body, proficient) =>
    h('button', { type: 'button', class: `test-btn${proficient ? ' prof' : ''}`, title: proficient ? 'Proficiente' : '', onclick: () => rollD20(body) },
      h('span', {}, label), h('b', {}, signed(value)));

  return h('div', { class: 'card dice-card' },
    h('h3', {}, 'Rolar dados'),
    h('div', { class: 'mode-switch', role: 'group', 'aria-label': 'Modo do próximo d20' }, MODES.map(([value, label]) =>
      h('button', { type: 'button', class: rollMode === value ? 'active' : '', 'aria-pressed': String(rollMode === value),
        onclick: () => { rollMode = value; renderMember(); } }, label))),

    attacks.length > 0 && h('h4', {}, 'Armas'),
    attacks.map((attack, index) => {
      const formula = damageFormula(attack.damage);
      const crit = criticalWeapon === index;
      const critFormula = formula?.replace(/(\d+)d/g, (_, n) => `${n * 2}d`);
      return h('div', { class: 'weapon-row' },
        h('div', { class: 'weapon-name' }, h('strong', {}, attack.name), h('small', { class: 'muted' }, attack.damage)),
        h('button', { type: 'button', class: 'primary', title: `Rola 1d20 ${attack.bonus || '+0'} (bônus de ataque anotado na ficha)`,
          onclick: () => rollD20({ kind: 'attack', index }) }, `Atacar ${attack.bonus || '+0'}`),
        formula && h('button', { type: 'button', class: crit ? 'crit' : '',
          onclick: async () => { criticalWeapon = null; await roll({ kind: 'damage', index, critical: crit }); } },
          crit ? `Crítico ${critFormula}` : `Dano ${formula}`));
    }),

    h('h4', {}, 'Testes'),
    h('div', { class: 'ability-buttons' }, meta.abilities.map((a) =>
      h('button', { type: 'button', title: `Teste de ${a.label}`, onclick: () => rollD20({ kind: 'attribute', key: a.key }) },
        a.short, h('b', {}, signed(derived.modifiers[a.key]))))),
    h('div', { class: 'quick-row' },
      h('button', { type: 'button', class: 'primary', title: `Rola 1d20 ${signed(derived.initiative)} (modificador de Destreza)`,
        onclick: () => rollD20({ kind: 'initiative' }) }, `Iniciativa ${signed(derived.initiative)}`)),
    h('details', { class: 'roll-group' }, h('summary', {}, 'Perícias'),
      h('div', { class: 'test-grid' }, meta.skills.map((s) => testButton(s.label, derived.skills[s.key], { kind: 'skill', key: s.key }, skillProf.has(s.key))))),
    h('details', { class: 'roll-group' }, h('summary', {}, 'Salvaguardas'),
      h('div', { class: 'test-grid' }, meta.abilities.map((a) => testButton(a.label, derived.saves[a.key], { kind: 'save', key: a.key }, saveProf.has(a.key))))),

    h('h4', {}, 'Dados'),
    h('div', { class: 'die-row' }, [4, 6, 8, 10, 12, 20, 100].map((sides) =>
      h('button', { type: 'button', onclick: () => (sides === 20 ? rollD20({ kind: 'plain' }) : roll({ kind: 'dice', expression: `1d${sides}` })) }, `d${sides}`))),
    h('form', { class: 'roll-row', onsubmit: (event) => { event.preventDefault(); roll({ kind: 'dice', expression: expression.value }); } },
      expression, h('button', {}, 'Rolar')),
    h('label', { class: 'check roll-notify' },
      h('input', {
        type: 'checkbox',
        id: 'roll-notify',
        checked: gmReactsToRolls(),
        onchange: (event) => store.set('gmReactsToRolls', event.target.checked ? 'on' : 'off'),
      }),
      'Mestre reage às rolagens'),
    member.current_hp === 0 && member.status === 'unconscious' &&
      h('button', { type: 'button', class: 'danger', style: 'width:100%;margin-top:.4rem', onclick: () => roll({ kind: 'death' }) }, 'Salvaguarda contra a morte'),
  );
}

function spellSection(member) {
  const { sheet, derived } = member;
  if (!sheet.spell_ability) return null;
  const circles = Object.entries(sheet.spell_slots ?? {}).filter(([, total]) => total > 0);
  return h('div', { class: 'card' },
    h('h3', {}, 'Magia'),
    h('p', { class: 'muted' }, `CD ${derived.spell_save_dc} · ataque ${signed(derived.spell_attack)}`),
    circles.map(([circle, total]) => {
      const used = member.spell_slots_used[circle] ?? 0;
      return h('p', {}, `${circle}º círculo: ${total - used}/${total} espaços`);
    }),
    h('details', {}, h('summary', { class: 'muted' }, 'Magias conhecidas'),
      Object.entries(sheet.spells ?? {}).filter(([, list]) => list.length).map(([circle, list]) =>
        h('p', { class: 'muted' }, `${circle === '0' ? 'Truques' : `${circle}º`}: ${list.map((s) => `${s.prepared ? '*' : ''}${s.name}`).join(', ')}`))),
  );
}

/** Estado do personagem nesta campanha, que muda durante o jogo e é separado da ficha. */
function manualEditor(member) {
  const number = (value, props = {}) => h('input', { type: 'number', min: 0, value, ...props });
  const hp = number(member.current_hp, { max: member.max_hp });
  const temp = number(member.temp_hp);
  const hitDice = number(member.hit_dice_used, { max: member.level });
  const status = h('select', {}, Object.entries(STATUS_LABELS).map(([value, label]) => h('option', { value }, label)));
  status.value = member.status;
  const inspiration = h('input', { type: 'checkbox', checked: Boolean(member.inspiration) });
  const inventory = h('textarea', { rows: 4 }, member.inventory.join('\n'));
  const conditions = h('textarea', { rows: 2 }, member.conditions.join('\n'));
  const coins = Object.fromEntries(meta.coins.map((coin) => [coin, number(member.coins[coin] ?? 0)]));
  const circles = Object.entries(member.sheet.spell_slots ?? {}).filter(([, total]) => total > 0);
  const slots = Object.fromEntries(circles.map(([circle, total]) => [circle, number(member.spell_slots_used[circle] ?? 0, { max: total })]));
  const lines = (input) => input.value.split('\n').map((line) => line.trim()).filter(Boolean);

  async function save(event) {
    event.preventDefault();
    showManualSaved = await patchMember({
      current_hp: Number(hp.value),
      temp_hp: Number(temp.value),
      hit_dice_used: Number(hitDice.value),
      status: status.value,
      inspiration: inspiration.checked,
      inventory: lines(inventory),
      conditions: lines(conditions),
      coins: Object.fromEntries(meta.coins.map((coin) => [coin, Number(coins[coin].value)])),
      spell_slots_used: Object.fromEntries(Object.entries(slots).map(([circle, input]) => [circle, Number(input.value)])),
    });
    renderMember();
    showManualSaved = false;
  }

  return h('details', { style: 'margin-top:.5rem', open: manualOpen, ontoggle: (event) => { manualOpen = event.target.open; } },
    h('summary', { class: 'muted' }, 'Ajustar estado na campanha'),
    h('form', { class: 'manual-form', onsubmit: save },
      h('div', { class: 'row' }, h('label', {}, 'PV', hp), h('label', {}, 'PV temp.', temp)),
      h('div', { class: 'row' }, h('label', {}, 'Dados de Vida usados', hitDice), h('label', {}, 'Estado', status)),
      h('label', { class: 'check' }, inspiration, 'Inspiração'),
      h('label', {}, 'Inventário (um item por linha)', inventory),
      h('label', {}, 'Condições (uma por linha)', conditions),
      h('div', { class: 'coin-row' }, meta.coins.map((coin) => h('label', {}, coin, coins[coin]))),
      circles.length > 0 && h('h4', {}, 'Espaços de magia usados'),
      circles.length > 0 && h('div', { class: 'slot-row' }, circles.map(([circle, total]) => h('label', {}, `${circle}º (de ${total})`, slots[circle]))),
      h('button', {}, 'Salvar ajustes'),
      showManualSaved && h('p', { class: 'saved-note', role: 'status' }, 'Ajustes salvos.'),
    ),
  );
}

function lastPlayedText() {
  if (!session?.last_played_at) return '';
  const date = new Date(`${session.last_played_at.replace(' ', 'T')}Z`);
  return `Última jogada em ${date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}.`;
}

/** Enquanto o Mestre não abrir a sessão, o chat fica fechado. */
function renderSessionGate(member) {
  const gate = el('session-gate');
  const waiting = Boolean(member) && (session?.status === 'new' || session?.status === 'returning');
  gate.hidden = !waiting;
  el('chat-form').hidden = waiting;
  if (!waiting) return;

  const isNew = session.status === 'new';
  gate.replaceChildren(
    h('div', {},
      h('strong', {}, isNew ? 'Sua aventura vai começar' : `Continuar: ${el('game-campaign').selectedOptions[0].textContent}`),
      h('p', { class: 'muted' }, openingSession
        ? (isNew ? 'O Mestre está preparando a introdução...' : 'O Mestre está relembrando a última sessão...')
        : (isNew ? 'O Mestre vai apresentar o mundo, situar seu personagem e explicar como jogar.' : `O Mestre vai resumir a última sessão antes de continuar. ${lastPlayedText()}`))),
    h('button', { type: 'button', class: 'primary', id: 'session-start', disabled: openingSession, onclick: openSession },
      openingSession ? 'Aguarde...' : (isNew ? 'Começar aventura' : 'Continuar campanha')),
  );
}

async function openSession() {
  const id = campaignId();
  openingSession = true;
  showError(el('chat-error'), null);
  renderMember();
  try {
    const result = await api(`/campaigns/${id}/session`, {
      method: 'POST',
      body: { character_id: characterId(), enable_image_gen: settings.imagesEnabled },
      gemini: true,
    });
    openingSession = false;
    await loadCampaign();
    el('chat-input').focus();
  } catch (err) {
    openingSession = false;
    showError(el('chat-error'), err);
    renderMember();
  }
}

async function finishSession() {
  try {
    const result = await api(`/campaigns/${campaignId()}/session/end`, { method: 'POST', body: {} });
    session = result.session;
    renderMember();
  } catch (err) {
    showError(el('chat-error'), err);
  }
}

function renderMember() {
  const panel = el('member-panel');
  const member = currentMember();
  el('game-join').hidden = !(campaignId() && characterId() && !member);
  el('chat-input').disabled = !member || member.status === 'dead';
  el('chat-send').disabled = !member || member.status === 'dead' || sending;
  renderSessionGate(member);
  if (!member) {
    panel.replaceChildren();
    updateJumpButton();
    return;
  }

  const { derived } = member;
  const percent = Math.round((member.current_hp / member.max_hp) * 100);
  const coins = meta.coins.filter((coin) => member.coins[coin]).map((coin) => `${member.coins[coin]} ${coin.toUpperCase()}`);

  panel.replaceChildren(
    h('div', { class: 'stack' },
      h('div', { class: 'card' },
        h('div', { class: 'member-head' },
          member.avatar_url && h('img', { src: member.avatar_url, alt: `Retrato de ${member.name}` }),
          h('div', {},
            h('div', { class: 'member-name' }, member.name),
            h('p', { class: 'muted' }, `${member.race}, ${member.class} ${member.level} · XP ${member.xp}`))),
        h('span', { class: `status-badge ${member.status}` }, STATUS_LABELS[member.status] ?? member.status),
        h('div', { class: `hp-bar ${percent <= 30 ? 'low' : ''}`, role: 'img', 'aria-label': `${member.current_hp} de ${member.max_hp} pontos de vida` }, h('i', { style: `width:${percent}%` })),
        h('p', {}, `PV ${member.current_hp}/${member.max_hp}${member.temp_hp ? ` + ${member.temp_hp} temp.` : ''}`),
        member.current_hp === 0 && h('p', { class: 'muted' }, `Contra a morte: ${member.death_successes} sucesso(s), ${member.death_failures} falha(s)`),
        h('div', { class: 'stat-grid' },
          [['CA', member.armor_class], ['Iniciativa', signed(derived.initiative)], ['Desloc.', member.speed],
            ['Proficiência', signed(derived.proficiency_bonus)], ['Perc. passiva', derived.passive_perception], ['Dados vida', `${member.level - member.hit_dice_used}d${member.hit_die}`]]
            .map(([label, value]) => h('div', { class: 'stat' }, h('b', {}, String(value)), h('small', {}, label)))),
        h('div', { class: 'sheet-buttons' },
          h('button', { type: 'button', class: 'edit-sheet', onclick: () => openSheetView(member, { state: member }) }, 'Ver ficha'),
          h('button', {
            type: 'button',
            class: 'edit-sheet',
            onclick: () => document.dispatchEvent(new CustomEvent('open-character', { detail: member.character_id })),
          }, 'Editar ficha')),
        session?.status === 'active' && h('button', { type: 'button', class: 'edit-sheet', id: 'session-end', onclick: finishSession }, 'Encerrar sessão'),
        manualEditor(member),
      ),
      rollControls(member),
      member.conditions.length > 0 && h('div', { class: 'card' }, h('h3', {}, 'Condições'), chips(member.conditions, 'condition')),
      h('div', { class: 'card' },
        h('h3', {}, 'Inventário'), chips(member.inventory),
        h('h4', {}, 'Moedas'), h('p', {}, coins.join(' · ') || '—'),
      ),
      spellSection(member),
    ),
  );
  updateJumpButton();
}


async function loadCampaign() {
  store.set('campaign', campaignId() ?? '');
  if (!campaignId()) {
    party = [];
    session = null;
    renderHistory([]);
    renderMember();
    return;
  }
  const [state, messages] = await Promise.all([
    api(`/campaigns/${campaignId()}/state`),
    api(`/campaigns/${campaignId()}/messages`),
  ]);
  party = state.party;
  session = state.session;
  renderHistory(messages);
  renderMember();
}

export function selectedCampaign() {
  const select = el('game-campaign');
  return campaignId() ? { id: campaignId(), name: select.selectedOptions[0].textContent } : null;
}

export async function refreshGameSelectors() {
  const [campaigns, characters] = await Promise.all([api('/campaigns'), api('/characters')]);
  const previousCampaign = campaignId() ?? store.get('campaign') ?? '';
  const previousCharacter = characterId() ?? store.get('character') ?? '';
  fillSelect(el('game-campaign'), campaigns.map((c) => ({ value: c.id, label: campaignLabel(c) })), { placeholder: 'Escolha uma campanha', value: previousCampaign });
  fillSelect(el('game-character'), characters.map((c) => ({ value: c.id, label: `${c.name} (${c.class} ${c.level})` })), { placeholder: 'Escolha um personagem', value: previousCharacter });
  await loadCampaign();
}

/** Um turno do Mestre, iniciado por uma mensagem do jogador ou por uma rolagem. Devolve true se deu certo. */
async function playGmTurn(extraBody, playerNode = null) {
  const member = currentMember();
  if (!member || sending) return false;

  sending = true;
  el('chat-send').disabled = true;
  showError(el('chat-error'), null);
  const pending = addMessage('gm pending', 'Mestre', 'O Mestre está pensando...');
  el('chat-log').scrollTop = el('chat-log').scrollHeight;

  try {
    const result = await api('/chat', {
      method: 'POST',
      body: { campaign_id: campaignId(), character_id: member.character_id, enable_image_gen: settings.imagesEnabled, ...extraBody },
      gemini: true,
    });
    pending.remove();
    for (const roll of result.rolls) addMessage('system', null, roll);
    attachIllustrations(addMessage('gm', 'Mestre', result.narration), result.illustrations);
    if (result.warning) addMessage('system', null, result.warning);
    if (result.memory_changes.length) addMessage('note', null, `Caderno atualizado: ${result.memory_changes.join(', ')}`);
    party = result.party;
    return true;
  } catch (err) {
    pending.remove();
    playerNode?.remove();
    showError(el('chat-error'), err);
    return false;
  } finally {
    sending = false;
    renderMember();
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const input = el('chat-input');
  const text = input.value.trim();
  const member = currentMember();
  if (!text || !member || sending) return;

  el('chat-log').querySelector('.empty')?.remove();
  const playerNode = addMessage('player', member.name, text);
  // Se falhar, a mensagem sai da tela mas continua na caixa de texto para reenviar.
  if (await playGmTurn({ message: text }, playerNode)) input.value = '';
  input.focus();
}

export async function initGame() {
  meta = await api('/characters/meta');
  initJumpButton();
  el('chat-form').addEventListener('submit', sendMessage);
  el('chat-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) el('chat-form').requestSubmit();
  });
  el('chat-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) event.preventDefault();
  });
  el('game-campaign').addEventListener('change', () => loadCampaign().catch((err) => showError(el('chat-error'), err)));
  el('game-character').addEventListener('change', () => {
    store.set('character', characterId() ?? '');
    renderMember();
  });
  el('game-join').addEventListener('click', async () => {
    try {
      const result = await api('/campaigns/join', { method: 'POST', body: { campaign_id: campaignId(), character_id: characterId() } });
      party = result.party;
      showError(el('chat-error'), null);
      renderMember();
    } catch (err) {
      showError(el('chat-error'), err);
    }
  });
  await refreshGameSelectors();
}
