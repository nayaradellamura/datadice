// Tipos de lugar que têm ilustração própria na faixa do topo do chat (desenhadas no navegador, sem custo).
export const SCENE_PLACES = [
  'taverna', 'cidade', 'vila', 'castelo', 'floresta', 'estrada', 'campo', 'montanha', 'caverna', 'masmorra',
  'ruinas', 'templo', 'mar', 'pantano', 'deserto', 'acampamento',
];
export const SCENE_TIMES = ['amanhecer', 'dia', 'entardecer', 'noite'];

export const SCENE_SCHEMA = {
  type: 'object',
  properties: {
    place: { type: 'string', enum: SCENE_PLACES },
    time: { type: 'string', enum: SCENE_TIMES },
    name: { type: 'string' },
  },
  required: ['place', 'time', 'name'],
};

/** Confere o que o modelo mandou; devolve null se não servir. */
export function cleanScene(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const place = SCENE_PLACES.includes(raw.place) ? raw.place : null;
  if (!place) return null;
  const time = SCENE_TIMES.includes(raw.time) ? raw.time : 'dia';
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 80) : '';
  return { place, time, name };
}

export async function getScene(db, campaignId) {
  const row = await db.get('SELECT scene_json FROM campaigns WHERE id = ?', campaignId);
  try {
    return row?.scene_json ? cleanScene(JSON.parse(row.scene_json)) : null;
  } catch {
    return null;
  }
}

export async function saveScene(db, campaignId, scene) {
  if (scene) await db.run('UPDATE campaigns SET scene_json = ? WHERE id = ?', JSON.stringify(scene), campaignId);
}
