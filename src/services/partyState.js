import { HttpError } from '../middleware/errorHandler.js';
import { COINS } from './sheet.js';

export const STATUSES = ['active', 'unconscious', 'stable', 'dead'];

function boundedInt(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${label} deve ser um inteiro entre ${min} e ${max}.`);
  }
  return value;
}

/**
 * Aplica um ajuste manual ao estado do personagem numa campanha (PV, condições, inventário...).
 * Devolve a linha nova, sem gravar. Usado pelo Solo e pelas mesas em grupo.
 */
export function applyStatePatch(row, body = {}) {
  const next = { ...row };
  if (body.current_hp !== undefined) next.current_hp = boundedInt(body.current_hp, 'Os PV atuais', 0, row.max_hp);
  if (body.temp_hp !== undefined) next.temp_hp = boundedInt(body.temp_hp, 'Os PV temporários', 0, 1000);
  if (body.death_successes !== undefined) next.death_successes = boundedInt(body.death_successes, 'Os sucessos', 0, 3);
  if (body.death_failures !== undefined) next.death_failures = boundedInt(body.death_failures, 'As falhas', 0, 3);
  if (body.hit_dice_used !== undefined) next.hit_dice_used = boundedInt(body.hit_dice_used, 'Os Dados de Vida usados', 0, 20);
  if (body.inspiration !== undefined) next.inspiration = body.inspiration ? 1 : 0;
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) throw new HttpError(400, 'Estado inválido.');
    next.status = body.status;
  }
  if (body.current_hp !== undefined && next.status !== 'dead') {
    if (next.current_hp > 0) {
      next.status = 'active';
      next.death_successes = 0;
      next.death_failures = 0;
    } else if (next.status === 'active') {
      next.status = 'unconscious';
    }
  }
  if (body.coins !== undefined) {
    if (typeof body.coins !== 'object' || body.coins === null) throw new HttpError(400, 'As moedas são inválidas.');
    const current = JSON.parse(row.coins_json);
    for (const coin of COINS) {
      if (body.coins[coin] !== undefined) current[coin] = boundedInt(body.coins[coin], 'As moedas', 0, 10000000);
    }
    next.coins_json = JSON.stringify(current);
  }
  if (body.spell_slots_used !== undefined) {
    if (typeof body.spell_slots_used !== 'object' || body.spell_slots_used === null) throw new HttpError(400, 'Os espaços de magia são inválidos.');
    const used = {};
    for (let circle = 1; circle <= 9; circle += 1) {
      used[circle] = boundedInt(body.spell_slots_used[circle] ?? 0, 'Os espaços usados', 0, 20);
    }
    next.spell_slots_used_json = JSON.stringify(used);
  }
  const textList = (value, label) => {
    if (!Array.isArray(value)) throw new HttpError(400, `${label} deve ser uma lista.`);
    return JSON.stringify(value.map((item) => String(item).trim().slice(0, 100)).filter(Boolean).slice(0, 200));
  };
  if (body.inventory !== undefined) next.inventory_json = textList(body.inventory, 'O inventário');
  if (body.conditions !== undefined) next.conditions_json = textList(body.conditions, 'As condições');
  return next;
}

export function saveState(db, next) {
  return db.run(
    `UPDATE campaign_characters
     SET current_hp = ?, temp_hp = ?, death_successes = ?, death_failures = ?, hit_dice_used = ?, inspiration = ?,
         status = ?, coins_json = ?, spell_slots_used_json = ?, inventory_json = ?, conditions_json = ?
     WHERE id = ?`,
    next.current_hp, next.temp_hp, next.death_successes, next.death_failures, next.hit_dice_used, next.inspiration,
    next.status, next.coins_json, next.spell_slots_used_json, next.inventory_json, next.conditions_json,
    next.id,
  );
}

const STATUS_LABELS = { active: 'ativo', unconscious: 'inconsciente', stable: 'estável', dead: 'morto' };

/** Resumo legível do que mudou, para avisar o jogador quando o Mestre mexe no estado dele. */
export function describeStateChange(before, after) {
  const changes = [];
  if (before.current_hp !== after.current_hp) changes.push(`PV ${before.current_hp} → ${after.current_hp}`);
  if (before.temp_hp !== after.temp_hp) changes.push(`PV temporários ${before.temp_hp} → ${after.temp_hp}`);
  if (before.status !== after.status) changes.push(`estado: ${STATUS_LABELS[after.status] ?? after.status}`);
  if (before.inspiration !== after.inspiration) changes.push(after.inspiration ? 'ganhou Inspiração' : 'usou a Inspiração');
  if (before.conditions_json !== after.conditions_json) {
    const list = JSON.parse(after.conditions_json);
    changes.push(list.length ? `condições: ${list.join(', ')}` : 'sem condições');
  }
  if (before.inventory_json !== after.inventory_json) changes.push('inventário');
  if (before.coins_json !== after.coins_json) changes.push('moedas');
  if (before.spell_slots_used_json !== after.spell_slots_used_json) changes.push('espaços de magia');
  if (before.hit_dice_used !== after.hit_dice_used) changes.push('Dados de Vida');
  if (before.death_successes !== after.death_successes || before.death_failures !== after.death_failures) changes.push('salvaguardas contra a morte');
  return changes;
}
