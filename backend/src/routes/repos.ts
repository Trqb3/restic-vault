import { Router } from 'express';
import { z } from 'zod';
import { getDb, type Repository, type RepoStatsRow } from '../db/index.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { validate, idParamsSchema } from '../middleware/validate.js';
import { encrypt, decrypt } from '../services/crypto.js';
import { indexRepo, scanBaseDir } from '../services/indexer.js';
import { getRepoStats } from '../services/restic.js';
import { sshContextForRepo } from '../services/ssh.js';
import { auditLog } from '../services/audit.js';

const router = Router();
router.use(requireAuth);

// ── Schemas ───────────────────────────────────────────────────────────────────

const VALID_REPO_TYPES = ['local', 'sftp', 's3', 'b2', 'azure', 'gs', 'rclone', 'rest', 'swift'] as const;

const createRepoSchema = z.object({
  name: z.string().min(1, 'name is required').max(128),
  path: z.string().min(1, 'path is required').max(4096),
  type: z.enum(VALID_REPO_TYPES).optional().default('local'),
  password: z.string().max(1024).optional(),
  connectionId: z.number().int().positive().optional(),
});

const updateRepoSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  password: z.string().max(1024).optional(),
  clearPassword: z.boolean().optional(),
});

const patchRepoSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  path: z.string().min(1).max(4096).optional(),
  password: z.string().max(1024).optional(),
  connectionId: z.number().int().positive().nullable().optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function canAccessRepo(userId: number, role: string, repoId: string | number): boolean {
  if (role === 'admin') return true;
  const db = getDb();
  return !!db.prepare(
    'SELECT 1 FROM user_repo_permissions WHERE user_id = ? AND repo_id = ?'
  ).get(userId, repoId);
}

// ── GET /api/repos — list all repos ──────────────────────────────────────────

router.get('/', (req, res) => {
  const db = getDb();
  const { userId, role } = req.user!;
  let repos;
  if (role === 'admin') {
    repos = db.prepare(`
      SELECT id, name, path, type, connection_id, last_indexed, status, error_message,
             snapshot_count, last_backup, created_at,
             CASE WHEN password_encrypted IS NOT NULL THEN 1 ELSE 0 END as has_password
      FROM repositories ORDER BY name
    `).all();
  } else {
    repos = db.prepare(`
      SELECT r.id, r.name, r.path, r.type, r.connection_id, r.last_indexed, r.status, r.error_message,
             r.snapshot_count, r.last_backup, r.created_at,
             CASE WHEN r.password_encrypted IS NOT NULL THEN 1 ELSE 0 END as has_password
      FROM repositories r
      INNER JOIN user_repo_permissions p ON p.repo_id = r.id AND p.user_id = ?
      ORDER BY r.name
    `).all(userId);
  }
  res.json(repos);
});

// ── GET /api/repos/:id — get repo details ─────────────────────────────────────

router.get('/:id', validate(idParamsSchema, 'params'), (req, res) => {
  const db = getDb();
  const repoId = req.params.id as string;
  if (!canAccessRepo(req.user!.userId, req.user!.role, repoId)) {
    res.status(404).json({ error: 'Repository not found' });
    return;
  }
  const repo = db.prepare(`
    SELECT id, name, path, type, connection_id, last_indexed, status, error_message,
           snapshot_count, last_backup, created_at,
           CASE WHEN password_encrypted IS NOT NULL THEN 1 ELSE 0 END as has_password
    FROM repositories WHERE id = ?
  `).get(req.params.id) as (Repository & { has_password: number }) | undefined;

  if (!repo) {
    res.status(404).json({ error: 'Repository not found' });
    return;
  }
  res.json(repo);
});

// ── POST /api/repos — add a repo (admin only) ─────────────────────────────────

