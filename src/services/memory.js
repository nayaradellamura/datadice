export const MEMORY_TYPES = ['npc', 'location', 'quest', 'item', 'faction', 'event', 'fact'];
export const MEMORY_STATUSES = ['active', 'resolved', 'dead', 'lost'];

const MAX_CONTENT = 4000;
const MAX_UPDATES_PER_CALL = 15;

const STOPWORDS = new Set(
  `que com para por uma uns umas dos das nos nas pelo pela pelos pelas ele ela eles elas voce voces
   meu minha seu sua nosso nossa isso isto esse essa este esta aquele aquela como mas mais muito
   tem ter foi era sao esta estou vou vai ser sim nao aqui ali entao quando onde quem qual sobre
   depois antes tambem ainda the and`.split(/\s+/)
);

export function normalizeKey(text) {
  return String(text)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Palavras de busca: sem acento, sem palavras vazias, com o fim cortado para pegar plural e flexões. */
function searchTerms(text) {
  const words = normalizeKey(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms = new Set();
  for (const word of words) {
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    terms.add(word.length >= 6 ? word.slice(0, -2) : word);
    if (terms.size === 16) break;
  }
  return [...terms];
}

/**
 * Consulta para to_tsquery('simple', ...), tolerante a plural e flexões. Os termos só têm letras e
 * números, então não dá para injetar operadores. joiner: '|' (qualquer termo) ou '&' (todos).
 */
export function buildFtsQuery(text, joiner = '|') {
  return searchTerms(text).map((term) => `${term}:*`).join(` ${joiner} `);
}

// A coluna "search" só serve ao índice de busca; não vai para a API nem para o prompt.
export const MEMORY_COLUMNS =
  'id, campaign_id, type, name, name_key, content, importance, status, pinned, source, created_at, updated_at';
export const MESSAGE_COLUMNS = `id, campaign_id, sender_type, sender_name, message_text, user_id, character_id, kind,
  visibility, recipient_user_id, image_id, created_at`;

export async function getSummary(db, campaignId) {
  return (
    (await db.get('SELECT summary_text, last_message_id FROM campaign_summaries WHERE campaign_id = ?', campaignId)) ?? {
      summary_text: '',
      last_message_id: 0,
    }
  );
}

/** Fatos que entram em todos os turnos. */
export function getCoreMemories(db, campaignId, limit = 30) {
  return db.all(
    `SELECT ${MEMORY_COLUMNS} FROM campaign_memories
     WHERE campaign_id = ?
       AND (pinned = 1 OR (importance >= 4 AND status = 'active'))
     ORDER BY pinned DESC, importance DESC, updated_at DESC, id DESC
     LIMIT ?`,
    campaignId, limit,
  );
}

/** Lista compacta de tudo o que existe, para o Mestre saber que aquilo já foi criado. */
export function getMemoryIndex(db, campaignId, limit = 200) {
  return db.all(
    `SELECT type, name, status FROM campaign_memories
     WHERE campaign_id = ?
     ORDER BY pinned DESC, importance DESC, updated_at DESC, id DESC
     LIMIT ?`,
    campaignId, limit,
  );
}

export async function searchMemories(db, campaignId, text, excludeIds = [], limit = 8) {
  const query = buildFtsQuery(text);
  if (!query) return [];
  // O nome pesa mais que o conteúdo (pesos A e B da coluna de busca).
  const rows = await db.all(
    `SELECT ${MEMORY_COLUMNS} FROM campaign_memories
     WHERE campaign_id = ? AND search @@ to_tsquery('simple', ?)
     ORDER BY ts_rank(search, to_tsquery('simple', ?), 1) DESC, id
     LIMIT ?`,
    campaignId, query, query, limit + excludeIds.length,
  );
  const excluded = new Set(excludeIds);
  return rows.filter((row) => !excluded.has(row.id)).slice(0, limit);
}

/** Só mensagens visíveis a todos: rolagens secretas e conversas privadas não entram na memória do Mestre IA. */
export async function searchOldMessages(db, campaignId, text, beforeId, limit = 5) {
  const query = buildFtsQuery(text);
  if (!query || !beforeId) return [];
  const rows = await db.all(
    `SELECT id, sender_name, message_text FROM messages
     WHERE campaign_id = ? AND id < ? AND visibility = 'all' AND search @@ to_tsquery('simple', ?)
     ORDER BY ts_rank(search, to_tsquery('simple', ?), 1) DESC, id
     LIMIT ?`,
    campaignId, beforeId, query, query, limit,
  );
  return rows.sort((a, b) => a.id - b.id);
}

/** A ficha e os livros usam nomes diferentes para as mesmas coisas. */
function toBookTerms(query) {
  return query
    .replace(/salvaguardas?/gi, 'teste de resistência')
    .replace(/lidar com animais/gi, 'adestrar animais')
    .replace(/beholders?/gi, 'observador')
    .replace(/^\s*(estat[ií]sticas?|ficha|bloco de estat[ií]sticas|monstro|criatura)\s+(d[eoa]s?\s+)?/i, '')
    .trim();
}

/**
 * Procura o termo como título em maiúsculas, sempre em palavra inteira ("LOBO" não casa com "GLOBO").
 * Fichas de criatura vêm primeiro, e títulos exatos antes de variações como "CHEFE GOBLIN".
 */
async function ruleHeadingHits(db, term, limit) {
  const heading = term
    .replace(/\b(condição|condicao|magia|regra|regras|talento)\b/gi, '')
    .replace(/[^\p{L}\p{N}\s'-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  if (heading.length < 3) return [];

  const singular = heading.replace(/S$/, '');
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])(${singular}S?)(?![\\p{L}\\p{N}])`, 'gu');
  // LIKE diferencia maiúsculas, como o GLOB da versão SQLite: só casa títulos em caixa alta.
  // O título só tem letras, números, espaço, apóstrofo e hífen, então não leva curingas do LIKE.
  const rows = await db.all("SELECT id, book, page, text FROM rule_chunks WHERE text LIKE '%' || ? || '%' ORDER BY id", singular);
  const nextText = async (id, book) => (await db.get('SELECT text FROM rule_chunks WHERE id = ? AND book = ?', id, book))?.text;

  const hits = [];
  for (const row of rows) {
    // Um trecho pode ter o título do texto descritivo e, depois, o da ficha: avalia todos.
    let best = null;
    for (const match of row.text.matchAll(pattern)) {
      const matchStart = match.index + match[1].length;
      const after = row.text.slice(matchStart + match[2].length, matchStart + match[2].length + 120);
      const isStatBlock = after.includes('Classe de Armadura');
      // Mantém o título inteiro: em "OBSERVADOR ZUMBI", o trecho não pode começar em "ZUMBI".
      const prefix = /(?:[\p{Lu}'-]{2,}\s)+$/u.exec(row.text.slice(0, matchStart))?.[0] ?? '';
      const score = (isStatBlock ? 0 : 2) + (prefix ? 1 : 0);
      if (!best || score < best.score) best = { row, start: matchStart - prefix.length, isStatBlock, score };
    }
    if (best) hits.push(best);
  }

  hits.sort((a, b) => a.score - b.score || a.row.id - b.row.id);
  // Começa no título e emenda os trechos seguintes, para a descrição ou a ficha não ficarem cortadas.
  const wholePage = async (book, page) =>
    (await db.all('SELECT text FROM rule_chunks WHERE book = ? AND page = ? ORDER BY id', book, page))
      .map((chunk) => chunk.text)
      .reduce(joinChunks, '')
      .trim();
  const seenPages = new Set();
  const unique = hits.filter(({ row, isStatBlock }) => {
    if (isStatBlock || row.book !== MONSTER_BOOK) return true;
    if (seenPages.has(row.page)) return false;
    seenPages.add(row.page);
    return true;
  });

  const results = [];
  for (const { row, start, isStatBlock } of unique.slice(0, limit)) {
    // Em algumas páginas o PDF guarda o texto fora de ordem; recortar ali perderia parte da ficha.
    if (!isStatBlock && row.book === MONSTER_BOOK) {
      let text = await wholePage(row.book, row.page);
      if (!text.includes('Classe de Armadura')) text = `${text} ${await wholePage(row.book, row.page + 1)}`.trim();
      results.push({ ...row, text });
      continue;
    }
    let text = row.text.slice(start);
    for (let offset = 1; offset <= (isStatBlock ? MAX_STAT_BLOCK_CHUNKS : 2); offset += 1) {
      const following = await nextText(row.id + offset, row.book);
      if (!following) break;
      text = joinChunks(text, following);
      if (isStatBlock && statBlockEnd(text) >= 0) break;
    }
    if (!isStatBlock) {
      results.push({ ...row, text });
      continue;
    }
    const end = statBlockEnd(text);
    results.push({ ...row, text: end >= 0 ? text.slice(0, end).trim() : text });
  }
  return results;
}

/** Nomes de todas as criaturas com ficha no manual, usados quando a tradução esperada não é a do livro. */
export async function listCreatureNames(db) {
  const pattern = /((?:\p{Lu}[\p{Lu}'-]+\s(?:D[EOA]S?\s)?)+)(?=\p{Lu}[\p{Ll}-]+\s(?:Miúd|Minúscul|Pequen|Médi|Grande|Enorme|Imens|Colossal))/gu;
  // Onde a ficha está fora de ordem, o nome ainda aparece como título no começo da página.
  const pageTitle = /^(?:\d{1,3}\s)?((?:\p{Lu}[\p{Lu}'-]+\s(?:D[EOA]S?\s)?)+)(?=\p{Lu}[\p{Ll}\s])/u;
  const notCreatures = new Set(['ações', 'reações', 'ações lendárias', 'introdução']);
  const names = new Set();
  const rows = await db.all('SELECT text FROM rule_chunks WHERE book = ? ORDER BY id', MONSTER_BOOK);
  for (const { text } of rows) {
    const title = pageTitle.exec(text);
    if (title) names.add(title[1].trim().toLowerCase());
    for (const match of text.matchAll(pattern)) {
      if (text.slice(match.index, match.index + match[0].length + 120).includes('Classe de Armadura')) {
        names.add(match[1].trim().toLowerCase());
      }
    }
  }
  const cleaned = [...names].map((name) => name.replace(/\s+(ações lendárias|ações|reações)$/u, ''));
  return [...new Set(cleaned)].filter((name) => !notCreatures.has(name)).sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

const MAX_STAT_BLOCK_CHUNKS = 8;
const MONSTER_BOOK = 'Manual dos Monstros';

/** Os trechos gravados se sobrepõem; remove a parte repetida ao emendar. */
function joinChunks(left, right) {
  for (let size = Math.min(300, left.length, right.length); size >= 20; size -= 1) {
    if (left.endsWith(right.slice(0, size))) return left + right.slice(size);
  }
  return `${left} ${right}`;
}

const STAT_BLOCK_SECTIONS = new Set(['AÇÕES', 'REAÇÕES', 'LENDÁRIAS']);

/**
 * Onde a ficha acaba: no primeiro título em maiúsculas depois do início dela que não seja
 * uma seção da própria ficha. Serve tanto para outra criatura quanto para texto descritivo.
 * Devolve -1 se o fim ainda não apareceu.
 */
function statBlockEnd(text) {
  const first = text.search(/Classe de Armadura/u);
  if (first < 0) return -1;
  const heading = /(?:^|\s)((?:\d{1,3}\s)?)(\p{Lu}[\p{Lu}'-]{3,})(?=[\s:]|$)/gu;
  heading.lastIndex = first;
  for (const match of text.matchAll(heading)) {
    if (match.index < first || STAT_BLOCK_SECTIONS.has(match[2])) continue;
    return match.index;
  }
  return -1;
}

/** Busca nos livros, da mais precisa para a mais ampla: título, frase exata, todos os termos, qualquer termo. */
export async function searchRules(db, queries, perQuery = 3) {
  // tsquery: phraseto_tsquery (frase exata) ou to_tsquery (termos com | ou &).
  const search = (tsquery, value, limit) => db.all(
    `SELECT id, book, page, text FROM rule_chunks
     WHERE search @@ ${tsquery}('simple', dd_unaccent(?))
     ORDER BY ts_rank(search, ${tsquery}('simple', dd_unaccent(?))) DESC, id
     LIMIT ?`,
    value, value, limit,
  );
  const found = new Map();
  for (const query of queries.slice(0, 6)) {
    const term = toBookTerms(query);
    const anyTerm = buildFtsQuery(term);
    if (!anyTerm) continue;
    const words = normalizeKey(term).match(/[\p{L}\p{N}]+/gu) ?? [];
    const tiers = [
      () => ruleHeadingHits(db, term, perQuery),
      () => search('phraseto_tsquery', words.join(' '), perQuery),
      () => search('to_tsquery', buildFtsQuery(term, '&'), perQuery),
    ];
    const rows = new Map();
    for (const tier of tiers) {
      if (rows.size >= perQuery) break;
      for (const row of await tier()) {
        if (rows.size < perQuery && !rows.has(row.id)) rows.set(row.id, row);
      }
    }
    // Só alguns termos em comum não confirmam nada: entra como parcial, e apenas se não houver mais nada.
    if (!rows.size) {
      for (const row of await search('to_tsquery', anyTerm, perQuery)) rows.set(row.id, { ...row, partial: true });
    }
    for (const row of rows.values()) if (!found.has(row.id) || !row.partial) found.set(row.id, row);
  }
  return [...found.values()];
}

/**
 * Consulta feita pelo Mestre quando tem dúvida: busca fichas e toda a conversa
 * da campanha, trazendo as mensagens vizinhas de cada trecho para dar contexto.
 */
export async function consultArchive(db, campaignId, queries) {
  const memories = new Map();
  const messages = new Map();
  const neighbor = (where, id) => db.get(
    `SELECT id, sender_name, message_text FROM messages
     WHERE campaign_id = ? AND visibility = 'all' AND ${where} LIMIT 1`,
    campaignId, id,
  );

  for (const query of queries.slice(0, 3)) {
    for (const memory of await searchMemories(db, campaignId, query, [], 5)) memories.set(memory.id, memory);
    for (const hit of await searchOldMessages(db, campaignId, query, 2147483647, 5)) {
      const previous = await neighbor('id < ? ORDER BY id DESC', hit.id);
      const next = await neighbor('id > ? ORDER BY id', hit.id);
      for (const row of [previous, hit, next]) {
        if (row) messages.set(row.id, row);
      }
    }
  }

  return {
    memories: [...memories.values()],
    messages: [...messages.values()].sort((a, b) => a.id - b.id),
  };
}

/**
 * Grava as atualizações vindas do modelo. Dados inválidos são ignorados, e o
 * conteúdo escrito por você nunca é substituído: a novidade entra como anexo.
 * Deve ser chamada dentro de uma transação quando fizer parte de um turno.
 */
export async function applyMemoryUpdates(db, campaignId, updates) {
  if (!Array.isArray(updates)) return [];

  const changed = [];
  for (const raw of updates.slice(0, MAX_UPDATES_PER_CALL)) {
    const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, 100) : '';
    const content = typeof raw?.content === 'string' ? raw.content.trim().slice(0, MAX_CONTENT) : '';
    const key = normalizeKey(name);
    if (!key || !content) continue;

    const importance = Number.isInteger(raw.importance) ? Math.min(5, Math.max(1, raw.importance)) : 3;
    const status = MEMORY_STATUSES.includes(raw.status) ? raw.status : undefined;
    const existing = await db.get(
      `SELECT ${MEMORY_COLUMNS} FROM campaign_memories WHERE campaign_id = ? AND name_key = ?`,
      campaignId, key,
    );

    if (!existing) {
      if (!MEMORY_TYPES.includes(raw.type)) continue;
      await db.run(
        `INSERT INTO campaign_memories (campaign_id, type, name, name_key, content, importance, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        campaignId, raw.type, name, key, content, importance, status ?? 'active',
      );
      changed.push(name);
      continue;
    }

    let nextContent = content;
    if (existing.source === 'user') {
      const addition = `${existing.content}\nAtualização: ${content}`;
      const alreadyKnown = normalizeKey(existing.content).includes(normalizeKey(content));
      nextContent = alreadyKnown || addition.length > MAX_CONTENT ? existing.content : addition;
    }
    await db.run(
      'UPDATE campaign_memories SET content = ?, importance = ?, status = ?, updated_at = now() WHERE id = ?',
      nextContent, Math.max(existing.importance, importance), status ?? existing.status, existing.id,
    );
    changed.push(existing.name);
  }
  return changed;
}
