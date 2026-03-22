import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { generateToken, verifyToken, cacheAuthResult, getCachedAuth, evictSourceFromCache } from '../services/token.js';
import { ensureSourceDir } from '../services/rest-server.js';
import { auditLog } from '../services/audit.js';
import { fireNotificationEvent } from '../services/notifications.js';
import type { BackupSource, AgentCommand, SourceExclusionRule } from '../db/index.js';

const router = Router();

// ── Schemas ───────────────────────────────────────────────────────────────────

const createSourceSchema = z.object({
  name:        z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/, 'Name may only contain lowercase letters, digits, hyphens and underscores'),
  description: z.string().max(256).optional(),
});

const updateSourceSchema = z.object({
  description: z.string().max(256).optional(),
  disabled:    z.boolean().optional(),
});

const exclusionRuleSchema = z.object({
  profileId:      z.number().int().positive().nullable().optional(),
  customPatterns: z.array(z.string().max(512)).max(200).optional(),
  backupPaths:    z.array(z.string().max(4096)).max(100).optional(),
});

const discoverSchema = z.object({
  paths: z.array(z.object({
    path:       z.string().max(4096),
    size_bytes: z.number().int().nonnegative().optional(),
    file_count: z.number().int().nonnegative().optional(),
  })).max(1000),
});

const backupResultSchema = z.object({
  commandId:    z.number().int().positive().optional(),
  status:       z.enum(['success', 'failure']),
  errorMessage: z.string().max(2048).optional(),
  snapshotId:   z.string().optional(),
});

// ── Admin: CRUD ───────────────────────────────────────────────────────────────

/** GET /api/sources  — list all sources (admin only) */
router.get('/', requireAuth, requireAdmin, (_req, res) => {
  const rows = getDb().prepare(`
    SELECT bs.*, r.name AS repo_name, r.path AS repo_path
    FROM backup_sources bs
    LEFT JOIN repositories r ON r.id = bs.repo_id
    ORDER BY bs.created_at DESC
  `).all();
  res.json(rows);
});

/** GET /api/sources/:id */
router.get('/:id', requireAuth, requireAdmin, (req, res) => {
  const row = getDb().prepare(`
    SELECT bs.*, r.name AS repo_name, r.path AS repo_path
    FROM backup_sources bs
    LEFT JOIN repositories r ON r.id = bs.repo_id
    WHERE bs.id = ?
  `).get(parseInt(req.params.id as string, 10)) as (BackupSource & { repo_name: string | null; repo_path: string | null }) | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(row);
});

/** POST /api/sources  — create new source, returns raw token (shown once) */
router.post('/', requireAuth, requireAdmin, validate(createSourceSchema), async (req, res) => {
  const { name, description } = req.body as z.infer<typeof createSourceSchema>;
  const db = getDb();

  // Check name uniqueness
  if (db.prepare('SELECT 1 FROM backup_sources WHERE name = ?').get(name)) {
    res.status(409).json({ error: 'A source with this name already exists' });
    return;
  }

  const { raw, hash } = await generateToken();

  // Ensure the source directory exists on disk
  try {
    ensureSourceDir(name);
  } catch (err) {
    console.error('[sources] Failed to create source dir:', err);
    // Non-fatal — continue; rest-server will create it on first backup
  }

  const result = db.prepare(`
    INSERT INTO backup_sources (name, description, token_hash)
    VALUES (?, ?, ?)
  `).run(name, description ?? null, hash);

  const id = Number(result.lastInsertRowid);

  auditLog({ eventType: 'source_created', req, details: { id, name } });

  res.status(201).json({ id, token: raw });
});

/** PATCH /api/sources/:id */
router.patch('/:id', requireAuth, requireAdmin, validate(updateSourceSchema), (req, res) => {
  const db  = getDb();
  const id  = parseInt(req.params.id as string, 10);
  const src = db.prepare('SELECT * FROM backup_sources WHERE id = ?').get(id) as BackupSource | undefined;
  if (!src) { res.status(404).json({ error: 'Not found' }); return; }

  const { description, disabled } = req.body as z.infer<typeof updateSourceSchema>;

  db.prepare(`
    UPDATE backup_sources SET
      description = COALESCE(?, description),
      disabled    = COALESCE(?, disabled)
    WHERE id = ?
  `).run(
    description !== undefined ? description : null,
    disabled    !== undefined ? (disabled ? 1 : 0) : null,
    id,
  );

  // If disabling, evict cached auth for this source
  if (disabled) evictSourceFromCache(id);

  res.json({ ok: true });
});

