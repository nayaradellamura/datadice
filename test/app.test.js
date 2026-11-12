import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createApp } from '../src/app.js';
import { freshDb } from './db.js';
import { addUser, authHeaders, SECRET } from './helpers.js';
import { listCreatureNames, searchRules } from '../src/services/memory.js';

const usage = { prompt: 100, completion: 20, total: 120 };
let db, server, base, llm, app, backgroundErrors, user;

const turn = (overrides = {}) => ({
  data: { narration: 'A taverna silencia.', state_changes: [], memory_updates: [], ...overrides },
  usage,
  model: 'fake',
});

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: authHeaders(user.token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function setup() {
  const character = (await api('POST', '/api/characters', { name: 'Lia', race: 'Elfa', class: 'Ladina', con: 14, dex: 16 })).body;
  const campaign = (await api('POST', '/api/campaigns', { name: 'Vale', world_description: 'Um vale sombrio.' })).body;
  await api('POST', '/api/campaigns/join', { campaign_id: campaign.id, character_id: character.id });
  return { character, campaign };
}

const say = (ctx, message) =>
  api('POST', '/api/chat', { campaign_id: ctx.campaign.id, character_id: ctx.character.id, message });

before(async () => {
  llm = { calls: [], responder: () => turn(), async generateJson(prompt) { this.calls.push(prompt); return this.responder(prompt); } };
});

beforeEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  llm.calls = [];
  llm.responder = () => turn();
  backgroundErrors = [];
  db = await freshDb();
  user = await addUser(db, { role: 'admin' });
  app = createApp({ db, llm, jwtSecret: SECRET, onBackgroundError: (err) => backgroundErrors.push(err) });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

test('valida a criação de personagem e calcula o HP pela CON', async () => {
  assert.equal((await api('POST', '/api/characters', { race: 'x', class: 'y' })).status, 400);
  assert.equal((await api('POST', '/api/characters', { name: 'a', race: 'x', class: 'y', str: 99 })).status, 400);
  const { campaign } = await setup();
  const state = (await api('GET', `/api/campaigns/${campaign.id}/state`)).body;
  assert.equal(state.party[0].max_hp, 10);
  assert.equal((await api('POST', '/api/campaigns/join', { campaign_id: campaign.id, character_id: state.party[0].character_id })).status, 409);
});

test('o turno salva o histórico, aplica o estado e soma os tokens', async () => {
  const ctx = await setup();
  let call = 0;
  llm.responder = () => {
    call += 1;
    return call === 1
      ? turn({ narration: '', gm_rolls: [{ label: 'Dano da armadilha', dice: '1d6' }] })
      : turn({ state_changes: [{ character_id: ctx.character.id, hp_delta: -5, inventory_add: ['Chave'], inventory_remove: [] }] });
  };

  const { status, body } = await say(ctx, 'Abro o baú');
  assert.equal(status, 200);
  assert.equal(body.party[0].current_hp, 5);
  assert.deepEqual(body.party[0].inventory, ['Chave']);

  const messages = (await api('GET', `/api/campaigns/${ctx.campaign.id}/messages`)).body;
  assert.deepEqual(messages.map((m) => m.sender_type), ['player', 'system', 'gm']);
  assert.equal((await api('GET', '/api/tokens/usage')).body.total_tokens, 240);
});

test('o HP fica entre 0 e o máximo, e outro personagem da mesma resposta é ignorado se estiver fora da campanha', async () => {
  const ctx = await setup();
  llm.responder = () =>
    turn({
      state_changes: [
        { character_id: ctx.character.id, hp_delta: -999, inventory_add: [], inventory_remove: [] },
        { character_id: 12345, hp_delta: -1, inventory_add: [], inventory_remove: [] },
      ],
    });
  let body = (await say(ctx, 'Salto')).body;
  assert.equal(body.party[0].current_hp, 0);
  assert.equal(body.party[0].status, 'unconscious');

  llm.responder = () => turn({ state_changes: [{ character_id: ctx.character.id, hp_delta: 999, inventory_add: [], inventory_remove: [] }] });
  body = (await say(ctx, 'Bebo a poção')).body;
  assert.equal(body.party[0].current_hp, 10);
  assert.equal(body.party[0].status, 'active');
});

test('uma falha do modelo não salva nada', async () => {
  const ctx = await setup();
  llm.responder = () => { throw Object.assign(new Error('fora do ar'), { status: 503 }); };
  assert.equal((await say(ctx, 'Olá')).status, 503);
  assert.equal((await api('GET', `/api/campaigns/${ctx.campaign.id}/messages`)).body.length, 0);
});

test('um NPC do primeiro turno volta ao prompt muitos turnos depois, quando é citado', async () => {
  const ctx = await setup();
  llm.responder = () =>
    turn({ memory_updates: [{ type: 'npc', name: 'Rurik', content: 'Ferreiro caolho que deve um favor a Lia.', importance: 3, status: 'active' }] });
  await say(ctx, 'Falo com o ferreiro');

  llm.responder = () => turn();
  for (let i = 0; i < 40; i += 1) {
    await say(ctx, `Caminho pela estrada ${i}`);
    await app.locals.gameMaster.waitForBackground();
  }

  const unrelated = llm.calls.filter((call) => !call.schema.properties.summary).at(-1).system;
  assert.ok(!unrelated.includes('Ferreiro caolho'), 'memória comum não deve ocupar todos os prompts');
  assert.ok(unrelated.includes('npc: Rurik'), 'o índice mantém o nome conhecido');

  await say(ctx, 'Procuro o rurik na forja');
  const cited = llm.calls.filter((call) => !call.schema.properties.summary).at(-1).system;
  assert.ok(cited.includes('Ferreiro caolho que deve um favor a Lia.'));
});

test('toda a conversa continua no banco depois do resumo', async () => {
  const ctx = await setup();
  llm.responder = (prompt) =>
    prompt.schema.properties.summary ? { data: { summary: 'Resumo.', memory_updates: [] }, usage, model: 'fake' } : turn();
  for (let i = 0; i < 30; i += 1) {
    await say(ctx, `Ação ${i}`);
    await app.locals.gameMaster.waitForBackground();
  }
  assert.ok((await db.get('SELECT last_message_id AS id FROM campaign_summaries')).id > 0);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM messages')).n, 60);
});

test('com dúvida, o Mestre consulta o histórico e responde com base no registro', async () => {
  const ctx = await setup();
  llm.responder = () => turn({ narration: 'A bruxa Morwen exige o anel de prata como pagamento.' });
  await say(ctx, 'Faço um pacto com a bruxa');

  llm.responder = () => turn();
  for (let i = 0; i < 30; i += 1) await say(ctx, `Caminho pela estrada ${i}`);

  const before = llm.calls.length;
  let round = 0;
  llm.responder = () => {
    round += 1;
    return round === 1 ? turn({ narration: '', lookup_queries: ['pacto bruxa'] }) : turn({ narration: 'Morwen quer o anel.' });
  };
  const { status, body } = await say(ctx, 'O que eu prometi mesmo?');

  assert.equal(status, 200);
  assert.equal(body.narration, 'Morwen quer o anel.');
  assert.equal(body.tokens.turn.total, 240);
  const second = llm.calls[before + 1].system;
  assert.ok(second.includes('RESULTADO DA CONSULTA'));
  assert.ok(second.includes('anel de prata'));
});

test('sem registro, o Mestre é avisado, e as consultas têm limite', async () => {
  const ctx = await setup();
  const before = llm.calls.length;
  llm.responder = () => turn({ narration: 'Ninguém conhece esse nome.', lookup_queries: ['zxqwv'] });
  const { status } = await say(ctx, 'Procuro o Zxqwv');
  assert.equal(status, 200);
  assert.equal(llm.calls.length - before, 5);
  assert.ok(llm.calls.at(-1).system.includes('NENHUM REGISTRO ENCONTRADO'));
  assert.ok(llm.calls.at(-1).system.includes('As consultas deste turno acabaram'));
});

test('fatos fixados ou importantes entram em todo turno', async () => {
  const ctx = await setup();
  await api('POST', `/api/campaigns/${ctx.campaign.id}/memories`, {
    type: 'fact', name: 'Segredo', content: 'O rei é um impostor.', importance: 2, pinned: true,
  });
  await say(ctx, 'Observo as nuvens');
  assert.ok(llm.calls.at(-1).system.includes('O rei é um impostor.'));
});

test('a busca ignora acentos e aceita caracteres especiais', async () => {
  const ctx = await setup();
  await api('POST', `/api/campaigns/${ctx.campaign.id}/memories`, {
    type: 'location', name: 'Torre de Ébano', content: 'Guardada por dragões.', importance: 2,
  });
  await say(ctx, 'Sigo para a torre de ebano');
  assert.ok(llm.calls.at(-1).system.includes('Guardada por dragões.'));

  await say(ctx, 'Vejo um dragao');
  assert.ok(llm.calls.at(-1).system.includes('Guardada por dragões.'));

  assert.equal((await say(ctx, `"* OR NEAR( ' -- :^`)).status, 200);
});

test('o modelo não apaga o que você escreveu, só acrescenta', async () => {
  const ctx = await setup();
  await api('POST', `/api/campaigns/${ctx.campaign.id}/memories`, {
    type: 'npc', name: 'Mira', content: 'Irmã perdida de Lia.', importance: 5,
  });
  llm.responder = () => turn({ memory_updates: [{ type: 'npc', name: ' MIRA ', content: 'Vista no porto.', importance: 1, status: 'active' }] });
  await say(ctx, 'Pergunto por ela');

  const [memory] = (await api('GET', `/api/campaigns/${ctx.campaign.id}/memories`)).body;
  assert.match(memory.content, /Irmã perdida de Lia\./);
  assert.match(memory.content, /Vista no porto\./);
  assert.equal(memory.importance, 5);
});

test('memórias inválidas do modelo são ignoradas', async () => {
  const ctx = await setup();
  llm.responder = () =>
    turn({ memory_updates: [{ type: 'alien', name: 'X', content: 'y' }, { type: 'npc', name: '', content: 'y' }, null] });
  assert.equal((await say(ctx, 'Oi')).status, 200);
  assert.equal((await api('GET', `/api/campaigns/${ctx.campaign.id}/memories`)).body.length, 0);
});

test('o resumo avança, e a crônica entra nos turnos seguintes', async () => {
  const ctx = await setup();
  llm.responder = (prompt) =>
    prompt.schema.properties.summary
      ? { data: { summary: 'Lia fez um pacto com a bruxa.', memory_updates: [] }, usage, model: 'fake' }
      : turn();

  for (let i = 0; i < 21; i += 1) {
    await say(ctx, `Ação ${i}`);
    await app.locals.gameMaster.waitForBackground();
  }
  const summary = (await db.get('SELECT * FROM campaign_summaries'));
  assert.equal(summary.summary_text, 'Lia fez um pacto com a bruxa.');
  assert.ok(summary.last_message_id >= 20);

  await say(ctx, 'Sigo em frente');
  assert.ok(llm.calls.at(-1).system.includes('Lia fez um pacto com a bruxa.'));
});

test('se o resumo falhar, o chat segue e nenhuma mensagem sai do contexto', async () => {
  const ctx = await setup();
  llm.responder = (prompt) => {
    if (prompt.schema.properties.summary) throw new Error('falha no resumo');
    return turn();
  };
  for (let i = 0; i < 25; i += 1) {
    assert.equal((await say(ctx, `Ação ${i}`)).status, 200);
    await app.locals.gameMaster.waitForBackground();
  }
  assert.ok(backgroundErrors.length > 0);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM campaign_summaries')).n, 0);

  const turnCalls = llm.calls.filter((call) => !call.schema.properties.summary);
  const text = JSON.stringify(turnCalls.at(-1).contents);
  assert.ok(text.includes('Ação 0'), 'a mensagem mais antiga ainda não resumida continua no contexto');
});

test('a rolagem de dados é feita pelo servidor e entra no contexto do Mestre', async () => {
  const ctx = await setup();
  const url = `/api/campaigns/${ctx.campaign.id}/roll`;
  const roll = await api('POST', url, { character_id: ctx.character.id, kind: 'attribute', key: 'dex' });
  assert.equal(roll.status, 201);
  assert.match(roll.body.message_text, /Lia rolou Destreza: \d+ \+ 3 = \d+/);
  assert.equal((await api('POST', url, { character_id: ctx.character.id, kind: 'attribute', key: 'toString' })).status, 400);

  const advantage = await api('POST', url, { character_id: ctx.character.id, kind: 'skill', key: 'furtividade', mode: 'advantage' });
  assert.match(advantage.body.message_text, /Furtividade \(com vantagem: \d+ e \d+\)/);
  const damage = await api('POST', url, { character_id: ctx.character.id, kind: 'dice', expression: '2d6+3' });
  assert.match(damage.body.message_text, /2d6 \+ 3: \[\d, \d\] \+ 3 = \d+/);
  assert.equal((await api('POST', url, { character_id: ctx.character.id, kind: 'dice', expression: '9d7' })).status, 400);

  await say(ctx, 'Tento abrir a fechadura');
  assert.ok(JSON.stringify(llm.calls.at(-1).contents).includes('[Sistema] Lia rolou'));
});

test('a ficha calcula os valores derivados da 5e', async () => {
  const { status, body } = await api('POST', '/api/characters', {
    name: 'Bren', race: 'Humano', class: 'Mago', level: 5, int: 18, dex: 14, con: 12, wis: 13,
    sheet: { skill_proficiencies: ['arcanismo', 'percepcao', 'invalida'], spell_slots: { 1: 4 }, spells: { 1: [{ name: 'Escudo', prepared: true }] } },
  });
  assert.equal(status, 201);
  const { derived, sheet } = body;
  assert.equal(derived.proficiency_bonus, 3);
  assert.equal(derived.modifiers.int, 4);
  assert.equal(derived.saves.int, 7, 'Mago é proficiente em salvaguarda de INT');
  assert.equal(derived.skills.arcanismo, 7);
  assert.equal(derived.passive_perception, 14);
  assert.equal(derived.spell_save_dc, 15);
  assert.equal(derived.spell_attack, 7);
  assert.equal(body.armor_class, 12);
  assert.equal(body.hit_die, 6);
  assert.equal(body.max_hp, 27, '6+1 no 1º nível, mais 4 x (4+1)');
  assert.deepEqual(sheet.skill_proficiencies, ['arcanismo', 'percepcao']);
});

test('valores digitados na ficha substituem o cálculo e valem nas rolagens', async () => {
  const body = {
    name: 'Kai', race: 'Humano', class: 'Ladino', level: 1, dex: 16, wis: 12,
    sheet: {
      skill_proficiencies: ['furtividade'],
      overrides: {
        modifiers: { dex: '+4' }, saves: { wis: '5' }, skills: { furtividade: '+9', percepcao: '' },
        proficiency_bonus: '3', initiative: '+6', passive_perception: '15',
      },
    },
  };
  const { status, body: created } = await api('POST', '/api/characters', body);
  assert.equal(status, 201);
  const { derived } = created;
  assert.equal(derived.modifiers.dex, 4);
  assert.equal(derived.saves.dex, 4 + 3, 'Ladino é proficiente em DES; usa o modificador e a proficiência digitados');
  assert.equal(derived.saves.wis, 5);
  assert.equal(derived.skills.furtividade, 9);
  assert.equal(derived.skills.acrobacia, 4, 'perícia sem valor manual usa o modificador digitado');
  assert.equal(derived.skills.percepcao, 1, 'campo vazio continua automático');
  assert.equal(derived.initiative, 6);
  assert.equal(derived.passive_perception, 15);
  assert.equal(created.sheet.overrides.skills.percepcao, undefined, 'campo vazio não é gravado');

  const campaign = (await api('POST', '/api/campaigns', { name: 'C' })).body;
  await api('POST', '/api/campaigns/join', { campaign_id: campaign.id, character_id: created.id });
  const roll = await api('POST', `/api/campaigns/${campaign.id}/roll`, { character_id: created.id, kind: 'skill', key: 'furtividade' });
  assert.match(roll.body.message_text, /Furtividade: \d+ \+ 9 = \d+/);

  for (const overrides of [{ skills: { furtividade: 'abc' } }, { proficiency_bonus: 99 }, { modifiers: { dex: 1.5 } }]) {
    assert.equal((await api('POST', '/api/characters', { ...body, sheet: { overrides } })).status, 400, JSON.stringify(overrides));
  }
});

test('subir de nível atualiza os PV também na campanha', async () => {
  const ctx = await setup();
  const updated = await api('PUT', `/api/characters/${ctx.character.id}`, { name: 'Lia', race: 'Elfa', class: 'Ladina', level: 2, con: 14, dex: 16 });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.max_hp, 17);
  const { party } = (await api('GET', `/api/campaigns/${ctx.campaign.id}/state`)).body;
  assert.equal(party[0].max_hp, 17);
  assert.equal(party[0].current_hp, 17);
});

