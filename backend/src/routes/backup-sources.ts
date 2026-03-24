import { Router, type Request, type Response } from 'express';
import path from 'path';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { generateToken, verifyToken, cacheAuthResult, getCachedAuth, evictSourceFromCache } from '../services/token.js';
import { ensureSourceDir, getSourcesDir } from '../services/rest-server.js';
import { auditLog } from '../services/audit.js';
import { fireNotificationEvent } from '../services/notifications.js';
import { indexRepo } from '../services/indexer.js';
import type { BackupSource, AgentCommand, SourceExclusionRule, Repository } from '../db/index.js';

const router = Router();

// Current agent version bundled with this server build.
// Bump this whenever agent-install.sh daemon logic changes.
const CURRENT_AGENT_VERSION = '1.1.5';

/** GET /api/sources/agent/version — public (no auth), used by agent to check for updates */
router.get('/agent/version', (_req, res) => {
  res.json({ version: CURRENT_AGENT_VERSION });
});

/** GET /api/sources/current-agent-version — admin only, used by UI */
router.get('/current-agent-version', requireAuth, (_req, res) => {
  res.json({ version: CURRENT_AGENT_VERSION });
});

// ── Schemas ───────────────────────────────────────────────────────────────────

const createSourceSchema = z.object({
  name:        z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/, 'Name may only contain lowercase letters, digits, hyphens and underscores'),
  description: z.string().max(256).optional(),
});

const updateSourceSchema = z.object({
  description:  z.string().max(256).optional(),
  disabled:     z.boolean().optional(),
  schedule:     z.string().max(64).regex(
    /^(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)$/,
    'Invalid cron expression',
  ).optional(),
  keepLast:     z.number().int().min(0).max(9999).nullable().optional(),
  keepDaily:    z.number().int().min(0).max(9999).nullable().optional(),
  keepWeekly:   z.number().int().min(0).max(9999).nullable().optional(),
  keepMonthly:  z.number().int().min(0).max(9999).nullable().optional(),
  keepYearly:   z.number().int().min(0).max(9999).nullable().optional(),
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

const backupProgressSchema = z.object({
  percentDone: z.number().min(0).max(1),
  totalFiles:  z.number().int().nonnegative(),
  filesDone:   z.number().int().nonnegative(),
  totalBytes:  z.number().int().nonnegative(),
  bytesDone:   z.number().int().nonnegative(),
  currentFile: z.string().max(4096).transform(s => s.replace(/[\x00-\x1f\x7f]/g, '')).optional(),
});

interface BackupProgress {
  percentDone: number;
  totalFiles: number;
  filesDone: number;
  totalBytes: number;
  bytesDone: number;
  currentFile: string;
  updatedAt: number;
}

const progressStore = new Map<number, BackupProgress>();

// Clean up stale progress entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of progressStore) {
    if (now - p.updatedAt > 300_000) progressStore.delete(id);
  }
}, 300_000);

// ── Viewer permission helper ──────────────────────────────────────────────────