/** DELETE /api/sources/:id */
router.delete('/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id as string, 10);
  evictSourceFromCache(id);
  getDb().prepare('DELETE FROM backup_sources WHERE id = ?').run(id);
  auditLog({ eventType: 'source_deleted', req, details: { id } });
  res.json({ ok: true });
});

/** POST /api/sources/:id/rotate-token  — generate new token, invalidate old */
router.post('/:id/rotate-token', requireAuth, requireAdmin, async (req, res) => {
  const id  = parseInt(req.params.id as string, 10);
  const db  = getDb();
  const src = db.prepare('SELECT id FROM backup_sources WHERE id = ?').get(id) as BackupSource | undefined;
  if (!src) { res.status(404).json({ error: 'Not found' }); return; }

  const { raw, hash } = await generateToken();
  db.prepare('UPDATE backup_sources SET token_hash = ? WHERE id = ?').run(hash, id);
  evictSourceFromCache(id);

  auditLog({ eventType: 'source_token_rotated', req, details: { id } });
  res.json({ token: raw });
});

// ── Exclusion rules ───────────────────────────────────────────────────────────

/** GET /api/sources/:id/exclusion-rule */
router.get('/:id/exclusion-rule', requireAuth, requireAdmin, (req, res) => {
  const row = getDb().prepare(
    'SELECT * FROM source_exclusion_rules WHERE source_id = ?'
  ).get(parseInt(req.params.id as string, 10)) as SourceExclusionRule | undefined;
  res.json(row ?? null);
});

/** PUT /api/sources/:id/exclusion-rule */
router.put('/:id/exclusion-rule', requireAuth, requireAdmin, validate(exclusionRuleSchema), (req, res) => {
  const db  = getDb();
  const id  = parseInt(req.params.id as string, 10);
  if (!db.prepare('SELECT 1 FROM backup_sources WHERE id = ?').get(id)) {
    res.status(404).json({ error: 'Not found' }); return;
  }
  const { profileId, customPatterns, backupPaths } = req.body as z.infer<typeof exclusionRuleSchema>;
  const existing = db.prepare('SELECT id FROM source_exclusion_rules WHERE source_id = ?').get(id);
  if (existing) {
    db.prepare(`
      UPDATE source_exclusion_rules SET
        profile_id      = ?,
        custom_patterns = ?,
        backup_paths    = ?
      WHERE source_id = ?
    `).run(
      profileId       ?? null,
      customPatterns  ? JSON.stringify(customPatterns) : null,
      backupPaths     ? JSON.stringify(backupPaths)    : null,
      id,
    );
  } else {
    db.prepare(`
      INSERT INTO source_exclusion_rules (source_id, profile_id, custom_patterns, backup_paths)
      VALUES (?, ?, ?, ?)
    `).run(
      id,
      profileId       ?? null,
      customPatterns  ? JSON.stringify(customPatterns) : null,
      backupPaths     ? JSON.stringify(backupPaths)    : null,
    );
  }
  res.json({ ok: true });
});

// ── Logs ─────────────────────────────────────────────────────────────────────

