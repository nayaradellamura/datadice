// Copia os dados da versão SQLite (data/rpg.db) e as imagens de public/images para o PostgreSQL (DATABASE_URL).
// Uso: npm run db:import            (ou: npm run db:import -- caminho/do/rpg.db)
// O arquivo SQLite é aberto só para leitura: nada nele é alterado. O banco de destino precisa estar vazio.
import 'dotenv/config';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db/connection.js';

// Na ordem certa para as chaves estrangeiras. [tabela no SQLite, tabela no PostgreSQL]
const TABLES = [
  ['users', 'users'],
  ['characters', 'characters'],
  ['campaigns', 'campaigns'],
  ['campaign_characters', 'campaign_characters'],
  ['chat_history', 'messages'],
  ['token_logs', 'token_logs'],
  ['campaign_memories', 'campaign_memories'],
  ['campaign_summaries', 'campaign_summaries'],
  ['campaign_sessions', 'campaign_sessions'],
  ['npcs', 'npcs'],
  ['monsters', 'monsters'],
  ['locations', 'locations'],
  ['message_illustrations', 'message_illustrations'],
  ['rule_chunks', 'rule_chunks'],
];
const TIME_COLUMNS = new Set(['created_at', 'updated_at', 'ended_at', 'timestamp']);
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const BATCH = 200;

// O SQLite guardava "2026-11-11 10:00:00" em UTC.
const utc = (value) => (typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? `${value.replace(' ', 'T')}Z` : value);

async function copyTable(sqlite, db, from, to) {
  const exists = sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(from);
  if (!exists) return 0;
  const sourceColumns = new Set(sqlite.prepare(`PRAGMA table_info(${from})`).all().map((column) => column.name));
  const targetColumns = (await db.all(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = ? AND is_generated = 'NEVER'
     ORDER BY ordinal_position`,
    to,
  )).map((row) => row.column_name);
  const columns = targetColumns.filter((column) => sourceColumns.has(column));
  const rows = sqlite.prepare(`SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM ${from} ORDER BY rowid`).all();
  if (to === 'campaigns') {
    // Campanhas de antes do login ficam com o primeiro usuário (o jogador local, que vira o admin).
    const owner = sqlite.prepare('SELECT MIN(id) AS id FROM users').get().id;
    for (const row of rows) row.user_id ??= owner;
  }

  for (let start = 0; start < rows.length; start += BATCH) {
    const batch = rows.slice(start, start + BATCH);
    const values = [];
    const tuples = batch.map((row) => `(${columns.map((column) => {
      values.push(TIME_COLUMNS.has(column) ? utc(row[column]) : row[column]);
      return '?';
    }).join(', ')})`);
    await db.run(
      `INSERT INTO ${to} (${columns.map((c) => `"${c}"`).join(', ')}) OVERRIDING SYSTEM VALUE VALUES ${tuples.join(', ')}`,
      ...values,
    );
  }
  // As próximas linhas continuam a numeração de onde o SQLite parou.
  if (targetColumns.includes('id')) {
    await db.run(`SELECT setval(pg_get_serial_sequence('${to}', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM ${to}`);
  }
  return rows.length;
}

async function copyImages(db, dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const name of readdirSync(dir)) {
    const extension = name.split('.').pop().toLowerCase();
    if (!MIME[extension] || !/^[\w-]{1,120}\.(png|jpg|jpeg|webp)$/i.test(name)) continue;
    const data = readFileSync(join(dir, name));
    await db.run('INSERT INTO images (name, mime, size, data) VALUES (?, ?, ?, ?)', name, MIME[extension], data.length, data);
    count += 1;
  }
  return count;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sqlitePath = process.argv[2] || fileURLToPath(new URL('../data/rpg.db', import.meta.url));
  const imagesDir = fileURLToPath(new URL('../public/images', import.meta.url));
  if (!existsSync(sqlitePath)) {
    console.error(`Não achei o banco antigo em ${sqlitePath}.`);
    process.exit(1);
  }
  // better-sqlite3 só é usado aqui (dependência de desenvolvimento).
  const { default: Database } = await import('better-sqlite3');
  const sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  const db = await openDb({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const used = await db.get('SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM campaigns) AS n');
    if (used.n > 0) {
      console.error('O banco PostgreSQL de destino já tem dados. Para não misturar nada, a importação parou sem alterar nada.');
      process.exitCode = 1;
    } else {
      await db.tx(async (t) => {
        for (const [from, to] of TABLES) {
          const count = await copyTable(sqlite, t, from, to);
          console.log(`${to}: ${count}`);
        }
        console.log(`imagens: ${await copyImages(t, imagesDir)}`);
      });
      console.log('Importação concluída. O arquivo SQLite não foi alterado.');
    }
  } catch (err) {
    console.error(`A importação falhou e nada foi gravado no PostgreSQL: ${err.message}`);
    process.exitCode = 1;
  } finally {
    sqlite.close();
    await db.close();
  }
}
