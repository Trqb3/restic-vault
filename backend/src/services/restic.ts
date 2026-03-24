import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import type { Response } from 'express';

const execFileAsync = promisify(execFile);

const RESTIC_BIN = process.env.RESTIC_BINARY || 'restic';
const MAX_BUFFER = 200 * 1024 * 1024; // 200MB
const EXEC_TIMEOUT = parseInt(process.env.RESTIC_TIMEOUT || '120000', 10); // 2 min default

// Summary embedded in every snapshot created by restic backup --json.
// Available via `restic snapshots --json` — no extra restic calls needed.
export interface ResticSnapshotSummary {
  backup_start: string;
  backup_end: string;
  files_new: number;
  files_changed: number;
  files_unmodified: number;
  dirs_new: number;
  dirs_changed: number;
  dirs_unmodified: number;
  data_blobs: number;
  tree_blobs: number;
  data_added: number;          // bytes of new unique data added to the repo
  data_added_packed?: number;  // same, after compression/packing
  total_files_processed: number;
  total_bytes_processed: number; // total restore size of the snapshot
}

export interface ResticSnapshot {
  id: string;
  short_id: string;
  time: string;
  tree: string;
  paths: string[];
  hostname: string;
  username: string;
  tags?: string[];
  parent?: string;
  summary?: ResticSnapshotSummary; // present for snapshots created by `restic backup`
}

export interface ResticNode {
  struct_type: string;
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  path: string;
  uid?: number;
  gid?: number;
  size?: number;
  mode?: number;
  mtime?: string;
  atime?: string;
  ctime?: string;
  content?: string[];
  subtree?: string;
}

interface EnvResult {
  env: NodeJS.ProcessEnv;
  /** Extra CLI args to prepend (e.g. --insecure-no-password for passwordless repos) */
  implicitArgs: string[];
}

function buildEnv(repoPath: string, password?: string): EnvResult {
  const env: NodeJS.ProcessEnv = { ...process.env, RESTIC_REPOSITORY: repoPath };
  // Remove any overrides that would take precedence over RESTIC_PASSWORD
  delete env.RESTIC_PASSWORD_FILE;
  delete env.RESTIC_PASSWORD_COMMAND;
  // Remove RESTIC_REPOSITORY_FILE too — our explicit value must win
  delete env.RESTIC_REPOSITORY_FILE;

  const implicitArgs: string[] = [];

  if (password) {
    // Encrypted repo — use the actual password
    env.RESTIC_PASSWORD = password;
    console.log(`[restic] buildEnv repo=${repoPath} passwordMode=encrypted`);
  } else {
    // Passwordless repo — use BOTH env var AND CLI flag for maximum compatibility.
    // Some restic versions ignore RESTIC_PASSWORD="" but respect --insecure-no-password.
    env.RESTIC_PASSWORD = '';
    implicitArgs.push('--insecure-no-password');
    console.log(`[restic] buildEnv repo=${repoPath} passwordMode=insecure-no-password`);
  }

  return { env, implicitArgs };
}

export async function listSnapshots(
  repoPath: string,
  password?: string,
  extraArgs: string[] = []
): Promise<ResticSnapshot[]> {
  const { env, implicitArgs } = buildEnv(repoPath, password);
  const args = [...implicitArgs, ...extraArgs, 'snapshots', '--json', '--no-lock', '--no-cache'];
  console.log(`[restic] listSnapshots cmd: ${RESTIC_BIN} ${args.join(' ')} | repo=${repoPath}`);

  // Pre-flight: verify the repo directory exists and looks like a restic repo
  if (!repoPath.startsWith('rest:') && !repoPath.startsWith('sftp:') &&
      !repoPath.startsWith('s3:') && !repoPath.startsWith('b2:') &&
      !repoPath.startsWith('azure:') && !repoPath.startsWith('gs:') &&
      !repoPath.includes('://')) {
    try {
      const entries = fs.readdirSync(repoPath);
      const hasConfig = entries.includes('config');
      const hasData = entries.includes('data');
      console.log(`[restic] listSnapshots repo-check: path=${repoPath} entries=[${entries.join(',')}] hasConfig=${hasConfig} hasData=${hasData}`);
      if (!hasConfig || !hasData) {
        console.error(`[restic] listSnapshots: ${repoPath} does not look like a restic repo (missing config or data dir)`);
        return [];
      }
    } catch (fsErr) {
      console.error(`[restic] listSnapshots: cannot read repo dir ${repoPath}: ${fsErr instanceof Error ? fsErr.message : fsErr}`);
      throw new Error(`Cannot access repo directory: ${repoPath}`);
    }
  }

  const startTime = Date.now();
  try {
    const { stdout } = await execFileAsync(RESTIC_BIN, args, {
      env,
      maxBuffer: MAX_BUFFER,
      timeout: EXEC_TIMEOUT,
    });
    const elapsed = Date.now() - startTime;
    const parsed = JSON.parse(stdout.trim() || '[]');
    const result = Array.isArray(parsed) ? parsed : [];
    console.log(`[restic] listSnapshots result: ${result.length} snapshots (${elapsed}ms)`);
    return result;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const e = err as Error & { stderr?: string; code?: number; killed?: boolean; signal?: string };
    if (e.killed || e.signal === 'SIGTERM') {
      console.error(`[restic] listSnapshots KILLED after ${elapsed}ms (timeout=${EXEC_TIMEOUT}ms) repo=${repoPath}`);
    } else {
      console.error(`[restic] listSnapshots FAILED (exit ${e.code ?? '?'}, ${elapsed}ms): ${e.message}`);
    }
    if (e.stderr) console.error(`[restic] listSnapshots stderr: ${e.stderr.slice(0, 1000)}`);
    throw err;
  }
}