test('o Mestre aplica moedas, magias, condições, XP, e o dano consome primeiro os PV temporários', async () => {
  const ctx = await setup();
  await api('PUT', `/api/characters/${ctx.character.id}`, {
    name: 'Lia', race: 'Elfa', class: 'Ladina', con: 14, dex: 16, sheet: { spell_slots: { 1: 2 } },
  });
  await api('PATCH', `/api/campaigns/${ctx.campaign.id}/characters/${ctx.character.id}`, { temp_hp: 3 });
  llm.responder = () =>
    turn({
      state_changes: [{
        character_id: ctx.character.id, hp_delta: -5, coins_delta: { po: 12, pc: -5 },
        conditions_add: ['Envenenado'], spell_slots_used: [{ level: 1, count: 9 }], xp_gain: 50, inspiration: true,
      }],
    });
  const [member] = (await say(ctx, 'Luto')).body.party;
  assert.equal(member.temp_hp, 0);
  assert.equal(member.current_hp, 8);
  assert.equal(member.coins.po, 12);
  assert.equal(member.coins.pc, 0);
  assert.deepEqual(member.conditions, ['Envenenado']);
  assert.equal(member.spell_slots_used[1], 2, 'nunca passa do total da ficha');
  assert.equal(member.xp, 50);
  assert.equal(member.inspiration, 1);
});

