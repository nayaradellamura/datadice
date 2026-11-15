import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { createApp } from '../src/app.js';
import { freshDb } from './db.js';
import { addUser, GEMINI_KEY, SECRET } from './helpers.js';

// Importar ficha em PDF: a oficial preenchível é lida sem IA; as outras vão para o Gemini do jogador.

/** PDF mínimo com campos de formulário de texto preenchidos (como uma ficha preenchível). */
function fillablePdf(fields) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const esc = (text) => String(text).replace(/[\\()]/g, (c) => `\\${c}`);
  const catalog = add(null);
  const pages = add(null);
  const page = add(null);
  const widgets = fields.map(([name, value], index) => add(
    `<< /Type /Annot /Subtype /Widget /FT /Tx /T (${esc(name)}) /V (${esc(value)}) /Rect [50 ${740 - index * 12} 250 ${750 - index * 12}] /P ${page} 0 R >>`,
  ));
  const refs = widgets.map((id) => `${id} 0 R`).join(' ');
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R /AcroForm << /Fields [${refs}] >> >>`;
  objects[pages - 1] = `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`;
  objects[page - 1] = `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Annots [${refs}] >>`;
  let out = '%PDF-1.7\n';
  const offsets = objects.map((body, index) => {
    const offset = Buffer.byteLength(out, 'latin1');
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * PDF com campos em posições escolhidas (x e y em % da página, a partir do canto superior esquerdo),
 * em várias páginas, com caixas de seleção. Imita o modelo brasileiro ("Iron").
 */
function layoutPdf(fields, pageCount = 3) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const esc = (text) => String(text).replace(/[\\()]/g, (c) => `\\${c}`);
  const catalog = add(null);
  const pages = add(null);
  const pageIds = Array.from({ length: pageCount }, () => add(null));
  const perPage = pageIds.map(() => []);
  const all = fields.map(({ name, value = '', page = 1, x, y, box = false }) => {
    const left = (x / 100) * 612;
    const top = 792 - (y / 100) * 792;
    const kind = box ? `/FT /Btn /V /${value ? 'Yes' : 'Off'} /AS /${value ? 'Yes' : 'Off'}` : `/FT /Tx /V (${esc(value)})`;
    const id = add(`<< /Type /Annot /Subtype /Widget ${kind} /T (${esc(name)}) /Rect [${left} ${top - 8} ${left + 30} ${top}] /P ${pageIds[page - 1]} 0 R >>`);
    perPage[page - 1].push(id);
    return id;
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R /AcroForm << /Fields [${all.map((id) => `${id} 0 R`).join(' ')}] >> >>`;
  objects[pages - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`;
  pageIds.forEach((id, index) => {
    objects[id - 1] = `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Annots [${perPage[index].map((n) => `${n} 0 R`).join(' ')}] >>`;
  });
  let out = '%PDF-1.7\n';
  const offsets = objects.map((body, index) => {
    const offset = Buffer.byteLength(out, 'latin1');
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const T = (n) => `Campo de Texto${n}`;
const C = (n) => `Caixa de Seleção${n}`;
// Ficha do modelo "Iron": as posições batem com a ficha brasileira de verdade.
function ironPdf({ blank = false } = {}) {
  const v = (value) => (blank ? '' : value);
  return layoutPdf([
    { name: T(0), value: v('Iron Aerandiel'), x: 7, y: 8 },
    { name: T(8), value: v('Ladino nível 5'), x: 44, y: 6 },
    { name: T(13), value: v('Elfo da floresta'), x: 44, y: 9 },
    { name: T(11), value: v('18.000'), x: 78, y: 9 },
    { name: T(27), value: v('11'), x: 6, y: 19 },
    { name: T(30), value: v('18'), x: 6, y: 28 },
    { name: T(32), value: v('9'), x: 6, y: 37 },
    { name: T(35), value: v('14'), x: 6, y: 46 },
    { name: T(36), value: v('14'), x: 6, y: 55 },
    { name: T(38), value: v('12'), x: 6, y: 64 },
    { name: T(28), value: v('+3'), x: 16, y: 21 },
    { name: T(25), value: v('+15'), x: 39, y: 19 },
    { name: T(24), value: v('7,5m'), x: 56, y: 18 },
    { name: T(42), value: v('27'), x: 49, y: 25 },
    { name: T(43), value: v('5d8'), x: 37, y: 42 },
    { name: C(1), value: !blank, box: true, x: 16, y: 28 },
    { name: T(61), value: v('+7'), x: 18, y: 27 },
    { name: C(6), value: !blank, box: true, x: 17, y: 41 },
    { name: T(66), value: v('+7'), x: 18, y: 40 },
    { name: C(11), value: !blank, box: true, x: 17, y: 49 },
    { name: T(71), value: v('+7'), x: 18, y: 49 },
    { name: T(83), value: v('+2'), x: 18, y: 69 },
    { name: T(45), value: v('Adagas'), x: 36, y: 50 },
    { name: T(48), value: v('+7'), x: 48, y: 50 },
    { name: T(51), value: v('1d4+4 perfurante'), x: 53, y: 49 },
    { name: T(57), value: v('6 PP'), x: 37, y: 79 },
    { name: T(59), value: v('125 PO'), x: 37, y: 85 },
    { name: T(56), value: v('45,5 Kg'), x: 37, y: 89 },
    { name: T(1), value: v('Teimoso.'), x: 68, y: 18 },
    { name: T(84), value: v('Iron Aerandiel'), page: 2, x: 7, y: 8 },
    { name: T(90), value: v('Roxo escuro'), page: 2, x: 43, y: 10 },
    { name: T(17), value: v('Fui deixado numa floresta.'), page: 2, x: 5, y: 49 },
    { name: T(19), value: v('Ladino'), page: 3, x: 7, y: 8 },
    { name: T(20), value: v('Inteligência'), page: 3, x: 46, y: 7 },
    { name: T(104), value: v('2'), page: 3, x: 8, y: 40 },
    { name: T(134), value: v('Mãos Mágicas'), page: 3, x: 5, y: 22 },
    { name: T(109), value: v('Sono'), page: 3, x: 6, y: 45 },
    { name: T(110), value: v('Disfarçar-se'), page: 3, x: 6, y: 47 },
    { name: C(54), value: !blank, box: true, page: 3, x: 5, y: 47 },
  ]);
}

const OFFICIAL = [
  ['CharacterName', 'Thorin'], ['ClassLevel', 'Fighter 3'], ['Race ', 'Hill Dwarf'], ['Background', 'Soldado'],
  ['STR', '16'], ['DEX', '12'], ['CON', '15'], ['INT', '10'], ['WIS', '13'], ['CHA', '8'],
  ['AC', '18'], ['Speed', '25 ft'], ['HPMax', '31'], ['HD', '3d10'], ['ProfBonus', '+2'],
  ['ST Strength', '+5'], ['ST Constitution', '+4'], ['Athletics', '+5'], ['Perception ', '+1'],
  ['Wpn Name', 'Machado de batalha'], ['Wpn1 AtkBonus', '+5'], ['Wpn1 Damage', '1d8+3 cortante'],
  ['GP', '15'], ['Equipment', 'Cota de malha, escudo'], ['PersonalityTraits ', 'Teimoso.'],
];
const GENERIC = [['Campo de Texto15', 'Lyra'], ['Campo de Texto16', 'Maga 2'], ['Campo de Texto17', '17']];

let db, server, base, app, llmCalls, llmReply;

beforeEach(async () => {
  if (server) await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  db = await freshDb();
  llmCalls = [];
  llmReply = null;
  const llm = {
    async generateJson(request) {
      llmCalls.push(request);
      return { data: llmReply, usage: { prompt: 900, completion: 300, total: 1200 }, model: 'modelo-teste' };
    },
  };
  app = createApp({ db, jwtSecret: SECRET, llm });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  app?.locals.tableHub.closeAll();
  server?.closeAllConnections?.();
  server?.close();
});

async function importPdf(user, pdf, { key = null, type = 'application/pdf', query = '' } = {}) {
  const res = await fetch(`${base}/api/characters/import${query}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${user.token}`, 'content-type': type, ...(key ? { 'x-gemini-key': key } : {}) },
    body: pdf,
  });
  return { status: res.status, body: await res.json() };
}

test('ficha oficial preenchível: lida sem IA, traduzida e com proficiências deduzidas', async () => {
  const user = await addUser(db);
  const { status, body } = await importPdf(user, fillablePdf(OFFICIAL));
  assert.equal(status, 200);
  assert.equal(body.source, 'form');
  assert.equal(llmCalls.length, 0);
  const c = body.character;
  assert.equal(c.name, 'Thorin');
  assert.equal(c.class, 'Guerreiro');
  assert.equal(c.race, 'Anão da Colina');
  assert.equal(c.level, 3);
  assert.equal(c.str, 16);
  assert.equal(c.armor_class, 18);
  assert.equal(c.max_hp, 31);
  assert.equal(c.hit_die, 10);
  assert.equal(c.speed, '7,5 m');
  assert.deepEqual(c.sheet.save_proficiencies.sort(), ['con', 'str']);
  assert.deepEqual(c.sheet.skill_proficiencies, ['atletismo']);
  assert.deepEqual(c.sheet.overrides.skills, {});
  assert.equal(c.sheet.coins.po, 15);
  assert.equal(c.sheet.attacks[0].damage, '1d8+3 cortante');
  assert.equal(c.sheet.personality, 'Teimoso.');

  // O rascunho é aceito como está pelo cadastro normal.
  const saved = await fetch(`${base}/api/characters`, {
    method: 'POST',
    headers: { authorization: `Bearer ${user.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(c),
  });
  assert.equal(saved.status, 201);
  const created = await saved.json();
  assert.equal(created.derived.skills.atletismo, 5);
});

