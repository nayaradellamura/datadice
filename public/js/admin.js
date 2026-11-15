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

/** Contador de pedidos de nova senha no menu Admin. */
export function setAdminBadge(count) {
  const badge = el('admin-badge');
  if (!badge) return;
  badge.textContent = count ? String(count) : '';
  badge.hidden = !count;
  badge.title = count ? `${count} pedido(s) de nova senha` : '';
  const hint = el('admin-menu-hint');
  if (hint) hint.textContent = count ? `${count} pedido(s) de nova senha esperando` : 'Contas e relatório geral';
}

export async function refreshAdminBadge() {
  try {
    setAdminBadge((await api('/admin/password-requests')).length);
  } catch {
    // Só um aviso: sem conexão agora, tenta de novo na próxima vez.
  }
}

const ago = (value) => {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 60) return minutes <= 1 ? 'agora há pouco' : `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `há ${hours} h` : `em ${new Date(value).toLocaleDateString('pt-BR')}`;
};

/** Pedidos de "Esqueci minha senha": gerar o link ou dispensar. */
function requestsCard(requests) {
  const card = h('div', { class: 'card reset-requests', id: 'admin-reset-requests' });
  const render = () => {
    if (!requests.length) {
      card.hidden = true;
      setAdminBadge(0);
      return;
    }
    setAdminBadge(requests.length);
    card.replaceChildren(
      h('h3', {}, `Pedidos de nova senha (${requests.length})`),
      h('p', { class: 'muted' }, 'Gere o link e mande para a pessoa (WhatsApp ou e-mail). Confira que é ela mesma antes de mandar.'),
      h('ul', { class: 'reset-request-list' }, requests.map((request) => h('li', {},
        h('span', {}, h('strong', {}, request.name), h('br'), h('span', { class: 'muted' }, `${request.email} · pediu ${ago(request.created_at)}`)),
        h('span', { class: 'reset-request-actions' },
          h('button', {
            type: 'button',
            class: 'primary',
            onclick: async () => {
              if (await makeResetLink(request)) {
                requests.splice(requests.indexOf(request), 1);
                render();
              }
            },
          }, 'Gerar link'),
          h('button', {
            type: 'button',
            onclick: async () => {
              try {
                await api(`/admin/password-requests/${request.id}`, { method: 'DELETE' });
                requests.splice(requests.indexOf(request), 1);
                render();
              } catch (err) {
                showError(el('admin-error'), err);
              }
            },
          }, 'Dispensar'))))));
  };
  render();
  return card;
}

/** Esqueci minha senha: o admin gera o link e manda para a pessoa (WhatsApp, por exemplo). */
async function makeResetLink(user) {
  const box = el('admin-reset-link');
  showError(el('admin-error'), null);
  try {
    const { token, expires_at: expiresAt } = await api(`/admin/users/${user.id}/password-reset`, { method: 'POST' });
    const link = `${location.origin}${location.pathname}#nova-senha=${token}`;
    const until = new Date(expiresAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const input = h('input', { readOnly: true, value: link, 'aria-label': `Link de nova senha de ${user.name}` });
    const copy = h('button', {
      type: 'button',
      class: 'primary',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(link);
          copy.textContent = 'Copiado';
        } catch {
          input.select();
        }
      },
    }, 'Copiar');
    box.replaceChildren(
      h('h3', {}, `Link de nova senha para ${user.name}`),
      h('p', { class: 'muted' }, `Mande só para ${user.email}. Vale até ${until} e funciona uma vez. Gerar outro cancela este.`),
      h('div', { class: 'reset-link' }, input, copy));
    box.hidden = false;
    box.scrollIntoView({ block: 'nearest' });
    return true;
  } catch (err) {
    showError(el('admin-error'), err);
    return false;
  }
}

const when = (value) => new Date(value).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * Atividade: o que cada conta fez (criar ficha, importar PDF, entrar...) e o que deu erro.
 * Filtra por conta e por "só erros"; carrega 100 por vez.
 */
