// Bundle smoke.ts with esbuild (TypeScript + the @pic workspace packages) and run it with Node.
// Makes two REAL calls to the user's Claude Code CLI (--model haiku). Usage: node electron/copilot/__smoke__/run.mjs
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(path.join(process.env.SMOKE_DIR ?? tmpdir(), 'pic-copilot-smoke-build-'));
const outfile = path.join(outDir, 'smoke.mjs');
await build({
  entryPoints: [path.join(here, 'smoke.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  external: ['electron'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});
const r = spawnSync(process.execPath, [outfile], { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 1);
