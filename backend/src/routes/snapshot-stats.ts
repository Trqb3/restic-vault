import { Router } from 'express';
import { z } from 'zod';
import { getDb, type Repository, type Snapshot, type SnapshotStats } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { validate, snapshotIdSchema } from '../middleware/validate.js';
import { decrypt } from '../services/crypto.js';
import { getSnapshotStats, getSnapshotDiff } from '../services/restic.js';

const router = Router({ mergeParams: true });
router.use(requireAuth);

// ── Helpers ───────────────────────────────────────────────────────────────────

function canAccessRepo(userId: number, role: string, repoId: string | number): boolean {
  if (role === 'admin') return true;
  const db = getDb();
  return !!db.prepare(
    'SELECT 1 FROM user_repo_permissions WHERE user_id = ? AND repo_id = ?'
  ).get(userId, repoId);
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const statsParamsSchema = z.object({ snapshotId: snapshotIdSchema });

// ── GET /api/repos/:repoId/snapshots/:snapshotId/stats ────────────────────────

router.get('/:snapshotId/stats',
  validate(statsParamsSchema, 'params'),
  async (req: import('express').Request<{ repoId: string; snapshotId: string }>, res) => {
    const { repoId, snapshotId } = req.params;
    const db = getDb();

    // Authorization: viewer must have explicit permission
    if (!canAccessRepo(req.user!.userId, req.user!.role, repoId)) {
      res.status(404).json({ error: 'Repository not found' });
      return;
    }

    const repo = db.prepare('SELECT * FROM repositories WHERE id = ?').get(repoId) as Repository | undefined;
    if (!repo) { res.status(404).json({ error: 'Repository not found' }); return; }

    // Return cached result if available
    const cached = db.prepare(
      'SELECT * FROM snapshot_stats WHERE snapshot_id = ? AND repo_id = ?'
    ).get(snapshotId, repoId) as SnapshotStats | undefined;
    if (cached) { res.json(cached); return; }

    // Get snapshot with parent from DB
    const snap = db.prepare(
      'SELECT snapshot_id, parent FROM snapshots WHERE snapshot_id = ? AND repo_id = ?'
    ).get(snapshotId, repoId) as Pick<Snapshot, 'snapshot_id' | 'parent'> | undefined;
    if (!snap) { res.status(404).json({ error: 'Snapshot not found' }); return; }

    let password: string | undefined;
    if (repo.password_encrypted) {
      try { password = decrypt(repo.password_encrypted); }
      catch { res.status(500).json({ error: 'Failed to decrypt password' }); return; }
    }

    // Use chronologically previous snapshot from same host AND same paths
    const snapFull = db.prepare(
      'SELECT hostname, time, paths FROM snapshots WHERE snapshot_id = ? AND repo_id = ?'
    ).get(snapshotId, repoId) as { hostname: string | null; time: number; paths: string | null } | undefined;

    let prevId: string | null = null;
    if (snapFull?.hostname) {
      const snapPaths = (() => {
        try { return (JSON.parse(snapFull.paths ?? '[]') as string[]).sort().join(','); }
        catch { return ''; }
      })();

      const candidates = db.prepare(`
        SELECT snapshot_id, paths FROM snapshots
        WHERE repo_id = ? AND hostname = ? AND time < ?
        ORDER BY time DESC
      `).all(repoId, snapFull.hostname, snapFull.time) as { snapshot_id: string; paths: string | null }[];

      const prev = candidates.find((c) => {
        try { return (JSON.parse(c.paths ?? '[]') as string[]).sort().join(',') === snapPaths; }
        catch { return false; }
      });
      prevId = prev?.snapshot_id ?? null;
    }

    const [statsResult, diffResult] = await Promise.allSettled([
      getSnapshotStats(repo.path, snapshotId, password),
      prevId
        ? getSnapshotDiff(repo.path, prevId, snapshotId, password)
        : Promise.resolve({ added_size: null, removed_size: null, files_new: null, files_changed: null, files_unmodified: null, net_count_change: null }),
    ]);

    const restore_size      = statsResult.status === 'fulfilled' ? statsResult.value.restore_size    : null;
    const file_count        = statsResult.status === 'fulfilled' ? statsResult.value.file_count      : null;
    const diffVal           = diffResult.status === 'fulfilled' ? diffResult.value : null;
    let   added_size        = diffVal?.added_size != null
                                ? diffVal.added_size - (diffVal.removed_size ?? 0)
                                : null;
    let   files_new         = diffVal?.files_new        ?? null;
    let   files_changed     = diffVal?.files_changed     ?? null;
    let   files_unmodified  = diffVal?.files_unmodified  ?? null;
    const fetched_at        = new Date().toISOString();

    if (files_unmodified === null && files_new !== null && files_changed !== null && file_count !== null) {
      files_unmodified = Math.max(0, file_count - files_new - files_changed);
    }

    if (prevId) {
      if (added_size === null && restore_size !== null) {
        const prevCached = db.prepare(
          'SELECT restore_size FROM snapshot_stats WHERE snapshot_id = ?'
        ).get(prevId) as { restore_size: number | null } | undefined;
        if (prevCached?.restore_size != null) {
          added_size = restore_size - prevCached.restore_size;
        }
      }
    } else if (snapFull?.hostname) {
      added_size       = restore_size;
      files_new        = file_count;
      files_changed    = 0;
      files_unmodified = 0;
    }

    db.prepare(`
      INSERT OR REPLACE INTO snapshot_stats
        (snapshot_id, repo_id, restore_size, added_size, file_count, files_new, files_changed, files_unmodified, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(snapshotId, Number(repoId), restore_size, added_size, file_count, files_new, files_changed, files_unmodified, fetched_at);

    res.json({
      snapshot_id: snapshotId,
      repo_id: Number(repoId),
      restore_size,
      added_size,
      file_count,
      files_new,
      files_changed,
      files_unmodified,
      fetched_at,
    });
  }
);

export default router;