test('ficha brasileira (modelo Iron): lida sem IA, com perícias, moedas e magias', async () => {
  const user = await addUser(db);
  const { status, body } = await importPdf(user, ironPdf());
  assert.equal(status, 200);
  assert.equal(body.source, 'form');
  assert.equal(llmCalls.length, 0);
  const c = body.character;
  assert.equal(c.name, 'Iron Aerandiel');
  assert.equal(c.class, 'Ladino');
  assert.equal(c.level, 5);
  assert.equal(c.race, 'Elfo da floresta');
  assert.equal(c.xp, 18000);
  assert.deepEqual([c.str, c.dex, c.con, c.int, c.wis, c.cha], [11, 18, 9, 14, 14, 12]);
  assert.equal(c.armor_class, 15);
  assert.equal(c.max_hp, 27);
  assert.equal(c.hit_die, 8);
  assert.equal(c.speed, '7,5m');
  assert.deepEqual(c.sheet.save_proficiencies, ['dex']);
  assert.deepEqual(c.sheet.skill_proficiencies, ['acrobacia', 'furtividade']);
  // Sobrevivência +2 = SAB sem proficiência: nada de ajuste manual.
  assert.deepEqual(c.sheet.overrides.skills, {});
  assert.deepEqual(c.sheet.coins, { pc: 0, pp: 6, pe: 0, po: 125, pl: 0 });
  assert.equal(c.sheet.attacks[0].damage, '1d4+4 perfurante');
  assert.equal(c.sheet.personality, 'Teimoso.');
  assert.equal(c.sheet.eyes, 'Roxo escuro');
  assert.equal(c.backstory, 'Fui deixado numa floresta.');
  assert.equal(c.sheet.spell_ability, 'int');
  assert.equal(c.sheet.spell_slots[1], 2);
  assert.deepEqual(c.sheet.spells[0], [{ name: 'Mãos Mágicas', prepared: false }]);
  assert.deepEqual(c.sheet.spells[1], [{ name: 'Sono', prepared: false }, { name: 'Disfarçar-se', prepared: true }]);
  assert.deepEqual(body.warnings, []);
});

