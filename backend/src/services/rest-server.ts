import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';

const REST_SERVER_BIN = process.env.REST_SERVER_BINARY || 'rest-server';
export const REST_SERVER_PORT = parseInt(process.env.REST_SERVER_PORT || '8079', 10);

/** Directory where each source gets its own subdirectory for its restic repo. */
export function getSourcesDir(): string {
  const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'restic-vault.db');
  const defaultDir = path.join(path.dirname(dbPath), 'sources');
  return process.env.SOURCES_DIR || defaultDir;
}

/** Ensure the sources directory and a specific source's subdirectory exist. */
export function ensureSourceDir(sourceName: string): string {
  const dir = path.join(getSourcesDir(), sourceName);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let serverProcess: ChildProcess | null = null;
let _available: boolean | null = null;

/** Check if the rest-server binary is available on PATH. */
export async function isRestServerAvailable(): Promise<boolean> {
  if (_available !== null) return _available;
  return new Promise((resolve) => {
    const proc = spawn(REST_SERVER_BIN, ['--version'], { stdio: 'pipe' });
    proc.on('close', (code) => {
      _available = code === 0 || code === 1;  // both 0 and 1 mean binary exists
      resolve(_available);
    });
    proc.on('error', () => {
      _available = false;
      resolve(false);
    });
  });
}

/** Start the rest-server process. Safe to call multiple times — no-op if already running. */
export async function startRestServer(): Promise<void> {
  if (serverProcess && !serverProcess.killed) return;

  const available = await isRestServerAvailable();
  if (!available) {
    console.warn('[rest-server] Binary not found — backup sources will be unavailable.');
    console.warn(`[rest-server] Install it from: https://github.com/restic/rest-server/releases`);
    console.warn(`[rest-server] Or set REST_SERVER_BINARY env var to the full path.`);
    return;
  }

  const sourcesDir = getSourcesDir();
  fs.mkdirSync(sourcesDir, { recursive: true });

  const args = [
    '--path', sourcesDir,
    '--no-auth',              // Auth handled by our Express proxy
    '--listen', `127.0.0.1:${REST_SERVER_PORT}`,
    '--private-repos',        // Each top-level subdir is an isolated repo namespace
  ];

  serverProcess = spawn(REST_SERVER_BIN, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout?.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    if (line) console.log(`[rest-server] ${line}`);
  });
  serverProcess.stderr?.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    if (line) console.log(`[rest-server] ${line}`);
  });

  serverProcess.on('exit', (code, signal) => {
    console.log(`[rest-server] Process exited (code=${code}, signal=${signal})`);
    serverProcess = null;
  });

  serverProcess.on('error', (err) => {
    console.error('[rest-server] Failed to start:', err.message);
    serverProcess = null;
  });

  // Give it a moment to start
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.log(`[rest-server] Started on 127.0.0.1:${REST_SERVER_PORT}, serving ${sourcesDir}`);
}

export function stopRestServer(): void {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

export function isRunning(): boolean {
  return !!serverProcess && !serverProcess.killed;
}

// Gracefully stop on process exit
process.on('exit', stopRestServer);
process.on('SIGINT',  () => { stopRestServer(); process.exit(0); });
process.on('SIGTERM', () => { stopRestServer(); process.exit(0); });