router.post('/', requireAdmin, validate(createRepoSchema), (req, res) => {
  const { name, path: repoPath, type, password, connectionId } = req.body as z.infer<typeof createRepoSchema>;

  const db = getDb();
  let passwordEncrypted: string | null = null;
  if (password) {
    try {
      passwordEncrypted = encrypt(password);
    } catch {
      res.status(500).json({ error: 'Failed to encrypt password. Is SECRET_KEY set?' });
      return;
    }
  }

  try {
    const result = db.prepare(`
      INSERT INTO repositories (name, path, type, password_encrypted, connection_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, repoPath, type, passwordEncrypted, connectionId ?? null);

    const repo = db.prepare('SELECT * FROM repositories WHERE id = ?').get(result.lastInsertRowid) as Repository;

    // Index asynchronously
    indexRepo(repo).catch(console.error);

    auditLog({ eventType: 'repo_added', req, username: req.user!.username, details: { name, path: repoPath, type } });
    res.status(201).json({ id: result.lastInsertRowid, name, path: repoPath, type });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'A repository with this path already exists' });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

// ── PUT /api/repos/:id — update a repo (admin only) ──────────────────────────

router.put('/:id', requireAdmin, validate(idParamsSchema, 'params'), validate(updateRepoSchema), (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM repositories WHERE id = ?').get(req.params.id) as Repository | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Repository not found' });
    return;
  }

  const { name, password, clearPassword } = req.body as z.infer<typeof updateRepoSchema>;

  let passwordEncrypted = existing.password_encrypted;
  if (clearPassword) {
    passwordEncrypted = null;
  } else if (password) {
    try {
      passwordEncrypted = encrypt(password);
    } catch {
      res.status(500).json({ error: 'Failed to encrypt password' });
      return;
    }
  }

  db.prepare(`
    UPDATE repositories SET name = ?, password_encrypted = ? WHERE id = ?
  `).run(name ?? existing.name, passwordEncrypted, existing.id);

  res.json({ ok: true });
});

// ── DELETE /api/repos/:id — remove a repo (admin only) ───────────────────────

router.delete('/:id', requireAdmin, validate(idParamsSchema, 'params'), (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT name, path FROM repositories WHERE id = ?').get(req.params.id) as { name: string; path: string } | undefined;
  const result = db.prepare('DELETE FROM repositories WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Repository not found' });
    return;
  }
  auditLog({ eventType: 'repo_deleted', req, username: req.user!.username, details: { id: req.params.id, name: existing?.name, path: existing?.path } });
  res.json({ ok: true });
});

// ── POST /api/repos/:id/refresh — re-index a specific repo (admin only) ───────

router.post('/:id/refresh', requireAdmin, validate(idParamsSchema, 'params'), async (req, res) => {
  const db = getDb();
  const repo = db.prepare('SELECT * FROM repositories WHERE id = ?').get(req.params.id) as Repository | undefined;
  if (!repo) {
    res.status(404).json({ error: 'Repository not found' });
    return;
  }

  try {
    await indexRepo(repo);
    const updated = db.prepare(`
      SELECT id, name, path, type, last_indexed, status, error_message,
             snapshot_count, last_backup, created_at
      FROM repositories WHERE id = ?
    `).get(repo.id);
    res.json(updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── POST /api/repos/scan — scan base dir for new repos (admin only) ───────────
//  Note: must be registered BEFORE /:id routes to avoid being caught as an id.

router.post('/scan', requireAdmin, async (_req, res) => {
  const db = getDb();
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'base_dir'").get() as { value: string } | undefined;
  const baseDir = setting?.value || process.env.REPO_BASE_DIR;

  if (!baseDir) {
    res.status(400).json({ error: 'No base directory configured. Set REPO_BASE_DIR or configure it in settings.' });
    return;
  }

  try {
    const paths = await scanBaseDir(baseDir);
    const added: string[] = [];

    for (const repoPath of paths) {
      try {
        const result = db.prepare(`
          INSERT OR IGNORE INTO repositories (name, path, type)
          VALUES (?, ?, 'local')
        `).run(repoPath.split('/').pop() || repoPath, repoPath);

        if (result.changes > 0) {
          added.push(repoPath);
          const repo = db.prepare('SELECT * FROM repositories WHERE path = ?').get(repoPath) as Repository;
          indexRepo(repo).catch(console.error);
        }
      } catch {
        // skip
      }
    }

    res.json({ found: paths.length, added: added.length, newPaths: added });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── Snapshot distribution helpers ─────────────────────────────────────────────

interface SnapshotDistributions {
  avg_snapshot_size: number | null;
  avg_interval_seconds: number | null;
  backup_by_weekday: Record<number, number>;
  backup_by_hour: Record<number, number>;
}

function computeSnapshotDistributions(repoId: string | number): SnapshotDistributions {
  const db = getDb();

  const { avg_snapshot_size } = db.prepare(`
    SELECT CAST(AVG(restore_size) AS INTEGER) as avg_snapshot_size
    FROM snapshot_stats WHERE repo_id = ? AND restore_size IS NOT NULL
  `).get(repoId) as { avg_snapshot_size: number | null };

  const { avg_interval_seconds } = db.prepare(`
    SELECT CAST(AVG(gap) AS INTEGER) as avg_interval_seconds FROM (
      SELECT time - LAG(time) OVER (ORDER BY time) AS gap
      FROM snapshots WHERE repo_id = ?
    ) WHERE gap IS NOT NULL
  `).get(repoId) as { avg_interval_seconds: number | null };

  const weekdayRows = db.prepare(`
    SELECT (CAST(strftime('%w', datetime(time, 'unixepoch')) AS INTEGER) + 6) % 7 AS dow,
           COUNT(*) AS cnt
    FROM snapshots WHERE repo_id = ?
    GROUP BY dow
  `).all(repoId) as { dow: number; cnt: number }[];

  const hourRows = db.prepare(`
    SELECT CAST(strftime('%H', datetime(time, 'unixepoch')) AS INTEGER) AS hour,
           COUNT(*) AS cnt
    FROM snapshots WHERE repo_id = ?
    GROUP BY hour
  `).all(repoId) as { hour: number; cnt: number }[];

  const backup_by_weekday: Record<number, number> = {};
  for (let i = 0; i <= 6; i++) backup_by_weekday[i] = 0;
  for (const { dow, cnt } of weekdayRows) backup_by_weekday[dow] = cnt;

  const backup_by_hour: Record<number, number> = {};
  for (let i = 0; i <= 23; i++) backup_by_hour[i] = 0;
  for (const { hour, cnt } of hourRows) backup_by_hour[hour] = cnt;

  return { avg_snapshot_size, avg_interval_seconds, backup_by_weekday, backup_by_hour };
}

// ── GET /api/repos/:id/stats — repo-level stats ───────────────────────────────

router.get('/:id/stats', validate(idParamsSchema, 'params'), async (req, res) => {
  const repoId = req.params.id as string;
  if (!canAccessRepo(req.user!.userId, req.user!.role, repoId)) {
    res.status(404).json({ error: 'Repository not found' }); return;
  }
  const db = getDb();
  const repo = db.prepare('SELECT * FROM repositories WHERE id = ?').get(repoId) as Repository | undefined;
  if (!repo) { res.status(404).json({ error: 'Repository not found' }); return; }

  // Fast path: return cached repo_stats if available
  const cached = db.prepare('SELECT * FROM repo_stats WHERE repo_id = ?').get(repo.id) as RepoStatsRow | undefined;
  if (cached) {
    let tags: string[] = [];
    try { tags = JSON.parse(cached.tags ?? '[]') as string[]; } catch { /* empty */ }
    const dist = computeSnapshotDistributions(repo.id);
    res.json({
      total_restore_size: cached.total_restore_size,
      total_file_count: cached.total_file_count,
      deduplicated_size: cached.deduplicated_size,
      snapshot_count: cached.snapshot_count,
      oldest_snapshot: cached.oldest_snapshot,
      newest_snapshot: cached.newest_snapshot,
      hostnames: cached.hostnames ? cached.hostnames.split(',').filter(Boolean) : [],
      tags,
      compression_ratio: cached.compression_ratio,
      total_blob_count: cached.total_blob_count,
      fetched_at: cached.fetched_at,
      ...dist,
    });
    return;
  }

  // Slow path: not yet cached — run live
  let password: string | undefined;
  if (repo.password_encrypted) {
    try { password = decrypt(repo.password_encrypted); }
    catch { res.status(500).json({ error: 'Failed to decrypt password' }); return; }
  }

  const meta = db.prepare(`
    SELECT COUNT(*) as snapshot_count, MIN(time) as oldest_snapshot, MAX(time) as newest_snapshot,
           GROUP_CONCAT(DISTINCT hostname) as hostnames, GROUP_CONCAT(tags) as all_tags
    FROM snapshots WHERE repo_id = ?
  `).get(repoId) as {
    snapshot_count: number; oldest_snapshot: number | null; newest_snapshot: number | null;
    hostnames: string | null; all_tags: string | null;
  };

  const sshCtx = await sshContextForRepo(repo.connection_id).catch(() => null);
  try {
    const sshArgs = sshCtx?.extraArgs ?? [];
    const [restoreStats, rawStats] = await Promise.all([
      getRepoStats(repo.path, password, undefined, sshArgs),
      getRepoStats(repo.path, password, 'raw-data', sshArgs),
    ]);
    const tagSet = new Set<string>();
    if (meta.all_tags) {
      for (const chunk of meta.all_tags.split(',')) {
        try { (JSON.parse(chunk) as string[]).forEach(t => tagSet.add(t)); } catch { /* skip */ }
      }
    }
    const dist = computeSnapshotDistributions(repoId);
    res.json({
      total_restore_size: restoreStats.total_size,
      total_file_count: restoreStats.total_file_count,
      deduplicated_size: rawStats.total_size,
      snapshot_count: meta.snapshot_count,
      oldest_snapshot: meta.oldest_snapshot,
      newest_snapshot: meta.newest_snapshot,
      hostnames: meta.hostnames ? meta.hostnames.split(',').filter(Boolean) : [],
      tags: [...tagSet],
      compression_ratio: restoreStats.compression_ratio,
      total_blob_count: rawStats.total_blob_count,
      fetched_at: null,
      ...dist,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  } finally {
    sshCtx?.cleanup();
  }
});

// ── GET /api/repos/:id/size-history — deduplicated size over time ─────────────

router.get('/:id/size-history', validate(idParamsSchema, 'params'), (req, res) => {
  const repoId = req.params.id as string;
  if (!canAccessRepo(req.user!.userId, req.user!.role, repoId)) {
    res.status(404).json({ error: 'Repository not found' });
    return;
  }
  const db = getDb();
  const days = Math.min(parseInt(req.query['days'] as string) || 90, 365);
  const since = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const history = db.prepare(`
    SELECT recorded_at, deduplicated_size, total_restore_size, snapshot_count
    FROM repo_size_history
    WHERE repo_id = ? AND recorded_at > ?
    ORDER BY recorded_at ASC
  `).all(repoId, since) as Array<{
    recorded_at: number;
    deduplicated_size: number;
    total_restore_size: number | null;
    snapshot_count: number | null;
  }>;
  res.json(history);
});

// ── PATCH /api/repos/:id — partial update (admin only) ───────────────────────

router.patch('/:id', requireAdmin, validate(idParamsSchema, 'params'), validate(patchRepoSchema), (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM repositories WHERE id = ?').get(req.params.id) as Repository | undefined;
  if (!existing) { res.status(404).json({ error: 'Repository not found' }); return; }

  const { name, path: newPath, password, connectionId } = req.body as z.infer<typeof patchRepoSchema>;

  let passwordEncrypted = existing.password_encrypted;
  if (password && password.trim() !== '') {
    try { passwordEncrypted = encrypt(password); }
    catch { res.status(500).json({ error: 'Failed to encrypt password' }); return; }
  }

  // connectionId: undefined = keep existing, null = clear, number = set new
  const newConnectionId = connectionId === undefined ? existing.connection_id : connectionId;

  db.prepare(`
    UPDATE repositories SET name = ?, path = ?, password_encrypted = ?, connection_id = ? WHERE id = ?
  `).run(name ?? existing.name, newPath ?? existing.path, passwordEncrypted, newConnectionId, existing.id);

  res.json({ ok: true });
});

export default router;
