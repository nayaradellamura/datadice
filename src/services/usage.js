// Consumo da chave de cada jogador: por dia, campanha, tipo de uso e modelo, com custo estimado.

// Preço pago em US$ por 1 milhão de tokens (entrada, saída), conferido em novembro de 2026.
// No plano gratuito não há cobrança; o valor serve para quem ativou o faturamento.
export const PRICES = {
  'gemini-3.5-flash-lite': { input: 0.30, output: 2.50 },
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.50 },
  'gemini-3.6-flash': { input: 0.75, output: 3.75 },
};

export const KIND_LABELS = {
  turn: 'Conversa com o Mestre',
  roll: 'Reação às rolagens',
  session: 'Abertura de sessão',
  summary: 'Resumos automáticos',
  campaign: 'Criação de campanha',
};

export const PERIODS = { today: 'Hoje', 7: '7 dias', 30: '30 dias', all: 'Tudo' };


/**
 * O Google zera o limite diário à meia-noite do Pacífico. Devolve esse instante (em UTC) e o próximo,
 * para contar os pedidos de "hoje" do mesmo jeito que o Google conta.
 */
export function quotaDay(now = new Date()) {
  // Data e hora "de parede" no Pacífico, sem depender do fuso do servidor.
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now).map(({ type, value }) => [type, Number(value)]));
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offset = wall - Math.floor(now.getTime() / 1000) * 1000; // ex.: -8h no inverno do Pacífico
  const start = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) - offset);
  return { start, next: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/** Início do período em horário de Brasília ("hoje" = desde a meia-noite de Brasília). */
function periodStart(period, now) {
  if (period === 'all') return null;
  const days = period === 'today' ? 0 : Number(period) - 1;
  const brasilia = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  brasilia.setUTCHours(0, 0, 0, 0);
  return new Date(brasilia.getTime() + 3 * 60 * 60 * 1000 - days * 24 * 60 * 60 * 1000);
}

const cost = (model, prompt, completion) => {
  const price = PRICES[model];
  return price ? (prompt * price.input + completion * price.output) / 1e6 : null;
};

function emptyTotals() {
  return { calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0, cost_known: true };
}

function add(target, row) {
  target.calls += row.calls;
  target.prompt_tokens += row.prompt_tokens;
  target.completion_tokens += row.completion_tokens;
  target.total_tokens += row.total_tokens;
  const value = cost(row.model_name, row.prompt_tokens, row.completion_tokens);
  if (value === null) target.cost_known = false;
  else target.cost_usd += value;
}

function groupBy(rows, keyOf, labelOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, { key, label: labelOf(row), ...emptyTotals() });
    add(groups.get(key), row);
  }
  return [...groups.values()].sort((a, b) => b.total_tokens - a.total_tokens);
}

export async function userUsage(db, userId, period = '30', now = new Date()) {
  if (!Object.hasOwn(PERIODS, period)) period = '30';
  const start = periodStart(period, now);
  // "Tudo" começa no ano 2000: mesma consulta, sem montar SQL diferente por período.
  const rows = await db.all(
    `SELECT t.campaign_id, c.name AS campaign_name, t.kind, t.model_name,
            COUNT(*) AS calls, SUM(t.prompt_tokens) AS prompt_tokens,
            SUM(t.completion_tokens) AS completion_tokens, SUM(t.total_tokens) AS total_tokens
     FROM token_logs t LEFT JOIN campaigns c ON c.id = t.campaign_id
     WHERE t.user_id = ? AND t."timestamp" >= ?
     GROUP BY t.campaign_id, c.name, t.kind, t.model_name`,
    userId, start ?? new Date('2000-01-01T00:00:00Z'),
  );

  const totals = emptyTotals();
  for (const row of rows) add(totals, row);

  // Gráfico: sempre os últimos 30 dias, agrupados pelo dia de Brasília.
  const days = await db.all(
    `SELECT to_char("timestamp" AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS day, model_name, COUNT(*) AS calls,
            SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens, SUM(total_tokens) AS total_tokens
     FROM token_logs WHERE user_id = ? AND "timestamp" >= ?
     GROUP BY day, model_name ORDER BY day`,
    userId, periodStart('30', now),
  );

  const { start: quotaStart, next } = quotaDay(now);
  const today = await db.get(
    `SELECT COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0) AS tokens
     FROM token_logs WHERE user_id = ? AND "timestamp" >= ?`,
    userId, quotaStart,
  );

  return {
    period,
    quota: { requests: today.requests, tokens: today.tokens, resets_at: next.toISOString() },
    totals,
    by_day: groupBy(days, (row) => row.day, (row) => row.day).sort((a, b) => a.key.localeCompare(b.key)),
    by_campaign: groupBy(rows, (row) => row.campaign_id ?? 0, (row) => row.campaign_name ?? 'Sem campanha (registros antigos)'),
    by_kind: groupBy(rows, (row) => row.kind ?? 'old', (row) => KIND_LABELS[row.kind] ?? 'Registros antigos'),
    by_model: groupBy(rows, (row) => row.model_name, (row) => row.model_name),
  };
}
