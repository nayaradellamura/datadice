import { randomInt } from 'node:crypto';
import { HttpError } from '../middleware/errorHandler.js';
import { asId } from '../http/validate.js';

/** Mesas em grupo: Mestre humano, até MAX_PLAYERS jogadores, entrada por código com aprovação. */
export const MAX_PLAYERS = 6;
// Pedidos esperando resposta numa mesa; acima disso, novos pedidos são recusados.
export const MAX_PENDING = 20;
// Mesas que uma conta pode ter como Mestre.
export const MAX_TABLES_AS_GM = 20;

// Sem letras e números que se confundem (O/0, I/1, L). 32^8 combinações: impossível de adivinhar no chute.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export function newJoinCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** "k7qf-m2xa", " K7QF M2XA " e "K7QFM2XA" valem o mesmo código. */
export function normalizeJoinCode(value) {
  return typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}

/** Como o código aparece para as pessoas: K7QF-M2XA. */
export const formatJoinCode = (code) => (code ? `${code.slice(0, 4)}-${code.slice(4)}` : null);


/**
 * A mesa e o papel de quem pede. Só membros ativos entram; para os outros (inclusive o admin, que não
 * lê as mesas dos outros) a mesa "não existe". Com gm: true, só o Mestre passa.
 */
export async function tableFor(db, user, id, { gm = false } = {}) {
  const tableId = asId(id);
  const table = tableId && (await db.get(
    `SELECT c.*, m.role AS my_role
     FROM campaigns c JOIN campaign_members m ON m.campaign_id = c.id
     WHERE c.id = ? AND c.mode = 'grupo' AND m.user_id = ? AND m.status = 'ativo'`,
    tableId, user.id,
  ));
  if (!table) throw new HttpError(404, 'Mesa não encontrada.');
  if (gm && table.my_role !== 'mestre') throw new HttpError(403, 'Só o Mestre da mesa pode fazer isso.');
  return table;
}

/** Liga uma ficha à campanha. O equipamento e as moedas da ficha são o ponto de partida do estado. */
export async function linkCharacter(t, campaignId, character) {
  const sheet = JSON.parse(character.sheet_json);
  const inventory = (sheet.equipment ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  return t.run(
    `INSERT INTO campaign_characters (campaign_id, character_id, current_hp, max_hp, inventory_json, coins_json)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (campaign_id, character_id) DO NOTHING`,
    campaignId, character.id, character.max_hp, character.max_hp, JSON.stringify(inventory), JSON.stringify(sheet.coins ?? {}),
  );
}

/** Tira da mesa as fichas de uma pessoa (ao sair, ser removida ou trocar de ficha). */
export function unlinkCharactersOf(t, campaignId, userId) {
  return t.run(
    `DELETE FROM campaign_characters cc USING characters ch
     WHERE cc.character_id = ch.id AND cc.campaign_id = ? AND ch.user_id = ?`,
    campaignId, userId,
  );
}
