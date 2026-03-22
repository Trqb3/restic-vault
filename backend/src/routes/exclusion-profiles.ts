import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import type { ExclusionProfile } from '../db/index.js';

const router = Router();
router.use(requireAuth, requireAdmin);

const profileSchema = z.object({
  name:        z.string().min(1).max(128).trim(),
  description: z.string().max(512).optional(),
  patterns:    z.array(z.string().max(512)).max(200),
});

router.get('/', (_req, res) => {
  res.json(getDb().prepare('SELECT * FROM exclusion_profiles ORDER BY name ASC').all());
});

router.post('/', validate(profileSchema), (req, res) => {
  const { name, description, patterns } = req.body as z.infer<typeof profileSchema>;
  const result = getDb().prepare(`
    INSERT INTO exclusion_profiles (name, description, patterns)
    VALUES (?, ?, ?)
  `).run(name, description ?? null, JSON.stringify(patterns));
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

router.patch('/:id', validate(profileSchema.partial()), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id as string, 10);
  if (!db.prepare('SELECT 1 FROM exclusion_profiles WHERE id = ?').get(id)) {
    res.status(404).json({ error: 'Not found' }); return;
  }
  const { name, description, patterns } = req.body as Partial<z.infer<typeof profileSchema>>;
  db.prepare(`
    UPDATE exclusion_profiles SET
      name        = COALESCE(?, name),
      description = COALESCE(?, description),
      patterns    = COALESCE(?, patterns)
    WHERE id = ?
  `).run(
    name        ?? null,
    description ?? null,
    patterns    ? JSON.stringify(patterns) : null,
    id,
  );
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  getDb().prepare('DELETE FROM exclusion_profiles WHERE id = ?').run(parseInt(req.params.id as string, 10));
  res.json({ ok: true });
});

export default router;
