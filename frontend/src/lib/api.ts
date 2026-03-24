export interface SshConnection {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  created_at: number;
}

export interface Repo {
  id: number;
  name: string;
  path: string;
  type: string;
  connection_id: number | null;
  last_indexed: number | null;
  status: 'ok' | 'error' | 'unknown';
  error_message: string | null;
  snapshot_count: number;
  last_backup: number | null;
  has_password: number;
  created_at: number;
}

export interface Snapshot {
  id: number;
  repo_id: number;
  snapshot_id: string;
  short_id: string;
  hostname: string;
  username: string;
  tags: string[];
  paths: string[];
  time: number;
  size_bytes: number | null;
  backup_type: 'daily' | 'weekly' | 'monthly' | 'yearly';
  // Inlined from snapshot_stats (null when not yet cached by indexer)
  restore_size: number | null;
  added_size: number | null;
  file_count: number | null;
  files_new: number | null;
  files_changed: number | null;
  files_unmodified: number | null;
}

export interface RepoStats {
  total_restore_size: number;
  total_file_count: number | null;
  deduplicated_size: number;
  snapshot_count: number;
  oldest_snapshot: number | null;
  newest_snapshot: number | null;
  hostnames: string[];
  tags: string[];
  compression_ratio: number | null;
  total_blob_count: number | null;
  fetched_at: string | null;
  avg_snapshot_size: number | null;
  avg_interval_seconds: number | null;
  backup_by_weekday: Record<number, number>;
  backup_by_hour: Record<number, number>;
}

export interface SnapshotStats {
  snapshot_id: string;
  repo_id: number;
  restore_size: number | null;
  added_size: number | null;
  file_count: number | null;
  files_new: number | null;
  files_changed: number | null;
  files_unmodified: number | null;
  fetched_at: string;
}

export interface AdminUser {
  id: number;
  username: string;
  role: 'admin' | 'viewer';
  totp_enabled: number;  // 0 | 1
  created_at: number;
  repo_count: number;
}

export interface AuditLog {
  id: number;
  event_type: string;
  username: string | null;
  ip_address: string | null;
  user_agent: string | null;
  details: string | null;
  success: number;  // 0 | 1
  created_at: number;
}

export interface AuditStats {
  loginFailures24h: number;
  rateLimitHits24h: number;
  totalEvents7d: number;
  byType: { event_type: string; c: number }[];
}

export interface SizeHistoryPoint {
  recorded_at: number;
  deduplicated_size: number;
  total_restore_size: number | null;
  snapshot_count: number | null;
}

export interface FileNode {
  struct_type: string;
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  path: string;
  size?: number;
  mtime?: string;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'include',
  });

  const data = await res.json().catch(() => ({}));

  if (res.status === 401) {
    // Auth endpoints (login, 2fa challenge) legitimately return 401 for wrong
    // credentials — bubble the error up to the caller instead of hard-redirecting.
    const isAuthEndpoint =
      url === '/api/auth/login' ||
      url === '/api/auth/2fa/challenge';
    if (!isAuthEndpoint) {
      window.location.href = '/login';
      throw new Error('Unauthorized');
    }
  }

  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

// Auth
export const auth = {
  login: (username: string, password: string) =>
    request<{ username?: string; role?: string; requires2fa?: boolean }>('POST', '/api/auth/login', { username, password }),
  logout: () => request<{ ok: boolean }>('POST', '/api/auth/logout'),
  me: () => request<{ username: string; userId: number; role: 'admin' | 'viewer'; totp_enabled: boolean }>('GET', '/api/auth/me'),
  challenge2fa: (code: string) =>
    request<{ username: string; role: string }>('POST', '/api/auth/2fa/challenge', { code }),
  setup2fa: () =>
    request<{ secret: string; qrCode: string; otpauthUrl: string }>('POST', '/api/auth/2fa/setup'),
  verify2fa: (code: string) =>
    request<{ ok: boolean }>('POST', '/api/auth/2fa/verify', { code }),
  disable2fa: (password: string, code: string) =>
    request<{ ok: boolean }>('POST', '/api/auth/2fa/disable', { password, code }),
};

