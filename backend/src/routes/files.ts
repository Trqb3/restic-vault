import { Router } from 'express';
import { z } from 'zod';
import path from 'path';
import { getDb, type Repository } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { validate, snapshotIdSchema } from '../middleware/validate.js';
import { decrypt } from '../services/crypto.js';
import { listFiles, streamFile, streamDirectory } from '../services/restic.js';

const router = Router({ mergeParams: true });
router.use(requireAuth);

// ── Schemas ───────────────────────────────────────────────────────────────────

const snapshotParamsSchema = z.object({ snapshotId: snapshotIdSchema });

// ── Helpers ───────────────────────────────────────────────────────────────────

function canAccessRepo(userId: number, role: string, repoId: string | number): boolean {
  if (role === 'admin') return true;
  const db = getDb();
  return !!db.prepare(
    'SELECT 1 FROM user_repo_permissions WHERE user_id = ? AND repo_id = ?'
  ).get(userId, repoId);
}

function getRepoAndPassword(
  repoId: string,
  userId: number,
  role: string
): { repo: Repository; password: string | undefined } | null {
  if (!canAccessRepo(userId, role, repoId)) return null;
  const db = getDb();
  const repo = db.prepare('SELECT * FROM repositories WHERE id = ?').get(repoId) as Repository | undefined;
  if (!repo) return null;

  let password: string | undefined;
  if (repo.password_encrypted) {
    password = decrypt(repo.password_encrypted);
  }
  return { repo, password };
}

/**
 * Decode and validate a file path from query params.
 * Must be absolute, no `..` segments, no null bytes.
 */
function decodePath(raw: string | undefined): string | null {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  // Must start with '/', must not contain '..' segments, no null bytes
  if (
    !decoded.startsWith('/') ||
    decoded.includes('\0') ||
    decoded.split('/').includes('..') ||
    decoded.split('/').some(seg => seg === '.')
  ) return null;
  return decoded;
}

// ── GET /api/repos/:repoId/snapshots/:snapshotId/ls?path=/ ───────────────────

router.get('/:snapshotId/ls',
  validate(snapshotParamsSchema, 'params'),
  async (req: import('express').Request<{ repoId: string; snapshotId: string }>, res) => {
    const { repoId, snapshotId } = req.params;
    const dirPath = (req.query.path as string) || '/';

    const validPath = decodePath(dirPath);
    if (!validPath) {
      res.status(400).json({ error: 'path query parameter must be an absolute path' });
      return;
    }

    const result = getRepoAndPassword(repoId, req.user!.userId, req.user!.role);
    if (!result) {
      res.status(404).json({ error: 'Repository not found' });
      return;
    }

    try {
      const { snapshot, nodes } = await listFiles(
        result.repo.path,
        snapshotId,
        validPath,
        result.password
      );
      res.json({ snapshot, nodes, path: validPath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  }
);

// ── GET /api/repos/:repoId/snapshots/:snapshotId/download?path=/file.txt ─────

router.get('/:snapshotId/download',
  validate(snapshotParamsSchema, 'params'),
  (req: import('express').Request<{ repoId: string; snapshotId: string }>, res) => {
    const { repoId, snapshotId } = req.params;
    const filePath = decodePath(req.query.path as string);

    if (!filePath) {
      res.status(400).json({ error: 'path query parameter is required and must be absolute' });
      return;
    }

    const result = getRepoAndPassword(repoId, req.user!.userId, req.user!.role);
    if (!result) {
      res.status(404).json({ error: 'Repository not found' });
      return;
    }

    const filename = path.basename(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    streamFile(result.repo.path, snapshotId, filePath, result.password, res);
  }
);

// ── GET /api/repos/:repoId/snapshots/:snapshotId/download-dir?path=/some/dir ─

router.get('/:snapshotId/download-dir',
  validate(snapshotParamsSchema, 'params'),
  (req: import('express').Request<{ repoId: string; snapshotId: string }>, res) => {
    const { repoId, snapshotId } = req.params;
    const dirPath = decodePath(req.query.path as string);

    if (!dirPath) {
      res.status(400).json({ error: 'path query parameter is required and must be absolute' });
      return;
    }

    const result = getRepoAndPassword(repoId, req.user!.userId, req.user!.role);
    if (!result) {
      res.status(404).json({ error: 'Repository not found' });
      return;
    }

    const dirname = path.basename(dirPath) || 'archive';
    res.setHeader('Content-Disposition', `attachment; filename="${dirname}.tar"`);
    res.setHeader('Content-Type', 'application/x-tar');

    streamDirectory(result.repo.path, snapshotId, dirPath, result.password, res);
  }
);

export default router;