test('o equipamento e as moedas da ficha iniciam o estado na campanha', async () => {
  const character = (await api('POST', '/api/characters', {
    name: 'Rui', race: 'Anão', class: 'Clérigo', sheet: { equipment: 'Maça\nEscudo\n', coins: { po: 15 } },
  })).body;
  const campaign = (await api('POST', '/api/campaigns', { name: 'C' })).body;
  const { party } = (await api('POST', '/api/campaigns/join', { campaign_id: campaign.id, character_id: character.id })).body;
  assert.deepEqual(party[0].inventory, ['Maça', 'Escudo']);
  assert.equal(party[0].coins.po, 15);
});

test('a salvaguarda contra a morte só vale com 0 PV e o resultado é salvo', async () => {
  const ctx = await setup();
  const url = `/api/campaigns/${ctx.campaign.id}/roll`;
  assert.equal((await api('POST', url, { character_id: ctx.character.id, kind: 'death' })).status, 400);
  await api('PATCH', `/api/campaigns/${ctx.campaign.id}/characters/${ctx.character.id}`, { current_hp: 0 });
  const { status, body } = await api('POST', url, { character_id: ctx.character.id, kind: 'death' });
  assert.equal(status, 201);
  const member = body.party[0];
  assert.ok(member.death_successes + member.death_failures > 0 || member.current_hp === 1);
});