// Repos
export const repos = {
  list: () => request<Repo[]>('GET', '/api/repos'),
  get: (id: number) => request<Repo>('GET', `/api/repos/${id}`),
  create: (data: { name: string; path: string; type?: string; password?: string; connectionId?: number }) =>
    request<{ id: number }>('POST', '/api/repos', data),
  update: (id: number, data: { name?: string; password?: string; clearPassword?: boolean }) =>
    request<{ ok: boolean }>('PUT', `/api/repos/${id}`, data),
  patch: (id: number, data: { name?: string; path?: string; password?: string }) =>
    request<{ ok: boolean }>('PATCH', `/api/repos/${id}`, data),
  delete: (id: number) => request<{ ok: boolean }>('DELETE', `/api/repos/${id}`),
  refresh: (id: number) => request<Repo>('POST', `/api/repos/${id}/refresh`),
  scan: () => request<{ found: number; added: number; newPaths: string[] }>('POST', '/api/repos/scan'),
  stats: (id: number) => request<RepoStats>('GET', `/api/repos/${id}/stats`),
  sizeHistory: (id: number, days = 90) =>
    request<SizeHistoryPoint[]>('GET', `/api/repos/${id}/size-history?days=${days}`),
};

// Settings
export const settings = {
  get: () => request<{ baseDir: string; indexIntervalMinutes: number }>('GET', '/api/settings'),
  set: (baseDir: string, indexIntervalMinutes?: number) =>
    request<{ ok: boolean }>('PUT', '/api/settings', { baseDir, indexIntervalMinutes }),
};

// Snapshots
export const snapshots = {
  list: (repoId: number) => request<Snapshot[]>('GET', `/api/repos/${repoId}/snapshots`),
  delete: (repoId: number, ids: string[]) =>
    request<{ ok: boolean; deleted: number }>('DELETE', `/api/repos/${repoId}/snapshots`, { ids }),
  stats: (repoId: number, snapshotId: string) =>
    request<SnapshotStats>('GET', `/api/repos/${repoId}/snapshots/${snapshotId}/stats`),
};

// Admin
export const admin = {
  listUsers: () => request<AdminUser[]>('GET', '/api/admin/users'),
  createUser: (data: { username: string; password: string; role: string }) =>
    request<{ id: number; username: string; role: string }>('POST', '/api/admin/users', data),
  deleteUser: (id: number) => request<{ ok: boolean }>('DELETE', `/api/admin/users/${id}`),
  resetPassword: (id: number, password: string) =>
    request<{ ok: boolean }>('POST', `/api/admin/users/${id}/reset-password`, { password }),
  getPermissions: (userId: number) => request<number[]>('GET', `/api/admin/users/${userId}/permissions`),
  setPermissions: (userId: number, repoIds: number[]) =>
    request<{ ok: boolean }>('PUT', `/api/admin/users/${userId}/permissions`, { repoIds }),
  listSshConnections: () =>
    request<SshConnection[]>('GET', '/api/admin/ssh-connections'),
  createSshConnection: (data: { name: string; host: string; port: number; username: string; privateKey: string }) =>
    request<{ id: number }>('POST', '/api/admin/ssh-connections', data),
  deleteSshConnection: (id: number) =>
    request<{ ok: boolean }>('DELETE', `/api/admin/ssh-connections/${id}`),
  testSshConnection: (id: number) =>
    request<{ ok: boolean; error?: string }>('POST', `/api/admin/ssh-connections/${id}/test`),
  reset2fa: (id: number) =>
    request<{ ok: boolean }>('DELETE', `/api/admin/users/${id}/2fa`),
  getAuditLogs: (params?: { eventType?: string; username?: string; success?: '0' | '1'; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.eventType) qs.set('eventType', params.eventType);
    if (params?.username)  qs.set('username',  params.username);
    if (params?.success !== undefined) qs.set('success', params.success);
    if (params?.limit  !== undefined) qs.set('limit',  String(params.limit));
    if (params?.offset !== undefined) qs.set('offset', String(params.offset));
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ total: number; rows: AuditLog[] }>('GET', `/api/admin/audit-logs${query}`);
  },
  getAuditStats: () => request<AuditStats>('GET', '/api/admin/audit-logs/stats'),
};

