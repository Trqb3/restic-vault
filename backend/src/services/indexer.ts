import fs from 'fs';
import path from 'path';
import * as cron from 'node-cron';
import { getDb, type Repository, type Snapshot } from '../db/index.js';
import { decrypt } from './crypto.js';
import { listSnapshots, classifySnapshots, getSnapshotStats, getSnapshotDiff, getRepoStats } from './restic.js';
import { sshContextForRepo, type SshKeyContext } from './ssh.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function parsePaths(pathsJson: string | null | undefined): string {
  try { return (JSON.parse(pathsJson ?? '[]') as string[]).sort().join(','); }
  catch { return ''; }
}

function findPreviousSnapshot(
  db: ReturnType<typeof getDb>,
  repoId: number,
  hostname: string,
  beforeTime: number,
  snapPaths: string
): { snapshot_id: string } | undefined {
  const candidates = db.prepare(`
    SELECT snapshot_id, paths FROM snapshots
    WHERE repo_id = ? AND hostname = ? AND time < ?
    ORDER BY time DESC
  `).all(repoId, hostname, beforeTime) as { snapshot_id: string; paths: string | null }[];
  return candidates.find((c) => parsePaths(c.paths) === snapPaths);
}

// ── Snapshot-level stat caching ───────────────────────────────────────────────

