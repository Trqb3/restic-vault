import { existsSync } from 'fs';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { execSync, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import path from 'path';
import { getDb, type SshConnection } from '../db/index.js';
import { decrypt } from './crypto.js';

// ── SSH / SFTP binary resolution ──────────────────────────────────────────────

function findSshBinary(): string {
  // 1. Check common Windows OpenSSH locations
  const candidates = [
    'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    'C:\\Program Files\\Git\\usr\\bin\\ssh.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\ssh.exe',
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {}
  }

  // 2. Try to find via PATH (works on Linux/Mac and Windows if OpenSSH is in PATH)
  try {
    const cmd = process.platform === 'win32' ? 'where ssh' : 'which ssh';
    return (execSync(cmd, { encoding: 'utf8' }).trim().split('\n')[0] ?? 'ssh').trim();
  } catch {}

  // 3. Fallback — let the OS resolve it from PATH at runtime
  return 'ssh';
}

function findSftpBinary(): string {
  // sftp lives next to ssh — derive its path from the resolved ssh binary
  const sshPath = SSH_BINARY;
  const sftpPath = sshPath.replace(/ssh(\.exe)?$/, 'sftp$1');
  try {
    if (existsSync(sftpPath)) return sftpPath;
  } catch {}
  return 'sftp';
}

export const SSH_BINARY  = findSshBinary();
export const SFTP_BINARY = findSftpBinary();
console.log('[ssh] using binary:', SSH_BINARY);
console.log('[ssh] using sftp binary:', SFTP_BINARY);

// ── Public types ──────────────────────────────────────────────────────────────

export interface SshKeyContext {
  keyFile: string;      // absolute path to the temp private key file
  extraArgs: string[];  // e.g. ['-o', 'sftp.command="C:\\...\\ssh.exe" -i "..." -p 22 ...']
  cleanup: () => void;  // deletes the temp key file
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Writes the private key to a temp file (mode 0o600) and returns the restic
 * `-o sftp.command=...` args needed to use it, plus a cleanup function.
 * Paths are quoted to handle spaces (e.g. "Program Files").
 */
export async function buildSshKeyContext(conn: {
  port: number;
  private_key: string;
}): Promise<SshKeyContext> {
  const keyFile = path.join(tmpdir(), `rv-ssh-${randomBytes(8).toString('hex')}`);
  // Normalise line endings (CRLF / CR → LF) and ensure trailing newline —
  // OpenSSH rejects keys that contain Windows-style CRLF line endings.
  const normalizedKey = conn.private_key
    .replace(/\r\n/g, '\n')   // Windows CRLF → LF
    .replace(/\r/g, '\n')     // old Mac CR  → LF
    .trimEnd() + '\n';
  await writeFile(keyFile, normalizedKey, { mode: 0o600 });

  if (process.platform === 'win32') {
    console.warn('[ssh] Windows detected — if key auth fails, check that the private key has Unix line endings (LF not CRLF)');
  }

  const sshCmd = [
    `"${SSH_BINARY}"`,
    `-i "${keyFile}"`,
    `-p ${conn.port}`,
    `-o StrictHostKeyChecking=accept-new`,
    `-o PasswordAuthentication=no`,
    `-o PubkeyAuthentication=yes`,
  ].join(' ');
  return {
    keyFile,
    extraArgs: ['-o', `sftp.command=${sshCmd}`],
    cleanup: () => unlink(keyFile).catch(() => {}),
  };
}

/**
 * Looks up a saved SSH connection by ID, decrypts its key and returns an
 * SshKeyContext ready to be passed to restic calls.  Returns null if no
 * connection is configured for this repo or if the connection row is missing.
 */
export async function sshContextForRepo(connectionId: number | null | undefined): Promise<SshKeyContext | null> {
  if (!connectionId) return null;
  const db = getDb();
  const conn = db.prepare(
    'SELECT * FROM ssh_connections WHERE id = ?'
  ).get(connectionId) as SshConnection | undefined;
  if (!conn) return null;
  const privateKey = decrypt(conn.private_key_encrypted);
  return buildSshKeyContext({ port: conn.port, private_key: privateKey });
}

/**
 * Tests SFTP connectivity by opening a batch-mode sftp session, running `ls`,
 * and quitting.  Times out after 10 seconds.
 * Note: sftp uses -P (uppercase) for port, unlike ssh which uses -p.
 */
export async function testSftpConnection(conn: {
  host: string;
  port: number;
  username: string;
  private_key: string;
}): Promise<{ success: boolean; error?: string }> {
  const { keyFile, cleanup } = await buildSshKeyContext(conn);

  return new Promise((resolve) => {
    const args = [
      '-i', keyFile,
      '-P', String(conn.port),   // sftp uses uppercase -P for port
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'PasswordAuthentication=no',
      '-o', 'PubkeyAuthentication=yes',
      '-o', 'BatchMode=no',
      '-o', 'ConnectTimeout=10',
      '-b', '-',                 // read batch commands from stdin
      `${conn.username}@${conn.host}`,
    ];
    console.log('[sftp test] command:', SFTP_BINARY, args.join(' '));
    console.log('[sftp test] key file:', keyFile);
    const proc = spawn(SFTP_BINARY, args);

    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      console.error('[sftp stderr]', d.toString());
    });
    proc.stdout.on('data', (d: Buffer) => {
      console.log('[sftp stdout]', d.toString());
    });

    // Send a simple directory listing then quit — if it succeeds we're connected
    proc.stdin.write('ls\nquit\n');
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill();
      cleanup();
      resolve({ success: false, error: 'Connection timed out after 10s' });
    }, 10_000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      cleanup();
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({ success: false, error: stderr.trim() || `sftp exited with code ${code}` });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      resolve({ success: false, error: err.message });
    });
  });
}