export async function listFiles(
  repoPath: string,
  snapshotId: string,
  dirPath: string,
  password?: string,
  extraArgs: string[] = []
): Promise<{ snapshot: ResticSnapshot | null; nodes: ResticNode[] }> {
  const { env, implicitArgs } = buildEnv(repoPath, password);
  const args = [...implicitArgs, ...extraArgs, 'ls', '--json', '--no-lock', '--no-cache', snapshotId, '--', dirPath];
  const { stdout } = await execFileAsync(RESTIC_BIN, args, {
    env,
    maxBuffer: MAX_BUFFER,
    timeout: EXEC_TIMEOUT,
  });

  const lines = stdout.trim().split('\n').filter(Boolean);
  let snapshot: ResticSnapshot | null = null;
  const nodes: ResticNode[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.struct_type === 'snapshot') {
        snapshot = obj as ResticSnapshot;
      } else if (obj.struct_type === 'node') {
        const node = obj as ResticNode;
        // Only include immediate children of dirPath
        const parentPath = node.path.substring(0, node.path.lastIndexOf('/')) || '/';
        const normalizedDir = dirPath === '/' ? '/' : dirPath.replace(/\/$/, '');
        if (parentPath === normalizedDir) {
          nodes.push(node);
        }
      }
    } catch {
      // skip malformed lines
    }
  }

  return { snapshot, nodes };
}

function spawnResticDump(
  args: string[],
  repoPath: string,
  password: string | undefined,
  res: Response,
  label: string,
  extraArgs: string[] = []
): void {
  const { env, implicitArgs } = buildEnv(repoPath, password);
  const fullArgs = [...implicitArgs, ...extraArgs, ...args];
  console.log(`[restic] ${label} args:`, fullArgs, '| repo:', repoPath);
  const proc = spawn(RESTIC_BIN, fullArgs, { env });

  // Collect stderr; only use it for error reporting on exit — never send 500
  // mid-stream because restic may write progress/warning lines to stderr even
  // during a successful dump (and headers may already be partially sent).
  const stderrChunks: Buffer[] = [];
  proc.stderr.on('data', (data: Buffer) => {
    console.error(`[restic ${label} stderr]`, data.toString());
    stderrChunks.push(data);
  });

  proc.on('error', (err) => {
    console.error(`[restic ${label} spawn error]`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.end();
    }
  });

  proc.stdout.on('data', (chunk: Buffer) => {
    res.write(chunk);
  });

  proc.on('close', (code) => {
    console.log(`[restic ${label} exit code]`, code);
    if (code !== 0 && code !== null && !res.headersSent) {
      const errMsg = Buffer.concat(stderrChunks).toString().trim()
        || `restic exited with code ${code}`;
      res.status(500).json({ error: errMsg });
    } else {
      res.end();
    }
  });

  res.on('close', () => proc.kill());
}

export function streamFile(
  repoPath: string,
  snapshotId: string,
  filePath: string,
  password: string | undefined,
  res: Response,
  extraArgs: string[] = []
): void {
  spawnResticDump(['dump', '--no-lock', snapshotId, filePath], repoPath, password, res, 'streamFile', extraArgs);
}

export function streamDirectory(
  repoPath: string,
  snapshotId: string,
  dirPath: string,
  password: string | undefined,
  res: Response,
  extraArgs: string[] = []
): void {
  // restic dump outputs tar automatically for directories
  spawnResticDump(['dump', '--no-lock', snapshotId, dirPath], repoPath, password, res, 'streamDirectory', extraArgs);
}

