// The Electron copilot service (electron/copilot) with a FAKE spawn: argv, environment, staging folder, result
// parsing, error mapping, status cache, cancel / timeout signals. The real CLI is never started here.
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  buildArgs, childEnv, interpretRun, parseAuthStatus, parseCliJson, validateRunRequest,
} from '../../../electron/copilot/cli';
import { createCopilotService, type SpawnFn } from '../../../electron/copilot/service';
import { ANSWER_JSON_SCHEMA } from './core/schema';

const SESSION = '0b7e3f7a-8f7e-4b3e-9a51-2a0c5d6e7f80';
const tmp = mkdtempSync(join(tmpdir(), 'pic-copilot-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const okResult = (extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: 3800, result: '',
  session_id: SESSION, total_cost_usd: 0.0026, structured_output: { reponse: 'Bonjour' },
  usage: { input_tokens: 1359, output_tokens: 257, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  modelUsage: { 'claude-haiku-4-5-20251001': { costUSD: 0.0026, outputTokens: 257 } },
  ...extra,
});

interface Script { stdout?: string; stderr?: string; code?: number | null; hang?: boolean; ignoreInt?: boolean; error?: string }
interface Spawned { command: string; args: string[]; cwd: string; env: Record<string, string>; signals: string[] }

/** Fake child processes: 'claude --version', 'claude auth status' and the run follow `scripts` by first argument. */
function fakeSpawn(scripts: { version?: Script; auth?: Script; runs: Script[] }) {
  const spawned: Spawned[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    const rec: Spawned = { command, args: [...args], cwd: String(options.cwd), env: options.env as Record<string, string>, signals: [] };
    spawned.push(rec);
    const script: Script = args[0] === '--version' ? (scripts.version ?? { stdout: '2.1.287 (Claude Code)\n' })
      : args[0] === 'auth' ? (scripts.auth ?? { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'x@y.z' }) })
        : (scripts.runs.shift() ?? { stdout: okResult() });
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill(sig?: string): boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const finish = (code: number | null) => setTimeout(() => {
      child.stdout.end(); child.stderr.end();
      child.emit('close', code);
    }, 1);
    child.kill = (sig = 'SIGTERM') => {
      rec.signals.push(sig);
      if (sig === 'SIGTERM' && script.hang) finish(143);
      if (sig === 'SIGINT' && script.hang && !script.ignoreInt) {
        // The CLI records the interrupted turn and exits.
        child.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'interrupted' }));
        finish(130);
      }
      return true;
    };
    setTimeout(() => {
      if (script.error) { child.emit('error', new Error(script.error)); return; }
      if (script.stdout) child.stdout.write(script.stdout);
      if (script.stderr) child.stderr.write(script.stderr);
      if (!script.hang) finish(script.code ?? 0);
    }, 1);
    return child as unknown as ReturnType<SpawnFn>;
  };
  return { spawn, spawned };
}

const request = (extra: Record<string, unknown> = {}) => ({
  requestId: 'r1', sessionId: SESSION, resume: false, prompt: "DEMANDE DE L'ÉTUDIANT :\nBonjour", systemPrompt: 'Tu es le copilote.',
  jsonSchema: ANSWER_JSON_SCHEMA, model: 'haiku', ...extra,
});

function service(scripts: Parameters<typeof fakeSpawn>[0], extra: Partial<Parameters<typeof createCopilotService>[0]> = {}) {
  const fake = fakeSpawn(scripts);
  const s = createCopilotService({
    stagingRoot: join(tmp, 'staging'),
    home: '/Users/eleve',
    env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-secret', ANTHROPIC_BASE_URL: 'http://proxy', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CONFIG_DIR: '/x', CLAUDE_CODE_USE_BEDROCK: '1', LANG: 'fr_FR.UTF-8' },
    cliPath: '/Users/eleve/.local/bin/claude',
    isExecutable: async (f) => f === '/Users/eleve/.local/bin/claude',
    spawn: fake.spawn,
    killGraceMs: 5,
    ...extra,
  });
  return { s, ...fake };
}

