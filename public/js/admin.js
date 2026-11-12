import { api, h, session, showError } from './api.js';

const el = (id) => document.getElementById(id);
const number = (value) => Number(value ?? 0).toLocaleString('pt-BR');
const date = (value) => new Date(`${value.replace(' ', 'T')}Z`).toLocaleDateString('pt-BR');

function stat(label, value) {
  return h('div', { class: 'stat' }, h('b', {}, value), h('small', {}, label));
}

/** Tabela que vira lista de cartões no celular (cada célula leva o rótulo da coluna). */
function table(columns, rows) {
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'data-table' },
      h('thead', {}, h('tr', {}, columns.map(([label]) => h('th', { scope: 'col' }, label)))),
      h('tbody', {}, rows.map((row) =>
        h('tr', {}, columns.map(([label, render]) => h('td', { dataset: { label } }, render(row))))))));
}

export async function renderMetrics() {
  try {
    const metrics = await api('/tokens/metrics');
    const max = Math.max(1, ...metrics.by_day.map((day) => day.total_tokens));
    el('metrics-content').replaceChildren(
      h('div', { class: 'card' },
        h('h3', {}, 'Total do sistema'),
        h('div', { class: 'stat-grid' },
          stat('Tokens', number(metrics.totals.total_tokens)),
          stat('Entrada', number(metrics.totals.prompt_tokens)),
          stat('Saída', number(metrics.totals.completion_tokens)),
          stat('Chamadas', number(metrics.totals.calls)))),
      h('div', { class: 'card' },
        h('h3', {}, 'Últimos 30 dias'),
        metrics.by_day.length
          ? h('div', { class: 'day-bars' }, metrics.by_day.map((day) =>
            h('div', { class: 'day-bar', title: `${date(day.day)}: ${number(day.total_tokens)} tokens` },
              h('i', { style: `height:${Math.max(4, Math.round((day.total_tokens / max) * 100))}%` }),
              h('small', {}, day.day.slice(8, 10)))))
          : h('p', { class: 'muted' }, 'Nenhum consumo nos últimos 30 dias.')),
      h('div', { class: 'card' },
        h('h3', {}, 'Por jogador'),
        table([
          ['Jogador', (row) => h('span', {}, h('strong', {}, row.name), h('br'), h('span', { class: 'muted' }, row.email))],
          ['Tokens', (row) => number(row.total_tokens)],
          ['Entrada', (row) => number(row.prompt_tokens)],
          ['Saída', (row) => number(row.completion_tokens)],
          ['Chamadas', (row) => number(row.calls)],
        ], metrics.by_user)),
      h('div', { class: 'card' },
        h('h3', {}, 'Por modelo'),
        table([
          ['Modelo', (row) => row.model_name],
          ['Tokens', (row) => number(row.total_tokens)],
          ['Chamadas', (row) => number(row.calls)],
        ], metrics.by_model)),
    );
    showError(el('metrics-error'), null);
  } catch (err) {
    showError(el('metrics-error'), err);
  }
}

async function changeRole(user, role) {
  try {
    await api(`/admin/users/${user.id}`, { method: 'PATCH', body: { role } });
    await renderAdmin();
  } catch (err) {
    showError(el('admin-error'), err);
  }
}

export async function renderAdmin() {
  try {
    const [stats, users] = await Promise.all([api('/admin/stats'), api('/admin/users')]);
    el('admin-content').replaceChildren(
      h('div', { class: 'card' },
        h('h3', {}, 'Relatório do sistema'),
        h('div', { class: 'stat-grid' },
          stat('Jogadores', number(stats.users)),
          stat('Personagens', number(stats.characters)),
          stat('Campanhas', number(stats.campaigns)),
          stat('Mensagens', number(stats.messages)),
          stat('Imagens prontas', number(stats.images_ready)),
          stat('Imagens com falha', number(stats.images_failed)))),
      h('div', { class: 'card' },
        h('h3', {}, 'Contas'),
        table([
          ['Nome', (row) => h('span', {}, h('strong', {}, row.name), h('br'), h('span', { class: 'muted' }, row.email))],
          ['Desde', (row) => date(row.created_at)],
          ['Personagens', (row) => number(row.characters)],
          ['Campanhas', (row) => number(row.campaigns)],
          ['Tokens', (row) => number(row.total_tokens)],
          ['Papel', (row) => row.id === session.user?.id
            ? h('span', { class: 'role-badge admin' }, 'Admin (você)')
            : h('select', {
              'aria-label': `Papel de ${row.name}`,
              onchange: (event) => changeRole(row, event.target.value),
            },
            h('option', { value: 'player', selected: row.role === 'player' }, 'Jogador'),
            h('option', { value: 'admin', selected: row.role === 'admin' }, 'Admin'))],
        ], users)),
    );
    showError(el('admin-error'), null);
  } catch (err) {
    showError(el('admin-error'), err);
  }
}

export function initAdmin() {
  el('metrics-refresh').addEventListener('click', renderMetrics);
  el('admin-refresh').addEventListener('click', renderAdmin);
}