export async function deleteSnapshots(
  repoPath: string,
  snapshotIds: string[],
  password?: string
): Promise<void> {
  const { env, implicitArgs } = buildEnv(repoPath, password);
  await execFileAsync(
    RESTIC_BIN,
    [...implicitArgs, 'forget', '--prune', ...snapshotIds],
    { env, maxBuffer: MAX_BUFFER, timeout: EXEC_TIMEOUT * 5 }  // prune can take much longer
  );
}

export async function checkRepo(
  repoPath: string,
  password?: string
): Promise<boolean> {
  try {
    const { env, implicitArgs } = buildEnv(repoPath, password);
    await execFileAsync(RESTIC_BIN, [...implicitArgs, 'snapshots', '--json', '--no-lock', '--no-cache'], {
      env,
      maxBuffer: 1024 * 1024,
      timeout: 30_000,  // quick check — 30s is plenty
    });
    return true;
  } catch {
    return false;
  }
}

// ── Repo & Snapshot Stats ─────────────────────────────────────────────────────

export interface ResticStats {
  total_size: number;
  total_file_count: number | null;
  total_blob_count: number | null;
  compression_ratio: number | null; // restic ≥0.15 only, null on older versions
}

export async function getRepoStats(
  repoPath: string,
  password?: string,
  mode?: string,
  extraArgs: string[] = []
): Promise<ResticStats> {
  const { env, implicitArgs } = buildEnv(repoPath, password);
  const args = [...implicitArgs, ...extraArgs, 'stats', '--json', '--no-lock'];
  if (mode) args.push('--mode', mode);
  console.log(`[restic] getRepoStats cmd: ${RESTIC_BIN} ${args.join(' ')} | repo=${repoPath}`);
  try {
    const { stdout } = await execFileAsync(RESTIC_BIN, args, { env, maxBuffer: MAX_BUFFER, timeout: EXEC_TIMEOUT });
    const data = JSON.parse(stdout.trim()) as Record<string, unknown>;
    const result = {
      total_size: (data.total_size as number) ?? 0,
      total_file_count: (data.total_file_count as number | undefined) ?? null,
      total_blob_count: (data.total_blob_count as number | undefined) ?? null,
      compression_ratio: (data.compression_ratio as number | undefined) ?? null,
    };
    console.log(`[restic] getRepoStats result: size=${result.total_size} files=${result.total_file_count} mode=${mode ?? 'default'}`);
    return result;
  } catch (err) {
    const e = err as Error & { stderr?: string; code?: number };
    console.error(`[restic] getRepoStats FAILED (exit ${e.code ?? '?'}, mode=${mode ?? 'default'}): ${e.message}`);
    if (e.stderr) console.error(`[restic] getRepoStats stderr: ${e.stderr.slice(0, 500)}`);
    throw err;
  }
}

export interface SnapshotStatsResult {
  restore_size: number;
  file_count: number;
}

export async function getSnapshotStats(
  repoPath: string,
  snapshotId: string,
  password?: string,
  extraArgs: string[] = []
): Promise<SnapshotStatsResult> {
  const { env, implicitArgs } = buildEnv(repoPath, password);
  const { stdout } = await execFileAsync(
    RESTIC_BIN,
    [...implicitArgs, ...extraArgs, 'stats', '--json', '--no-lock', '--mode', 'restore-size', snapshotId],
    { env, maxBuffer: MAX_BUFFER, timeout: EXEC_TIMEOUT }
  );
  const data = JSON.parse(stdout.trim()) as Record<string, unknown>;
  return {
    restore_size: (data.total_size as number) ?? 0,
    file_count: (data.total_file_count as number) ?? 0,
  };
}

export interface DiffResult {
  added_size: number | null;    // bytes added (positive) or net change (can be negative)
  removed_size: number | null;  // bytes explicitly removed (from restic diff summary)
  files_new: number | null;
  files_changed: number | null;
  files_unmodified: number | null;
  net_count_change: number | null; // net change in total node count (files+dirs+others); used to derive file_count without restic stats
}

