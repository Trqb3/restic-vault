import cron from 'node-cron';
import { getDb } from '../db/index.js';
import { sendAndLog, getDefaultProviderId } from './email.js';
import {
  backupFailedTemplate,
  agentDisconnectedTemplate,
  auditDigestTemplate,
  loginFailureAlertTemplate,
} from './email-templates.js';
import type { NotificationRuleRow } from '../types/db.js';

export type NotificationEvent =
  | 'backup_failed'
  | 'backup_success'
  | 'agent_disconnected'
  | 'agent_connected'
  | 'login_failure_burst'
  | 'repo_added'
  | 'repo_deleted'
  | 'snapshot_deleted'
  | 'user_created'
  | 'user_deleted';

export interface EventContext {
  event: NotificationEvent;
  repoId?: number;
  sourceId?: number;
  data: Record<string, unknown>;
}

// ── Event-based notifications ─────────────────────────────────────────────────

export async function fireNotificationEvent(ctx: EventContext): Promise<void> {
  const db = getDb();

  // Fetch all enabled event rules then filter in JS to avoid complex JSON-in-SQL queries
  const rules = db.prepare(`
    SELECT * FROM notification_rules
    WHERE enabled = 1 AND trigger_type = 'event'
  `).all() as NotificationRuleRow[];

  for (const rule of rules) {
    const events = JSON.parse(rule.events ?? '[]') as string[];
    if (!events.includes(ctx.event)) continue;

    // Repo filter
    if (rule.repo_ids && ctx.repoId !== undefined) {
      const ids = JSON.parse(rule.repo_ids) as number[];
      if (!ids.includes(ctx.repoId)) continue;
    }

    // Source filter
    if (rule.source_ids && ctx.sourceId !== undefined) {
      const ids = JSON.parse(rule.source_ids) as number[];
      if (!ids.includes(ctx.sourceId)) continue;
    }

    const providerId = rule.provider_id ?? getDefaultProviderId();
    if (!providerId) {
      console.warn(`[notifications] Rule ${rule.id} (${rule.name}): no provider configured, skipping`);
      continue;
    }

    const recipients = JSON.parse(rule.recipients) as string[];
    if (recipients.length === 0) continue;

    try {
      let template: { subject: string; html: string; text: string } | null = null;

      switch (ctx.event) {
        case 'backup_failed':
          template = backupFailedTemplate({
            repoName:     ctx.data['repoName'] as string,
            repoPath:     ctx.data['repoPath'] as string,
            errorMessage: ctx.data['errorMessage'] as string,
            timestamp:    new Date(),
          });
          break;
        case 'agent_disconnected':
          template = agentDisconnectedTemplate({
            sourceName: ctx.data['sourceName'] as string,
            hostname:   ctx.data['hostname'] as string,
            lastSeen:   new Date((ctx.data['lastSeen'] as number) * 1000),
          });
          break;
        case 'login_failure_burst':
          template = loginFailureAlertTemplate({
            username:  ctx.data['username'] as string,
            ip:        ctx.data['ip'] as string,
            attempts:  ctx.data['attempts'] as number,
            timestamp: new Date(),
          });
          break;
        default:
          // Events like backup_success, repo_added, etc. don't have a template yet
          continue;
      }

      if (rule.subject_template) {
        template.subject = rule.subject_template
          .replace('{event}', ctx.event)
          .replace('{repo}', (ctx.data['repoName'] as string | undefined) ?? '');
      }

      await sendAndLog(rule.id, providerId, {
        to:      recipients,
        subject: template.subject,
        html:    template.html,
        text:    template.text,
      });

      db.prepare('UPDATE notification_rules SET last_triggered_at = unixepoch() WHERE id = ?')
        .run(rule.id);
    } catch (err) {
      console.error(`[notifications] Rule ${rule.id} (${rule.name}) failed:`, err);
    }
  }
}

// ── Digest helpers ────────────────────────────────────────────────────────────

