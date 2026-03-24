import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import http from 'http';
import bcrypt from 'bcrypt';
import { getDb } from './db/index.js';
import { startIndexer, indexAllRepos, backfillSizeHistory } from './services/indexer.js';
import { auditLog } from './services/audit.js';
import cron from 'node-cron';
import authRouter from './routes/auth.js';
import reposRouter from './routes/repos.js';
import snapshotsRouter from './routes/snapshots.js';
import filesRouter from './routes/files.js';
import settingsRouter from './routes/settings.js';
import adminRouter from './routes/admin.js';
import snapshotStatsRouter from './routes/snapshot-stats.js';
import notificationsRouter from './routes/notifications.js';
import backupSourcesRouter from './routes/backup-sources.js';
import exclusionProfilesRouter from './routes/exclusion-profiles.js';
import { startNotificationScheduler } from './services/notifications.js';
import { startRestServer, stopRestServer, isRunning, REST_SERVER_PORT, getSourcesDir } from './services/rest-server.js';
import { getCachedAuth, cacheAuthResult, verifyToken } from './services/token.js';
import type { User } from './db/index.js';
import type { BackupSource } from './db/index.js';

const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT) || 3001;
const isProd = process.env.NODE_ENV === 'production';

// ── Security headers (helmet) ─────────────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],  // Tailwind requires inline styles
      imgSrc: ["'self'", 'data:'],               // QR codes use data: URIs
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false, // Allow download streams
}));

// ── Rate limiting ─────────────────────────────────────────────────────────────

/** Login: 5 attempts per 15 minutes per IP (default IP key — no custom keyGenerator needed) */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,  // Only count failures
  handler: (req, res) => {
    auditLog({
      eventType: 'rate_limit_hit',
      req,
      success: false,
      details: { endpoint: req.path },
    });
    res.status(429).json({ error: 'Zu viele Anmeldeversuche. Bitte in 15 Minuten erneut versuchen.' });
  },
});

/** API: 200 requests per minute per user (falls back to IPv6-safe IP key) */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use authenticated userId if available, otherwise IPv6-safe IP via helper
    const user = (req as express.Request & { user?: { userId: number } }).user;
    return user ? `user:${user.userId}` : ipKeyGenerator(req.ip ?? '');
  },
  message: { error: 'Rate limit exceeded. Please slow down.' },
});

/** Restic REST proxy: 2000 requests per minute per token (high-volume backup traffic) */
const resticLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers.authorization ?? req.ip ?? 'unknown',
  message: { error: 'Restic rate limit exceeded' },
  skip: () => !isRunning(),
});

// Skip JSON body parsing for /restic — the restic REST protocol sends raw binary
// data (repo packs). Parsing would consume the stream before the proxy can forward it.
app.use((req, res, next) => {
  if (req.path.startsWith('/restic')) return next();
  express.json({ limit: '1mb' })(req, res, (err) => {
    if (err) {
      console.error(`[json-parse] ${req.method} ${req.path} — ${err.message}`);
      // Log the raw body if available (express stores it on the error for SyntaxError)
      if (err.type === 'entity.parse.failed' && (err as { body?: string }).body) {
        console.error(`[json-parse] raw body: ${String((err as { body?: string }).body).slice(0, 500)}`);
      }
      res.status(400).json({ error: `Invalid JSON: ${err.message}` });
      return;
    }
    next();
  });
});
app.use(cookieParser());

// Apply login rate limiter before the auth router
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/2fa/challenge', loginLimiter);

/** Agent progress: 60 requests per minute per token (prevents flood from compromised tokens) */
const agentProgressLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers.authorization ?? req.ip ?? 'unknown',
  message: { error: 'Progress update rate limit exceeded' },
});
app.use('/api/sources/agent/backup-progress', agentProgressLimiter);

// Apply general API rate limiter to all API routes
app.use('/api', apiLimiter);

