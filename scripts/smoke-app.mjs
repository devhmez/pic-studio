#!/usr/bin/env node
// Smoke test of the packaged app (`npm run app:smoke`, after `npm run package`):
//   - opens dist-app/PIC Studio-darwin-<arch>/PIC Studio.app with `open -n`, with a throw-away profile and
//     PIC_STUDIO_SMOKE_LOG=<tmp>/pic-studio-smoke-*.log (the app appends JSON lines: app-ready, renderer-ready…);
//   - waits for the renderer's « renderer-ready » ping, which carries the in-page checks: native host platform,
//     simulation Web Worker and pdf.js worker under file://, no Content-Security-Policy violation;
//   - checks with pgrep that the process stays up for 10 s, saves a capture of the window, then quits it (SIGTERM)
//     and expects a clean « will-quit ».
// Exit code 0 when everything passed.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arch = process.env.PIC_STUDIO_ARCH?.trim() || (process.arch === 'x64' ? 'x64' : 'arm64');
const appPath = path.resolve(process.argv[2] ?? path.join(root, 'dist-app', `PIC Studio-darwin-${arch}`, 'PIC Studio.app'));
const executable = path.join(appPath, 'Contents', 'MacOS', 'PIC Studio');
const RUN_SECONDS = Number(process.env.PIC_STUDIO_SMOKE_SECONDS ?? 10);

if (!existsSync(executable)) {
  console.error(`[smoke] ${appPath} introuvable : lancez d’abord « npm run package ».`);
  process.exit(1);
}

