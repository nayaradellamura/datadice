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

async function importPdf(user, pdf, { key = null, type = 'application/pdf' } = {}) {
  const res = await fetch(`${base}/api/characters/import`, {
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
  assert.match(parts[1].text, /p1 x\d+ y\d+ \[Campo de Texto15\]: "Lyra"/);
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