// Notifications
export interface EmailProvider {
  id: number;
  name: string;
  provider: 'smtp' | 'sendgrid' | 'mailgun' | 'resend' | 'ses';
  is_default: 0 | 1;
  enabled: 0 | 1;
  created_at: number;
}

export interface NotificationRule {
  id: number;
  name: string;
  provider_id: number | null;
  enabled: 0 | 1;
  trigger_type: 'event' | 'schedule';
  events: string | null;
  schedule_type: 'weekly' | 'monthly' | null;
  schedule_day: number | null;
  schedule_hour: number;
  repo_ids: string | null;
  source_ids: string | null;
  severity_min: string;
  recipients: string;
  subject_template: string | null;
  last_triggered_at: number | null;
  created_at: number;
}

export interface NotificationLogEntry {
  id: number;
  rule_id: number | null;
  provider_id: number | null;
  recipients: string;
  subject: string;
  status: 'sent' | 'failed';
  error_message: string | null;
  created_at: number;
}

export const notifications = {
  getProviders:   () =>
    request<EmailProvider[]>('GET', '/api/notifications/providers'),
  createProvider: (data: object) =>
    request<{ id: number }>('POST', '/api/notifications/providers', data),
  updateProvider: (id: number, data: object) =>
    request<{ ok: boolean }>('PATCH', `/api/notifications/providers/${id}`, data),
  deleteProvider: (id: number) =>
    request<{ ok: boolean }>('DELETE', `/api/notifications/providers/${id}`),
  testProvider:   (id: number, to: string) =>
    request<{ ok: boolean }>('POST', `/api/notifications/providers/${id}/test`, { to }),
  getRules:   () =>
    request<NotificationRule[]>('GET', '/api/notifications/rules'),
  createRule: (data: object) =>
    request<{ id: number }>('POST', '/api/notifications/rules', data),
  updateRule: (id: number, data: object) =>
    request<{ ok: boolean }>('PATCH', `/api/notifications/rules/${id}`, data),
  deleteRule: (id: number) =>
    request<{ ok: boolean }>('DELETE', `/api/notifications/rules/${id}`),
  getLog: () =>
    request<NotificationLogEntry[]>('GET', '/api/notifications/log'),
};

// Backup Sources
export interface BackupSource {
  id: number;
  name: string;
  description: string | null;
  token_hash: string;
  repo_id: number | null;
  repo_name: string | null;
  repo_path: string | null;
  disabled: 0 | 1;
  last_seen_at: number | null;
  last_backup_at: number | null;
  agent_version: string | null;
  schedule: string;
  keep_last: number | null;
  keep_daily: number | null;
  keep_weekly: number | null;
  keep_monthly: number | null;
  keep_yearly: number | null;
  created_at: number;
}

export interface BackupSourceLog {
  id: number;
  source_id: number;
  level: 'info' | 'warning' | 'error';
  message: string;
  created_at: number;
}

export interface AgentCommand {
  id: number;
  source_id: number;
  command: string;
  params: string | null;
  status: 'pending' | 'acked' | 'done';
  created_at: number;
  acked_at: number | null;
  done_at: number | null;
}

export interface ExclusionProfile {
  id: number;
  name: string;
  description: string | null;
  patterns: string;  // JSON array string
  created_at: number;
}

export interface SourceExclusionRule {
  id: number;
  source_id: number;
  profile_id: number | null;
  custom_patterns: string | null;
  backup_paths: string | null;
  created_at: number;
}