const work = mkdtempSync(path.join(tmpdir(), 'pic-studio-smoke-'));
const logFile = path.join(work, 'pic-studio-smoke.log');
const capture = path.join(work, 'fenetre.png');
const userData = path.join(work, 'profil');
const saveDir = path.join(work, 'enregistrements');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** JSON lines written by the app so far. */
function events() {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/** PIDs of the app's main process (helpers have other executables). */
function mainPids() {
  const result = spawnSync('pgrep', ['-f', executable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')], { encoding: 'utf8' });
  const pids = result.stdout.split('\n').map((s) => Number(s.trim())).filter((n) => n > 0);
  return pids.filter((pid) => {
    const command = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
    return command === executable || command.startsWith(`${executable} `);
  });
}

const checks = [];
const check = (ok, label, detail = '') => {
  checks.push({ ok, label });
  console.log(`[smoke] ${ok ? 'OK  ' : 'ÉCHEC'} ${label}${detail ? ` — ${detail}` : ''}`);
};

if (mainPids().length > 0) console.log('[smoke] (une autre instance de ce PIC Studio.app tourne déjà : l’instance de test démarre avec son propre profil)');

mkdirSync(saveDir, { recursive: true });
console.log(`[smoke] ouverture de ${path.relative(root, appPath)}`);
console.log(`[smoke] journal : ${logFile}`);
execFileSync('open', [
  '-n', '-g',
  '--env', `PIC_STUDIO_SMOKE_LOG=${logFile}`,
  '--env', `PIC_STUDIO_SMOKE_CAPTURE=${capture}`,
  '--env', `PIC_STUDIO_USER_DATA=${userData}`,
  '--env', `PIC_STUDIO_SMOKE_SAVE_DIR=${saveDir}`,
  appPath,
]);

// 1. renderer-ready
let ready = null;
for (let i = 0; i < 60 && !ready; i++) {
  await sleep(500);
  ready = events().find((e) => e.event === 'renderer-ready') ?? null;
}
const pid = events().find((e) => e.event === 'app-ready')?.pid ?? null;
check(pid !== null, 'le processus principal démarre', pid ? `pid ${pid}` : 'pas de « app-ready » dans le journal');
check(ready !== null, 'la page se charge et signale « renderer-ready »', ready ? `${ready.renderMs} ms après le chargement` : 'délai dépassé (30 s)');
if (ready) {
  check(typeof ready.href === 'string' && ready.href.startsWith('file://') && ready.href.includes('app.asar'),
    'la page vient de app.asar (file://)', ready.href);
  check(ready.hostPlatform === true, 'window.picStudio est branché (dialogues natifs)');
  check(ready.simWorker === 'ok', 'Web Worker de simulation', `${ready.simWorker}${ready.simPc !== undefined ? `, PC = ${ready.simPc}` : ''}`);
  check(ready.pdfWorker === 'ok', 'Web Worker de pdf.js', String(ready.pdfWorker));
  const violations = Array.isArray(ready.cspViolations) ? ready.cspViolations : [];
  check(violations.length === 0, 'aucune violation de la Content-Security-Policy', violations.join(', '));
  check(ready.saves === 'ok', 'enregistrement par les dialogues natifs (projet, PNG, PDF)', (ready.savedFiles ?? []).join(', ') || String(ready.saves));
  const saved = (name) => (existsSync(path.join(saveDir, name)) ? readFileSync(path.join(saveDir, name)) : null);
  const project = saved('controle.picproj');
  let projectOk = false;
  try {
    projectOk = project !== null && typeof JSON.parse(project.toString('utf8')) === 'object';
  } catch {
    projectOk = false;
  }
  check(projectOk, 'le projet enregistré est un JSON lisible', project ? `${project.length} octets` : 'absent');
  const png = saved('controle.png');
  check(png !== null && png.subarray(1, 4).toString('latin1') === 'PNG', 'l’image PNG est écrite octet par octet', png ? `${png.length} octets` : 'absente');
  const pdf = saved('controle-fiche-de-cablage.pdf');
  const pdfText = pdf ? pdf.toString('latin1') : '';
  const a4 = /\/MediaBox \[0 0 59[45]\.\d* 841\.\d*\]/.test(pdfText);
  check(pdf !== null && pdfText.startsWith('%PDF-') && a4, 'la fiche de câblage sort en PDF A4 (printToPDF)', pdf ? `${pdf.length} octets` : 'absente');
  if (ready.detail) console.log(`[smoke]      détail : ${ready.detail}`);
}

// 2. stays up
let alive = true;
for (let s = 0; s < RUN_SECONDS; s++) {
  await sleep(1000);
  const pids = mainPids();
  if (pid ? !pids.includes(pid) : pids.length === 0) {
    alive = false;
    break;
  }
}
const crashes = events().filter((e) => ['render-process-gone', 'main-error', 'main-rejection', 'did-fail-load', 'preload-error', 'load-error'].includes(e.event));
check(alive, `le processus tourne pendant ${RUN_SECONDS} s (pgrep)`);
check(crashes.length === 0, 'pas de plantage ni d’erreur de chargement', crashes.map((e) => `${e.event}: ${e.message ?? e.reason ?? e.description ?? ''}`).join(' | '));
const consoleErrors = events().filter((e) => e.event === 'console-error');
check(consoleErrors.length === 0, 'console de la page sans erreur', consoleErrors.map((e) => e.message).join(' | ').slice(0, 400));
const captured = events().find((e) => e.event === 'captured');
check(Boolean(captured), 'capture de la fenêtre', captured ? `${captured.width}×${captured.height} → ${capture}` : 'pas de capture');

// 3. quit
if (pid && mainPids().includes(pid)) {
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 40 && mainPids().includes(pid); i++) await sleep(250);
}
const quit = pid ? !mainPids().includes(pid) : false;
check(quit && events().some((e) => e.event === 'will-quit'), 'l’application se ferme proprement (will-quit)');

const failed = checks.filter((c) => !c.ok).length;
console.log(failed === 0 ? `[smoke] RÉUSSI (${checks.length} contrôles)` : `[smoke] ${failed} contrôle(s) en échec sur ${checks.length}`);
process.exit(failed === 0 ? 0 : 1);
