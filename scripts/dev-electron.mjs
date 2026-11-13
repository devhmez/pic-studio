#!/usr/bin/env node
// `npm run app:dev`: the Vite dev server (hot reload) inside the Electron window.
//   1. bundles electron/ in watch mode (out/electron/*.cjs, unminified, source maps);
//   2. starts Vite on http://localhost:5173 (or reuses one already running there);
//   3. opens Electron with PIC_STUDIO_DEV_URL; quitting Electron stops everything.
// Changes in app/src reload live; changes in electron/ need a restart of this command (main process).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV_URL = process.env.PIC_STUDIO_DEV_URL?.trim() || 'http://localhost:5173';
const electron = createRequire(import.meta.url)('electron');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(143));

function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
  children.push(child);
  return child;
}

async function reachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await reachable(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

// 1. Electron bundles (first build synchronously, then watch).
await new Promise((resolve, reject) => {
  const first = spawn(process.execPath, [path.join(root, 'scripts', 'build-electron.mjs'), '--dev'], { cwd: root, stdio: 'inherit' });
  first.on('exit', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`build-electron a échoué (${code})`))));
});
run(process.execPath, [path.join(root, 'scripts', 'build-electron.mjs'), '--watch']);

// 2. Vite.
if (await reachable(DEV_URL)) {
  console.log(`[app:dev] serveur Vite déjà lancé sur ${DEV_URL}`);
} else {
  const vite = run(npm, ['-w', 'app', 'run', 'dev']);
  vite.on('exit', (code) => {
    if (!stopping) {
      console.error(`[app:dev] Vite s’est arrêté (${code}).`);
      stop(code ?? 1);
    }
  });
  if (!(await waitFor(DEV_URL, 30_000))) {
    console.error(`[app:dev] ${DEV_URL} ne répond pas.`);
    stop(1);
  }
}

// 3. Electron.
const app = run(electron, [path.join(root, 'out', 'electron', 'main.cjs')], {
  env: { ...process.env, PIC_STUDIO_DEV_URL: DEV_URL, ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING ?? '0' },
});
app.on('exit', (code) => stop(code ?? 0));