/** GET /api/sources/:id/logs */
router.get('/:id/logs', requireAuth, requireAdmin, (req, res) => {
  const limit  = Math.min(parseInt(String(req.query.limit  ?? '100'), 10), 500);
  const offset = parseInt(String(req.query.offset ?? '0'), 10);
  const rows   = getDb().prepare(
    'SELECT * FROM backup_source_logs WHERE source_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(parseInt(req.params.id as string, 10), limit, offset);
  res.json(rows);
});

// ── Agent commands ─────────────────────────────────────────────────────────────

/** POST /api/sources/:id/commands  — enqueue a command for the agent */
router.post('/:id/commands', requireAuth, requireAdmin, (req, res) => {
  const schema = z.object({
    command: z.enum(['backup', 'uninstall', 'rotate_token', 'discover']),
    params:  z.record(z.string(), z.unknown()).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message }); return; }

  const id  = parseInt(req.params.id as string, 10);
  const db  = getDb();
  if (!db.prepare('SELECT 1 FROM backup_sources WHERE id = ?').get(id)) {
    res.status(404).json({ error: 'Not found' }); return;
  }

  const result = db.prepare(`
    INSERT INTO agent_commands (source_id, command, params)
    VALUES (?, ?, ?)
  `).run(id, parsed.data.command, parsed.data.params ? JSON.stringify(parsed.data.params) : null);

  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

/** GET /api/sources/:id/commands  — list commands */
router.get('/:id/commands', requireAuth, requireAdmin, (req, res) => {
  const rows = getDb().prepare(
    `SELECT * FROM agent_commands WHERE source_id = ? ORDER BY created_at DESC LIMIT 50`
  ).all(parseInt(req.params.id as string, 10));
  res.json(rows);
});

// ── Discovered paths ──────────────────────────────────────────────────────────

/** GET /api/sources/:id/paths */
router.get('/:id/paths', requireAuth, requireAdmin, (req, res) => {
  const rows = getDb().prepare(
    `SELECT * FROM agent_discovered_paths WHERE source_id = ? ORDER BY path ASC`
  ).all(parseInt(req.params.id as string, 10));
  res.json(rows);
});

// ── Agent endpoints (Bearer token auth, no session required) ─────────────────

/** Middleware: authenticate agent by Bearer token */
async function agentAuth(req: Request, res: Response, next: () => void): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Bearer token' });
    return;
  }
  const raw = authHeader.slice(7);
  if (!raw.startsWith('rvs1_')) {
    res.status(401).json({ error: 'Invalid token format' });
    return;
  }

  // Check cache first
  const cached = getCachedAuth(raw);
  if (cached) {
    if (cached.disabled) { res.status(403).json({ error: 'Source is disabled' }); return; }
    (req as Request & { sourceId: number }).sourceId = cached.sourceId;
    next();
    return;
  }

  // Cache miss — do full bcrypt lookup
  const db      = getDb();
  const sources = db.prepare('SELECT id, token_hash, disabled FROM backup_sources').all() as Pick<BackupSource, 'id' | 'token_hash' | 'disabled'>[];

  for (const src of sources) {
    if (await verifyToken(raw, src.token_hash)) {
      cacheAuthResult(raw, src.id, src.disabled === 1);
      if (src.disabled) { res.status(403).json({ error: 'Source is disabled' }); return; }
      (req as Request & { sourceId: number }).sourceId = src.id;
      next();
      return;
    }
  }

  res.status(401).json({ error: 'Invalid token' });
}

type AgentReq = Request & { sourceId: number };

/** POST /api/sources/agent/heartbeat — agent pings in, updates last_seen_at */
router.post('/agent/heartbeat', (req, res, next) => {
  agentAuth(req, res, () => next());
}, (req, res) => {
  const aReq = req as AgentReq;
  const schema = z.object({ agentVersion: z.string().max(64).optional() });
  const parsed = schema.safeParse(req.body);
  const agentVersion = parsed.success ? (parsed.data.agentVersion ?? null) : null;

  getDb().prepare(`
    UPDATE backup_sources SET last_seen_at = unixepoch(), agent_version = COALESCE(?, agent_version)
    WHERE id = ?
  `).run(agentVersion, aReq.sourceId);

  res.json({ ok: true });
});

/** GET /api/sources/agent/poll — long-poll for pending commands (30s timeout) */
router.get('/agent/poll', (req, res, next) => {
  agentAuth(req, res, () => next());
}, (req, res) => {
  const aReq    = req as AgentReq;
  const db      = getDb();
  const timeout = 30_000;
  const start   = Date.now();

  // Update last_seen_at
  db.prepare('UPDATE backup_sources SET last_seen_at = unixepoch() WHERE id = ?').run(aReq.sourceId);

  function check(): void {
    const cmd = db.prepare(`
      SELECT * FROM agent_commands
      WHERE source_id = ? AND status = 'pending'
      ORDER BY created_at ASC LIMIT 1
    `).get(aReq.sourceId) as AgentCommand | undefined;

    if (cmd) {
      res.json({ command: cmd });
      return;
    }

    if (Date.now() - start >= timeout) {
      res.json({ command: null });
      return;
    }

    setTimeout(check, 2000);
  }

  check();
  req.on('close', () => { /* client disconnected — check loop will end on next iteration */ });
});

/** POST /api/sources/agent/ack — acknowledge a command */
router.post('/agent/ack', (req, res, next) => {
  agentAuth(req, res, () => next());
}, (req, res) => {
  const aReq = req as AgentReq;
  const schema = z.object({ commandId: z.number().int().positive() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'commandId required' }); return; }

  const db = getDb();
  db.prepare(`
    UPDATE agent_commands SET status = 'acked', acked_at = unixepoch()
    WHERE id = ? AND source_id = ? AND status = 'pending'
  `).run(parsed.data.commandId, aReq.sourceId);

  res.json({ ok: true });
});