async function fetchAndCacheSnapshotStats(
  repoId: number,
  snapshotId: string,
  repoPath: string,
  password: string | undefined,
  extraArgs: string[] = []
): Promise<void> {
  const db = getDb();

  const snap = db.prepare(
    'SELECT hostname, time, paths FROM snapshots WHERE snapshot_id = ? AND repo_id = ?'
  ).get(snapshotId, repoId) as Pick<Snapshot, 'hostname' | 'time' | 'paths'> | undefined;

  if (!snap?.hostname) return;

  let restoreSize = 0;
  let fileCount   = 0;
  let addedSize:      number | null = null;
  let filesNew:       number | null = null;
  let filesChanged:   number | null = null;
  let filesUnmodified: number | null = null;

  const snapPaths = parsePaths(snap.paths);
  const previous  = findPreviousSnapshot(db, repoId, snap.hostname, snap.time, snapPaths);

  if (previous) {
    // Look up previous snapshot's cached stats — needed to derive current values without restic stats
    const prevCached = db.prepare(
      'SELECT restore_size, file_count FROM snapshot_stats WHERE snapshot_id = ?'
    ).get(previous.snapshot_id) as { restore_size: number | null; file_count: number | null } | undefined;

    // Run diff first — provides size data + file change counts in one restic call
    let diff: Awaited<ReturnType<typeof getSnapshotDiff>> | null = null;
    try {
      diff = await getSnapshotDiff(repoPath, previous.snapshot_id, snapshotId, password, extraArgs);
    } catch (err) {
      console.error('[indexer] diff failed for', snapshotId.slice(0, 8), err instanceof Error ? err.message : err);
    }

    if (diff) {
      filesNew        = diff.files_new;
      filesChanged    = diff.files_changed;
      filesUnmodified = diff.files_unmodified;

      if (diff.added_size !== null) {
        addedSize = diff.added_size - (diff.removed_size ?? 0);

        // Derive restore_size and file_count from diff + previous cache — avoids a separate
        // `restic stats` call per snapshot (cuts restic invocations roughly in half).
        if (prevCached?.restore_size != null) {
          restoreSize = prevCached.restore_size + addedSize;
          if (prevCached.file_count != null && diff.net_count_change !== null) {
            fileCount = prevCached.file_count + diff.net_count_change;
          }
        }
      }
    }

    // Fall back to restic stats if diff didn't give us sizes or previous wasn't cached
    if (restoreSize === 0) {
      try {
        const stats = await getSnapshotStats(repoPath, snapshotId, password, extraArgs);
        restoreSize = stats.restore_size;
        fileCount   = stats.file_count;
      } catch (err) {
        console.error('[indexer] snapshot stats failed for', snapshotId, err instanceof Error ? err.message : err);
        return;
      }
    }

    // Fallback for added_size when diff failed — use restore-size differential
    if (addedSize === null && prevCached?.restore_size != null) {
      addedSize = restoreSize - prevCached.restore_size;
    }
  } else {
    // First snapshot from this host+paths — need restic stats, everything counts as new
    try {
      const stats = await getSnapshotStats(repoPath, snapshotId, password, extraArgs);
      restoreSize = stats.restore_size;
      fileCount   = stats.file_count;
    } catch (err) {
      console.error('[indexer] snapshot stats failed for', snapshotId, err instanceof Error ? err.message : err);
      return;
    }
    addedSize       = restoreSize;
    filesNew        = fileCount;
    filesChanged    = 0;
    filesUnmodified = 0;
  }

  // Compute unmodified from total when diff format doesn't provide it
  // total = new + changed + unmodified  →  unmodified = total - new - changed
  if (filesUnmodified === null && filesNew !== null && filesChanged !== null) {
    filesUnmodified = Math.max(0, fileCount - filesNew - filesChanged);
  }

  console.log(`[indexer] stats cached for ${snapshotId.slice(0, 8)}: new=${filesNew} changed=${filesChanged} unmodified=${filesUnmodified} added=${addedSize !== null ? Math.round(addedSize / 1024 / 1024) + 'MB' : 'null'}`);
  db.prepare(`
    INSERT OR REPLACE INTO snapshot_stats
      (snapshot_id, repo_id, restore_size, added_size, file_count, files_new, files_changed, files_unmodified, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(snapshotId, repoId, restoreSize, addedSize, fileCount, filesNew, filesChanged, filesUnmodified, new Date().toISOString());
}

// ── Repo-level stat caching ───────────────────────────────────────────────────

async function fetchAndCacheRepoStats(
  repoId: number,
  repoPath: string,
  password: string | undefined,
  extraArgs: string[] = []
): Promise<void> {
  const db = getDb();
  // Guard against the race where repo is deleted while indexing is in progress.
  // The repo_stats FK would fail if the repo no longer exists.
  if (!db.prepare('SELECT 1 FROM repositories WHERE id = ?').get(repoId)) return;

  try {
    const meta = db.prepare(`
      SELECT
        COUNT(*) as snapshot_count,
        MIN(time) as oldest_snapshot,
        MAX(time) as newest_snapshot,
        GROUP_CONCAT(DISTINCT hostname) as hostnames,
        GROUP_CONCAT(tags) as all_tags
      FROM snapshots WHERE repo_id = ?
    `).get(repoId) as {
      snapshot_count: number;
      oldest_snapshot: number | null;
      newest_snapshot: number | null;
      hostnames: string | null;
      all_tags: string | null;
    };

    // Skip expensive restic stats calls if nothing has changed since last cache
    const existing = db.prepare(
      'SELECT snapshot_count, newest_snapshot FROM repo_stats WHERE repo_id = ?'
    ).get(repoId) as { snapshot_count: number; newest_snapshot: number | null } | undefined;
    if (existing &&
        existing.snapshot_count === meta.snapshot_count &&
        existing.newest_snapshot === meta.newest_snapshot) {
      return; // repo unchanged — skip two heavy `restic stats` calls
    }

    const [restoreStats, rawStats] = await Promise.all([
      getRepoStats(repoPath, password, undefined, extraArgs),
      getRepoStats(repoPath, password, 'raw-data', extraArgs),
    ]);

    // Collect distinct tags
    const tagSet = new Set<string>();
    if (meta.all_tags) {
      for (const chunk of meta.all_tags.split(',')) {
        try { (JSON.parse(chunk) as string[]).forEach(t => tagSet.add(t)); }
        catch { /* skip malformed */ }
      }
    }

    db.prepare(`
      INSERT OR REPLACE INTO repo_stats
        (repo_id, total_restore_size, total_file_count, deduplicated_size, snapshot_count,
         oldest_snapshot, newest_snapshot, hostnames, tags,
         compression_ratio, total_blob_count, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      repoId,
      restoreStats.total_size,
      restoreStats.total_file_count,
      rawStats.total_size,
      meta.snapshot_count,
      meta.oldest_snapshot,
      meta.newest_snapshot,
      meta.hostnames,
      JSON.stringify([...tagSet]),
      restoreStats.compression_ratio,
      rawStats.total_blob_count,
      new Date().toISOString()
    );
  } catch (err) {
    console.error('[indexer] repo stats failed for repo', repoId, err instanceof Error ? err.message : err);
  }
}