// API routes
app.use('/api/auth', authRouter);
app.use('/api/repos', reposRouter);
app.use('/api/repos/:repoId/snapshots', snapshotsRouter);
app.use('/api/repos/:repoId/snapshots', snapshotStatsRouter);
app.use('/api/repos/:repoId/snapshots', filesRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/sources', backupSourcesRouter);
app.use('/api/exclusion-profiles', exclusionProfilesRouter);

// ── Restic REST server proxy ───────────────────────────────────────────────────
// Agents call restic with: restic -r rest:https://<host>/restic/<name>/
// We authenticate the Bearer token, map to a backup source, and forward to
// the locally-running rest-server process.

app.use('/restic', resticLimiter, async (req, res) => {
  if (!isRunning()) {
    res.status(503).json({ error: 'Backup source server is not available. Install rest-server.' });
    return;
  }

  // Accept Bearer token OR HTTP Basic Auth (restic embeds credentials in the repo URL as
  // rest:https://x:<token>@host/... which restic sends as Basic Auth — this works with all
  // restic versions, whereas --header was only added in restic 0.14.0).
  const authHeader = req.headers.authorization;
  let raw: string | null = null;
  if (authHeader?.startsWith('Bearer ')) {
    raw = authHeader.slice(7);
  } else if (authHeader?.startsWith('Basic ')) {
    // Basic base64("username:password") — we use the password field as the token
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx !== -1) raw = decoded.slice(colonIdx + 1);
  }
  if (!raw) {
    res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'Missing Bearer token' });
    return;
  }
  if (!raw.startsWith('rvs1_')) {
    res.status(401).json({ error: 'Invalid token format' });
    return;
  }

  // Auth: check cache or full bcrypt
  let sourceId: number | null = null;
  const cached = getCachedAuth(raw);
  if (cached) {
    if (cached.disabled) {
      console.warn(`[restic-proxy] Source ${cached.sourceId} is disabled (cached)`);
      res.status(403).json({ error: 'Source is disabled' }); return;
    }
    sourceId = cached.sourceId;
  } else {
    console.log(`[restic-proxy] Cache miss, bcrypt lookup for ${req.method} ${req.path}`);
    const db = getDb();
    const sources = db.prepare('SELECT id, token_hash, disabled, name FROM backup_sources').all() as (BackupSource & { name: string })[];
    let matched: (typeof sources)[number] | null = null;
    for (const src of sources) {
      const isMatch = await verifyToken(raw, src.token_hash);
      if (isMatch && !matched) matched = src;
    }
    if (matched) {
      console.log(`[restic-proxy] Matched source ${matched.id} "${matched.name}"`);
      cacheAuthResult(raw, matched.id, matched.disabled === 1);
      if (matched.disabled) { res.status(403).json({ error: 'Source is disabled' }); return; }
      sourceId = matched.id;
    }
  }

  if (!sourceId) {
    console.warn(`[restic-proxy] No matching source for ${req.method} ${req.path}`);
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  // Update last_seen_at in background (non-blocking)
  getDb().prepare('UPDATE backup_sources SET last_seen_at = unixepoch() WHERE id = ?').run(sourceId);

  // Extract the source name from the URL path: /restic/<name>/...
  const urlPath  = req.path;                          // e.g. /my-server/data/abc123
  const segments = urlPath.replace(/^\//, '').split('/');
  const sourceName = segments[0];

  if (!sourceName) {
    res.status(400).json({ error: 'Missing source name in path' });
    return;
  }

  // Verify the token belongs to this source name
  const src = getDb().prepare('SELECT name FROM backup_sources WHERE id = ?').get(sourceId) as { name: string } | undefined;
  if (!src || src.name !== sourceName) {
    res.status(403).json({ error: 'Token does not match source name in path' });
    return;
  }

  // Forward to rest-server via http.request + pipe (reliable for binary streams)
  const upstreamPath = `${urlPath}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  console.log(`[restic-proxy] ${req.method} ${upstreamPath} → source=${sourceId} (${sourceName})`);

  const fwdHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'authorization' || k === 'host') continue;
    if (typeof v === 'string') fwdHeaders[k] = v;
  }

  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: REST_SERVER_PORT,
      path: upstreamPath,
      method: req.method,
      headers: fwdHeaders,
    },
    (proxyRes) => {
      res.status(proxyRes.statusCode ?? 502);
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (k === 'transfer-encoding' || !v) continue;
        res.setHeader(k, v);
      }
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', (err) => {
    console.error('[restic-proxy] Forward error:', err);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Failed to reach backup source server' });
    }
  });

  req.pipe(proxyReq);
});

// Serve agent install script from backend/public/
// dist/src/index.js → __dirname = dist/src → ../../public = backend/public/
const AGENT_SCRIPT = path.join(__dirname, '..', '..', 'public', 'agent-install.sh');

app.get('/agent-install.sh', (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (!fs.existsSync(AGENT_SCRIPT)) {
    res.status(404).send('# agent-install.sh not found on this server\n');
    return;
  }
  res.sendFile(AGENT_SCRIPT);
});

// Serve SvelteKit static build in production
const FRONTEND_BUILD = path.join(process.cwd(), '..', 'frontend', 'build');
if (fs.existsSync(FRONTEND_BUILD)) {
  app.use(express.static(FRONTEND_BUILD));
  app.get('*', (_req, res) => {
    const fallback = path.join(FRONTEND_BUILD, '200.html');
    if (fs.existsSync(fallback)) {
      res.sendFile(fallback);
    } else {
      res.sendFile(path.join(FRONTEND_BUILD, 'index.html'));
    }
  });
}

// ── Error handler ─────────────────────────────────────────────────────────────
// In production: hide stack traces. In development: include them.

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  if (isProd) {
    res.status(500).json({ error: 'Internal server error' });
  } else {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────

function warnWeakSecrets(): void {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    console.warn('[SECURITY] JWT_SECRET is not set — authentication will fail.');
    return;
  }
  if (jwtSecret.length < 32) {
    console.warn('[SECURITY] JWT_SECRET is shorter than 32 characters — use a strong random secret.');
  }

  const secretKey = process.env.SECRET_KEY;
  if (!secretKey) {
    console.warn('[SECURITY] SECRET_KEY is not set — encrypted fields will fail.');
    return;
  }
  if (secretKey.length < 32) {
    console.warn('[SECURITY] SECRET_KEY is shorter than 32 characters — use a strong random secret.');
  }

  if (jwtSecret === secretKey) {
    console.warn('[SECURITY] JWT_SECRET and SECRET_KEY should be different values.');
  }
}

function ensureDefaultUser(): void {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
  if (count === 0) {
    const username = 'admin';
    const password = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
    const hash = bcrypt.hashSync(password, 12);
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
    console.log('');
    console.log('='.repeat(50));
    console.log('  Default admin credentials created:');
    console.log(`  Username: ${username}`);
    console.log(`  Password: ${password}`);
    console.log('  Please change this password after first login.');
    console.log('='.repeat(50));
    console.log('');
  }
}

app.listen(PORT, () => {
  console.log(`[ResticVault] Backend running on http://localhost:${PORT}`);
  warnWeakSecrets();
  ensureDefaultUser();
  const db = getDb();
  const intervalSetting = db
    .prepare("SELECT value FROM settings WHERE key = 'index_interval_minutes'")
    .get() as { value: string } | undefined;
  const intervalMinutes = parseInt(intervalSetting?.value ?? '15', 10);
  startIndexer(intervalMinutes);
  // Index immediately on startup so stats are available without waiting for the first cron tick
  indexAllRepos().catch((err) => console.error('[startup] indexAllRepos failed:', err));
  // Backfill size history for any repos that have no history points yet
  backfillSizeHistory().catch((err) => console.error('[startup] backfillSizeHistory failed:', err));

  // Start scheduled email digest jobs (weekly / monthly reports)
  startNotificationScheduler();

  // Start embedded restic REST server for backup sources (non-fatal if binary absent)
  startRestServer().catch((err) => console.error('[rest-server] Startup error:', err));

  // Purge audit log entries older than 90 days — runs every Sunday at 03:00
  cron.schedule('0 3 * * 0', () => {
    try {
      const cutoff = Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60;
      const result = getDb().prepare('DELETE FROM audit_logs WHERE created_at < ?').run(cutoff);
      if (result.changes > 0) {
        console.log(`[audit] Purged ${result.changes} log entries older than 90 days`);
      }
    } catch (err) {
      console.error('[audit] Log purge failed:', err);
    }
  });
});
