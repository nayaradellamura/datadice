import { Router } from 'express';
import { characterFor } from '../services/access.js';
import { ABILITIES, CLASSES, COINS, deriveSheet, parseCharacter, publicCharacter, SKILLS } from '../services/sheet.js';

const COLUMNS = [
  'name', 'race', 'class', 'level', 'str', 'dex', 'con', 'int', 'wis', 'cha', 'background', 'alignment',
  'player_name', 'xp', 'armor_class', 'speed', 'hit_die', 'max_hp', 'backstory', 'avatar_url', 'sheet_json',
];
const quoted = (column) => `"${column}"`;

export function characterRoutes(db, { onChanged = async () => {} } = {}) {
  const router = Router();


  router.get('/meta', (_req, res) => {
    res.json({
      abilities: ABILITIES,
      skills: SKILLS,
      coins: COINS,
      classes: CLASSES.map(({ name, hitDie, saves, spell }) => ({ name, hitDie, saves, spell })),
    });
  });

  // Calcula os valores derivados sem gravar, para o formulário mostrar a ficha ao vivo.
  router.post('/preview', (req, res) => {
    const fields = parseCharacter(req.body);
    const sheet = JSON.parse(fields.sheet_json);
    res.json({ ...fields, sheet, sheet_json: undefined, derived: deriveSheet(fields, sheet) });
  });

  router.post('/', async (req, res) => {
    const fields = parseCharacter(req.body);
    const { id } = await db.run(
      `INSERT INTO characters (user_id, ${COLUMNS.map(quoted).join(', ')})
       VALUES (?, ${COLUMNS.map(() => '?').join(', ')}) RETURNING id`,
      req.user.id, ...COLUMNS.map((column) => fields[column]),
    );
    res.status(201).json(publicCharacter(await characterFor(db, req.user, id)));
  });

  // O admin vê todos; cada jogador, só os seus.
  router.get('/', async (req, res) => {
    const rows = req.user.role === 'admin'
      ? await db.all('SELECT * FROM characters ORDER BY id DESC')
      : await db.all('SELECT * FROM characters WHERE user_id = ? ORDER BY id DESC', req.user.id);
    res.json(rows.map(publicCharacter));
  });

  router.get('/:id', async (req, res) => {
    res.json(publicCharacter(await characterFor(db, req.user, req.params.id)));
  });

  router.put('/:id', async (req, res) => {
    const current = await characterFor(db, req.user, req.params.id);
    const fields = parseCharacter(req.body);
    await db.tx(async (t) => {
      await t.run(
        `UPDATE characters SET ${COLUMNS.map((column) => `${quoted(column)} = ?`).join(', ')} WHERE id = ?`,
        ...COLUMNS.map((column) => fields[column]), current.id,
      );

      // Subir de nível soma a diferença de PV; diminuir o máximo apenas limita o valor atual.
      const gained = Math.max(0, fields.max_hp - current.max_hp);
      await t.run(
        `UPDATE campaign_characters
         SET max_hp = ?, current_hp = LEAST(?, current_hp + ?)
         WHERE character_id = ?`,
        fields.max_hp, fields.max_hp, gained, current.id,
      );
    });
    // As mesas em que o personagem está recarregam o grupo.
    await onChanged(current.id);
    res.json(publicCharacter(await characterFor(db, req.user, current.id)));
  });

  return router;
}
