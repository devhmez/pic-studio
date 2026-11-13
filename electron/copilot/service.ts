// Copilot service (Electron main process): runs the user's own Claude Code CLI headless for the renderer
// (window.picStudio.copilot, app/src/host/bridge.ts → CopilotBridge) through the channels of ./channels.ts.
//   - the CLI is found at its usual places (~/.local/bin/claude first), else through the login shell;
//   - each run: argv array (no shell), cwd = an empty app-owned staging folder per conversation
//     (userData/copilot-staging/<session uuid>), scrubbed environment, stdin closed, one run per conversation;
//   - timeout / cancel: SIGINT, then SIGTERM, then SIGKILL; stdout is parsed even after a failure;
//   - status(): `claude --version` + `claude auth status`, cached 60 s when everything is fine.
// Never reads credentials, the Keychain or token variables (see ./cli.ts and research/08).
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants as fsConstants, readdirSync } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CopilotRunResult, CopilotStatus } from '../../app/src/host/bridge';
import type { AppIpc } from '../security';
import { CHANNELS } from './channels';
import {
  buildArgs, bundledCliCandidates, childEnv, cliCandidates, excerpt, interpretRun, isBundledCli, MESSAGES, parseAuthStatus,
  parseVersion, validateRunRequest, type ProcessOutcome, type ValidRunRequest,
} from './cli';

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface CopilotServiceOptions {
  /** Folder holding one empty working directory per conversation. */
  stagingRoot: string | (() => string);
  home?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Use this CLI instead of searching (tests, PIC_STUDIO_CLAUDE). */
  cliPath?: string;
  spawn?: SpawnFn;
  /** Executable check (tests). */
  isExecutable?(file: string): Promise<boolean>;
  /** Directory listing (tests): used to find the CLI bundled with the Claude desktop app. */
  listDir?(dir: string): string[];
  now?(): number;
  statusTtlMs?: number;
  /** Delay between SIGINT, SIGTERM and SIGKILL. */
  killGraceMs?: number;
  /** Timeout of `--version` / `auth status` / the login-shell lookup. */
  probeTimeoutMs?: number;
}

export interface CopilotService {
  status(force?: boolean): Promise<CopilotStatus>;
  run(request: unknown): Promise<CopilotRunResult>;
  cancel(requestId: unknown): void;
  /** Stop every running CLI (app quit). */
  dispose(): void;
}

const MAX_STDOUT = 20 * 1024 * 1024;
const NEGATIVE_TTL_MS = 3_000;
const MAX_STDERR = 1024 * 1024;

function defaultListDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