test('com dúvida de regra, o Mestre consulta os livros', async () => {
  const ctx = await setup();
  (await db.run('INSERT INTO rule_chunks (book, page, text) VALUES (?, ?, ?)', 'Livro do Jogador', 290, 'AGARRADO o deslocamento da criatura se torna 0.'));
  let round = 0;
  llm.responder = () => {
    round += 1;
    return round === 1 ? turn({ narration: '', rule_queries: ['condição agarrado'] }) : turn({ narration: 'Você não consegue se mover.' });
  };
  const { body } = await say(ctx, 'Tento fugir do ogro que me agarrou');
  assert.equal(body.narration, 'Você não consegue se mover.');
  const system = llm.calls.at(-1).system;
  assert.ok(system.includes('[Livro do Jogador, pág. do PDF 290] AGARRADO'));
});

test('a busca nos livros prioriza o título e entende os termos da ficha', async () => {
  const insert = (...args) => db.run('INSERT INTO rule_chunks (book, page, text) VALUES (?, ?, ?)', ...args);
  await insert('L', 1, 'O mago lança bola de fogo várias vezes, fogo e fogo e mais fogo, bola e bola.');
  await insert('L', 2, 'Texto anterior. BOLA DE FOGO 3° nível de evocação. Um clarão explode');
  await insert('L', 3, 'causando 8d6 de dano de fogo.');
  await insert('L', 4, 'Você faz um teste de resistência contra a morte com 0 pontos de vida.');

  const [first] = (await searchRules(db, ['magia bola de fogo']));
  assert.ok(first.text.startsWith('BOLA DE FOGO'));
  assert.ok(first.text.includes('8d6'), 'emenda o trecho seguinte');

  const [death] = (await searchRules(db, ['salvaguarda contra a morte']));
  assert.equal(death.page, 4);
  assert.deepEqual((await searchRules(db, ['"* NEAR( --'])), []);
});

