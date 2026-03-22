import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
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
import { startNotificationScheduler } from './services/notifications.js';
import type { User } from './db/index.js';

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

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Apply login rate limiter before the auth router
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/2fa/challenge', loginLimiter);

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
