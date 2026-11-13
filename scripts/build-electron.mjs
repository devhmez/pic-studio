#!/usr/bin/env node
// Bundles the Electron main process and the preload with esbuild:
//   electron/main.ts    → out/electron/main.cjs     (imports the copilot service, menu, PDF, dialogs…)
//   electron/preload.ts → out/electron/preload.cjs  (sandboxed: one self-contained file, only `electron` external)
// Usage: node scripts/build-electron.mjs [--watch] [--dev]
//   --dev    keep the bundles unminified with inline source maps (npm run app:dev)
//   --watch  rebuild on change (implies --dev)
import { build, context } from 'esbuild';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'out', 'electron');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

const electronVersion = JSON.parse(await readFile(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
/** Node version embedded in this Electron (44.x ships Node 24). */
const nodeTarget = 'node24';
/** Chromium of Electron 44 is 152 (the preload runs in the renderer). */
const chromeTarget = 'chrome150';

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  format: 'cjs',
  outdir,
  outExtension: { '.js': '.cjs' },
  external: ['electron'],
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  keepNames: true,
  legalComments: 'none',
  logLevel: 'info',
  tsconfig: path.join(root, 'electron', 'tsconfig.json'),
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
};

/** @type {import('esbuild').BuildOptions[]} */
const targets = [
  { ...common, entryPoints: { main: path.join(root, 'electron', 'main.ts') }, platform: 'node', target: nodeTarget },
  // The sandboxed preload can only require('electron') (and a few node built-ins we do not use): bundle the rest.
  { ...common, entryPoints: { preload: path.join(root, 'electron', 'preload.ts') }, platform: 'browser', target: chromeTarget },
];

if (!watch) await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

if (watch) {
  for (const options of targets) {
    const ctx = await context(options);
    await ctx.watch();
  }
  console.log(`[build-electron] watching electron/ (Electron ${electronVersion})`);
} else {
  for (const options of targets) await build(options);
  console.log(`[build-electron] out/electron/main.cjs + preload.cjs (Electron ${electronVersion}${dev ? ', dev' : ''})`);
}