function activityCard(users) {
  const list = h('ol', { class: 'activity-list', id: 'admin-activity' });
  const more = h('button', { type: 'button', class: 'small', hidden: true }, 'Carregar mais');
  const who = h('select', { 'aria-label': 'Conta' },
    h('option', { value: '' }, 'Todas as contas'),
    users.map((user) => h('option', { value: String(user.id) }, user.name)));
  const errorsOnly = h('input', { type: 'checkbox' });
  const status = h('p', { class: 'muted' });
  let last = null;

  const item = (row) => {
    const failed = row.status >= 400 || row.status === 0;
    return h('li', { class: failed ? 'failed' : '' },
      h('span', { class: 'activity-when' }, when(row.created_at)),
      h('span', { class: 'activity-what' },
        h('strong', {}, row.user_name ?? 'Sem conta'), ' ',
        row.action,
        row.detail && h('span', { class: 'muted' }, ` · ${row.detail}`),
        failed && h('span', { class: 'activity-error' }, row.status === 0 ? row.error : `Erro ${row.status}: ${row.error ?? ''}`)));
  };

  async function load(reset) {
    if (reset) {
      last = null;
      list.replaceChildren();
    }
    const query = new URLSearchParams();
    if (who.value) query.set('user', who.value);
    if (errorsOnly.checked) query.set('errors', '1');
    if (last) query.set('before', String(last));
    try {
      const { items, more: hasMore } = await api(`/admin/activity?${query}`);
      list.append(...items.map(item));
      last = items.at(-1)?.id ?? last;
      more.hidden = !hasMore;
      status.textContent = list.children.length ? '' : 'Nada registrado ainda.';
    } catch (err) {
      showError(el('admin-error'), err);
    }
  }
  who.addEventListener('change', () => load(true));
  errorsOnly.addEventListener('change', () => load(true));
  more.addEventListener('click', () => load(false));
  load(true);

  return h('div', { class: 'card activity-card' },
    h('h3', {}, 'Atividade'),
    h('p', { class: 'muted small-print' }, 'O que cada conta fez e o que deu erro, dos últimos 60 dias. Mensagens, rolagens e anotações só aparecem quando dão erro; o conteúdo delas nunca é gravado.'),
    h('div', { class: 'activity-filters' },
      h('label', {}, 'Conta', who),
      h('label', { class: 'check' }, errorsOnly, ' Só erros')),
    status,
    list,
    more);
}

/** Remove a conta, depois de confirmar o que vai junto. */
async function removeUser(user) {
  const parts = [
    `${number(user.characters)} personagem(ns)`,
    `${number(user.campaigns)} campanha(s) do Mestre IA`,
    `${number(user.tables)} mesa(s) em que é Mestre`,
  ];
  const tablesWarning = Number(user.tables) > 0 ? ' As mesas em que é Mestre acabam para todos os jogadores delas.' : '';
  const ok = window.confirm(
    `Remover a conta de ${user.name} (${user.email})?\n\nApaga junto: ${parts.join(', ')}.${tablesWarning}\n\nNão dá para desfazer.`,
  );
  if (!ok) return;
  showError(el('admin-error'), null);
  try {
    await api(`/admin/users/${user.id}`, { method: 'DELETE' });
    await renderAdmin();
  } catch (err) {
    showError(el('admin-error'), err);
  }
}

export async function renderAdmin() {
  try {
    const [stats, users, requests] = await Promise.all([api('/admin/stats'), api('/admin/users'), api('/admin/password-requests')]);
    el('admin-content').replaceChildren(
      // Pedidos pendentes primeiro, e o link gerado logo abaixo deles.
      requestsCard(requests),
      h('div', { class: 'card', id: 'admin-reset-link', hidden: true }),
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
          ['Visto', (row) => (row.last_seen_at ? ago(row.last_seen_at) : h('span', { class: 'muted' }, 'nunca'))],
          ['Personagens', (row) => number(row.characters)],
          ['Campanhas', (row) => number(row.campaigns)],
          ['Mesas', (row) => number(row.tables)],
          ['Tokens', (row) => number(row.total_tokens)],
          ['Papel', (row) => row.id === session.user?.id
            ? h('span', { class: 'role-badge admin' }, 'Admin (você)')
            : h('select', {
              'aria-label': `Papel de ${row.name}`,
              onchange: (event) => changeRole(row, event.target.value),
            },
            h('option', { value: 'player', selected: row.role === 'player' }, 'Jogador'),
            h('option', { value: 'admin', selected: row.role === 'admin' }, 'Admin'))],
          ['Senha', (row) => row.id === session.user?.id
            ? h('span', { class: 'muted' }, '—')
            : h('button', { type: 'button', class: 'small', onclick: () => makeResetLink(row) }, 'Link de nova senha')],
          ['Conta', (row) => row.id === session.user?.id
            ? h('span', { class: 'muted' }, '—')
            : h('button', { type: 'button', class: 'small danger', onclick: () => removeUser(row) }, 'Remover')],
        ], users)),
      activityCard(users),
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
