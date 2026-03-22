import { Router } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { getDb, type SshConnection } from '../db/index.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { validate, idParamsSchema } from '../middleware/validate.js';
import { encrypt, decrypt } from '../services/crypto.js';
import { testSftpConnection } from '../services/ssh.js';
import { auditLog } from '../services/audit.js';
import {RunResult} from "better-sqlite3";
import type { Database } from "better-sqlite3";

const router: Router = Router();
router.use(requireAuth);
router.use(requireAdmin);

// ── Schemas ───────────────────────────────────────────────────────────────────

const createUserSchema = z.object({
  username: z.string().min(1, 'username is required').max(64).regex(/^[a-zA-Z0-9_.-]+$/, 'username may only contain letters, numbers, underscores, dots and hyphens'),
  password: z.string().min(8, 'password must be at least 8 characters').max(256),
  role: z.enum(['admin', 'viewer']).optional().default('viewer'),
});

const resetPasswordSchema = z.object({
  password: z.string().min(8, 'password must be at least 8 characters').max(256),
});

const setPermissionsSchema = z.object({
  repoIds: z.array(z.number().int().nonnegative()).max(1000),
});

const createSshConnectionSchema = z.object({
  name: z.string().min(1, 'name is required').max(128),
  host: z.string().min(1, 'host is required').max(256),
  port: z.number().int().min(1).max(65535).optional().default(22),
  username: z.string().min(1, 'username is required').max(64),
  privateKey: z.string().min(1, 'privateKey is required').max(16384),
});

// ── GET /api/admin/users ──────────────────────────────────────────────────────

router.get('/users', (_req, res) => {
  const db: Database = getDb();
  const users = db.prepare(`
    SELECT u.id, u.username, u.role, u.created_at, u.totp_enabled,
           COUNT(p.repo_id) as repo_count
    FROM users u
    LEFT JOIN user_repo_permissions p ON p.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at
  `).all();
  res.json(users);
});

// ── POST /api/admin/users ─────────────────────────────────────────────────────

