import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'restic-vault.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    migrate(_db);
  }
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL DEFAULT 'local',
      password_encrypted TEXT,
      last_indexed INTEGER,
      status TEXT NOT NULL DEFAULT 'unknown',
      error_message TEXT,
      snapshot_count INTEGER NOT NULL DEFAULT 0,
      last_backup INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      snapshot_id TEXT NOT NULL,
      short_id TEXT,
      hostname TEXT,
      username TEXT,
      tags TEXT,
      paths TEXT,
      time INTEGER NOT NULL,
      tree TEXT,
      parent TEXT,
      size_bytes INTEGER,
      backup_type TEXT NOT NULL DEFAULT 'daily',
      UNIQUE(repo_id, snapshot_id)
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_repo_time ON snapshots(repo_id, time);

    CREATE TABLE IF NOT EXISTS user_repo_permissions (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, repo_id)
    );

    CREATE TABLE IF NOT EXISTS snapshot_stats (
      snapshot_id      TEXT PRIMARY KEY,
      repo_id          INTEGER NOT NULL,
      restore_size     INTEGER,
      added_size       INTEGER,
      file_count       INTEGER,
      files_new        INTEGER,
      files_changed    INTEGER,
      files_unmodified INTEGER,
      fetched_at       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repo_stats (
      repo_id           INTEGER PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
      total_restore_size INTEGER,
      total_file_count   INTEGER,
      deduplicated_size  INTEGER,
      snapshot_count     INTEGER,
      oldest_snapshot    INTEGER,
      newest_snapshot    INTEGER,
      hostnames          TEXT,
      tags               TEXT,
      fetched_at         TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ssh_connections (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      name                  TEXT NOT NULL,
      host                  TEXT NOT NULL,
      port                  INTEGER NOT NULL DEFAULT 22,
      username              TEXT NOT NULL,
      private_key_encrypted TEXT NOT NULL,
      created_at            INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type  TEXT    NOT NULL,
      username    TEXT,
      ip_address  TEXT,
      user_agent  TEXT,
      details     TEXT,
      success     INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type  ON audit_logs(event_type);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_username    ON audit_logs(username);

    INSERT OR IGNORE INTO settings (key, value) VALUES ('index_interval_minutes', '15');
  `);

  // Additive migrations — idempotent
  const alterations = [
    `ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`,
    `ALTER TABLE users ADD COLUMN totp_secret TEXT`,
    `ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE snapshot_stats ADD COLUMN files_new        INTEGER`,
    `ALTER TABLE snapshot_stats ADD COLUMN files_changed    INTEGER`,
    `ALTER TABLE snapshot_stats ADD COLUMN files_unmodified INTEGER`,
    `ALTER TABLE repo_stats ADD COLUMN compression_ratio REAL`,
    `ALTER TABLE repo_stats ADD COLUMN total_blob_count  INTEGER`,
    `ALTER TABLE repositories ADD COLUMN connection_id INTEGER REFERENCES ssh_connections(id) ON DELETE SET NULL`,
  ];
  for (const sql of alterations) {
    try {
      db.exec(sql);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column name')) throw err;
    }
  }

  // One-time migrations keyed by a settings flag
  const oneTime: Array<{ key: string; run: () => void }> = [
    {
      // snapshot_stats rows cached before --no-lock was added to restic diff had
      // added_size = restore_size as a fallback (diff always failed on read-only mounts).
      // Clear them so the indexer recomputes with real diff values.
      key: 'migration_clear_snapshot_stats_v1',
      run: () => db.exec('DELETE FROM snapshot_stats'),
    },
    {
      // Clear again now that the diff parser has a stats-differential fallback and
      // first-snapshot handling, so previously-null rows get real values.
      key: 'migration_clear_snapshot_stats_v2',
      run: () => db.exec('DELETE FROM snapshot_stats'),
    },
    {
      // Clear again now that the parent lookup matches hostname AND paths,
      // so stats computed against a wrong parent (different backup paths) are evicted.
      key: 'migration_clear_snapshot_stats_v3',
      run: () => db.exec('DELETE FROM snapshot_stats'),
    },
    {
      // Clear again: added_size now represents net change (added − removed, can be negative)
      // instead of the previously clamped max(0, …) value.
      key: 'migration_clear_snapshot_stats_v4',
      run: () => db.exec('DELETE FROM snapshot_stats'),
    },
    {
      // Clear again: per-file diff counting now also matches message_type "changed" (not only
      // "modified"), and falls back to text-mode parsing. Rows where files_changed was incorrectly
      // stored as 0 due to the wrong message_type name are evicted.
      key: 'migration_clear_snapshot_stats_v5',
      run: () => db.exec('DELETE FROM snapshot_stats'),
    },
    {
      // Clear again: stats are now populated directly from the snapshot summary embedded in
      // `restic snapshots --json` (files_new, files_changed, files_unmodified, data_added,
      // total_bytes_processed) — no restic diff needed. Evict old diff-based data.
      key: 'migration_clear_snapshot_stats_v6',
      run: () => db.exec('DELETE FROM snapshot_stats'),
    },
    {
      // Clear again: restic diff summary lines with absent 'files' keys in changed/unmodified
      // objects were incorrectly stored as null instead of 0. Re-compute with corrected parser.
      key: 'migration_clear_snapshot_stats_v7',
      run: () => db.exec('DELETE FROM snapshot_stats'),
    },
    {
      // Clear again: restic diff summary used 'bytes' not 'size' for the size field in older
      // versions, causing added_size=null. Also now computes files_unmodified from file_count
      // when diff format doesn't provide it. Re-compute all rows.
      key: 'migration_clear_snapshot_stats_v8',
      run: () => db.exec('DELETE FROM snapshot_stats'),
    },
    {
      // Clear again: files_unmodified was returned as 0 instead of null when absent from diff
      // summary, blocking the fileCount-based fallback computation. Re-compute all rows.
      key: 'migration_clear_snapshot_stats_v9',
      run: () => db.exec('DELETE FROM snapshot_stats'),
    },
    {
      // Clear again: files_changed now computed via path intersection (added ∩ removed paths)
      // instead of 0 for older restic diff format. Files_new = added - changed (truly new only).
      key: 'migration_clear_snapshot_stats_v10',
      run: () => db.exec('DELETE FROM snapshot_stats'),
    },
    {
      // Clear again: hasJsonLines was gated on path field presence; per-file lines without path
      // fell through to hasSummary returning 0. Now tracks addedCount/removedCount separately
      // from path sets so path-absent lines are handled correctly.
      key: 'migration_clear_snapshot_stats_v11',
      run: () => db.exec('DELETE FROM snapshot_stats'),
    },
    {
      // Clear again: summaryFilesNew was never set for the older diff format, causing files_new=0
      // and files_unmodified=fileCount. Now reads a.files from the older summary format.
      key: 'migration_clear_snapshot_stats_v12',
      run: () => db.exec('DELETE FROM snapshot_stats'),
    },
  ];
  for (const { key, run } of oneTime) {
    const done = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key);
    if (!done) {
      run();
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')").run(key);
    }
  }
}

export interface User {
  id: number;
  username: string;
  password_hash: string;
  role: 'admin' | 'viewer';
  totp_secret: string | null;
  totp_enabled: number;  // 0 | 1
  created_at: number;
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

export interface SshConnection {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  private_key_encrypted: string;
  created_at: number;
}

export interface Repository {
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

export interface Snapshot {
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