test('a busca de criaturas usa palavra inteira e prioriza a ficha', async () => {
  const insert = (...args) => db.run('INSERT INTO rule_chunks (book, page, text) VALUES (?, ?, ?)', ...args);
  await insert('L', 1, 'GLOBO DE INVULNERABILIDADE 6° nível de abjuração.');
  await insert('M', 2, 'LOBOS Os lobos caçam em bando pelas florestas do norte.');
  await insert('M', 3, 'Texto. LOBO Besta Média, imparcial Classe de Armadura 13 Pontos de Vida 11');
  await insert('M', 4, 'Mordida. Ataque Corpo-a-Corpo: +4 para atingir.');
  await insert('M', 5, 'CHEFE ORC Humanoide Médio Classe de Armadura 16');
  await insert('M', 6, 'ORC Humanoide Médio Classe de Armadura 13');
  await insert('M', 7, 'OBSERVADOR Aberração Grande Classe de Armadura 18');

  const wolves = (await searchRules(db, ['lobo']));
  assert.ok(wolves[0].text.startsWith('LOBO Besta'));
  assert.ok(wolves[0].text.includes('Mordida'), 'a ficha vem com o trecho seguinte');
  assert.ok(!wolves.some((row) => row.text.includes('GLOBO')));

  assert.ok((await searchRules(db, ['estatísticas do orc']))[0].text.startsWith('ORC Humanoide'));
  assert.ok((await searchRules(db, ['beholder']))[0].text.startsWith('OBSERVADOR'));

  await insert('M', 8, 'Fim da ficha. OGRO ZUMBI Morto-vivo Grande Classe de Armadura 8');
  assert.ok((await searchRules(db, ['zumbi']))[0].text.startsWith('OGRO ZUMBI'), 'a variante mantém o nome completo');
});

