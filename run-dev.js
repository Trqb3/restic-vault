#!/usr/bin/env node
// Launcher that changes CWD to the frontend dir, then runs Vite dev server
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.join(__dirname, 'frontend');
const viteBin = path.join(__dirname, 'node_modules', 'vite', 'bin', 'vite.js');

const child = spawn(
  process.execPath,
  [viteBin, '--host', '0.0.0.0', '--port', '5173'],
  {
    cwd: frontendDir,
    stdio: 'inherit',
  }
);

child.on('exit', (code) => process.exit(code ?? 0));
