import { HttpError } from '../middleware/errorHandler.js';
import { rollForGm } from './dice.js';
import { applyMemoryUpdates, consultArchive, getSummary, listCreatureNames, MESSAGE_COLUMNS, searchRules } from './memory.js';
import { buildSummaryPrompt, buildTurnPrompt, getParty, RECENT_WINDOW } from './promptBuilder.js';
import { publicPartyMember } from './sheet.js';
import { applyStateChanges } from './state.js';

const SUMMARY_TRIGGER = 20;
const SUMMARY_BATCH = 40;
// Pode ser preciso consultar a ficha, rolar o ataque, rolar o dano e só então narrar.
const MAX_LOOKUP_ROUNDS = 4;
const MAX_ROLLS_PER_ROUND = 12;
const UNROLLED_DAMAGE_NOTE = 'Aviso: o Mestre aplicou dano neste turno sem uma rolagem registrada pelo sistema.';

const dealsDamage = (data) =>
  Array.isArray(data?.state_changes) && data.state_changes.some((change) => Number.isInteger(change?.hp_delta) && change.hp_delta < 0);

/** source: { userId, campaignId, kind } diz de quem foi o consumo, em qual campanha e para quê. */
export async function logTokens(db, model, usage, { userId = null, campaignId = null, kind = null } = {}) {
  await db.run(
    `INSERT INTO token_logs (user_id, campaign_id, kind, model_name, prompt_tokens, completion_tokens, total_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    userId, campaignId, kind, model, usage.prompt, usage.completion, usage.total,
  );
}

const TOTALS = `COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
  COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
  COALESCE(SUM(total_tokens), 0) AS total_tokens,
  COUNT(*) AS calls`;

/** Sem userId, soma o sistema todo (painel do admin); com ele, só o consumo daquele jogador. */
export function tokenTotals(db, userId) {
  return userId === undefined
    ? db.get(`SELECT ${TOTALS} FROM token_logs`)
    : db.get(`SELECT ${TOTALS} FROM token_logs WHERE user_id = ?`, userId);
}

const cleanQueries = (value) =>
  Array.isArray(value) ? value.filter((query) => typeof query === 'string' && query.trim()) : [];

export function createGameMaster({ db, visuals, onBackgroundError = console.error }) {
  const busy = new Set();
  const summarizing = new Map();

  // llm já vem com a chave de quem está jogando; source registra de quem foi o consumo e onde.
  async function callLlm(llm, source, prompt) {
    try {
      const result = await llm.generateJson(prompt);
      await logTokens(db, result.model, result.usage, source);
      return result;
    } catch (err) {
      if (err.usage) await logTokens(db, err.model, err.usage, source);
      throw err;
    }
  }

  async function summarizeIfNeeded(campaign, llm, userId) {
    const summary = await getSummary(db, campaign.id);
    // Os resumos de sessão só repetem o que já aconteceu, então não entram na crônica.
    const candidates = await db.all(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
       WHERE campaign_id = ? AND id > ? AND visibility = 'all'
         AND id NOT IN (SELECT first_message_id FROM campaign_sessions WHERE kind = 'recap')
       ORDER BY id`,
      campaign.id, summary.last_message_id,
    );
    const outsideWindow = candidates.slice(0, Math.max(0, candidates.length - RECENT_WINDOW));
    if (outsideWindow.length < SUMMARY_TRIGGER) return;

    const batch = outsideWindow.slice(0, SUMMARY_BATCH);
    const prompt = await buildSummaryPrompt(db, { campaign, previousSummary: summary.summary_text, messages: batch });
    const { data } = await callLlm(llm, { userId, campaignId: campaign.id, kind: 'summary' }, prompt);
    const text = typeof data?.summary === 'string' ? data.summary.trim() : '';
    if (!text) throw new Error('O resumo veio vazio.');

    await db.tx(async (t) => {
      await applyMemoryUpdates(t, campaign.id, data.memory_updates);
      await t.run(
        `INSERT INTO campaign_summaries (campaign_id, summary_text, last_message_id)
         VALUES (?, ?, ?)
         ON CONFLICT (campaign_id) DO UPDATE SET
           summary_text = excluded.summary_text,
           last_message_id = excluded.last_message_id,
           updated_at = now()`,
        campaign.id, text, batch.at(-1).id,
      );
    });
  }

  /** Roda fora da resposta ao jogador. Se falhar, o chat segue e o próximo turno tenta de novo. */
  function scheduleSummary(campaign, llm, userId) {
    if (summarizing.has(campaign.id)) return;
    const task = summarizeIfNeeded(campaign, llm, userId)
      .catch(onBackgroundError)
      .finally(() => summarizing.delete(campaign.id));
    summarizing.set(campaign.id, task);
  }

  /**
   * Sem sessionKind, é um turno normal do jogador. Com 'intro' ou 'recap', o Mestre fala primeiro,
   * guiado pela directive. O resumo não pode alterar o jogo: não usa consultas nem aplica mudanças.
   */
  async function playTurn({
    campaign, actor, message, directive = null, sessionKind = null, llm, images = null, illustrate = false, userId = null,
  }) {
    const isRecap = sessionKind === 'recap';
    // Abertura de sessão, reação a uma rolagem (directive sem sessão) ou conversa normal.
    const turnKind = sessionKind ? 'session' : directive ? 'roll' : 'turn';
    const maxRounds = isRecap ? 0 : MAX_LOOKUP_ROUNDS;
    if (busy.has(campaign.id)) {
      throw new HttpError(409, 'O Mestre ainda está respondendo ao turno anterior.');
    }
    busy.add(campaign.id);
    try {
      const lookups = [];
      const rolls = [];
      const usage = { prompt: 0, completion: 0, total: 0 };
      let data;
      let damageReminderSent = false;
      for (let round = 0; round <= maxRounds; round += 1) {
        const prompt = await buildTurnPrompt(db, {
          campaign,
          actor,
          message,
          directive,
          lookups,
          rolls,
          canAskAgain: round < maxRounds,
          illustrate,
        });
        const result = await callLlm(llm, { userId, campaignId: campaign.id, kind: turnKind }, prompt);
        data = result.data;
        for (const key of Object.keys(usage)) usage[key] += result.usage[key];

        const queries = cleanQueries(data?.lookup_queries);
        const ruleQueries = cleanQueries(data?.rule_queries);
        const rollRequests = Array.isArray(data?.gm_rolls) ? data.gm_rolls.slice(0, MAX_ROLLS_PER_ROUND) : [];
        if (round === maxRounds) break;

        if (queries.length || ruleQueries.length || rollRequests.length) {
          rolls.push(...rollRequests.map(rollForGm));
          if (queries.length || ruleQueries.length) {
            const rules = await searchRules(db, ruleQueries);
            lookups.push({
              queries,
              ruleQueries,
              result: queries.length ? await consultArchive(db, campaign.id, queries) : { memories: [], messages: [] },
              rules,
              // Sem confirmação, mostra os nomes do manual: a tradução do livro pode ser outra.
              creatureNames: ruleQueries.length && !rules.some((row) => !row.partial) ? await listCreatureNames(db) : [],
            });
          }
          continue;
        }
        if (!damageReminderSent && !rolls.some((roll) => !roll.error) && dealsDamage(data)) {
          damageReminderSent = true;
          continue;
        }
        break;
      }

      const narration = typeof data?.narration === 'string' ? data.narration.trim() : '';
      if (!narration) throw new HttpError(502, 'O Mestre devolveu uma resposta vazia. Tente de novo.');

      const validRolls = rolls.filter((roll) => !roll.error);
      const unrolledDamage = !isRecap && dealsDamage(data) && !validRolls.length;

      const { memoryChanges, illustrations } = await db.tx(async (t) => {
        const insertMessage = async (senderType, senderName, text, playerId = null) => (await t.run(
          `INSERT INTO messages (campaign_id, sender_type, sender_name, message_text, user_id, character_id)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
          campaign.id, senderType, senderName, text, playerId, playerId && actor.character_id,
        )).id;
        // Só um turno normal grava a fala do jogador; aberturas e reações a rolagens partem do sistema.
        if (!directive) await insertMessage('player', actor.name, message, userId);
        for (const roll of validRolls) await insertMessage('system', 'Dados', roll.text);
        const gmMessageId = await insertMessage('gm', 'Mestre', narration);
        if (sessionKind) {
          await t.run('INSERT INTO campaign_sessions (campaign_id, kind, first_message_id) VALUES (?, ?, ?)', campaign.id, sessionKind, gmMessageId);
        }
        if (isRecap) return { memoryChanges: [], illustrations: [] };
        if (unrolledDamage) await insertMessage('system', 'Dados', UNROLLED_DAMAGE_NOTE);
        await applyStateChanges(t, campaign.id, data.state_changes);
        return {
          memoryChanges: await applyMemoryUpdates(t, campaign.id, data.memory_updates),
          // Ilustrações desligadas: nada é registrado nem gerado, e nenhuma imagem é cobrada.
          illustrations: illustrate ? await visuals.register(t, campaign.id, gmMessageId, data.illustrations) : [],
        };
      });

      // A resposta não espera a imagem: ela é gerada em segundo plano e a bolha é atualizada depois.
      visuals.enqueueAll(illustrations, images);
      scheduleSummary(campaign, llm, userId);
      return {
        narration,
        illustrations,
        rolls: validRolls.map((roll) => roll.text),
        warning: unrolledDamage ? UNROLLED_DAMAGE_NOTE : null,
        memory_changes: memoryChanges,
        party: (await getParty(db, campaign.id)).map(publicPartyMember),
        tokens: { turn: usage, totals: await tokenTotals(db, userId) },
      };
    } finally {
      busy.delete(campaign.id);
    }
  }

  return {
    playTurn,
    waitForBackground: () => Promise.all(summarizing.values()),
  };
}