test('o sistema rola os dados do Mestre, devolve o resultado e registra no chat', async () => {
  const ctx = await setup();
  let call = 0;
  llm.responder = () => {
    call += 1;
    return call === 1
      ? turn({ narration: '', gm_rolls: [{ label: 'Goblin ataca Lia', dice: '1d20+4', mode: 'advantage' }, { label: 'Erro', dice: 'muitos' }] })
      : turn({ narration: 'A lâmina passa perto.' });
  };
  const { body } = await say(ctx, 'Avanço');

  assert.equal(body.rolls.length, 1, 'expressão inválida não vai para o chat');
  assert.match(body.rolls[0], /^Mestre rolou Goblin ataca Lia \(com vantagem: \d+ e \d+\): \d+ \+ 4 = \d+/);
  const second = llm.calls[1].system;
  assert.ok(second.includes('ROLAGENS FEITAS PELO SISTEMA'));
  assert.ok(second.includes(body.rolls[0]), 'o Mestre recebe exatamente o resultado do sistema');
  assert.ok(second.includes('Expressão inválida'));

  const messages = (await api('GET', `/api/campaigns/${ctx.campaign.id}/messages`)).body;
  assert.deepEqual(messages.map((m) => m.sender_type), ['player', 'system', 'gm']);
});

test('dano sem rolagem é cobrado do Mestre; se ele insistir, o chat mostra um aviso', async () => {
  const ctx = await setup();
  llm.responder = () => turn({ state_changes: [{ character_id: ctx.character.id, hp_delta: -2 }] });
  const { body } = await say(ctx, 'Luto');
  assert.equal(llm.calls.length, 2, 'cobra uma vez');
  assert.match(body.warning, /sem uma rolagem registrada/);
  const messages = (await api('GET', `/api/campaigns/${ctx.campaign.id}/messages`)).body;
  assert.match(messages.at(-1).message_text, /sem uma rolagem registrada/);
});

test('busca sem correspondência real fica marcada como parcial', async () => {
  const ctx = await setup();
  (await db.run('INSERT INTO rule_chunks (book, page, text) VALUES (?, ?, ?)', 'M', 1, 'A besta rugiu na floresta.'));
  const [hit] = (await searchRules(db, ['displacer beast besta']));
  assert.equal(hit.partial, true);

  let round = 0;
  llm.responder = () => {
    round += 1;
    return round === 1 ? turn({ narration: '', rule_queries: ['besta deslocadora', 'displacer beast'] }) : turn();
  };
  await say(ctx, 'Enfrento a criatura');
  const { system } = llm.calls.at(-1);
  assert.ok(system.includes('CORRESPONDÊNCIA PARCIAL') && system.includes('NADA CONFIRMADO NOS LIVROS'));
});

test('a ficha de criatura vem inteira e termina antes da próxima', async () => {
  const insert = (...args) => db.run('INSERT INTO rule_chunks (book, page, text) VALUES (?, ?, ?)', ...args);
  const action = 'Ação lendária final do dragão. ';
  await insert('M', 1, `DRAGÃO VELHO Dragão Enorme Classe de Armadura 22 Pontos de Vida 546 ${'Sopro de fogo. '.repeat(90)}`);
  await insert('M', 1, `AÇÕES ${'Mordida poderosa. '.repeat(75)}`);
  await insert('M', 2, `AÇÕES LENDÁRIAS ${'Garra afiada. '.repeat(100)}${action}`);
  await insert('M', 2, `${'Cauda longa. '.repeat(50)}${action}`);
  await insert('M', 2, '123 SAPOS Os sapos vivem em pântanos e coaxam à noite. SAPO Besta Miúda Classe de Armadura 11 Pontos de Vida 1 Coaxa.');

  const [dragon] = (await searchRules(db, ['dragão velho']));
  assert.ok(dragon.text.length > 4000, 'sem corte fixo de 4000 caracteres');
  assert.ok(dragon.text.includes('AÇÕES LENDÁRIAS') && dragon.text.endsWith(action.trim()));
  assert.ok(!/SAPO|pântanos|Coaxa/.test(dragon.text), 'termina antes do próximo título');

  assert.ok((await listCreatureNames(db)).length === 0, 'só lê o Manual dos Monstros');
  (await db.run('INSERT INTO rule_chunks (book, page, text) VALUES (?, ?, ?)', 'Manual dos Monstros', 9, 'PANTERA DESLOCADORA Monstruosidade Grande, leal e mau Classe de Armadura 13 Pontos de Vida 85'));
  assert.deepEqual((await listCreatureNames(db)), ['pantera deslocadora']);
});

