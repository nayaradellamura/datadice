import { isAdmin } from '../middleware/auth.js';
import { HttpError } from '../middleware/errorHandler.js';
import { asId } from '../http/validate.js';

// O que é de outro jogador responde "não encontrado": nem confirma que existe.
// campaignFor é só para o modo Solo (Mestre IA). As mesas em grupo têm regras próprias (services/tables.js):
// nem o admin entra nelas por aqui, e as rotas de IA não funcionam numa mesa.

// Ids fora do intervalo de um integer do PostgreSQL dariam erro no banco; tratamos como "não existe".

export async function campaignFor(db, user, id) {
  const campaign = asId(id) && (await db.get(`SELECT * FROM campaigns WHERE id = ? AND mode = 'solo'`, asId(id)));
  if (!campaign || (!isAdmin(user) && campaign.user_id !== user.id)) throw new HttpError(404, 'Campanha não encontrada.');
  return campaign;
}

export async function characterFor(db, user, id) {
  const character = asId(id) && (await db.get('SELECT * FROM characters WHERE id = ?', asId(id)));
  if (!character || (!isAdmin(user) && character.user_id !== user.id)) throw new HttpError(404, 'Personagem não encontrado.');
  return character;
}

export async function visualCampaignFor(db, user, table, id) {
  const row = asId(id) && (await db.get(`SELECT campaign_id FROM ${table} WHERE id = ?`, asId(id)));
  if (!row) throw new HttpError(404, 'Imagem não encontrada.');
  return campaignFor(db, user, row.campaign_id);
}
