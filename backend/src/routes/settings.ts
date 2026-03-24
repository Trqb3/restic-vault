import { Router } from 'express';
import { getDb } from '../db';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { restartIndexer } from '../services/indexer.js';
import type { Database } from 'better-sqlite3';

const router: Router = Router();
router.use(requireAuth);

router.get('/', (_req, res): void => {
  const db: Database = getDb();
  const baseDirSetting = db
    .prepare("SELECT value FROM settings WHERE key = 'base_dir'")
    .get() as { value: string } | undefined;
  const intervalSetting = db
    .prepare("SELECT value FROM settings WHERE key = 'index_interval_minutes'")
    .get() as { value: string } | undefined;
  res.json({
    baseDir: baseDirSetting?.value || process.env.REPO_BASE_DIR || '',
    indexIntervalMinutes: parseInt(intervalSetting?.value ?? '15', 10),
  });
});

router.put('/', requireAdmin, (req, res): void => {
  const { baseDir, indexIntervalMinutes } = req.body as {
    baseDir?: string;
    indexIntervalMinutes?: number;
  };

  if (indexIntervalMinutes !== undefined) {
    const interval: number = parseInt(String(indexIntervalMinutes), 10);
    if (isNaN(interval) || interval < 1 || interval > 1440) {
      res.status(400).json({ error: 'indexIntervalMinutes must be between 1 and 1440' });
      return;
    }
    const db: Database = getDb();
    if (baseDir !== undefined) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('base_dir', ?)").run(baseDir);
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('index_interval_minutes', ?)").run(String(interval));
    restartIndexer(interval);
  } else if (baseDir !== undefined) {
    const db: Database = getDb();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('base_dir', ?)").run(baseDir);
  }

  res.json({ ok: true });
});

export default router;