test('ficha fora de ordem no PDF: o Mestre recebe a página inteira e a seguinte', async () => {
  const insert = (...args) => db.run('INSERT INTO rule_chunks (book, page, text) VALUES (?, ?, ?)', ...args);
  await insert('Manual dos Monstros', 200, 'KRAKEN Abaixo das ondas, o kraken dorme por eras.');
  await insert('Manual dos Monstros', 200, 'Lenda dos marinheiros sobre o KRAKEN e seu covil.');
  await insert('Manual dos Monstros', 201, 'AÇÕES LENDÁRIAS Monstruosidade Imensa (titã) Classe de Armadura 18 Pontos de Vida 472 Tentáculo.');

  const results = (await searchRules(db, ['kraken']));
  const pages = results.filter((row) => row.text.includes('dorme por eras'));
  assert.equal(pages.length, 1, 'a mesma página não é enviada duas vezes');
  assert.ok(pages[0].text.includes('seu covil') && pages[0].text.includes('Classe de Armadura 18'));
  assert.ok((await listCreatureNames(db)).includes('kraken'));
  assert.ok(!(await listCreatureNames(db)).includes('ações lendárias'));
});

test('sem confirmação nos livros, o Mestre recebe os nomes de criaturas do manual', async () => {
  const ctx = await setup();
  (await db.run('INSERT INTO rule_chunks (book, page, text) VALUES (?, ?, ?)', 'Manual dos Monstros', 9, 'PANTERA DESLOCADORA Monstruosidade Grande, leal e mau Classe de Armadura 13 Pontos de Vida 85'));
  let round = 0;
  llm.responder = () => {
    round += 1;
    return round === 1 ? turn({ narration: '', rule_queries: ['displacer beast'] }) : turn();
  };
  await say(ctx, 'Observo a criatura');
  const { system } = llm.calls.at(-1);
  assert.ok(system.includes('NADA CONFIRMADO') && system.includes('pantera deslocadora'));
});

test('o estado na campanha pode ser ajustado à mão, e valores inválidos são recusados', async () => {
  const ctx = await setup();
  const url = `/api/campaigns/${ctx.campaign.id}/characters/${ctx.character.id}`;
  const { status, body } = await api('PATCH', url, {
    inventory: ['Corda', ' ', 'Tocha'], conditions: ['Caído'], coins: { po: 7 },
    spell_slots_used: { 1: 1 }, hit_dice_used: 1, inspiration: true, status: 'stable', current_hp: 0,
  });
  assert.equal(status, 200);
  const [member] = body.party;
  assert.deepEqual(member.inventory, ['Corda', 'Tocha']);
  assert.deepEqual(member.conditions, ['Caído']);
  assert.equal(member.coins.po, 7);
  assert.equal(member.spell_slots_used[1], 1);
  assert.equal(member.hit_dice_used, 1);
  assert.equal(member.inspiration, 1);
  assert.equal(member.status, 'stable');
  assert.equal((await api('PATCH', url, { current_hp: 999 })).status, 400);
  assert.equal((await api('PATCH', url, { status: 'voando' })).status, 400);
});

test('editar uma memória escrita pela IA a protege de ser substituída', async () => {
  const ctx = await setup();
  llm.responder = () => turn({ memory_updates: [{ type: 'npc', name: 'Rurik', content: 'Ferreiro.', importance: 3, status: 'active' }] });
  await say(ctx, 'Oi');
  const [memory] = (await api('GET', `/api/campaigns/${ctx.campaign.id}/memories`)).body;
  const edited = await api('PATCH', `/api/memories/${memory.id}`, { content: 'Ferreiro caolho.' });
  assert.equal(edited.body.source, 'user');

  llm.responder = () => turn({ memory_updates: [{ type: 'npc', name: 'Rurik', content: 'Mudou de vila.', importance: 3, status: 'active' }] });
  await say(ctx, 'Oi de novo');
  const [after] = (await api('GET', `/api/campaigns/${ctx.campaign.id}/memories`)).body;
  assert.match(after.content, /Ferreiro caolho\./);
  assert.match(after.content, /Mudou de vila\./);
});

