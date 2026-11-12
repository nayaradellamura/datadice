import { COINS } from './sheet.js';

function parse(value, fallback) {
  try {
    return JSON.parse(value) ?? fallback;
  } catch {
    return fallback;
  }
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const asInt = (value) => (Number.isInteger(value) ? value : 0);
const asList = (value) => (Array.isArray(value) ? value : []);
const clean = (value) => String(value ?? '').trim().slice(0, 100);

function removeFrom(list, names) {
  for (const name of asList(names)) {
    const target = clean(name).toLowerCase();
    const index = list.findIndex((entry) => entry.toLowerCase() === target);
    if (index >= 0) list.splice(index, 1);
  }
}

/** PV ganhos ou perdidos: o dano consome primeiro os PV temporários. */
export function nextVitals(row, change) {
  const delta = asInt(change.hp_delta);
  let temp = Number.isInteger(change.temp_hp) ? clamp(change.temp_hp, 0, 1000) : row.temp_hp;
  let hp = row.current_hp;

  if (delta < 0) {
    const absorbed = Math.min(temp, -delta);
    temp -= absorbed;
    hp = Math.max(0, hp + delta + absorbed);
  } else {
    hp = Math.min(row.max_hp, hp + delta);
  }

  let { status, death_successes: successes, death_failures: failures } = row;
  if (hp === 0 && status === 'active') status = 'unconscious';
  if (hp > 0 && (status === 'unconscious' || status === 'stable')) status = 'active';
  if (hp > 0) {
    successes = 0;
    failures = 0;
  }
  return { hp, temp, status, successes, failures };
}

/** Aplica as mudanças vindas do Mestre, ignorando personagens e valores inválidos. */
export async function applyStateChanges(db, campaignId, changes) {
  for (const change of asList(changes)) {
    // O id vem do modelo: só um inteiro vai para a consulta.
    if (!Number.isInteger(change?.character_id)) continue;
    const row = await db.get(
      `SELECT cc.*, c.hit_die, c.level, c.sheet_json FROM campaign_characters cc
       JOIN characters c ON c.id = cc.character_id
       WHERE cc.campaign_id = ? AND cc.character_id = ?`,
      campaignId, change.character_id,
    );
    if (!row) continue;

    const inventory = parse(row.inventory_json, []);
    removeFrom(inventory, change.inventory_remove);
    for (const item of asList(change.inventory_add)) {
      if (clean(item)) inventory.push(clean(item));
    }

    const conditions = parse(row.conditions_json, []);
    removeFrom(conditions, change.conditions_remove);
    for (const item of asList(change.conditions_add)) {
      const name = clean(item);
      if (name && !conditions.some((entry) => entry.toLowerCase() === name.toLowerCase())) conditions.push(name);
    }

    const coins = parse(row.coins_json, {});
    for (const coin of COINS) {
      coins[coin] = Math.max(0, asInt(coins[coin]) + asInt(change.coins_delta?.[coin]));
    }

    const totals = parse(row.sheet_json, {}).spell_slots ?? {};
    const used = parse(row.spell_slots_used_json, {});
    for (const entry of asList(change.spell_slots_used)) {
      const circle = asInt(entry?.level);
      if (circle < 1 || circle > 9) continue;
      used[circle] = clamp(asInt(used[circle]) + asInt(entry.count), 0, asInt(totals[circle]));
    }

    const vitals = nextVitals(row, change);
    if (Number.isInteger(change.xp_gain)) {
      await db.run('UPDATE characters SET xp = GREATEST(0, xp + ?) WHERE id = ?', clamp(change.xp_gain, -1000000, 1000000), row.character_id);
    }

    await db.run(
      `UPDATE campaign_characters
       SET current_hp = ?, temp_hp = ?, status = ?, death_successes = ?, death_failures = ?,
           inventory_json = ?, coins_json = ?, spell_slots_used_json = ?, conditions_json = ?, inspiration = ?
       WHERE id = ?`,
      vitals.hp, vitals.temp, vitals.status, vitals.successes, vitals.failures,
      JSON.stringify(inventory), JSON.stringify(coins), JSON.stringify(used), JSON.stringify(conditions),
      typeof change.inspiration === 'boolean' ? Number(change.inspiration) : row.inspiration,
      row.id,
    );
  }
}