// ── Main index function ───────────────────────────────────────────────────────

export async function indexRepo(repo: Repository): Promise<void> {
  const db = getDb();
  let password: string | undefined;
  console.log(`[indexer] indexing repo ${repo.id} "${repo.name}"`);

  // Resolve SSH key context for SFTP repos — writes temp key file, returns cleanup fn
  let sshCtx: SshKeyContext | null = null;
  try {
    sshCtx = await sshContextForRepo(repo.connection_id);
  } catch (err) {
    console.error('[indexer] SSH context setup failed for repo', repo.id, err instanceof Error ? err.message : err);
  }
  const extraArgs = sshCtx?.extraArgs ?? [];

  try {
    if (repo.password_encrypted) {
      password = decrypt(repo.password_encrypted);
    }

    const snapshots = await listSnapshots(repo.path, password, extraArgs);
    console.log(`[indexer] repo ${repo.id} "${repo.name}": ${snapshots.length} snapshots`);
    const types = classifySnapshots(
      snapshots.map((s) => ({
        snapshot_id: s.id,
        time: Math.floor(new Date(s.time).getTime() / 1000),
      }))
    );

    const upsert = db.prepare(`
      INSERT INTO snapshots (repo_id, snapshot_id, short_id, hostname, username, tags, paths, time, tree, parent, backup_type)
      VALUES (@repo_id, @snapshot_id, @short_id, @hostname, @username, @tags, @paths, @time, @tree, @parent, @backup_type)
      ON CONFLICT(repo_id, snapshot_id) DO UPDATE SET
        backup_type = excluded.backup_type,
        short_id = excluded.short_id,
        hostname = excluded.hostname,
        tags = excluded.tags,
        paths = excluded.paths
    `);

    // Populate snapshot_stats directly from the summary embedded in the snapshot JSON.
    // This requires no extra restic calls and is always accurate (it's what restic recorded
    // at backup time). Uses INSERT OR REPLACE so re-indexing always reflects the source data.
    const upsertStats = db.prepare(`
      INSERT OR REPLACE INTO snapshot_stats
        (snapshot_id, repo_id, restore_size, added_size, file_count,
         files_new, files_changed, files_unmodified, fetched_at)
      VALUES (@snapshot_id, @repo_id, @restore_size, @added_size, @file_count,
              @files_new, @files_changed, @files_unmodified, @fetched_at)
    `);

    const deleteOld = db.prepare(`
      DELETE FROM snapshots
      WHERE repo_id = ? AND snapshot_id NOT IN (${snapshots.map(() => '?').join(',') || 'NULL'})
    `);

    const withSummary = snapshots.filter(s => s.summary).length;
    console.log(`[indexer] repo ${repo.id} (${repo.name}): ${snapshots.length} snapshots, ${withSummary} have embedded summary`);

    const now = new Date().toISOString();
    db.transaction(() => {
      for (const snap of snapshots) {
        const ts = Math.floor(new Date(snap.time).getTime() / 1000);
        upsert.run({
          repo_id: repo.id,
          snapshot_id: snap.id,
          short_id: snap.short_id,
          hostname: snap.hostname,
          username: snap.username,
          tags: snap.tags ? JSON.stringify(snap.tags) : null,
          paths: snap.paths ? JSON.stringify(snap.paths) : null,
          time: ts,
          tree: snap.tree,
          parent: snap.parent ?? null,
          backup_type: types.get(snap.id) ?? 'daily',
        });

        if (snap.summary) {
          const s = snap.summary;
          upsertStats.run({
            snapshot_id:      snap.id,
            repo_id:          repo.id,
            restore_size:     s.total_bytes_processed ?? null,
            added_size:       s.data_added            ?? null,
            file_count:       s.total_files_processed ?? null,
            files_new:        s.files_new             ?? null,
            files_changed:    s.files_changed         ?? null,
            files_unmodified: s.files_unmodified      ?? null,
            fetched_at:       now,
          });
        }
      }

      if (snapshots.length > 0) {
        deleteOld.run(repo.id, ...snapshots.map((s) => s.id));
      } else {
        db.prepare('DELETE FROM snapshots WHERE repo_id = ?').run(repo.id);
      }
    })();

    const lastSnap = snapshots.reduce(
      (latest, s) => {
        const t = new Date(s.time).getTime();
        return t > latest ? t : latest;
      },
      0
    );

    db.prepare(`
      UPDATE repositories
      SET status = 'ok', error_message = NULL, last_indexed = unixepoch(),
          snapshot_count = ?, last_backup = ?
      WHERE id = ?
    `).run(snapshots.length, lastSnap > 0 ? Math.floor(lastSnap / 1000) : null, repo.id);

    // Fetch snapshot stats for any snapshots not yet cached (sequential to avoid overloading)
    const missing = db.prepare(`
      SELECT s.snapshot_id FROM snapshots s
      LEFT JOIN snapshot_stats ss ON ss.snapshot_id = s.snapshot_id
      WHERE s.repo_id = ? AND ss.snapshot_id IS NULL
      ORDER BY s.time ASC
    `).all(repo.id) as { snapshot_id: string }[];

    // Small pause between snapshot stat fetches — restic is CPU-heavy and we want to
    // keep the system responsive. 100ms is enough to avoid a solid CPU wall.
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    // Cap: process at most this many heavy (diff) fetches per index run.
    // Remaining rows will be picked up on subsequent cron runs.
    const STATS_BATCH_LIMIT = 10;

    if (missing.length > 0) {
      console.log(`[indexer] repo ${repo.id}: ${missing.length} snapshots missing stats (processing up to ${STATS_BATCH_LIMIT})`);
      for (const row of missing.slice(0, STATS_BATCH_LIMIT)) {
        await fetchAndCacheSnapshotStats(repo.id, row.snapshot_id, repo.path, password, extraArgs);
        await sleep(100); // brief pause — main cost is the restic call itself
      }
    }

    // Re-fetch stale rows: cached but both files_changed AND files_unmodified are NULL.
    // (First-snapshot rows have files_changed = 0 and files_unmodified = 0, so they're excluded.)
    const stale = db.prepare(`
      SELECT s.snapshot_id FROM snapshots s
      JOIN snapshot_stats ss ON ss.snapshot_id = s.snapshot_id
      WHERE s.repo_id = ?
        AND ss.files_changed    IS NULL
        AND ss.files_unmodified IS NULL
        AND ss.restore_size     IS NOT NULL
      ORDER BY s.time ASC
    `).all(repo.id) as { snapshot_id: string }[];

    if (stale.length > 0) {
      const toProcess = stale.slice(0, STATS_BATCH_LIMIT - Math.min(missing.length, STATS_BATCH_LIMIT));
      console.log(`[indexer] repo ${repo.id}: ${stale.length} stale rows, re-fetching ${toProcess.length}`);
      for (const row of toProcess) {
        await fetchAndCacheSnapshotStats(repo.id, row.snapshot_id, repo.path, password, extraArgs);
        await sleep(100);
      }
    }

    // Update repo-level stats cache
    await fetchAndCacheRepoStats(repo.id, repo.path, password, extraArgs);

    // Record a size history data point (throttled to at most once per hour)
    await recordSizeHistory(repo, password, extraArgs);

    console.log(`[indexer] repo ${repo.id} "${repo.name}": index complete`);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare(`
      UPDATE repositories
      SET status = 'error', error_message = ?, last_indexed = unixepoch()
      WHERE id = ?
    `).run(msg.slice(0, 500), repo.id);
  } finally {
    sshCtx?.cleanup();
  }
}

