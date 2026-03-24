import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { encrypt } from '../services/crypto.js';
import { sendEmail } from '../services/email.js';
import type { EmailProviderRow } from '../types/db.js';
import type { Database, RunResult } from 'better-sqlite3';

const router: Router = Router();
router.use(requireAuth, requireAdmin);

// ── Schemas ───────────────────────────────────────────────────────────────────

const smtpConfigSchema = z.object({
  host:        z.string().min(1),
  port:        z.number().int().min(1).max(65535),
  secure:      z.boolean(),
  username:    z.string(),
  password:    z.string(),
  fromAddress: z.email(),
  fromName:    z.string().min(1),
});

const apiKeyConfigSchema = z.object({
  apiKey:      z.string().min(1),
  fromAddress: z.email(),
  fromName:    z.string().min(1),
});

const mailgunConfigSchema = z.object({
  apiKey:      z.string().min(1),
  domain:      z.string().min(1),
  region:      z.enum(['us', 'eu']),
  fromAddress: z.email(),
  fromName:    z.string().min(1),
});

const sesConfigSchema = z.object({
  accessKeyId:     z.string().min(1),
  secretAccessKey: z.string().min(1),
  region:          z.string().min(1),
  fromAddress:     z.email(),
  fromName:        z.string().min(1),
});

const providerSchema = z.object({
  name:      z.string().min(1).max(128).trim(),
  provider:  z.enum(['smtp', 'sendgrid', 'mailgun', 'resend', 'ses']),
  isDefault: z.boolean().optional(),
  enabled:   z.boolean().optional(),
  config:    z.union([smtpConfigSchema, apiKeyConfigSchema, mailgunConfigSchema, sesConfigSchema]),
});

const ruleSchema = z.object({
  name:            z.string().min(1).max(128).trim(),
  providerId:      z.number().int().positive().nullable().optional(),
  enabled:         z.boolean().optional(),
  triggerType:     z.enum(['event', 'schedule']),
  events:          z.array(z.string()).optional(),
  scheduleType:    z.enum(['weekly', 'monthly']).optional(),
  scheduleDay:     z.number().int().min(0).max(31).optional(),
  scheduleHour:    z.number().int().min(0).max(23).optional(),
  repoIds:         z.array(z.number().int().positive()).nullable().optional(),
  sourceIds:       z.array(z.number().int().positive()).nullable().optional(),
  severityMin:     z.enum(['info', 'warning', 'error']).optional(),
  recipients:      z.array(z.email()).min(1).max(20),
  subjectTemplate: z.string().max(256).optional(),
});

// ── Provider routes ───────────────────────────────────────────────────────────

router.get('/providers', (_req, res): void => {
  const db: Database = getDb();
  const providers = db.prepare(
    'SELECT id, name, provider, is_default, enabled, created_at FROM email_providers ORDER BY created_at DESC'
  ).all();
  res.json(providers);
});