function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

async function sendDigest(type: 'weekly' | 'monthly', rule: NotificationRuleRow): Promise<void> {
  const db   = getDb();
  const now  = Math.floor(Date.now() / 1000);
  const since = now - (type === 'weekly' ? 7 : 30) * 24 * 60 * 60;

  const today = new Date();
  const periodLabel = type === 'weekly'
    ? `KW ${getISOWeek(today)} ${today.getFullYear()}`
    : today.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });

  const totalBackups = (db.prepare(
    "SELECT COUNT(*) as c FROM audit_logs WHERE event_type LIKE 'backup%' AND created_at > ?"
  ).get(since) as { c: number }).c;

  const failedBackups = (db.prepare(
    "SELECT COUNT(*) as c FROM audit_logs WHERE event_type = 'backup_failed' AND created_at > ?"
  ).get(since) as { c: number }).c;

  const totalSnapshots = (db.prepare(
    'SELECT COALESCE(SUM(snapshot_count), 0) as s FROM repositories'
  ).get() as { s: number }).s;

  const failedLogins = (db.prepare(
    "SELECT COUNT(*) as c FROM audit_logs WHERE event_type = 'login_failure' AND created_at > ?"
  ).get(since) as { c: number }).c;

  const repos = db.prepare(
    'SELECT name, snapshot_count, last_backup, status FROM repositories ORDER BY name'
  ).all() as Array<{ name: string; snapshot_count: number; last_backup: number | null; status: string }>;

  const providerId = rule.provider_id ?? getDefaultProviderId();
  if (!providerId) {
    console.warn(`[notifications] Digest rule ${rule.id}: no provider configured, skipping`);
    return;
  }

  const recipients = JSON.parse(rule.recipients) as string[];
  if (recipients.length === 0) return;

  const template = auditDigestTemplate({
    period: type,
    periodLabel,
    totalBackups,
    failedBackups,
    totalSnapshots,
    totalSize: '—',
    repos: repos.map(r => ({
      name:          r.name,
      snapshotCount: r.snapshot_count,
      lastBackup:    r.last_backup ? new Date(r.last_backup * 1000) : null,
      status:        r.status,
    })),
    topFailures: [],
    auditEvents: totalBackups,
    failedLogins,
  });

  await sendAndLog(rule.id, providerId, {
    to:      recipients,
    subject: template.subject,
    html:    template.html,
    text:    template.text,
  });

  db.prepare('UPDATE notification_rules SET last_triggered_at = unixepoch() WHERE id = ?')
    .run(rule.id);
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export function startNotificationScheduler(): void {
  // Check every hour at :02 past (avoids landing exactly on :00 with other cron jobs)
  cron.schedule('2 * * * *', async () => {
    const db  = getDb();
    const now = new Date();
    const currentHour = now.getHours();
    const currentDow  = (now.getDay() + 6) % 7; // 0 = Mon, 6 = Sun
    const currentDom  = now.getDate();           // 1-31

    const rules = db.prepare(`
      SELECT * FROM notification_rules
      WHERE enabled = 1 AND trigger_type = 'schedule'
    `).all() as NotificationRuleRow[];

    for (const rule of rules) {
      if (rule.schedule_hour !== currentHour) continue;

      const shouldFire =
        (rule.schedule_type === 'weekly'  && rule.schedule_day === currentDow) ||
        (rule.schedule_type === 'monthly' && rule.schedule_day === currentDom);

      if (!shouldFire) continue;

      // Prevent double-firing within 23 hours
      if (rule.last_triggered_at !== null &&
          now.getTime() / 1000 - rule.last_triggered_at < 23 * 60 * 60) continue;

      try {
        await sendDigest(rule.schedule_type as 'weekly' | 'monthly', rule);
      } catch (err) {
        console.error(`[notifications] Digest rule ${rule.id} failed:`, err);
      }
    }
  });

  console.log('[notifications] Scheduler started');
}
