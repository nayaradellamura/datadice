import { api, h, showError, store } from './api.js';

// O Google não informa ao DataDice quanto resta da cota da chave. O limite diário vem do valor típico do
// plano gratuito e a pessoa ajusta para o da sua chave (aparece no Google AI Studio, em Limites de taxa).
const DEFAULT_DAILY_LIMIT = 1000;
const dailyLimit = () => Number(store.get('usage.dailyLimit')) || DEFAULT_DAILY_LIMIT;

const el = (id) => document.getElementById(id);
const PERIODS = [['today', 'Hoje'], ['7', '7 dias'], ['30', '30 dias'], ['all', 'Tudo']];
const number = (value) => Number(value ?? 0).toLocaleString('pt-BR');
const plural = (count, one, many) => `${number(count)} ${count === 1 ? one : many}`;
let period = '30';

function money(totals) {
  if (!totals.cost_known) return '—';
  // Valores pequenos aparecem com mais casas, para não virar "US$ 0,00".
  const digits = totals.cost_usd > 0 && totals.cost_usd < 0.01 ? 4 : 2;
  return `US$ ${totals.cost_usd.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function stat(label, value) {
  return h('div', { class: 'stat' }, h('b', {}, value), h('small', {}, label));
}

/** Lista com barras: cada linha mostra a parte do total gasta naquele item. */
function bars(groups, total) {
  if (!groups.length) return h('p', { class: 'muted' }, 'Nenhum uso neste período.');
  return h('div', { class: 'usage-bars' }, groups.map((group) =>
    h('div', { class: 'usage-bar' },
      h('span', {}, group.label),
      h('b', {}, `${number(group.total_tokens)} tokens`),
      h('i', { style: `--share:${total ? Math.max(2, Math.round((group.total_tokens / total) * 100)) : 0}%` }),
      h('small', {}, `${plural(group.calls, 'pedido', 'pedidos')} · custo estimado ${money(group)}`))));
}

function dayChart(days) {
  if (!days.length) return h('p', { class: 'muted' }, 'Nenhum uso nos últimos 30 dias.');
  const max = Math.max(1, ...days.map((day) => day.total_tokens));
  return h('div', { class: 'day-bars' }, days.map((day) => {
    const [, month, date] = day.key.split('-');
    return h('div', { class: 'day-bar', title: `${date}/${month}: ${number(day.total_tokens)} tokens, ${plural(day.calls, 'pedido', 'pedidos')}` },
      h('i', { style: `height:${Math.max(4, Math.round((day.total_tokens / max) * 100))}%` }),
      h('small', {}, date));
  }));
}

export async function renderUsage() {
  for (const button of el('usage-periods').children) {
    const active = button.dataset.period === period;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  try {
    const usage = await api(`/tokens/mine?period=${period}`);
    const resets = new Date(usage.quota.resets_at)
      .toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    const label = PERIODS.find(([value]) => value === usage.period)[1].toLowerCase();

    const limit = dailyLimit();
    const used = usage.quota.requests;
    const left = Math.max(0, limit - used);
    const share = Math.min(100, Math.round((used / limit) * 100));
    const level = share >= 90 ? 'high' : share >= 70 ? 'mid' : 'low';
    const limitInput = h('input', {
      type: 'number', min: 1, max: 1000000, value: limit, inputmode: 'numeric', class: 'quota-limit-input', 'aria-label': 'Limite diário da sua chave (pedidos)',
      onchange: (event) => {
        const value = Number(event.target.value);
        if (Number.isInteger(value) && value > 0) { store.set('usage.dailyLimit', String(value)); renderUsage(); }
      },
    });
    const accordion = (title, open, ...children) => h('details', { class: 'accordion', open }, h('summary', {}, title), h('div', { class: 'accordion-body' }, ...children));

    el('usage-content').replaceChildren(
      h('div', { class: 'card quota-card stack' },
        h('h3', {}, 'Hoje'),
        h('p', { class: 'quota-number' }, `Restam cerca de ${plural(left, 'pedido', 'pedidos')}`),
        h('div', { class: `quota-meter ${level}`, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(limit), 'aria-valuenow': String(used), 'aria-label': `${used} de ${limit} pedidos usados hoje` },
          h('i', { style: `width:${share}%` })),
        h('p', {}, `Usados hoje: ${plural(used, 'pedido', 'pedidos')} de ${number(limit)} (${number(usage.quota.tokens)} tokens). Renova às ${resets}, horário de Brasília.`),
        h('details', { class: 'more' },
          h('summary', {}, 'De onde vem esse limite?'),
          h('ul', {},
            h('li', {}, 'O plano gratuito do Gemini limita quantos pedidos a chave faz por dia. Cada mensagem ao Mestre usa um ou mais pedidos.'),
            h('li', {}, 'O Google não informa ao DataDice quanto sobra. O limite abaixo é o valor típico do plano gratuito: confira o da sua chave no Google AI Studio (Limites de taxa) e ajuste aqui.'),
            h('li', {}, 'A conta considera só o que foi usado pelo DataDice com a sua conta. Se a mesma chave for usada em outro lugar, sobra menos.')),
          h('label', { class: 'inline quota-limit' }, 'Limite diário da minha chave:', limitInput, 'pedidos'))),
      accordion(`Total (${label})`, true,
        h('div', { class: 'stat-grid' },
          stat('Tokens', number(usage.totals.total_tokens)),
          stat('Pedidos', number(usage.totals.calls)),
          stat('Custo estimado', money(usage.totals)),
          stat('Entrada', number(usage.totals.prompt_tokens)),
          stat('Saída', number(usage.totals.completion_tokens))),
        h('p', { class: 'muted' }, 'O custo estimado vale só para chaves com faturamento ativo; no plano gratuito não há cobrança.')),
      accordion('Por campanha', false, bars(usage.by_campaign, usage.totals.total_tokens)),
      accordion('Por tipo de uso', false, bars(usage.by_kind, usage.totals.total_tokens)),
      accordion('Últimos 30 dias', false, dayChart(usage.by_day)),
      ...(usage.by_model.length > 1 ? [accordion('Por modelo', false, bars(usage.by_model, usage.totals.total_tokens))] : []),
    );
    showError(el('usage-error'), null);
  } catch (err) {
    showError(el('usage-error'), err);
  }
}

export function initUsage() {
  el('usage-periods').append(...PERIODS.map(([value, label]) =>
    h('button', { type: 'button', dataset: { period: value }, onclick: () => { period = value; renderUsage(); } }, label)));
}
