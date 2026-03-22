export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: 'admin' | 'viewer';
  totp_secret: string | null;
  totp_enabled: 0 | 1;
  created_at: number;
}

export interface RepositoryRow {
  id: number;
  name: string;
  path: string;
  type: string;
  password_encrypted: string | null;
  connection_id: number | null;
  last_indexed: number | null;
  status: string;
  error_message: string | null;
  snapshot_count: number;
  last_backup: number | null;
  created_at: number;
}

export interface SnapshotRow {
  id: number;
  repo_id: number;
  snapshot_id: string;
  short_id: string | null;
  hostname: string | null;
  username: string | null;
  tags: string | null;
  paths: string | null;
  time: number;
  tree: string | null;
  parent: string | null;
  size_bytes: number | null;
  backup_type: string;
}

export interface SnapshotStatsRow {
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

export interface RepoStatsRow {
  repo_id: number;
  total_restore_size: number | null;
  total_file_count: number | null;
  deduplicated_size: number | null;
  snapshot_count: number | null;
  oldest_snapshot: number | null;
  newest_snapshot: number | null;
  hostnames: string | null;
  tags: string | null;
  compression_ratio: number | null;
  total_blob_count: number | null;
  fetched_at: string;
}

export interface SshConnectionRow {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  private_key_encrypted: string;
  created_at: number;
}

export interface SettingRow {
  key: string;
  value: string;
}

export interface AuditLogRow {
  id: number;
  event_type: string;
  username: string | null;
  ip_address: string | null;
  user_agent: string | null;
  details: string | null;
  success: 0 | 1;
  created_at: number;
}

export interface UserRepoPermissionRow {
  user_id: number;
  repo_id: number;
}

export interface CountRow {
  c: number;
}

export interface AvgRow {
  avg_snapshot_size: number | null;
}

export interface AvgIntervalRow {
  avg_interval_seconds: number | null;
}

export interface WeekdayRow {
  dow: number;
  cnt: number;
}

export interface HourRow {
  hour: number;
  cnt: number;
}

export interface EmailProviderRow {
  id:         number;
  name:       string;
  provider:   string;
  config:     string;  // encrypted JSON
  is_default: 0 | 1;
  enabled:    0 | 1;
  created_at: number;
}

export interface NotificationRuleRow {
  id:               number;
  name:             string;
  provider_id:      number | null;
  enabled:          0 | 1;
  trigger_type:     string;
  events:           string | null;   // JSON array
  schedule_type:    string | null;
  schedule_day:     number | null;
  schedule_hour:    number;
  repo_ids:         string | null;   // JSON array
  source_ids:       string | null;   // JSON array
  severity_min:     string;
  recipients:       string;          // JSON array
  subject_template: string | null;
  created_at:       number;
  last_triggered_at: number | null;
}

export interface NotificationLogRow {
  id:            number;
  rule_id:       number | null;
  provider_id:   number | null;
  recipients:    string;  // JSON array
  subject:       string;
  status:        string;
  error_message: string | null;
  created_at:    number;
}
