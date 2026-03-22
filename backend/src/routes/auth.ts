import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import { getDb } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { encrypt, decrypt } from '../services/crypto.js';
import { auditLog } from '../services/audit.js';
import { fireNotificationEvent } from '../services/notifications.js';
import type { User } from '../db/index.js';

const router = Router();

// ── Schemas ───────────────────────────────────────────────────────────────────

const loginSchema = z.object({
  username: z.string().min(1, 'Username is required').max(64),
  password: z.string().min(1, 'Password is required').max(256),
});

const totpCodeSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Code must be exactly 6 digits'),
});

const disable2faSchema = z.object({
  password: z.string().min(1, 'Password is required'),
  code: z.string().regex(/^\d{6}$/, 'Code must be exactly 6 digits'),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTOTP(username: string, base32Secret: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: 'ResticVault',
    label: username,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(base32Secret),
  });
}

function issueSessionCookie(res: Parameters<Router>[1], user: User): void {
  const secret = process.env.JWT_SECRET!;
  const token = jwt.sign(
    { userId: user.id, username: user.username, role: user.role },
    secret,
    { expiresIn: '24h', algorithm: 'HS256' },
  );
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
  });
}

// ── POST /login ───────────────────────────────────────────────────────────────

router.post('/login', validate(loginSchema), (req, res) => {
  const { username, password } = req.body as z.infer<typeof loginSchema>;

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    auditLog({ eventType: 'login_failure', req, username, success: false });

    // Check for burst threshold (3+ failures in 15 min from same IP) and notify
    const db = getDb();
    const recentFailures = db.prepare(`
      SELECT COUNT(*) as c, ip_address FROM audit_logs
      WHERE event_type = 'login_failure'
        AND username = ?
        AND created_at > unixepoch() - 900
      GROUP BY ip_address
      ORDER BY c DESC LIMIT 1
    `).get(username) as { c: number; ip_address: string | null } | undefined;

    if (recentFailures && recentFailures.c >= 3) {
      fireNotificationEvent({
        event: 'login_failure_burst',
        data: {
          username,
          ip:       recentFailures.ip_address ?? 'unknown',
          attempts: recentFailures.c,
        },
      }).catch(console.error);
    }

    // Same message regardless of whether user exists — prevents username enumeration
    res.status(401).json({ error: 'Benutzername oder Passwort falsch.' });
    return;
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    res.status(500).json({ error: 'Server misconfiguration' });
    return;
  }

  // 2FA enabled — issue a short-lived pending token, don't create a full session yet
  if (user.totp_enabled) {
    const pendingToken = jwt.sign(
      { userId: user.id, pending2fa: true },
      jwtSecret,
      { expiresIn: '5m', algorithm: 'HS256' },
    );
    res.cookie('rv_2fa_pending', pendingToken, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 5 * 60 * 1000,
      secure: process.env.NODE_ENV === 'production',
    });
    res.json({ requires2fa: true });
    return;
  }

  auditLog({ eventType: 'login_success', req, username: user.username });
  issueSessionCookie(res, user);
  res.json({ username: user.username, role: user.role });
});

// ── POST /logout ──────────────────────────────────────────────────────────────

router.post('/logout', (req, res) => {
  auditLog({ eventType: 'logout', req, username: req.user?.username });
  res.clearCookie('token');
  res.clearCookie('rv_2fa_pending');
  res.json({ ok: true });
});

// ── GET /me ───────────────────────────────────────────────────────────────────

router.get('/me', requireAuth, (req, res) => {
  const db = getDb();
  const row = db
    .prepare('SELECT totp_enabled FROM users WHERE id = ?')
    .get(req.user!.userId) as { totp_enabled: number } | undefined;
  res.json({
    username: req.user!.username,
    userId: req.user!.userId,
    role: req.user!.role,
    totp_enabled: row?.totp_enabled === 1,
  });
});

// ── POST /2fa/challenge — second step of login ────────────────────────────────

