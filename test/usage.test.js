import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createApp } from '../src/app.js';
import { freshDb } from './db.js';
import { quotaDay, userUsage } from '../src/services/usage.js';
import { addUser, authHeaders, SECRET } from './helpers.js';

const usage = { prompt: 1000, completion: 200, total: 1200 };
let db, server, base, ana;

const turn = () => ({
  data: { narration: 'A cena continua.', state_changes: [], memory_updates: [], illustrations: [] },
  usage,
  model: 'gemini-3.5-flash-lite',
});

async function call(method, path, body, token = ana.token) {
  const res = await fetch(base + path, { method, headers: authHeaders(token), body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

async function campaignWithCharacter(name) {
  const character = (await call('POST', '/api/characters', { name: 'Lia', race: 'Elfo', class: 'Mago' })).body;
  const campaign = (await call('POST', '/api/campaigns', { name })).body;
  await call('POST', '/api/campaigns/join', { campaign_id: campaign.id, character_id: character.id });
  return { character, campaign };
}

beforeEach(async () => {
  db = await freshDb();
  const llm = { async generateJson() { return turn(); } };
  const app = createApp({ db, llm, jwtSecret: SECRET });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  ana = await addUser(db);
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

test('cada uso fica registrado com a campanha e o tipo: abertura, conversa e reação a rolagem', async () => {
  const vale = await campaignWithCharacter('Vale');
  const porto = await campaignWithCharacter('Porto');
  await call('POST', `/api/campaigns/${vale.campaign.id}/session`, { character_id: vale.character.id });
  await call('POST', '/api/chat', { campaign_id: vale.campaign.id, character_id: vale.character.id, message: 'Sigo' });
  const rolled = (await call('POST', `/api/campaigns/${vale.campaign.id}/roll`, { character_id: vale.character.id, kind: 'dice', expression: '1d20' })).body;
  await call('POST', '/api/chat', { campaign_id: vale.campaign.id, character_id: vale.character.id, roll_id: rolled.id });
  await call('POST', `/api/campaigns/${porto.campaign.id}/session`, { character_id: porto.character.id });

  const mine = (await call('GET', '/api/tokens/mine?period=all')).body;
  assert.equal(mine.totals.calls, 4);
  assert.equal(mine.totals.total_tokens, 4800);
  assert.deepEqual(mine.by_campaign.map((row) => [row.label, row.calls]), [['Vale', 3], ['Porto', 1]]);
  const kinds = Object.fromEntries(mine.by_kind.map((row) => [row.label, row.calls]));
  assert.deepEqual(kinds, { 'Abertura de sessão': 2, 'Conversa com o Mestre': 1, 'Reação às rolagens': 1 });
  assert.equal(mine.quota.requests, 4);
  assert.equal(mine.by_day.length, 1);

  // Custo estimado pelo preço do gemini-3.5-flash-lite: US$ 0,30 e 2,50 por milhão.
  assert.ok(mine.totals.cost_known);
  assert.ok(Math.abs(mine.totals.cost_usd - (4000 * 0.30 + 800 * 2.50) / 1e6) < 1e-12);
});

test('cada jogador vê só o próprio consumo', async () => {
  const vale = await campaignWithCharacter('Vale');
  await call('POST', '/api/chat', { campaign_id: vale.campaign.id, character_id: vale.character.id, message: 'Sigo' });
  const bia = await addUser(db);
  const theirs = (await call('GET', '/api/tokens/mine?period=all', undefined, bia.token)).body;
  assert.equal(theirs.totals.calls, 0);
  assert.deepEqual(theirs.by_campaign, []);
});

test('períodos: "hoje" ignora o que é de ontem; período inválido vira 30 dias', async () => {
  const user = await addUser(db);
  const insert = (...args) => db.run(`INSERT INTO token_logs (user_id, kind, model_name, prompt_tokens, completion_tokens, total_tokens, "timestamp")
                             VALUES (?, 'turn', 'modelo-sem-preco', 10, 5, 15, ?::timestamp AT TIME ZONE 'UTC')`, ...args);
  const now = new Date('2026-11-10T15:00:00Z'); // 12h em Brasília
  await insert(user.id, '2026-11-10 14:00:00'); // hoje, 11h em Brasília
  await insert(user.id, '2026-11-10 02:00:00'); // ontem, 23h em Brasília
  await insert(user.id, '2026-10-01 12:00:00'); // há mais de 30 dias

  assert.equal((await userUsage(db, user.id, 'today', now)).totals.calls, 1);
  assert.equal((await userUsage(db, user.id, '7', now)).totals.calls, 2);
  assert.equal((await userUsage(db, user.id, 'all', now)).totals.calls, 3);
  const fallback = (await userUsage(db, user.id, 'qualquer', now));
  assert.equal(fallback.period, '30');
  assert.equal(fallback.totals.calls, 2);
  // Modelo sem preço conhecido: o custo não é inventado.
  assert.equal(fallback.totals.cost_known, false);
});

test('o limite diário conta a partir da meia-noite do Pacífico, como o Google', async () => {
  // 10/11 às 15h UTC = 7h no Pacífico (PST, UTC-8): o dia do Google começou às 8h UTC.
  const { start, next } = quotaDay(new Date('2026-11-10T15:00:00Z'));
  assert.equal(start.toISOString(), '2026-11-10T08:00:00.000Z');
  assert.equal(next.toISOString(), '2026-11-11T08:00:00.000Z');
  // Às 5h UTC ainda é dia 9 no Pacífico.
  assert.equal(quotaDay(new Date('2026-11-10T05:00:00Z')).start.toISOString(), '2026-11-09T08:00:00.000Z');
});