async function defaultIsExecutable(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

interface Running {
  child: ChildProcess;
  sessionId: string;
  cancelled: boolean;
  stop(reason: 'cancel' | 'timeout'): void;
}

export function createCopilotService(options: CopilotServiceOptions): CopilotService {
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const spawn: SpawnFn = options.spawn ?? ((c, a, o) => nodeSpawn(c, [...a], o));
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  const listDir = options.listDir ?? defaultListDir;
  const now = options.now ?? (() => Date.now());
  const ttl = options.statusTtlMs ?? 60_000;
  const grace = options.killGraceMs ?? 5_000;
  const probeTimeout = options.probeTimeoutMs ?? 15_000;
  const stagingRoot = () => (typeof options.stagingRoot === 'function' ? options.stagingRoot() : options.stagingRoot);

  const running = new Map<string, Running>();
  /** Conversations with a run in progress (reserved before the status check, so two calls cannot race). */
  const busy = new Set<string>();
  let cached: { at: number; status: CopilotStatus } | null = null;
  let pending: Promise<CopilotStatus> | null = null;

  /** Run a short command and collect its output (status probes). */
  const probe = (command: string, args: string[], cwd: string): Promise<ProcessOutcome> => new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd, env: childEnv(env, home, path.dirname(command)), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ stdout: '', stderr: '', exitCode: null, timedOut: false, cancelled: false, spawnError: e instanceof Error ? e.message : String(e) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, probeTimeout);
    child.stdout?.on('data', (d: Buffer) => { if (stdout.length < 1_000_000) stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 100_000) stderr += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: null, timedOut, cancelled: false, spawnError: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code, timedOut, cancelled: false }); });
  });

  /**
   * The CLI: explicit path, usual install places, `command -v claude` in the user's login shell, and last the copy
   * bundled with the Claude desktop app (newest version).
   */
  const findCli = async (): Promise<string | null> => {
    const explicit = options.cliPath ?? env.PIC_STUDIO_CLAUDE;
    if (explicit) return (await isExecutable(explicit)) ? explicit : null;
    for (const c of cliCandidates(home)) if (await isExecutable(c)) return c;
    const shell = env.SHELL && /\/(zsh|bash)$/.test(env.SHELL) ? env.SHELL : '/bin/zsh';
    const r = await probe(shell, ['-lc', 'command -v claude'], home);
    const found = r.stdout.trim().split('\n').pop()?.trim();
    if (r.exitCode === 0 && found && path.isAbsolute(found) && (await isExecutable(found))) return found;
    for (const c of bundledCliCandidates(home, listDir)) if (await isExecutable(c)) return c;
    return null;
  };

  const computeStatus = async (): Promise<CopilotStatus> => {
    const cli = await findCli();
    if (!cli) return { available: false, error: MESSAGES.notInstalled };
    const version = await probe(cli, ['--version'], home);
    if (version.spawnError || version.exitCode !== 0) {
      return { available: false, cliPath: cli, error: `${MESSAGES.crashed} (${excerpt(version.spawnError ?? version.stderr ?? '', home) || 'claude --version'})` };
    }
    const cliVersion = parseVersion(version.stdout);
    const auth = await probe(cli, ['auth', 'status'], home);
    const info = parseAuthStatus(auth.stdout, auth.exitCode);
    const status: CopilotStatus = { available: false, cliPath: cli, loggedIn: info.loggedIn, ...(cliVersion ? { cliVersion } : {}), ...(info.subscription ? { subscription: info.subscription } : {}) };
    if (!info.loggedIn) return { ...status, error: isBundledCli(cli) ? MESSAGES.bundledNotLoggedIn : MESSAGES.notLoggedIn };
    if (info.authMethod && info.authMethod !== 'claude.ai') return { ...status, error: MESSAGES.apiKeyLogin };
    return { ...status, available: true };
  };

  // A working setup is cached for `ttl`; a problem only for a few seconds, so « Réessayer » sees the fix at once
  // (the renderer's status() carries no « force » flag).
  const status = async (force = false): Promise<CopilotStatus> => {
    if (!force && cached && now() - cached.at < (cached.status.available ? ttl : NEGATIVE_TTL_MS)) return cached.status;
    pending ??= computeStatus().then((s) => {
      cached = { at: now(), status: s };
      return s;
    }).finally(() => { pending = null; });
    return pending;
  };

  const run = async (raw: unknown): Promise<CopilotRunResult> => {
    const req = validateRunRequest(raw);
    if ('error' in req) return { requestId: req.requestId, sessionId: req.sessionId, ok: false, error: { kind: 'process', message: req.error } };
    const ids = { requestId: req.requestId, sessionId: req.sessionId };
    if (busy.has(req.sessionId)) return { ...ids, ok: false, error: { kind: 'process', message: MESSAGES.busy } };
    busy.add(req.sessionId);
    try {
      return await runReserved(req, ids);
    } finally {
      busy.delete(req.sessionId);
    }
  };

  const runReserved = async (req: ValidRunRequest, ids: { requestId: string; sessionId: string }): Promise<CopilotRunResult> => {

    const st = await status();
    if (!st.available || !st.cliPath) {
      return { ...ids, ok: false, error: { kind: st.cliPath ? (st.loggedIn === false ? 'not-logged-in' : 'process') : 'not-installed', message: st.error ?? MESSAGES.notInstalled } };
    }
    const cwd = path.join(stagingRoot(), req.sessionId);
    try {
      await mkdir(cwd, { recursive: true });
    } catch (e) {
      return { ...ids, ok: false, error: { kind: 'process', message: `Dossier de travail du copilote inaccessible (${excerpt(e instanceof Error ? e.message : String(e), home)}).` } };
    }

    const outcome = await new Promise<ProcessOutcome>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(st.cliPath!, buildArgs(req), { cwd, env: childEnv(env, home, path.dirname(st.cliPath!)), stdio: ['ignore', 'pipe', 'pipe'], detached: false });
      } catch (e) {
        resolve({ stdout: '', stderr: '', exitCode: null, timedOut: false, cancelled: false, spawnError: e instanceof Error ? e.message : String(e) });
        return;
      }
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let finished = false;
      const timers: ReturnType<typeof setTimeout>[] = [];
      const entry: Running = {
        child,
        sessionId: req.sessionId,
        cancelled: false,
        stop(reason) {
          if (finished) return;
          if (reason === 'cancel') entry.cancelled = true;
          else timedOut = true;
          // SIGINT ends the turn cleanly (the CLI records it); then insist.
          child.kill('SIGINT');
          timers.push(setTimeout(() => { if (!finished) child.kill('SIGTERM'); }, grace));
          timers.push(setTimeout(() => { if (!finished) child.kill('SIGKILL'); }, grace * 2));
        },
      };
      running.set(req.requestId, entry);
      timers.push(setTimeout(() => entry.stop('timeout'), req.timeoutMs));
      child.stdout?.on('data', (d: Buffer) => { if (stdout.length < MAX_STDOUT) stdout += d.toString('utf8'); });
      child.stderr?.on('data', (d: Buffer) => { if (stderr.length < MAX_STDERR) stderr += d.toString('utf8'); });
      const done = (o: Partial<ProcessOutcome>) => {
        if (finished) return;
        finished = true;
        timers.forEach(clearTimeout);
        running.delete(req.requestId);
        resolve({ stdout, stderr, exitCode: null, timedOut, cancelled: entry.cancelled, ...o });
      };
      child.on('error', (e) => done({ spawnError: e.message }));
      child.on('close', (code) => done({ exitCode: code }));
    });

    const result = interpretRun(outcome, home, req.model);
    if (result.error?.kind === 'not-logged-in' || result.error?.kind === 'not-installed') cached = null;
    const { cliSessionId: _cli, ...rest } = result;
    void _cli;
    return { ...ids, ...rest };
  };

  return {
    status,
    run,
    cancel(requestId) {
      if (typeof requestId === 'string') running.get(requestId)?.stop('cancel');
    },
    dispose() {
      for (const r of running.values()) r.stop('cancel');
    },
  };
}

let service: CopilotService | null = null;

/** Register the copilot's IPC handlers (called once by electron/main.ts, with the app-page-only ipcMain). */
export function registerCopilotIpc(ipcMain: AppIpc): void {
  service ??= createCopilotService({
    // userData is final by the time the first request arrives (main.ts sets it before start()).
    stagingRoot: () => path.join(electronApp().getPath('userData'), 'copilot-staging'),
  });
  const s = service;
  ipcMain.handle(CHANNELS.status, (_event, force?: unknown) => s.status(force === true));
  ipcMain.handle(CHANNELS.run, (_event, request: unknown) => s.run(request));
  ipcMain.handle(CHANNELS.cancel, (_event, requestId: unknown) => s.cancel(requestId));
  electronApp().on('will-quit', () => s.dispose());
}

/** Electron's `app`, loaded lazily so this module also runs under plain Node (tests, smoke script). */
function electronApp(): typeof import('electron').app {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('electron') as typeof import('electron')).app;
}