export async function getSnapshotDiff(
  repoPath: string,
  parentId: string,
  snapshotId: string,
  password?: string,
  extraArgs: string[] = []
): Promise<DiffResult> {
  const { env, implicitArgs } = buildEnv(repoPath, password);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      RESTIC_BIN,
      [...implicitArgs, ...extraArgs, 'diff', '--json', '--no-lock', parentId, snapshotId],
      { env, maxBuffer: MAX_BUFFER, timeout: EXEC_TIMEOUT }
    ));
  } catch (err: unknown) {
    const e = err as Error & { stderr?: string; code?: number };
    console.warn(`[restic] diff failed (exit ${e.code ?? '?'}): ${e.message}${e.stderr ? ' | ' + e.stderr.trim() : ''}`);
    throw err;
  }
  // Helper: extract size from a diff bucket — restic uses 'size' in newer versions
  // and 'bytes' in older versions (the format seen in the wild).
  function diffSize(bucket: Record<string, unknown> | undefined): number | null {
    if (!bucket) return null;
    if (typeof bucket.size  === 'number') return bucket.size;
    if (typeof bucket.bytes === 'number') return bucket.bytes;
    return null;
  }

  const lines = stdout.trim().split('\n').filter(Boolean);

  // ── Pass 1: scan from end to find the summary line (size totals) ─────────────
  let summaryAddedSize:   number | null = null;
  let summaryRemovedSize: number | null = null;
  // For restic 0.17+ the summary includes accurate per-category file counts
  let summaryFilesNew:        number | null = null;
  let summaryFilesChanged:    number | null = null;
  let summaryFilesUnmodified: number | null = null;
  let summaryNetCountChange:  number | null = null; // (added - removed) across files+dirs+others
  let hasSummary = false;

  // Helper: count total nodes (files + dirs + others) from a diff bucket
  function bucketCount(b: Record<string, unknown> | undefined): number {
    if (!b) return 0;
    return (typeof b.files  === 'number' ? b.files  : 0)
         + (typeof b.dirs   === 'number' ? b.dirs   : 0)
         + (typeof b.others === 'number' ? b.others : 0);
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const line = lines[i];
      if (line === undefined) continue;
      const obj = JSON.parse(line) as Record<string, unknown>;

      // restic 0.17+: { message_type:'statistics', stats:{ added, removed, changed, unmodified } }
      const stats = obj.stats as Record<string, unknown> | undefined;
      if (stats) {
        const a = stats.added      as Record<string, unknown> | undefined;
        const r = stats.removed    as Record<string, unknown> | undefined;
        const c = stats.changed    as Record<string, unknown> | undefined;
        const u = stats.unmodified as Record<string, unknown> | undefined;
        if (a !== undefined) {
          summaryAddedSize   = diffSize(a);
          summaryRemovedSize = diffSize(r);
          // 0.17+ summary has reliable changed/unmodified counts — use them directly
          summaryFilesNew        = typeof a.files === 'number' ? a.files : null;
          summaryFilesChanged    = typeof c?.files === 'number' ? c.files : null;
          summaryFilesUnmodified = typeof u?.files === 'number' ? u.files : null;
          summaryNetCountChange  = bucketCount(a) - bucketCount(r);
          hasSummary = true;
          break;
        }
      }

      // Older flat format: { added, removed, [changed], [unmodified] }
      const a = obj.added as Record<string, unknown> | undefined;
      if (a !== undefined) {
        const r = obj.removed    as Record<string, unknown> | undefined;
        const c = obj.changed    as Record<string, unknown> | undefined;
        const u = obj.unmodified as Record<string, unknown> | undefined;
        summaryAddedSize       = diffSize(a);
        summaryRemovedSize     = diffSize(r);
        summaryFilesNew        = typeof a.files === 'number' ? a.files : null;
        // Older format rarely has changed/unmodified; if absent we'll compute via path intersection
        summaryFilesChanged    = typeof c?.files === 'number' ? c.files : null;
        summaryFilesUnmodified = typeof u?.files === 'number' ? u.files : null;
        summaryNetCountChange  = bucketCount(a) - bucketCount(r);
        hasSummary = true;
        break;
      }
    } catch { /* skip */ }
  }

  // ── Pass 2: scan per-file JSON lines for path-level change detection ──────────
  // Modified files in older restic appear as a 'removed' line + an 'added' line with the same
  // path. The intersection of removed and added paths = files changed in place.
  // Also track plain counts for when path field is absent.
  const addedPaths   = new Set<string>();
  const removedPaths = new Set<string>();
  let addedCount         = 0; // total 'added' lines (with or without path)
  let removedCount       = 0; // total 'removed' lines
  let filesChangedDirect = 0; // restic 0.17+: explicit 'modified'/'changed' per-file lines
  let hasJsonLines  = false;
  let hasTextOutput = false;
  let textFilesNew     = 0;
  let textFilesChanged = 0;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const mt   = obj.message_type as string | undefined;
      const path = obj.path as string | undefined;
      if (mt === 'added') {
        addedCount++; hasJsonLines = true;
        if (path !== undefined) addedPaths.add(path);
      } else if (mt === 'removed') {
        removedCount++; hasJsonLines = true;
        if (path !== undefined) removedPaths.add(path);
      } else if (mt === 'modified' || mt === 'changed') {
        filesChangedDirect++; hasJsonLines = true;
      }
    } catch {
      // Text-mode fallback: "+  /path" = added, "M/C/T  /path" = changed
      if (/^\+\s+\S/.test(line))         { textFilesNew++;     hasTextOutput = true; }
      else if (/^[MCT]\s+\S/.test(line)) { textFilesChanged++; hasTextOutput = true; }
    }
  }

  // ── Combine results ───────────────────────────────────────────────────────────
  if (hasJsonLines) {
    let filesNew: number;
    let filesChanged: number;
    let filesUnmodified: number | null = null;

    if (filesChangedDirect > 0 || summaryFilesChanged !== null) {
      // restic 0.17+: explicit 'modified' lines or summary with 'changed' counts — use them
      filesNew        = summaryFilesNew     ?? addedCount;
      filesChanged    = summaryFilesChanged ?? filesChangedDirect;
      filesUnmodified = summaryFilesUnmodified ?? null;
    } else if (addedPaths.size > 0 || removedPaths.size > 0) {
      // Paths available: modified files appear as removed (old) + added (new) with same path.
      // Intersection of added and removed paths = files changed in place.
      let intersection = 0;
      for (const p of addedPaths) {
        if (removedPaths.has(p)) intersection++;
      }
      filesChanged    = intersection;
      filesNew        = addedPaths.size - intersection;  // truly new (path not in removed set)
      filesUnmodified = null; // caller computes from fileCount - new - changed
    } else {
      // Per-file lines have message_type but no path field — can count adds but not changes.
      filesNew        = addedCount;
      filesChanged    = 0;          // indeterminate without path, treat as 0
      filesUnmodified = null;
    }

    return {
      added_size:       summaryAddedSize,
      removed_size:     summaryRemovedSize,
      files_new:        filesNew,
      files_changed:    filesChanged,
      files_unmodified: filesUnmodified,
      net_count_change: summaryNetCountChange,
    };
  }

  if (hasSummary) {
    // Summary found but no per-file lines — nothing changed or empty diff
    return {
      added_size:       summaryAddedSize,
      removed_size:     summaryRemovedSize,
      files_new:        summaryFilesNew     ?? 0,
      files_changed:    summaryFilesChanged ?? 0,
      files_unmodified: summaryFilesUnmodified ?? null,
      net_count_change: summaryNetCountChange,
    };
  }

  if (hasTextOutput) {
    return {
      added_size:       null,
      removed_size:     null,
      files_new:        textFilesNew,
      files_changed:    textFilesChanged,
      files_unmodified: null,
      net_count_change: null,
    };
  }

  // Truly empty stdout: snapshots are identical.
  if (lines.length === 0) {
    return { added_size: null, removed_size: null, files_new: 0, files_changed: 0, files_unmodified: null, net_count_change: 0 };
  }

  console.warn('[restic] diff unrecognised output format, first line:', lines[0]);
  return { added_size: null, removed_size: null, files_new: null, files_changed: null, files_unmodified: null, net_count_change: null };
}