export interface AgentDiscoveredPath {
  id: number;
  source_id: number;
  path: string;
  size_bytes: number | null;
  file_count: number | null;
  last_seen_at: number;
}

export interface BackupProgress {
  active: boolean;
  percentDone?: number;
  totalFiles?: number;
  filesDone?: number;
  totalBytes?: number;
  bytesDone?: number;
  currentFile?: string;
}

export const backupSources = {
  list: () =>
    request<BackupSource[]>('GET', '/api/sources'),
  get: (id: number) =>
    request<BackupSource>('GET', `/api/sources/${id}`),
  create: (data: { name: string; description?: string }) =>
    request<{ id: number; token: string }>('POST', '/api/sources', data),
  update: (id: number, data: {
    description?: string; disabled?: boolean;
    schedule?: string;
    keepLast?: number | null; keepDaily?: number | null; keepWeekly?: number | null;
    keepMonthly?: number | null; keepYearly?: number | null;
  }) =>
    request<{ ok: boolean }>('PATCH', `/api/sources/${id}`, data),
  delete: (id: number) =>
    request<{ ok: boolean }>('DELETE', `/api/sources/${id}`),
  rotateToken: (id: number) =>
    request<{ token: string }>('POST', `/api/sources/${id}/rotate-token`),
  getLogs: (id: number, params?: { limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.limit  !== undefined) qs.set('limit',  String(params.limit));
    if (params?.offset !== undefined) qs.set('offset', String(params.offset));
    const q = qs.toString() ? `?${qs.toString()}` : '';
    return request<BackupSourceLog[]>('GET', `/api/sources/${id}/logs${q}`);
  },
  getCommands: (id: number) =>
    request<AgentCommand[]>('GET', `/api/sources/${id}/commands`),
  sendCommand: (id: number, command: string, params?: Record<string, unknown>) =>
    request<{ id: number }>('POST', `/api/sources/${id}/commands`, { command, params }),
  getExclusionRule: (id: number) =>
    request<SourceExclusionRule | null>('GET', `/api/sources/${id}/exclusion-rule`),
  setExclusionRule: (id: number, data: { profileId?: number | null; customPatterns?: string[]; backupPaths?: string[] }) =>
    request<{ ok: boolean }>('PUT', `/api/sources/${id}/exclusion-rule`, data),
  getPaths: (id: number) =>
    request<AgentDiscoveredPath[]>('GET', `/api/sources/${id}/paths`),
  getProgress: (id: number) =>
    request<BackupProgress>('GET', `/api/sources/${id}/progress`),
};

export const exclusionProfiles = {
  list: () =>
    request<ExclusionProfile[]>('GET', '/api/exclusion-profiles'),
  create: (data: { name: string; description?: string; patterns: string[] }) =>
    request<{ id: number }>('POST', '/api/exclusion-profiles', data),
  update: (id: number, data: { name?: string; description?: string; patterns?: string[] }) =>
    request<{ ok: boolean }>('PATCH', `/api/exclusion-profiles/${id}`, data),
  delete: (id: number) =>
    request<{ ok: boolean }>('DELETE', `/api/exclusion-profiles/${id}`),
};

// Files
export const files = {
  ls: (repoId: number, snapshotId: string, path = '/') =>
    request<{ nodes: FileNode[]; path: string }>('GET', `/api/repos/${repoId}/snapshots/${snapshotId}/ls?path=${encodeURIComponent(path)}`),
  downloadUrl: (repoId: number, snapshotId: string, path: string) =>
    `/api/repos/${repoId}/snapshots/${snapshotId}/download?path=${encodeURIComponent(path)}`,
  downloadDirUrl: (repoId: number, snapshotId: string, path: string) =>
    `/api/repos/${repoId}/snapshots/${snapshotId}/download-dir?path=${encodeURIComponent(path)}`,
};
