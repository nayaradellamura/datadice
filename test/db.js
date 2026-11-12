import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { after } from 'node:test';
import pg from 'pg';
import { createDb, migrate } from '../src/db/connection.js';

const url = process.env.TEST_DATABASE_URL;

async function runAsAdmin(sql) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/**
 * Banco de teste: um esquema novo e vazio dentro de TEST_DATABASE_URL. destroy() fecha as conexões
 * e apaga o esquema. Os arquivos de teste rodam em paralelo, cada um no seu esquema.
 */
export async function openTestDb() {
  if (!url) throw new Error('Defina TEST_DATABASE_URL no .env para rodar os testes (veja o README).');
  if (url === process.env.DATABASE_URL) throw new Error('TEST_DATABASE_URL não pode ser o mesmo banco de DATABASE_URL.');
  const schema = `teste_${randomBytes(6).toString('hex')}`;
  await runAsAdmin(`CREATE SCHEMA ${schema}`);
  const db = createDb({ connectionString: url, schema, max: 4 });
  await migrate(db);
  db.destroy = async () => {
    await db.pool.end();
    await runAsAdmin(`DROP SCHEMA ${schema} CASCADE`);
  };
  return db;
}

const userTables = (db) => db.all(
  `SELECT tablename FROM pg_tables WHERE schemaname = ? AND tablename <> 'schema_migrations' ORDER BY tablename`,
  db.schema,
);

// Um esquema por arquivo de teste, esvaziado antes de cada teste (bem mais rápido que recriar).
let shared = null;
after(async () => {
  if (shared) await shared.destroy();
});

/** Banco vazio para um teste. O db.close() dos testes não faz nada; o esquema some no fim do arquivo. */
export async function freshDb() {
  if (!shared) {
    shared = await openTestDb();
    shared.close = async () => {};
  }
  const tables = await userTables(shared);
  await shared.exec(`TRUNCATE ${tables.map((row) => `"${row.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  return shared;
}

/** Todo o conteúdo do esquema como texto, para conferir que um segredo não foi gravado em lugar nenhum. */
export async function dumpText(db) {
  let text = '';
  for (const { tablename } of await userTables(db)) {
    for (const row of await db.all(`SELECT t::text AS row FROM "${tablename}" t`)) text += `${row.row}\n`;
  }
  return text;
}