// Run repos in parallel — each repo uses a separate path so there's no lock contention
// (all reads use --no-lock). Each repo still processes its snapshots sequentially internally.
// With N repos, total time ≈ slowest single repo instead of sum of all repos.
export async function indexAllRepos(): Promise<void> {
  const db = getDb();
  const repos = db.prepare('SELECT * FROM repositories').all() as Repository[];
  console.log(`[indexer] starting full index run for ${repos.length} repos`);
  await Promise.all(
    repos.map((r) =>
      indexRepo(r).catch((err) =>
        console.error(`[indexer] indexRepo ${r.id} threw:`, err instanceof Error ? err.message : err)
      )
    )
  );
  console.log('[indexer] full index run complete');
}

// Scan base directory for restic repos
export async function scanBaseDir(baseDir: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const names = new Set(entries.filter((e) => !e.isDirectory()).map((e) => e.name));
    const dirs = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));

    if (names.has('config') && dirs.has('data')) {
      found.push(dir);
      return; // don't recurse into a repo
    }

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        await walk(path.join(dir, entry.name));
      }
    }
  }

  try {
    fs.accessSync(baseDir);
    await walk(baseDir);
  } catch {
    // base dir doesn't exist or isn't accessible
  }

  return found;
}

// ── Repo size history ─────────────────────────────────────────────────────────

