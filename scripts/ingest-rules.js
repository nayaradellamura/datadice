// Uso: npm run rules:ingest -- "Livro do Jogador=caminho.pdf" "Guia do Mestre=caminho.pdf"
// Extrai o texto dos PDFs e grava trechos pesquisáveis no banco (DATABASE_URL). Pode ser repetido com segurança.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { openDb } from '../src/db/connection.js';

const CHUNK_SIZE = 1400;
const OVERLAP = 200;

/** Junta os fragmentos da página pela posição, recuperando palavras como "M ESTRE" -> "MESTRE". */
export function pageText(items) {
  let output = '';
  let last = null;
  for (const item of items) {
    if (!item.str) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    const size = Math.abs(item.transform[3]) || 10;
    if (last) {
      const sameLine = Math.abs(y - last.y) < size * 0.6;
      const gap = x - last.end;
      if (!sameLine || gap > size * 0.15) output += ' ';
    }
    output += item.str;
    last = { y, end: x + item.width };
  }
  return output.replace(/\s+/g, ' ').trim();
}

export function chunkText(text) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK_SIZE);
    if (end < text.length) {
      const sentence = text.lastIndexOf('. ', end);
      if (sentence > start + CHUNK_SIZE / 2) end = sentence + 1;
    }
    chunks.push(text.slice(start, end).trim());
    if (end === text.length) break;
    start = Math.max(start + 1, end - OVERLAP);
  }
  return chunks;
}

async function ingest(db, book, path) {
  const doc = await getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise;
  const rows = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();
    const text = pageText(content.items);
    if (text.length >= 50) for (const chunk of chunkText(text)) rows.push({ book, page: number, text: chunk });
    page.cleanup();
  }

  await db.tx(async (t) => {
    await t.run('DELETE FROM rule_chunks WHERE book = ?', book);
    for (const row of rows) await t.run('INSERT INTO rule_chunks (book, page, text) VALUES (?, ?, ?)', row.book, row.page, row.text);
  });
  console.log(`${book}: ${doc.numPages} páginas, ${rows.length} trechos.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sources = process.argv.slice(2).map((arg) => {
    const separator = arg.indexOf('=');
    return { book: arg.slice(0, separator), path: arg.slice(separator + 1) };
  });
  if (!sources.length || sources.some(({ book, path }) => !book || !path)) {
    console.error('Uso: npm run rules:ingest -- "Nome do livro=caminho.pdf" ...');
    process.exit(1);
  }
  const db = await openDb({ connectionString: process.env.DATABASE_URL, max: 1 });
  for (const { book, path } of sources) await ingest(db, book, path);
  await db.close();
}