router.post('/users', validate(createUserSchema), async (req, res) => {
  const { username, password, role } = req.body as z.infer<typeof createUserSchema>;

  const db: Database = getDb();
  try {
    const hash: string = await bcrypt.hash(password, 12);
    const result: RunResult = db.prepare(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
    ).run(username, hash, role);
    auditLog({ eventType: 'user_created', req, username: req.user!.username, details: { createdUsername: username, role } });
    res.status(201).json({ id: result.lastInsertRowid, username, role });
  } catch (err: unknown) {
    const msg: string = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'Username already exists' });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

// ── DELETE /api/admin/users/:id ───────────────────────────────────────────────

router.delete('/users/:id', validate(idParamsSchema, 'params'), (req, res) => {
  const targetId: number = Number(req.params.id);
  if (targetId === req.user!.userId) {
    res.status(400).json({ error: 'Cannot delete your own account' });
    return;
  }

  const db: Database = getDb();
  const target = db.prepare('SELECT username FROM users WHERE id = ?').get(targetId) as { username: string } | undefined;
  const result: RunResult = db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  if (result.changes === 0) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  auditLog({ eventType: 'user_deleted', req, username: req.user!.username, details: { deletedUsername: target?.username, deletedId: targetId } });
  res.json({ ok: true });
});

// ── POST /api/admin/users/:id/reset-password ──────────────────────────────────

router.post('/users/:id/reset-password', validate(idParamsSchema, 'params'), validate(resetPasswordSchema), async (req, res): Promise<void> => {
  const { password } = req.body as z.infer<typeof resetPasswordSchema>;

  const db: Database = getDb();
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const hash: string = await bcrypt.hash(password, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
  auditLog({ eventType: 'password_reset', req, username: req.user!.username, details: { targetUserId: req.params.id } });
  res.json({ ok: true });
});

// ── GET /api/admin/users/:id/permissions ──────────────────────────────────────

router.get('/users/:id/permissions', validate(idParamsSchema, 'params'), (req, res): void => {
  const db: Database = getDb();
  const perms = db.prepare(
    'SELECT repo_id FROM user_repo_permissions WHERE user_id = ?'
  ).all(req.params.id) as { repo_id: number }[];
  res.json(perms.map(p => p.repo_id));
});

// ── PUT /api/admin/users/:id/permissions ──────────────────────────────────────

router.put('/users/:id/permissions', validate(idParamsSchema, 'params'), validate(setPermissionsSchema), (req, res): void => {
  const { repoIds } = req.body as z.infer<typeof setPermissionsSchema>;
  const db: Database = getDb();
  const userId: number = Number(req.params.id);

  db.transaction((): void => {
    db.prepare('DELETE FROM user_repo_permissions WHERE user_id = ?').run(userId);
    const insert = db.prepare(
      'INSERT OR IGNORE INTO user_repo_permissions (user_id, repo_id) VALUES (?, ?)'
    );
    for (const repoId of repoIds) {
      insert.run(userId, repoId);
    }
  })();

  auditLog({ eventType: 'permissions_updated', req, username: req.user!.username, details: { targetUserId: userId, repoIds } });
  res.json({ ok: true });
});

// ── DELETE /api/admin/users/:id/2fa ───────────────────────────────────────────

router.delete('/users/:id/2fa', validate(idParamsSchema, 'params'), (req, res): void => {
  const db: Database = getDb();
  const result: RunResult = db.prepare(
    'UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?'
  ).run(req.params.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({ ok: true });
});

// ── SSH Connections ───────────────────────────────────────────────────────────

// GET /api/admin/ssh-connections — list all (private key never returned)
router.get('/ssh-connections', (_req, res): void => {
  const db: Database = getDb();
  const rows = db.prepare(`
    SELECT id, name, host, port, username, created_at
    FROM ssh_connections ORDER BY name
  `).all();
  res.json(rows);
});

// POST /api/admin/ssh-connections — create a new connection
router.post('/ssh-connections', validate(createSshConnectionSchema), (req, res): void => {
  const { name, host, port, username, privateKey } = req.body as z.infer<typeof createSshConnectionSchema>;

  let keyEncrypted: string;
  try {
    keyEncrypted = encrypt(privateKey);
  } catch {
    res.status(500).json({ error: 'Failed to encrypt private key. Is SECRET_KEY set?' });
    return;
  }

  const db: Database = getDb();
  const result: RunResult = db.prepare(`
    INSERT INTO ssh_connections (name, host, port, username, private_key_encrypted)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, host, port, username, keyEncrypted);

  auditLog({ eventType: 'ssh_connection_created', req, username: req.user!.username, details: { name, host, port, sshUsername: username } });
  res.status(201).json({ id: result.lastInsertRowid, name, host, port, username });
});

// DELETE /api/admin/ssh-connections/:id — delete a connection
router.delete('/ssh-connections/:id', validate(idParamsSchema, 'params'), (req, res): void => {
  const db: Database = getDb();
  const conn = db.prepare('SELECT name, host FROM ssh_connections WHERE id = ?').get(req.params.id) as { name: string; host: string } | undefined;
  const result: RunResult = db.prepare('DELETE FROM ssh_connections WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'SSH connection not found' });
    return;
  }
  auditLog({ eventType: 'ssh_connection_deleted', req, username: req.user!.username, details: { id: req.params.id, name: conn?.name, host: conn?.host } });
  res.json({ ok: true });
});

// ── Audit Logs ────────────────────────────────────────────────────────────────

const auditLogsQuerySchema = z.object({
  eventType: z.string().optional(),
  username:  z.string().optional(),
  success:   z.enum(['0', '1']).optional(),
  limit:     z.string().regex(/^\d+$/).optional().transform(v => (v ? Math.min(Number(v), 500) : 100)),
  offset:    z.string().regex(/^\d+$/).optional().transform(v => (v ? Number(v) : 0)),
});

// GET /api/admin/audit-logs — paginated log list with optional filters
router.get('/audit-logs', validate(auditLogsQuerySchema, 'query'), (req, res): void => {
  const { eventType, username, success, limit, offset } = req.query as unknown as z.infer<typeof auditLogsQuerySchema>;

  const db: Database = getDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (eventType) { conditions.push('event_type = ?'); params.push(eventType); }
  if (username)  { conditions.push('username = ?');   params.push(username); }
  if (success !== undefined) { conditions.push('success = ?'); params.push(Number(success)); }

  const where: string = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const total: number = (db.prepare(`SELECT COUNT(*) as c FROM audit_logs ${where}`).get(...params) as { c: number }).c;
  const rows = db.prepare(`
    SELECT id, event_type, username, ip_address, user_agent, details, success, created_at
    FROM audit_logs ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ total, rows });
});

// GET /api/admin/audit-logs/stats — aggregate counts for dashboard cards
router.get('/audit-logs/stats', (_req, res): void => {
  const db: Database = getDb();
  const since24h: number  = Math.floor(Date.now() / 1000) - 86400;
  const since7d: number   = Math.floor(Date.now() / 1000) - 7 * 86400;

  const loginFailures24h: number = (db.prepare(
    `SELECT COUNT(*) as c FROM audit_logs WHERE event_type = 'login_failure' AND created_at >= ?`
  ).get(since24h) as { c: number }).c;

  const rateLimitHits24h: number = (db.prepare(
    `SELECT COUNT(*) as c FROM audit_logs WHERE event_type = 'rate_limit_hit' AND created_at >= ?`
  ).get(since24h) as { c: number }).c;

  const totalEvents7d: number = (db.prepare(
    `SELECT COUNT(*) as c FROM audit_logs WHERE created_at >= ?`
  ).get(since7d) as { c: number }).c;

  const byType = db.prepare(
    `SELECT event_type, COUNT(*) as c FROM audit_logs WHERE created_at >= ? GROUP BY event_type ORDER BY c DESC`
  ).all(since7d) as { event_type: string; c: number }[];

  res.json({ loginFailures24h, rateLimitHits24h, totalEvents7d, byType });
});

// POST /api/admin/ssh-connections/:id/test — test SSH connectivity
router.post('/ssh-connections/:id/test', validate(idParamsSchema, 'params'), async (req, res): Promise<void> => {
  const db: Database = getDb();
  const conn = db.prepare('SELECT * FROM ssh_connections WHERE id = ?').get(req.params.id) as SshConnection | undefined;
  if (!conn) {
    res.status(404).json({ error: 'SSH connection not found' });
    return;
  }

  let privateKey: string;
  try {
    privateKey = decrypt(conn.private_key_encrypted);
  } catch {
    res.status(500).json({ error: 'Failed to decrypt private key' });
    return;
  }

  const result = await testSftpConnection({
    host: conn.host,
    port: conn.port,
    username: conn.username,
    private_key: privateKey,
  });
  res.json({ ok: result.success, error: result.error });
});

export default router;