/** POST /api/sources/agent/backup-result — agent reports backup outcome */
router.post('/agent/backup-result', (req, res, next) => {
  agentAuth(req, res, () => next());
}, (req, res) => {
  const aReq   = req as AgentReq;
  const parsed = backupResultSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message }); return; }

  const { commandId, status, errorMessage, snapshotId } = parsed.data;
  const db = getDb();

  // Update last_backup_at and log the result
  db.prepare(`
    UPDATE backup_sources SET last_backup_at = unixepoch() WHERE id = ?
  `).run(aReq.sourceId);

  const level   = status === 'success' ? 'info' : 'error';
  const message = status === 'success'
    ? `Backup succeeded${snapshotId ? ` (snapshot ${snapshotId.slice(0, 8)})` : ''}`
    : `Backup failed: ${errorMessage ?? 'unknown error'}`;

  db.prepare(`
    INSERT INTO backup_source_logs (source_id, level, message) VALUES (?, ?, ?)
  `).run(aReq.sourceId, level, message);

  // Mark command done if provided
  if (commandId) {
    db.prepare(`
      UPDATE agent_commands SET status = 'done', done_at = unixepoch()
      WHERE id = ? AND source_id = ?
    `).run(commandId, aReq.sourceId);
  }

  // Fire notification on failure
  if (status === 'failure') {
    const src = db.prepare('SELECT name FROM backup_sources WHERE id = ?').get(aReq.sourceId) as { name: string } | undefined;
    if (src) {
      fireNotificationEvent({
        event: 'backup_failed',
        sourceId: aReq.sourceId,
        data: { repoName: src.name, repoPath: '', errorMessage: errorMessage ?? 'unknown' },
      }).catch(console.error);
    }
  }

  res.json({ ok: true });
});

/** POST /api/sources/agent/discover — agent reports discovered filesystem paths */
router.post('/agent/discover', (req, res, next) => {
  agentAuth(req, res, () => next());
}, (req, res) => {
  const aReq   = req as AgentReq;
  const parsed = discoverSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message }); return; }

  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO agent_discovered_paths (source_id, path, size_bytes, file_count, last_seen_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT(source_id, path) DO UPDATE SET
      size_bytes   = excluded.size_bytes,
      file_count   = excluded.file_count,
      last_seen_at = excluded.last_seen_at
  `);

  const upsertMany = db.transaction((paths: typeof parsed.data.paths) => {
    for (const p of paths) {
      insert.run(aReq.sourceId, p.path, p.size_bytes ?? null, p.file_count ?? null);
    }
  });

  upsertMany(parsed.data.paths);
  res.json({ ok: true, count: parsed.data.paths.length });
});

/** GET /api/sources/agent/config — return backup config for agent (paths + exclusions) */
router.get('/agent/config', (req, res, next) => {
  agentAuth(req, res, () => next());
}, (req, res) => {
  const aReq = req as AgentReq;
  const db   = getDb();

  const src = db.prepare('SELECT name FROM backup_sources WHERE id = ?').get(aReq.sourceId) as { name: string } | undefined;
  if (!src) { res.status(404).json({ error: 'Source not found' }); return; }

  const rule = db.prepare('SELECT * FROM source_exclusion_rules WHERE source_id = ?').get(aReq.sourceId) as {
    profile_id: number | null;
    custom_patterns: string | null;
    backup_paths: string | null;
  } | undefined;

  // Merge profile patterns + custom patterns
  let excludePatterns: string[] = [];
  if (rule?.profile_id) {
    const profile = db.prepare('SELECT patterns FROM exclusion_profiles WHERE id = ?').get(rule.profile_id) as { patterns: string } | undefined;
    if (profile) {
      try { excludePatterns = JSON.parse(profile.patterns); } catch { /* ignore */ }
    }
  }
  if (rule?.custom_patterns) {
    try {
      const custom = JSON.parse(rule.custom_patterns) as string[];
      excludePatterns = [...excludePatterns, ...custom];
    } catch { /* ignore */ }
  }

  let backupPaths: string[] = [];
  if (rule?.backup_paths) {
    try { backupPaths = JSON.parse(rule.backup_paths); } catch { /* ignore */ }
  }

  res.json({
    sourceName:     src.name,
    backupPaths,
    excludePatterns,
  });
});

export default router;