// ISO week helpers
function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function getISOWeekYear(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  return d.getUTCFullYear();
}

export function classifySnapshots(
  snapshots: Array<{ snapshot_id: string; time: number }>
): Map<string, string> {
  const sorted = [...snapshots].sort((a, b) => a.time - b.time);
  const seenYears = new Set<number>();
  const seenMonths = new Set<string>();
  const seenWeeks = new Set<string>();
  const result = new Map<string, string>();

  for (const snap of sorted) {
    const date = new Date(snap.time * 1000);
    const year = date.getFullYear();
    const month = `${year}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const isoYear = getISOWeekYear(date);
    const isoWeek = getISOWeek(date);
    const week = `${isoYear}-W${String(isoWeek).padStart(2, '0')}`;

    if (!seenYears.has(year)) {
      seenYears.add(year);
      seenMonths.add(month);
      seenWeeks.add(week);
      result.set(snap.snapshot_id, 'yearly');
    } else if (!seenMonths.has(month)) {
      seenMonths.add(month);
      seenWeeks.add(week);
      result.set(snap.snapshot_id, 'monthly');
    } else if (!seenWeeks.has(week)) {
      seenWeeks.add(week);
      result.set(snap.snapshot_id, 'weekly');
    } else {
      result.set(snap.snapshot_id, 'daily');
    }
  }

  return result;
}