router.post('/2fa/challenge', validate(totpCodeSchema), (req, res) => {
  const pendingToken = req.cookies?.rv_2fa_pending;
  if (!pendingToken) {
    res.status(401).json({ error: 'No pending 2FA session' });
    return;
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    res.status(500).json({ error: 'Server misconfiguration' });
    return;
  }

  let payload: { userId: number; pending2fa: boolean };
  try {
    payload = jwt.verify(pendingToken, jwtSecret, { algorithms: ['HS256'] }) as typeof payload;
  } catch {
    res.clearCookie('rv_2fa_pending');
    res.status(401).json({ error: 'Session expired, please log in again' });
    return;
  }

  if (!payload.pending2fa) {
    res.status(401).json({ error: 'Invalid session type' });
    return;
  }

  const { code } = req.body as z.infer<typeof totpCodeSchema>;

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.userId) as User | undefined;
  if (!user || !user.totp_secret) {
    res.status(401).json({ error: 'User not found' });
    return;
  }

  const totp = makeTOTP(user.username, decrypt(user.totp_secret));
  if (totp.validate({ token: code, window: 1 }) === null) {
    auditLog({ eventType: 'login_2fa_failure', req, username: user.username, success: false });
    res.status(401).json({ error: 'Invalid or expired code' });
    return;
  }

  auditLog({ eventType: 'login_2fa_success', req, username: user.username });
  res.clearCookie('rv_2fa_pending');
  issueSessionCookie(res, user);
  res.json({ username: user.username, role: user.role });
});

// ── POST /2fa/setup — generate secret, store encrypted (not yet enabled) ──────

router.post('/2fa/setup', requireAuth, async (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.userId) as User | undefined;
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (user.totp_enabled) {
    res.status(400).json({ error: '2FA is already enabled' });
    return;
  }

  const totp = new OTPAuth.TOTP({
    issuer: 'ResticVault',
    label: user.username,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: new OTPAuth.Secret({ size: 20 }),
  });

  const secretBase32 = totp.secret.base32;
  const otpauthUrl = totp.toString();
  const qrCode = await QRCode.toDataURL(otpauthUrl);

  // Store encrypted — 2FA isn't active until /verify succeeds
  db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?')
    .run(encrypt(secretBase32), req.user!.userId);

  res.json({ secret: secretBase32, qrCode, otpauthUrl });
});

// ── POST /2fa/verify — confirm code and activate 2FA ─────────────────────────

router.post('/2fa/verify', requireAuth, validate(totpCodeSchema), (req, res) => {
  const { code } = req.body as z.infer<typeof totpCodeSchema>;

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.userId) as User | undefined;
  if (!user?.totp_secret) {
    res.status(400).json({ error: 'Run /2fa/setup first' });
    return;
  }
  if (user.totp_enabled) {
    res.status(400).json({ error: '2FA is already enabled' });
    return;
  }

  const totp = makeTOTP(user.username, decrypt(user.totp_secret));
  if (totp.validate({ token: code, window: 1 }) === null) {
    res.status(400).json({ error: 'Invalid code — check your authenticator app and try again' });
    return;
  }

  db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(req.user!.userId);
  res.json({ ok: true });
});

// ── POST /2fa/disable — deactivate 2FA (requires password + TOTP code) ────────

router.post('/2fa/disable', requireAuth, validate(disable2faSchema), (req, res) => {
  const { password, code } = req.body as z.infer<typeof disable2faSchema>;

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.userId) as User | undefined;
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (!user.totp_enabled || !user.totp_secret) {
    res.status(400).json({ error: '2FA is not enabled' });
    return;
  }

  if (!bcrypt.compareSync(password, user.password_hash)) {
    res.status(400).json({ error: 'Incorrect password' });
    return;
  }

  const totp = makeTOTP(user.username, decrypt(user.totp_secret));
  if (totp.validate({ token: code, window: 1 }) === null) {
    res.status(400).json({ error: 'Invalid 2FA code' });
    return;
  }

  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?')
    .run(req.user!.userId);
  res.json({ ok: true });
});

export default router;
