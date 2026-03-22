import type { Request } from 'express';
import { getDb } from '../db/index.js';

export type AuditEventType =
  | 'login_success'
  | 'login_failure'
  | 'login_2fa_success'
  | 'login_2fa_failure'
  | 'logout'
  | 'rate_limit_hit'
  | 'repo_added'
  | 'repo_deleted'
  | 'repo_updated'
  | 'repo_refreshed'
  | 'snapshots_deleted'
  | 'user_created'
  | 'user_deleted'
  | 'password_reset'
  | 'ssh_connection_created'
  | 'ssh_connection_deleted'
  | 'permissions_updated';

export interface AuditOptions {
  eventType: AuditEventType;
  req: Request;
  username?: string | null;
  success?: boolean;
  details?: Record<string, unknown> | string | null;
}

function extractIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
    return first?.trim() ?? null;
  }
  return req.ip ?? null;
}

export function auditLog(opts: AuditOptions): void {
  const { eventType, req, username = null, success = true, details = null } = opts;
  try {
    const db = getDb();
    const ip = extractIp(req);
    const userAgent = (req.headers['user-agent'] ?? null) as string | null;
    const detailsStr = details == null
      ? null
      : typeof details === 'string'
        ? details
        : JSON.stringify(details);

    db.prepare(`
      INSERT INTO audit_logs (event_type, username, ip_address, user_agent, details, success)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(eventType, username, ip, userAgent, detailsStr, success ? 1 : 0);
  } catch (err) {
    // Audit logging must never crash the main request
    console.error('[audit] Failed to write audit log:', err);
  }
}
