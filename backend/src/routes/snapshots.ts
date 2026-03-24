import { Router } from 'express';
import { z } from 'zod';
import { getDb, type Repository, type Snapshot } from '../db';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { validate, snapshotIdSchema } from '../middleware/validate.js';
import { decrypt } from '../services/crypto.js';
import { deleteSnapshots } from '../services/restic.js';
import { indexRepo } from '../services/indexer.js';
import { auditLog } from '../services/audit.js';
import type { Database } from 'better-sqlite3';

const router: Router = Router({ mergeParams: true });
router.use(requireAuth);

// ── Schemas ───────────────────────────────────────────────────────────────────

const deleteSnapshotsSchema = z.object({
  ids: z
    .array(snapshotIdSchema)
    .min(1, 'At least one snapshot ID is required')
    .max(500, 'Cannot delete more than 500 snapshots at once'),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function canAccessRepo(userId: number, role: string, repoId: string | number): boolean {
  if (role === 'admin') return true;
  const db: Database = getDb();
  const numericId: number = typeof repoId === 'string' ? parseInt(repoId, 10) : repoId;
  return !!db.prepare(
    'SELECT 1 FROM user_repo_permissions WHERE user_id = ? AND repo_id = ?'
  ).get(userId, numericId);
}

// ── GET /api/repos/:repoId/snapshots ─────────────────────────────────────────

router.get('/', (req: import('express').Request<{ repoId: string }>, res): void => {
  const db: Database = getDb();
  const { repoId } = req.params;
  const numericRepoId: number = parseInt(repoId, 10);

  if (!canAccessRepo(req.user!.userId, req.user!.role, numericRepoId)) {
    res.status(404).json({ error: 'Repository not found' });
    return;
  }

  const repo = db.prepare('SELECT id FROM repositories WHERE id = ?').get(numericRepoId);
  if (!repo) {
    res.status(404).json({ error: 'Repository not found' });
    return;
  }

  const snapshots = db.prepare(`
    SELECT s.*, ss.restore_size, ss.added_size, ss.file_count, ss.files_new, ss.files_changed, ss.files_unmodified
    FROM snapshots s
    LEFT JOIN snapshot_stats ss ON ss.snapshot_id = s.snapshot_id
    WHERE s.repo_id = ? ORDER BY s.time DESC
  `).all(numericRepoId) as (Snapshot & {
    restore_size: number | null; added_size: number | null; file_count: number | null;
    files_new: number | null; files_changed: number | null; files_unmodified: number | null;
  })[];

  const parsed = snapshots.map((s) => ({
    ...s,
    tags: s.tags ? JSON.parse(s.tags) : [],
    paths: s.paths ? JSON.parse(s.paths) : [],
  }));

  res.json(parsed);
});

// ── DELETE /api/repos/:repoId/snapshots — admin only ─────────────────────────

router.delete('/', requireAdmin, validate(deleteSnapshotsSchema),
  async (req: import('express').Request<{ repoId: string }>, res): Promise<void> => {
    const db: Database = getDb();
    const { repoId } = req.params;
    const numericRepoId: number = parseInt(repoId, 10);
    const { ids } = req.body as z.infer<typeof deleteSnapshotsSchema>;

    const repo = db.prepare('SELECT * FROM repositories WHERE id = ?').get(numericRepoId) as Repository | undefined;
    if (!repo) {
      res.status(404).json({ error: 'Repository not found' });
      return;
    }

    let password: string | undefined;
    if (repo.password_encrypted) {
      try {
        password = decrypt(repo.password_encrypted);
      } catch {
        res.status(500).json({ error: 'Failed to decrypt repository password' });
        return;
      }
    }

    try {
      await deleteSnapshots(repo.path, ids, password);
      // Re-index after deletion
      await indexRepo(repo);
      auditLog({ eventType: 'snapshots_deleted', req, username: req.user!.username, details: { repoId, repoName: repo.name, count: ids.length, ids } });
      res.json({ ok: true, deleted: ids.length });
    } catch (err) {
      const msg: string = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  }
);

export default router;