test('editar a campanha vale no turno seguinte e preserva o histórico', async () => {
  const ctx = await setup();
  await say(ctx, 'Olá');
  const url = `/api/campaigns/${ctx.campaign.id}`;
  assert.equal((await api('PUT', url, { name: ' ' })).status, 400);
  assert.equal((await api('PUT', '/api/campaigns/9999', { name: 'X' })).status, 404);

  const { status, body } = await api('PUT', url, { name: 'Vale Novo', world_description: 'Um vale em chamas.', system_prompt: 'Tom sombrio.' });
  assert.equal(status, 200);
  assert.equal(body.name, 'Vale Novo');

  await say(ctx, 'Sigo em frente');
  const { system } = llm.calls.at(-1);
  assert.ok(system.includes('Vale Novo') && system.includes('Um vale em chamas.') && system.includes('Tom sombrio.'));
  assert.ok(!system.includes('Um vale sombrio.'));
  assert.equal((await api('GET', `${url}/messages`)).body.length, 4);
  assert.equal((await api('GET', `${url}/state`)).body.party.length, 1);
});

test('o Mestre reage à rolagem usando o valor gravado no servidor', async () => {
  const ctx = await setup();
  await say(ctx, 'Tento abrir a fechadura');
  const roll = (await api('POST', `/api/campaigns/${ctx.campaign.id}/roll`, { character_id: ctx.character.id, kind: 'skill', key: 'prestidigitacao' })).body;

  llm.responder = () => turn({ narration: 'A fechadura cede.' });
  const before = (await api('GET', `/api/campaigns/${ctx.campaign.id}/messages`)).body.length;
  const { status, body } = await api('POST', '/api/chat', { campaign_id: ctx.campaign.id, character_id: ctx.character.id, roll_id: roll.id, message: 'tirei 20!' });
  assert.equal(status, 200);
  assert.equal(body.narration, 'A fechadura cede.');

  const sent = JSON.stringify(llm.calls.at(-1).contents.at(-1));
  assert.ok(sent.includes(`[Rolagem] ${roll.message_text}`), 'usa o texto da rolagem gravada');
  assert.ok(!sent.includes('tirei 20'), 'ignora o que o navegador mandar junto');

  const after = (await api('GET', `/api/campaigns/${ctx.campaign.id}/messages`)).body;
  assert.equal(after.length, before + 1, 'grava só a resposta do Mestre, sem fala falsa do jogador');
  assert.equal(after.at(-1).sender_type, 'gm');

  const again = await api('POST', '/api/chat', { campaign_id: ctx.campaign.id, character_id: ctx.character.id, roll_id: roll.id });
  assert.equal(again.status, 409, 'a mesma rolagem não gera duas respostas');
});

test('rolagem de outra campanha ou mensagem que não é rolagem não é aceita', async () => {
  const ctx = await setup();
  await say(ctx, 'Oi');
  const messages = (await api('GET', `/api/campaigns/${ctx.campaign.id}/messages`)).body;
  const calls = llm.calls.length;
  for (const roll_id of [messages[0].id, messages[1].id, 99999, 'abc']) {
    const res = await api('POST', '/api/chat', { campaign_id: ctx.campaign.id, character_id: ctx.character.id, roll_id });
    assert.equal(res.status, 400, String(roll_id));
  }

  const other = (await api('POST', '/api/campaigns', { name: 'Outra' })).body;
  await api('POST', '/api/campaigns/join', { campaign_id: other.id, character_id: ctx.character.id });
  const foreign = (await api('POST', `/api/campaigns/${other.id}/roll`, { character_id: ctx.character.id, kind: 'plain' })).body;
  const res = await api('POST', '/api/chat', { campaign_id: ctx.campaign.id, character_id: ctx.character.id, roll_id: foreign.id });
  assert.equal(res.status, 400);
  assert.equal(llm.calls.length, calls, 'nenhuma chamada ao Gemini');
});

test('um personagem de fora da campanha não pode jogar', async () => {
  const ctx = await setup();
  const other = (await api('POST', '/api/characters', { name: 'Bo', race: 'Anão', class: 'Guerreiro' })).body;
  const res = await api('POST', '/api/chat', { campaign_id: ctx.campaign.id, character_id: other.id, message: 'Oi' });
  assert.equal(res.status, 400);
  assert.equal(llm.calls.length, 0);
});
