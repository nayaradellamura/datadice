// Sem jogar por este tempo, a próxima abertura da campanha começa uma nova sessão.
export const SESSION_GAP_MINUTES = 60;

const MAX_RECAP_MESSAGES = 120;
const MAX_RECAP_CHARS = 40000;

export const INTRO_DIRECTIVE = `Esta é a abertura da campanha; o jogador acabou de chegar e ainda não sabe nada. Faça a introdução:
1. Apresente o mundo e o clima da campanha, usando apenas o que foi definido.
2. Situe cada personagem do grupo: onde está, por que está ali e o que acabou de acontecer, respeitando a ficha e a história de cada um.
3. Apresente a primeira situação com um gancho claro.
4. Explique em poucas linhas como jogar: basta descrever o que o personagem faz ou diz, o Mestre cuida das consequências, e as rolagens são feitas no painel "Rolar dados" quando o Mestre pedir.
5. Termine perguntando o que o jogador faz, sem listar opções de ação.
Registre em memory_updates o que criar. Se a cena abrir em um lugar marcante, inclua-o em illustrations.`;

export async function getSessionState(db, campaignId) {
  const last = await db.get(
    `SELECT created_at, EXTRACT(EPOCH FROM (now() - created_at)) / 60 AS minutes
     FROM messages WHERE campaign_id = ? ORDER BY id DESC LIMIT 1`,
    campaignId,
  );
  const { total: opened } = await db.get(
    `SELECT COUNT(*) AS total FROM campaign_sessions WHERE campaign_id = ? AND kind != 'legacy'`,
    campaignId,
  );
  if (!last) return { status: 'new', number: 0, last_played_at: null };

  const latest = await db.get('SELECT ended_at FROM campaign_sessions WHERE campaign_id = ? ORDER BY id DESC LIMIT 1', campaignId);
  const finished = Boolean(latest?.ended_at) || last.minutes >= SESSION_GAP_MINUTES;
  return { status: finished ? 'returning' : 'active', number: opened, last_played_at: last.created_at };
}

export async function endSession(db, campaignId) {
  const latest = await db.get('SELECT id FROM campaign_sessions WHERE campaign_id = ? ORDER BY id DESC LIMIT 1', campaignId);
  if (latest) {
    await db.run('UPDATE campaign_sessions SET ended_at = now() WHERE id = ?', latest.id);
    return;
  }
  // Campanha com conversa, mas sem abertura registrada.
  const first = await db.get('SELECT MIN(id) AS id FROM messages WHERE campaign_id = ?', campaignId);
  await db.run(
    `INSERT INTO campaign_sessions (campaign_id, kind, first_message_id, ended_at) VALUES (?, 'legacy', ?, now())`,
    campaignId, first.id,
  );
}

/** Marcadores para mostrar o início de cada sessão no chat. */
export async function sessionMarkers(db, campaignId) {
  const rows = await db.all(
    `SELECT kind, first_message_id FROM campaign_sessions WHERE campaign_id = ? AND kind != 'legacy' ORDER BY id`,
    campaignId,
  );
  return new Map(rows.map((row, index) => [row.first_message_id, { kind: row.kind, number: index + 1 }]));
}

async function lastSessionMessages(db, campaignId) {
  const latest = await db.get('SELECT first_message_id FROM campaign_sessions WHERE campaign_id = ? ORDER BY id DESC LIMIT 1', campaignId);
  const select = (fromId, limit) => db.all(
    `SELECT id, sender_name, message_text FROM messages
     WHERE campaign_id = ? AND id >= ? AND visibility = 'all'
       AND id NOT IN (SELECT first_message_id FROM campaign_sessions WHERE kind = 'recap')
     ORDER BY id DESC LIMIT ?`,
    campaignId, fromId, limit,
  );
  const rows = await select(latest?.first_message_id ?? 0, MAX_RECAP_MESSAGES);
  // Se a última sessão só teve o resumo, volta para o que foi jogado antes dela.
  return (rows.length ? rows : await select(0, 40)).reverse();
}

export async function buildRecapDirective(db, campaignId) {
  let transcript = (await lastSessionMessages(db, campaignId))
    .map((row) => `${row.sender_name}: ${row.message_text}`)
    .join('\n');
  if (transcript.length > MAX_RECAP_CHARS) transcript = transcript.slice(-MAX_RECAP_CHARS);

  return `O jogador está voltando à campanha depois de uma pausa. Faça o resumo da última sessão. Não avance a história, não crie acontecimentos novos, não peça rolagens nem consultas, e deixe state_changes, memory_updates, illustrations, gm_rolls, lookup_queries e rule_queries vazios.

Escreva na voz do Mestre, em português, começando por "Na última sessão...":
1. Conte em ordem o que aconteceu, com os nomes de pessoas e lugares e as decisões que os jogadores tomaram.
2. Diga em que situação o grupo parou: onde está, quem está por perto e se há perigo imediato.
3. Lembre as pendências: missões, promessas e pistas em aberto.
4. Termine perguntando o que o jogador faz agora, sem listar opções de ação.
Use apenas o que está registrado; se algo não aparece, não invente.

TRANSCRIÇÃO DA ÚLTIMA SESSÃO:
${transcript}`;
}