describe('cli helpers', () => {
  it('builds the documented flags: first turn with --session-id and --system-prompt, follow-ups with --resume', () => {
    const v = validateRunRequest(request());
    if ('error' in v) throw new Error(v.error);
    const first = buildArgs(v);
    expect(first.slice(0, 2)).toEqual(['-p', "DEMANDE DE L'ÉTUDIANT :\nBonjour"]);
    for (const [flag, value] of [['--model', 'haiku'], ['--effort', 'low'], ['--tools', ''], ['--disallowedTools', 'mcp__*'], ['--permission-mode', 'dontAsk'], ['--max-turns', '3'], ['--output-format', 'json'], ['--session-id', SESSION], ['--system-prompt', 'Tu es le copilote.']]) {
      expect(first[first.indexOf(flag) + 1]).toBe(value);
    }
    expect(first).toContain('--safe-mode');
    expect(first).toContain('--strict-mcp-config');
    expect(JSON.parse(first[first.indexOf('--json-schema') + 1])).toEqual(ANSWER_JSON_SCHEMA);
    const next = buildArgs({ ...v, resume: true, model: 'sonnet' });
    expect(next[next.indexOf('--resume') + 1]).toBe(SESSION);
    expect(next).not.toContain('--session-id');
    expect(next).not.toContain('--system-prompt');
    expect(next[next.indexOf('--model') + 1]).toBe('sonnet');
    expect(next).toContain('--json-schema');
    expect(next).toContain('--permission-mode');
  });

  it('validates untrusted requests', () => {
    expect(validateRunRequest({ ...request(), sessionId: '../../etc' })).toHaveProperty('error');
    expect(validateRunRequest({ ...request(), prompt: '  ' })).toHaveProperty('error');
    expect(validateRunRequest({ ...request(), jsonSchema: 'x' })).toHaveProperty('error');
    const v = validateRunRequest({ ...request(), prompt: '--help', model: 'opus', maxTurns: 99, timeoutMs: 1 });
    if ('error' in v) throw new Error(v.error);
    expect(v.prompt).toBe('Message : --help');
    expect(v.model).toBe('haiku');
    expect(v.maxTurns).toBe(6);
    expect(v.timeoutMs).toBe(10_000);
  });

  it('scrubs credentials and cloud-provider variables from the child environment', () => {
    const e = childEnv({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 'a', ANTHROPIC_FOO: 'f', CLAUDE_CODE_OAUTH_TOKEN: 'o', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_PROFILE: 'p', CLAUDE_CONFIG_DIR: '/c', USER: 'eleve' }, '/Users/eleve', '/Users/eleve/.local/bin');
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_FOO', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_PROFILE', 'CLAUDE_CONFIG_DIR']) expect(e).not.toHaveProperty(k);
    expect(e).toMatchObject({ USER: 'eleve', HOME: '/Users/eleve', ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
    expect(e.PATH.split(':')).toEqual(expect.arrayContaining(['/usr/bin', '/Users/eleve/.local/bin', '/bin']));
  });

  it('maps CLI outcomes to error kinds and keeps the usage of failed runs', () => {
    const run = (o: Partial<Parameters<typeof interpretRun>[0]>) => interpretRun({ stdout: '', stderr: '', exitCode: 0, timedOut: false, cancelled: false, ...o });
    const ok = run({ stdout: `warning: something\n${okResult()}` });
    expect(ok.ok).toBe(true);
    expect(ok.structuredOutput).toEqual({ reponse: 'Bonjour' });
    expect(ok.usage).toMatchObject({ inputTokens: 1359, outputTokens: 257, sessionCostUsd: 0.0026, model: 'claude-haiku-4-5-20251001', durationMs: 3800 });
    expect(run({ stdout: okResult({ structured_output: undefined }) }).error?.kind).toBe('schema');
    expect(run({ stdout: okResult({ subtype: 'error_max_structured_output_retries', is_error: true }), exitCode: 1 }).error?.kind).toBe('schema');
    expect(run({ stdout: okResult({ subtype: 'error_during_execution', is_error: true, result: 'Not logged in · Please run /login' }), exitCode: 1 }).error?.kind).toBe('not-logged-in');
    const limit = run({ stdout: okResult({ is_error: true, subtype: 'error_during_execution', result: 'Claude usage limit reached. Your limit will reset at 3pm.' }), exitCode: 1 });
    expect(limit.error?.kind).toBe('usage-limit');
    // The reset time is given in French, without the CLI's English text.
    expect(limit.error?.message).toMatch(/se renouvelle à 15 h/);
    expect(limit.error?.message).not.toMatch(/reset/);
    expect(limit.usage).toBeDefined();
    expect(run({ stdout: okResult({ subtype: 'error_max_turns', is_error: true }), exitCode: 1 }).error?.message).toMatch(/limite de tours/);
    expect(run({ timedOut: true, exitCode: null }).error?.kind).toBe('timeout');
    expect(run({ cancelled: true, stdout: okResult() }).error?.kind).toBe('cancelled');
    expect(run({ spawnError: 'spawn /x ENOENT' }).error?.kind).toBe('not-installed');
    const crash = run({ stderr: 'error: unknown option --foo at /Users/eleve/x', exitCode: 1 }, );
    expect(crash.error?.kind).toBe('process');
    expect(parseCliJson('garbage')).toBeNull();
  });

  it('parses auth status without keeping the e-mail', () => {
    expect(parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro","email":"a@b.c"}', 0)).toEqual({ loggedIn: true, authMethod: 'claude.ai', subscription: 'pro' });
    expect(parseAuthStatus('{"loggedIn":false}', 1).loggedIn).toBe(false);
    expect(parseAuthStatus('Not logged in', 1).loggedIn).toBe(false);
  });
});

describe('copilot service', () => {
  it('reports the status (cached), runs in the staging folder with a scrubbed environment and closed stdin', async () => {
    const { s, spawned } = service({ runs: [{ stdout: okResult() }] });
    const st = await s.status();
    expect(st).toEqual({ available: true, cliPath: '/Users/eleve/.local/bin/claude', cliVersion: '2.1.287', loggedIn: true, subscription: 'max' });
    expect(JSON.stringify(st)).not.toContain('@');
    await s.status();
    expect(spawned.filter((p) => p.args[0] === '--version')).toHaveLength(1);
    await s.status(true);
    expect(spawned.filter((p) => p.args[0] === '--version')).toHaveLength(2);
    const r = await s.run(request());
    expect(r).toMatchObject({ requestId: 'r1', sessionId: SESSION, ok: true, structuredOutput: { reponse: 'Bonjour' } });
    const call = spawned.find((p) => p.args[0] === '-p')!;
    expect(call.command).toBe('/Users/eleve/.local/bin/claude');
    expect(call.cwd).toBe(join(tmp, 'staging', SESSION));
    expect(statSync(call.cwd).isDirectory()).toBe(true);
    expect(readdirSync(call.cwd)).toEqual([]);
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK']) expect(call.env).not.toHaveProperty(k);
    expect(call.env.HOME).toBe('/Users/eleve');
  });

  it('refuses to run when Claude Code is missing, not logged in, or logged in with an API key', async () => {
    const missing = service({ runs: [] }, { cliPath: undefined, isExecutable: async () => false, env: { SHELL: '/bin/zsh' } });
    missing.spawned.length = 0;
    const st = await missing.s.status();
    expect(st.available).toBe(false);
    expect(st.error).toMatch(/a besoin de Claude Code/);
    expect(st.error).toContain('curl -fsSL https://claude.ai/install.sh | bash');
    expect(missing.spawned[0]).toMatchObject({ command: '/bin/zsh', args: ['-lc', 'command -v claude'] });
    expect((await missing.s.run(request())).error?.kind).toBe('not-installed');

    let t = 0;
    const out = service({ auth: { stdout: '{"loggedIn":false}', code: 1 }, runs: [] }, { now: () => t });
    expect((await out.s.status()).error).toMatch(/\/login/);
    // A failed check is not kept for a minute: « Réessayer » checks again a few seconds later.
    t = 10_000;
    await out.s.status();
    expect(out.spawned.filter((p) => p.args[0] === 'auth')).toHaveLength(2);
    expect((await out.s.run(request())).error?.kind).toBe('not-logged-in');
    expect(out.spawned.some((p) => p.args[0] === '-p')).toBe(false);

    const key = service({ auth: { stdout: '{"loggedIn":true,"authMethod":"api_key"}' }, runs: [] });
    const ks = await key.s.status();
    expect(ks.available).toBe(false);
    expect(ks.error).toMatch(/clé d’API/);
  });

  it('cancels with SIGINT then SIGTERM, and times out the same way', async () => {
    const { s, spawned } = service({ runs: [{ hang: true }, { hang: true }] });
    const pending = s.run(request());
    await new Promise((r) => setTimeout(r, 20));
    s.cancel('r1');
    const r = await pending;
    expect(r.error?.kind).toBe('cancelled');
    expect(spawned.find((p) => p.args[0] === '-p')!.signals[0]).toBe('SIGINT');
  });

  it('times out: SIGINT, then SIGTERM when the CLI does not stop', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { s, spawned } = service({ runs: [{ hang: true, ignoreInt: true }] });
      const pending = s.run(request({ timeoutMs: 10_000 }));
      for (let i = 0; i < 400 && !spawned.some((p) => p.args[0] === '-p'); i++) await vi.advanceTimersByTimeAsync(5);
      await vi.advanceTimersByTimeAsync(10_100);
      const r = await pending;
      expect(r.error?.kind).toBe('timeout');
      expect(spawned.find((p) => p.args[0] === '-p')!.signals).toEqual(['SIGINT', 'SIGTERM']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces one run per conversation and reports the timeout kind', async () => {
    const { s } = service({ runs: [{ hang: true }] });
    const first = s.run(request());
    await new Promise((r) => setTimeout(r, 20));
    const second = await s.run(request({ requestId: 'r2' }));
    expect(second.error?.message).toMatch(/déjà en cours/);
    s.cancel('r1');
    await first;
  });

  it('passes the parsed usage through when the CLI fails after running', async () => {
    const { s } = service({ runs: [{ stdout: okResult({ is_error: true, subtype: 'error_during_execution', result: 'usage limit reached' }), code: 1 }] });
    const r = await s.run(request());
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('usage-limit');
    expect(r.usage?.sessionCostUsd).toBe(0.0026);
  });
});
