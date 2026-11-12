import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);

// COUNT e SUM chegam como bigint/numeric (texto); os valores do DataDice cabem em Number.
pg.types.setTypeParser(20, (value) => Number.parseInt(value, 10));
pg.types.setTypeParser(1700, (value) => Number.parseFloat(value));
// Datas no mesmo formato da versão SQLite ("2026-11-11 10:00:00", em UTC), que o navegador já entende.
// A conexão usa TimeZone=UTC, então o texto vem como "2026-11-11 10:00:00.123+00".
const utcText = (value) => value.slice(0, 19);
pg.types.setTypeParser(1184, utcText);
pg.types.setTypeParser(1114, utcText);

/** Troca os "?" da consulta por $1, $2... ignorando o que estiver entre aspas. */
export function toPositional(sql) {
  let out = '';
  let index = 0;
  let quote = null;
  for (const char of sql) {
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '?') {
      index += 1;
      out += `$${index}`;
      continue;
    }
    out += char;
  }
  return out;
}

function queries(run) {
  return {
    /** Todas as linhas. */
    all: async (sql, ...params) => (await run(toPositional(sql), params)).rows,
    /** A primeira linha, ou undefined. */
    get: async (sql, ...params) => (await run(toPositional(sql), params)).rows[0],
    /** Para INSERT/UPDATE/DELETE. Com "RETURNING id", devolve o id em .id. */
    run: async (sql, ...params) => {
      const result = await run(toPositional(sql), params);
      return { changes: result.rowCount, id: result.rows[0]?.id, rows: result.rows };
    },
    /** SQL puro, sem parâmetros e sem trocar "?"; aceita vários comandos (usado nas migrações). */
    exec: async (sql) => { await run(sql); },
  };
}

/**
 * Banco do DataDice. db.get/all/run aceitam "?" como marcador; db.tx(fn) roda fn numa transação
 * e passa a ela um objeto com a mesma interface (as funções aceitam db ou a transação).
 */
export function createDb({ connectionString, schema = null, max = 10 }) {
  if (!connectionString) {
    throw new Error('DATABASE_URL não definida. Veja o README (seção "Banco de dados").');
  }
  const searchPath = schema ? `${schema},public` : 'public';
  // Tempos-limite: se o banco travar, a requisição falha em segundos em vez de ficar presa para sempre.
  const pool = new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 10000,
    options: `-c TimeZone=UTC -c search_path=${searchPath} -c statement_timeout=20000 -c idle_in_transaction_session_timeout=30000`,
  });
  // Uma conexão que cai no pool não pode derrubar o servidor; a próxima consulta abre outra.
  pool.on('error', (err) => console.error(`Banco: conexão perdida (${err.message}).`));

  const db = {
    ...queries((text, params) => pool.query(text, params)),
    pool,
    schema,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const handle = queries((text, params) => client.query(text, params));
        handle.tx = (inner) => inner(handle);
        const result = await fn(handle);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  return db;
}

/** Aplica, em ordem, as migrações que ainda não rodaram neste banco. */
export async function migrate(db) {
  const files = readdirSync(MIGRATIONS_DIR).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  await db.tx(async (t) => {
    // Dois servidores subindo juntos não aplicam a mesma migração duas vezes.
    await t.run('SELECT pg_advisory_xact_lock(4242001)');
    await t.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await t.all('SELECT version FROM schema_migrations')).map((row) => row.version));
    for (const file of files) {
      if (done.has(file)) continue;
      await t.exec(readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8'));
      await t.run('INSERT INTO schema_migrations (version) VALUES (?)', file);
    }
  });
}

/** Abre o banco e aplica as migrações. */
export async function openDb(options) {
  const db = createDb(options);
  await migrate(db);
  return db;
}