test('modelo Iron: dá para pedir a leitura pela IA, e ficha em branco é avisada', async () => {
  const user = await addUser(db);
  llmReply = { is_character_sheet: true, name: 'Iron', class: 'Ladino', race: 'Elfo', level: 5 };
  const ai = await importPdf(user, ironPdf(), { key: GEMINI_KEY, query: '?ia=1' });
  assert.equal(ai.status, 200);
  assert.equal(ai.body.source, 'ia');
  assert.equal(llmCalls.length, 1);
  const noKey = await importPdf(user, ironPdf(), { query: '?ia=1' });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.body.code, 'gemini_key');
  const blank = await importPdf(user, ironPdf({ blank: true }));
  assert.equal(blank.status, 400);
  assert.match(blank.body.error, /em branco/);
});

test('ficha com campos genéricos e sem chave: pede a chave do Gemini', async () => {
  const user = await addUser(db);
  const { status, body } = await importPdf(user, fillablePdf(GENERIC));
  assert.equal(status, 400);
  assert.equal(body.code, 'gemini_key');
  assert.equal(llmCalls.length, 0);
});

test('ficha com campos genéricos e com chave: o Gemini recebe o PDF e os campos com posição', async () => {
  const user = await addUser(db);
  llmReply = {
    is_character_sheet: true, name: 'Lyra', race: 'High Elf', class: 'Wizard', level: 2,
    abilities: { str: 8, dex: 14, con: 12, int: 17, wis: 12, cha: 10 },
    skills: { arcanismo: { value: 5, proficient: true }, historia: { value: 7 } },
    spells: [{ circle: 0, name: 'Raio de Fogo' }, { circle: 1, name: 'Mísseis Mágicos', prepared: true }],
    spell_ability: 'Inteligência', speed: '9 m',
  };
  const { status, body } = await importPdf(user, fillablePdf(GENERIC), { key: GEMINI_KEY });
  assert.equal(status, 200);
  assert.equal(body.source, 'ia');
  const parts = llmCalls[0].contents[0].parts;
  assert.equal(parts[0].inlineData.mimeType, 'application/pdf');
  assert.match(parts[1].text, /p1 x[\d.]+ y[\d.]+ \[Campo de Texto15\]: "Lyra"/);
  const c = body.character;
  assert.equal(c.class, 'Mago');
  assert.equal(c.race, 'Alto Elfo');
  assert.equal(c.sheet.spell_ability, 'int');
  assert.deepEqual(c.sheet.spells[1], [{ name: 'Mísseis Mágicos', prepared: true }]);
  assert.ok(c.sheet.skill_proficiencies.includes('arcanismo'));
  // História +7 não bate com o cálculo (+3 sem proficiência + 2): fica como valor manual.
  assert.equal(c.sheet.overrides.skills.historia, 7);
  const log = await db.get('SELECT kind, total_tokens FROM token_logs WHERE user_id = ?', user.id);
  assert.deepEqual({ ...log }, { kind: 'import', total_tokens: 1200 });
});

test('o Gemini diz que não é ficha: recusa com mensagem clara', async () => {
  const user = await addUser(db);
  llmReply = { is_character_sheet: false };
  const { status, body } = await importPdf(user, fillablePdf(GENERIC), { key: GEMINI_KEY });
  assert.equal(status, 422);
  assert.match(body.error, /não parece uma ficha/);
});

test('arquivo que não é PDF, vazio ou sem login é recusado', async () => {
  const user = await addUser(db);
  assert.equal((await importPdf(user, Buffer.from('<html>oi</html>'))).status, 400);
  assert.equal((await importPdf(user, Buffer.alloc(0))).status, 400);
  const noLogin = await fetch(`${base}/api/characters/import`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: fillablePdf(OFFICIAL) });
  assert.equal(noLogin.status, 401);
});