/** Check if a non-admin user can access a source (via user_repo_permissions on the linked repo) */
function canAccessSource(userId: number, role: string, sourceId: number): boolean {
  if (role === 'admin') return true;
  const src = getDb().prepare('SELECT repo_id FROM backup_sources WHERE id = ?').get(sourceId) as { repo_id: number | null } | undefined;
  if (!src?.repo_id) return false;
  return !!getDb().prepare('SELECT 1 FROM user_repo_permissions WHERE user_id = ? AND repo_id = ?').get(userId, src.repo_id);
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/** GET /api/sources  — admin sees all; viewer sees only sources linked to their permitted repos */
router.get('/', requireAuth, (req, res) => {
  const user = (req as Request & { user: { userId: number; role: string } }).user;
  if (user.role === 'admin') {
    const rows = getDb().prepare(`
      SELECT bs.*, r.name AS repo_name, r.path AS repo_path
      FROM backup_sources bs
      LEFT JOIN repositories r ON r.id = bs.repo_id
      ORDER BY bs.created_at DESC
    `).all();
    res.json(rows);
  } else {
    const rows = getDb().prepare(`
      SELECT bs.*, r.name AS repo_name, r.path AS repo_path
      FROM backup_sources bs
      LEFT JOIN repositories r ON r.id = bs.repo_id
      INNER JOIN user_repo_permissions urp ON urp.repo_id = bs.repo_id AND urp.user_id = ?
      ORDER BY bs.created_at DESC
    `).all(user.userId);
    res.json(rows);
  }
});

/** GET /api/sources/:id */
router.get('/:id', requireAuth, (req, res) => {
  const user = (req as Request & { user: { userId: number; role: string } }).user;
  const id = parseInt(req.params.id as string, 10);
  if (!canAccessSource(user.userId, user.role, id)) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }
  const row = getDb().prepare(`
    SELECT bs.*, r.name AS repo_name, r.path AS repo_path
    FROM backup_sources bs
    LEFT JOIN repositories r ON r.id = bs.repo_id
    WHERE bs.id = ?
  `).get(id) as (BackupSource & { repo_name: string | null; repo_path: string | null }) | undefined;
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

  const { description, disabled, schedule, keepLast, keepDaily, keepWeekly, keepMonthly, keepYearly } = req.body as z.infer<typeof updateSourceSchema>;

  const sets: string[] = [];
  const params: unknown[] = [];

  if (description !== undefined) { sets.push('description = ?'); params.push(description); }
  if (disabled !== undefined)    { sets.push('disabled = ?');    params.push(disabled ? 1 : 0); }
  if (schedule !== undefined)    { sets.push('schedule = ?');    params.push(schedule); }
  if (keepLast !== undefined)    { sets.push('keep_last = ?');    params.push(keepLast); }
  if (keepDaily !== undefined)   { sets.push('keep_daily = ?');   params.push(keepDaily); }
  if (keepWeekly !== undefined)  { sets.push('keep_weekly = ?');  params.push(keepWeekly); }
  if (keepMonthly !== undefined) { sets.push('keep_monthly = ?'); params.push(keepMonthly); }
  if (keepYearly !== undefined)  { sets.push('keep_yearly = ?');  params.push(keepYearly); }

  if (sets.length > 0) {
    params.push(id);
    db.prepare(`UPDATE backup_sources SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

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
router.get('/:id/logs', requireAuth, (req, res) => {
  const user = (req as Request & { user: { userId: number; role: string } }).user;
  const id = parseInt(req.params.id as string, 10);
  if (!canAccessSource(user.userId, user.role, id)) { res.status(403).json({ error: 'Forbidden' }); return; }
  const limit  = Math.min(parseInt(String(req.query.limit  ?? '100'), 10), 500);
  const offset = parseInt(String(req.query.offset ?? '0'), 10);
  const rows   = getDb().prepare(
    'SELECT * FROM backup_source_logs WHERE source_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(id, limit, offset);
  res.json(rows);
});

// ── Agent commands ─────────────────────────────────────────────────────────────

/** POST /api/sources/:id/commands  — enqueue a command for the agent */
router.post('/:id/commands', requireAuth, requireAdmin, (req, res) => {
  const schema = z.object({
    command: z.enum(['backup', 'uninstall', 'rotate_token', 'discover', 'update']),
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
router.get('/:id/commands', requireAuth, (req, res) => {
  const user = (req as Request & { user: { userId: number; role: string } }).user;
  const id = parseInt(req.params.id as string, 10);
  if (!canAccessSource(user.userId, user.role, id)) { res.status(403).json({ error: 'Forbidden' }); return; }
  const rows = getDb().prepare(
    `SELECT * FROM agent_commands WHERE source_id = ? ORDER BY created_at DESC LIMIT 50`
  ).all(id);
  res.json(rows);
});

// ── Discovered paths ──────────────────────────────────────────────────────────

/** GET /api/sources/:id/paths */
router.get('/:id/paths', requireAuth, (req, res) => {
  const user = (req as Request & { user: { userId: number; role: string } }).user;
  const id = parseInt(req.params.id as string, 10);
  if (!canAccessSource(user.userId, user.role, id)) { res.status(403).json({ error: 'Forbidden' }); return; }
  const rows = getDb().prepare(
    `SELECT * FROM agent_discovered_paths WHERE source_id = ? ORDER BY path ASC`
  ).all(id);
  res.json(rows);
});

/** GET /api/sources/:id/progress — poll backup progress for this source */
router.get('/:id/progress', requireAuth, (req, res) => {
  const user = (req as Request & { user: { userId: number; role: string } }).user;
  const id = parseInt(req.params.id as string, 10);
  if (!canAccessSource(user.userId, user.role, id)) { res.status(403).json({ error: 'Forbidden' }); return; }
  const progress = progressStore.get(id);

  if (!progress || (Date.now() - progress.updatedAt > 60_000)) {
    res.json({ active: false });
    return;
  }

  res.json({
    active:      true,
    percentDone: progress.percentDone,
    totalFiles:  progress.totalFiles,
    filesDone:   progress.filesDone,
    totalBytes:  progress.totalBytes,
    bytesDone:   progress.bytesDone,
    currentFile: progress.currentFile,
  });
});

// ── Agent endpoints (Bearer token auth, no session required) ─────────────────

/** Middleware: authenticate agent by Bearer token */
async function agentAuth(req: Request, res: Response, next: () => void): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    console.warn(`[agent-auth] Missing Bearer token on ${req.method} ${req.path}`);
    res.status(401).json({ error: 'Missing Bearer token' });
    return;
  }
  const raw = authHeader.slice(7);
  if (!raw.startsWith('rvs1_')) {
    console.warn(`[agent-auth] Invalid token format on ${req.method} ${req.path}: prefix=${raw.slice(0, 8)}...`);
    res.status(401).json({ error: 'Invalid token format' });
    return;
  }

  // Check cache first
  const cached = getCachedAuth(raw);
  if (cached) {
    if (cached.disabled) {
      console.warn(`[agent-auth] Source ${cached.sourceId} is disabled (cached)`);
      res.status(403).json({ error: 'Source is disabled' }); return;
    }
    (req as Request & { sourceId: number }).sourceId = cached.sourceId;
    next();
    return;
  }

  // Cache miss — do full bcrypt lookup (constant-time: always iterate all sources)
  console.log(`[agent-auth] Cache miss, performing bcrypt lookup for ${req.method} ${req.path}`);
  const db      = getDb();
  const sources = db.prepare('SELECT id, token_hash, disabled FROM backup_sources').all() as Pick<BackupSource, 'id' | 'token_hash' | 'disabled'>[];
  console.log(`[agent-auth] Checking ${sources.length} sources`);

  let matched: Pick<BackupSource, 'id' | 'token_hash' | 'disabled'> | null = null;
  for (const src of sources) {
    const isMatch = await verifyToken(raw, src.token_hash);
    if (isMatch && !matched) matched = src;
  }

  if (matched) {
    console.log(`[agent-auth] Matched source ${matched.id} (disabled=${matched.disabled})`);
    cacheAuthResult(raw, matched.id, matched.disabled === 1);
    if (matched.disabled) { res.status(403).json({ error: 'Source is disabled' }); return; }
    (req as Request & { sourceId: number }).sourceId = matched.id;
    next();
    return;
  }

  console.warn(`[agent-auth] No matching source found for token on ${req.method} ${req.path}`);
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
  console.log(`[agent-heartbeat] source=${aReq.sourceId} version=${agentVersion ?? 'unknown'}`);

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

/** POST /api/sources/agent/backup-progress — agent reports mid-backup progress */
router.post('/agent/backup-progress', (req, res, next) => {
  agentAuth(req, res, () => next());
}, (req, res) => {
  const aReq = req as AgentReq;
  const parsed = backupProgressSchema.safeParse(req.body);
  if (!parsed.success) {
    console.error(`[agent-progress] source=${aReq.sourceId} PARSE ERROR: ${parsed.error.issues.map(i => i.message).join('; ')}`);
    console.error(`[agent-progress] source=${aReq.sourceId} raw body: ${JSON.stringify(req.body).slice(0, 500)}`);
    res.status(400).json({ error: parsed.error.issues[0]?.message }); return;
  }

  console.log(`[agent-progress] source=${aReq.sourceId} pct=${(parsed.data.percentDone * 100).toFixed(1)}% files=${parsed.data.filesDone}/${parsed.data.totalFiles} currentFile=${(parsed.data.currentFile ?? '').slice(0, 80)}`);

  progressStore.set(aReq.sourceId, {
    percentDone: parsed.data.percentDone,
    totalFiles:  parsed.data.totalFiles,
    filesDone:   parsed.data.filesDone,
    totalBytes:  parsed.data.totalBytes,
    bytesDone:   parsed.data.bytesDone,
    currentFile: parsed.data.currentFile ?? '',
    updatedAt:   Date.now(),
  });

  // Keep agent "online" while backup is running (daemon loop is blocked during backup)
  getDb().prepare('UPDATE backup_sources SET last_seen_at = unixepoch() WHERE id = ?').run(aReq.sourceId);

  res.json({ ok: true });
});

/** POST /api/sources/agent/backup-result — agent reports backup outcome */
router.post('/agent/backup-result', (req, res, next) => {
  agentAuth(req, res, () => next());
}, (req, res) => {
  const aReq   = req as AgentReq;
  progressStore.delete(aReq.sourceId);
  const parsed = backupResultSchema.safeParse(req.body);
  if (!parsed.success) {
    console.error(`[agent-result] source=${aReq.sourceId} PARSE ERROR: ${parsed.error.issues.map(i => i.message).join('; ')}`);
    console.error(`[agent-result] source=${aReq.sourceId} raw body: ${JSON.stringify(req.body).slice(0, 500)}`);
    res.status(400).json({ error: parsed.error.issues[0]?.message }); return;
  }

  const { commandId, status, errorMessage, snapshotId } = parsed.data;
  console.log(`[agent-result] source=${aReq.sourceId} status=${status} snapshot=${snapshotId?.slice(0, 8) ?? 'none'} error=${errorMessage ?? 'none'}`);
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

  // Auto-create repository record for this source if not yet linked,
  // then trigger indexing so snapshots appear in the UI.
  if (status === 'success') {
    const src = db.prepare('SELECT id, name, repo_id FROM backup_sources WHERE id = ?')
      .get(aReq.sourceId) as { id: number; name: string; repo_id: number | null } | undefined;
    if (src) {
      let repoId = src.repo_id;
      const repoPath = path.join(getSourcesDir(), src.name);

      if (!repoId) {
        // Check if a repo with this path already exists (UNIQUE constraint on path)
        const existing = db.prepare('SELECT id FROM repositories WHERE path = ?').get(repoPath) as { id: number } | undefined;
        if (existing) {
          repoId = existing.id;
        } else {
          const result = db.prepare(`
            INSERT INTO repositories (name, path, type, password_encrypted, status)
            VALUES (?, ?, 'local', NULL, 'ok')
          `).run(`source:${src.name}`, repoPath);
          repoId = Number(result.lastInsertRowid);
          console.log(`[sources] Auto-created repo ${repoId} for source "${src.name}"`);
        }
        db.prepare('UPDATE backup_sources SET repo_id = ? WHERE id = ?').run(repoId, src.id);
      }

      // Trigger indexing in background (non-blocking)
      const repo = db.prepare('SELECT * FROM repositories WHERE id = ?').get(repoId) as Repository | undefined;
      if (repo) {
        indexRepo(repo).catch((err) =>
          console.error(`[sources] indexRepo ${repoId} failed:`, err instanceof Error ? err.message : err)
        );
      }
    }
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

  const src = db.prepare('SELECT name, schedule, keep_last, keep_daily, keep_weekly, keep_monthly, keep_yearly FROM backup_sources WHERE id = ?').get(aReq.sourceId) as {
    name: string; schedule: string;
    keep_last: number | null; keep_daily: number | null; keep_weekly: number | null;
    keep_monthly: number | null; keep_yearly: number | null;
  } | undefined;
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
    schedule:       src.schedule,
    keepLast:       src.keep_last,
    keepDaily:      src.keep_daily,
    keepWeekly:     src.keep_weekly,
    keepMonthly:    src.keep_monthly,
    keepYearly:     src.keep_yearly,
  });
});

export default router;