async function recordSizeHistory(
  repo: Repository,
  password: string | undefined,
  sshArgs: string[],
): Promise<void> {
  const db = getDb();
  try {
    // Only record once per hour max — avoid duplicate points on frequent re-indexing
    const lastRecord = db.prepare(`
      SELECT recorded_at FROM repo_size_history
      WHERE repo_id = ?
      ORDER BY recorded_at DESC LIMIT 1
    `).get(repo.id) as { recorded_at: number } | undefined;

    const oneHourAgo = Math.floor(Date.now() / 1000) - 60 * 60;
    if (lastRecord && lastRecord.recorded_at > oneHourAgo) return;

    const [rawStats, restoreStats] = await Promise.all([
      getRepoStats(repo.path, password, 'raw-data', sshArgs),
      getRepoStats(repo.path, password, undefined, sshArgs),
    ]);

    const snapshotCount = (db.prepare(
      'SELECT COUNT(*) as c FROM snapshots WHERE repo_id = ?',
    ).get(repo.id) as { c: number }).c;

    db.prepare(`
      INSERT INTO repo_size_history (repo_id, deduplicated_size, total_restore_size, snapshot_count)
      VALUES (?, ?, ?, ?)
    `).run(repo.id, rawStats.total_size, restoreStats.total_size, snapshotCount);
  } catch (err) {
    // Non-fatal — don't fail the whole index run
    console.warn(`[indexer] Failed to record size history for repo ${repo.id}:`, err instanceof Error ? err.message : err);
  }
}

export async function backfillSizeHistory(): Promise<void> {
  const db = getDb();
  const repos = db.prepare(`
    SELECT r.* FROM repositories r
    LEFT JOIN repo_size_history h ON h.repo_id = r.id
    WHERE h.id IS NULL AND r.status = 'ok'
  `).all() as Repository[];

  if (repos.length === 0) return;
  console.log(`[indexer] Backfilling size history for ${repos.length} repos...`);

  for (const repo of repos) {
    try {
      let password: string | undefined;
      if (repo.password_encrypted) {
        password = decrypt(repo.password_encrypted);
      }
      const sshCtx = await sshContextForRepo(repo.connection_id).catch(() => null);
      await recordSizeHistory(repo, password, sshCtx?.extraArgs ?? []);
      sshCtx?.cleanup();
    } catch {
      // Skip failed repos silently
    }
  }
  console.log(`[indexer] Size history backfill complete`);
}

// ── Dynamic cron scheduler ────────────────────────────────────────────────────

let currentTask: cron.ScheduledTask | null = null;

function minutesToCron(minutes: number): string {
  if (minutes < 60) return `*/${minutes} * * * *`;
  const hours = Math.floor(minutes / 60);
  if (minutes % 60 === 0) return `0 */${hours} * * *`;
  return `*/${minutes} * * * *`; // fallback for non-round hours
}

export function startIndexer(intervalMinutes: number = 15): void {
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
  }
  const schedule = minutesToCron(intervalMinutes);
  console.log(`[indexer] Starting with schedule: ${schedule} (every ${intervalMinutes} min)`);
  currentTask = cron.schedule(schedule, () => {
    console.log('[indexer] Running scheduled index...');
    indexAllRepos().catch((err) =>
      console.error('[indexer] Error during scheduled indexing:', err)
    );
  });
}

export function restartIndexer(intervalMinutes: number): void {
  console.log(`[indexer] Restarting with interval: ${intervalMinutes} minutes`);
  startIndexer(intervalMinutes);
}

export function stopIndexer(): void {
  currentTask?.stop();
  currentTask = null;
}