router.post('/providers', validate(providerSchema), (req, res): void => {
  const db: Database = getDb();
  const { name, provider, isDefault, enabled, config } = req.body as z.infer<typeof providerSchema>;

  if (isDefault) {
    db.prepare('UPDATE email_providers SET is_default = 0').run();
  }

  const result: RunResult = db.prepare(`
    INSERT INTO email_providers (name, provider, config, is_default, enabled)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, provider, encrypt(JSON.stringify(config)), isDefault ? 1 : 0, enabled !== false ? 1 : 0);

  res.status(201).json({ id: result.lastInsertRowid });
});

router.patch('/providers/:id', validate(providerSchema.partial()), (req, res): void => {
  const db: Database = getDb();
  const existing = db.prepare('SELECT * FROM email_providers WHERE id = ?').get(req.params.id) as EmailProviderRow | undefined;
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

  const { name, provider, isDefault, enabled, config } = req.body as Partial<z.infer<typeof providerSchema>>;

  if (isDefault) {
    db.prepare('UPDATE email_providers SET is_default = 0').run();
  }

  db.prepare(`
    UPDATE email_providers SET
      name       = COALESCE(?, name),
      provider   = COALESCE(?, provider),
      config     = COALESCE(?, config),
      is_default = COALESCE(?, is_default),
      enabled    = COALESCE(?, enabled)
    WHERE id = ?
  `).run(
    name      ?? null,
    provider  ?? null,
    config    ? encrypt(JSON.stringify(config)) : null,
    isDefault !== undefined ? (isDefault ? 1 : 0) : null,
    enabled   !== undefined ? (enabled   ? 1 : 0) : null,
    req.params.id,
  );

  res.json({ ok: true });
});

router.delete('/providers/:id', (req, res): void => {
  getDb().prepare('DELETE FROM email_providers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/notifications/providers/:id/test — send test email
router.post('/providers/:id/test', validate(z.object({ to: z.email() })), async (req, res): Promise<void> => {
  const db: Database = getDb();
  const row = db.prepare('SELECT id FROM email_providers WHERE id = ?').get(req.params.id);
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }

  try {
    await sendEmail(parseInt(req.params.id as string, 10), {
      to:      [(req.body as { to: string }).to],
      subject: '✓ ResticVault — Test-E-Mail',
      html:    `<p style="font-family: sans-serif; color: #333;">Diese Test-E-Mail wurde von ResticVault gesendet. Der E-Mail-Anbieter ist korrekt konfiguriert.</p>`,
      text:    'Diese Test-E-Mail wurde von ResticVault gesendet.',
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Send failed' });
  }
});

// ── Rule routes ───────────────────────────────────────────────────────────────

router.get('/rules', (_req, res): void => {
  res.json(getDb().prepare('SELECT * FROM notification_rules ORDER BY created_at DESC').all());
});

router.post('/rules', validate(ruleSchema), (req, res): void => {
  const db: Database = getDb();
  const b  = req.body as z.infer<typeof ruleSchema>;

  const result: RunResult = db.prepare(`
    INSERT INTO notification_rules (
      name, provider_id, enabled, trigger_type, events,
      schedule_type, schedule_day, schedule_hour,
      repo_ids, source_ids, severity_min, recipients, subject_template
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    b.name,
    b.providerId    ?? null,
    b.enabled       !== false ? 1 : 0,
    b.triggerType,
    b.events        ? JSON.stringify(b.events) : null,
    b.scheduleType  ?? null,
    b.scheduleDay   ?? null,
    b.scheduleHour  ?? 8,
    b.repoIds       ? JSON.stringify(b.repoIds)   : null,
    b.sourceIds     ? JSON.stringify(b.sourceIds) : null,
    b.severityMin   ?? 'info',
    JSON.stringify(b.recipients),
    b.subjectTemplate ?? null,
  );

  res.status(201).json({ id: result.lastInsertRowid });
});

router.patch('/rules/:id', validate(ruleSchema.partial()), (req, res): void => {
  const db: Database = getDb();
  if (!db.prepare('SELECT id FROM notification_rules WHERE id = ?').get(req.params.id)) {
    res.status(404).json({ error: 'Not found' }); return;
  }

  const b = req.body as Partial<z.infer<typeof ruleSchema>>;

  db.prepare(`
    UPDATE notification_rules SET
      name             = COALESCE(?, name),
      provider_id      = COALESCE(?, provider_id),
      enabled          = COALESCE(?, enabled),
      events           = COALESCE(?, events),
      schedule_type    = COALESCE(?, schedule_type),
      schedule_day     = COALESCE(?, schedule_day),
      schedule_hour    = COALESCE(?, schedule_hour),
      recipients       = COALESCE(?, recipients),
      subject_template = COALESCE(?, subject_template)
    WHERE id = ?
  `).run(
    b.name            ?? null,
    b.providerId      ?? null,
    b.enabled         !== undefined ? (b.enabled ? 1 : 0) : null,
    b.events          ? JSON.stringify(b.events) : null,
    b.scheduleType    ?? null,
    b.scheduleDay     ?? null,
    b.scheduleHour    ?? null,
    b.recipients      ? JSON.stringify(b.recipients) : null,
    b.subjectTemplate ?? null,
    req.params.id,
  );

  res.json({ ok: true });
});

router.delete('/rules/:id', (req, res): void => {
  getDb().prepare('DELETE FROM notification_rules WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Log route ────────────────────────────────────────────────────────────────

router.get('/log', (_req, res): void => {
  const logs = getDb().prepare(
    'SELECT * FROM notification_log ORDER BY created_at DESC LIMIT 100'
  ).all();
  res.json(logs);
});

export default router;
