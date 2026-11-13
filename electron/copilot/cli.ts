// Pure helpers of the copilot service (no Electron, no process spawning): where the user's Claude Code CLI lives,
// the scrubbed environment, the argv of a headless run, and the mapping of its JSON result / failures to the
// bridge's CopilotRunResult. See research/08_claude_code_headless.md for the flags and the verified behaviour.
// Policy: the app only runs the user's own, unmodified `claude` binary under their own login. It never reads
// credentials, the Keychain or token variables; it removes them from the child's environment instead.
import type { CopilotErrorKind, CopilotModel, CopilotRunRequest, CopilotRunResult, CopilotUsage } from '../../app/src/host/bridge';

export const DEFAULT_MAX_TURNS = 3;
export const DEFAULT_TIMEOUT_MS = 180_000;
export const MAX_PROMPT_CHARS = 200_000;
export const MAX_SYSTEM_PROMPT_CHARS = 30_000;
export const MAX_SCHEMA_CHARS = 30_000;

/** Variables that would make the CLI bill an API key / a cloud account or use another config, removed for the child. */
export const SCRUBBED_ENV: readonly string[] = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_PROFILE', 'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  // A Node-based CLI must not inherit the app's Node / Electron switches.
  'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE',
];

/**
 * Prefixes removed as a whole: every ANTHROPIC_* variable, and every Claude Code variable of a parent session
 * (CLAUDECODE, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_ENTRYPOINT, CLAUDE_EFFORT...) — PIC Studio started from a Claude Code
 * terminal (npm run app:dev, the smoke script) must not pass its auth, effort or nesting state to the copilot's CLI.
 * FORCED_ENV is added back afterwards.
 */
export const SCRUBBED_PREFIXES: readonly string[] = ['ANTHROPIC_', 'CLAUDE'];

/** Set for every run: no claude.ai connectors, no CLAUDE.md, no auto memory. */
export const FORCED_ENV: Readonly<Record<string, string>> = {
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
};

const BASE_PATH = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** Environment of the child: the app's, minus the scrubbed variables (and every ANTHROPIC_* / CLAUDE*), plus FORCED_ENV. */
export function childEnv(parent: Readonly<Record<string, string | undefined>>, home: string, cliDir?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (SCRUBBED_ENV.includes(k) || SCRUBBED_PREFIXES.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  out.HOME = home;
  // Apps opened from the Finder get a minimal PATH: make sure the usual tool folders are there.
  const path = (out.PATH ?? '').split(':').filter(Boolean);
  for (const p of [...(cliDir ? [cliDir] : []), ...BASE_PATH]) if (!path.includes(p)) path.push(p);
  out.PATH = path.join(':');
  Object.assign(out, FORCED_ENV);
  return out;
}

/**
 * Claude Code bundled with the Claude desktop app (~/Library/Application Support/Claude/claude-code/<version>/<hash>/
 * claude.app/Contents/MacOS/claude): not on the PATH, but the same CLI. Newest version first.
 */
export function bundledCliCandidates(home: string, listDir: (dir: string) => string[]): string[] {
  const root = `${home}/Library/Application Support/Claude/claude-code`;
  const versions = listDir(root).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort(compareVersions).reverse();
  const out: string[] = [];
  for (const v of versions) {
    for (const h of listDir(`${root}/${v}`)) out.push(`${root}/${v}/${h}/claude.app/Contents/MacOS/claude`);
  }
  return out;
}

/** True for a CLI found inside the Claude desktop app (not installed by the student). */
export const isBundledCli = (file: string): boolean => /\/Library\/Application Support\/Claude\/claude-code\//.test(file);

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Where the CLI usually lives (native installer first). */
export function cliCandidates(home: string): string[] {
  return [
    `${home}/.local/bin/claude`,
    `${home}/.claude/local/claude`,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    `${home}/.npm-global/bin/claude`,
    `${home}/.bun/bin/claude`,
  ];
}

// ------------------------------------------------------------------------------------------------ requests

export interface ValidRunRequest {
  requestId: string;
  sessionId: string;
  resume: boolean;
  prompt: string;
  systemPrompt: string;
  schemaJson: string;
  model: CopilotModel;
  maxTurns: number;
  timeoutMs: number;
}

/** C0 control characters (except tab / newline / carriage return) and DEL: NUL cannot go into argv at all. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
export const stripControlChars = (s: string): string => s.replace(CONTROL_CHARS, '');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Check a request coming from the renderer (untrusted). Returns a French error message when invalid. */
export function validateRunRequest(raw: unknown): ValidRunRequest | { error: string; requestId: string; sessionId: string } {
  const r = isRecord(raw) ? raw : {};
  const requestId = typeof r.requestId === 'string' ? r.requestId.slice(0, 100) : '';
  const sessionId = typeof r.sessionId === 'string' ? r.sessionId : '';
  const fail = (error: string) => ({ error, requestId, sessionId });
  if (!requestId) return fail('Demande invalide (identifiant manquant).');
  if (!UUID.test(sessionId)) return fail('Demande invalide (identifiant de conversation).');
  // Control characters (a NUL from a badly decoded énoncé...) would make spawn() throw: they are removed.
  const rawPrompt = typeof r.prompt === 'string' ? stripControlChars(r.prompt) : '';
  if (rawPrompt.trim() === '') return fail('Message vide.');
  if (rawPrompt.length > MAX_PROMPT_CHARS) return fail('Message trop long.');
  const systemPrompt = typeof r.systemPrompt === 'string' ? stripControlChars(r.systemPrompt) : '';
  if (systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS) return fail('Consigne système trop longue.');
  if (!isRecord(r.jsonSchema)) return fail('Schéma de réponse manquant.');
  let schemaJson: string;
  try {
    schemaJson = JSON.stringify(r.jsonSchema);
  } catch {
    return fail('Schéma de réponse invalide.');
  }
  if (schemaJson.length > MAX_SCHEMA_CHARS) return fail('Schéma de réponse trop long.');
  const model: CopilotModel = r.model === 'sonnet' ? 'sonnet' : 'haiku';
  const maxTurns = Number.isInteger(r.maxTurns) ? Math.min(6, Math.max(2, r.maxTurns as number)) : DEFAULT_MAX_TURNS;
  const timeoutMs = typeof r.timeoutMs === 'number' && Number.isFinite(r.timeoutMs) ? Math.min(600_000, Math.max(10_000, r.timeoutMs)) : DEFAULT_TIMEOUT_MS;
  // The prompt is a positional argument: never let it look like an option.
  const prompt = rawPrompt.startsWith('-') ? `Message : ${rawPrompt}` : rawPrompt;
  return { requestId, sessionId, resume: r.resume === true, prompt, systemPrompt, schemaJson, model, maxTurns, timeoutMs };
}

/**
 * argv (without the executable) of a headless run. First turn: --session-id + --system-prompt; later turns:
 * --resume with every other flag re-passed (they are not restored on resume).
 */
export function buildArgs(r: Pick<ValidRunRequest, 'sessionId' | 'resume' | 'prompt' | 'systemPrompt' | 'schemaJson' | 'model' | 'maxTurns'>): string[] {
  return [
    '-p', r.prompt,
    '--model', r.model,
    '--effort', 'low',
    '--safe-mode',
    '--tools', '',
    '--disallowedTools', 'mcp__*',
    '--strict-mcp-config',
    '--permission-mode', 'dontAsk',
    ...(r.resume ? ['--resume', r.sessionId] : ['--session-id', r.sessionId, ...(r.systemPrompt ? ['--system-prompt', r.systemPrompt] : [])]),
    '--json-schema', r.schemaJson,
    '--max-turns', String(r.maxTurns),
    '--output-format', 'json',
  ];
}

// ------------------------------------------------------------------------------------------------ results

/** Official one-line installer of Claude Code (native build, no Node needed). */
export const INSTALL_COMMAND = 'curl -fsSL https://claude.ai/install.sh | bash';

export const MESSAGES = {
  notInstalled: `Le copilote a besoin de Claude Code, l’outil en ligne de commande de Claude (l’application Claude seule ne suffit pas). Pour l’installer, une seule fois : ouvrez le Terminal, collez « ${INSTALL_COMMAND} » et appuyez sur Entrée. Tapez ensuite « claude » et connectez-vous avec votre compte Claude (votre abonnement). Revenez ici et cliquez sur « Réessayer ».`,
  bundledNotLoggedIn: `Claude Code est présent dans l’application Claude, mais il n’est pas connecté pour être utilisé ici. Installez Claude Code une fois : ouvrez le Terminal, collez « ${INSTALL_COMMAND} » et appuyez sur Entrée, puis tapez « claude » et connectez-vous avec votre compte Claude. Revenez ici et cliquez sur « Réessayer ».`,
  notLoggedIn: 'Claude Code n’est pas connecté à votre compte Claude. Ouvrez Claude Code une fois (dans le Terminal, tapez « claude ») et connectez-vous avec votre abonnement Claude (commande « /login »). Revenez ensuite ici et cliquez sur « Réessayer ».',
  apiKeyLogin: 'Claude Code est connecté avec une clé d’API (facturée à l’usage), pas avec votre abonnement Claude. Dans le Terminal, tapez « claude » puis « /login » et choisissez votre compte Claude.',
  usageLimit: 'La limite d’utilisation de votre abonnement Claude est atteinte. Réessayez plus tard : elle se renouvelle automatiquement.',
  timeout: 'Le copilote a mis trop de temps à répondre. Réessayez, ou découpez la demande en étapes plus petites.',
  cancelled: 'Demande annulée.',
  schema: 'Le copilote n’a pas réussi à répondre au bon format. Réessayez, ou choisissez le modèle « Plus fiable (Sonnet) ».',
  maxTurns: 'Le copilote n’a pas terminé sa réponse à temps (limite de tours atteinte). Réessayez.',
  overloaded: 'Les serveurs de Claude sont très sollicités en ce moment. Réessayez dans un instant.',
  busy: 'Une demande est déjà en cours pour cette conversation.',
  crashed: 'Claude Code s’est arrêté de façon inattendue.',
  unreadableText: 'Le texte envoyé contient des caractères illisibles (énoncé mal décodé ?). Copiez le texte de l’énoncé dans le message et réessayez.',
  sessionInUse: 'Cette conversation est déjà ouverte ailleurs dans Claude Code. Cliquez sur « Nouvelle conversation » puis renvoyez la demande.',
} as const;

const MONTHS_FR: Readonly<Record<string, string>> = {
  jan: 'janvier', feb: 'février', mar: 'mars', apr: 'avril', may: 'mai', jun: 'juin',
  jul: 'juillet', aug: 'août', sep: 'septembre', oct: 'octobre', nov: 'novembre', dec: 'décembre',
};

const hourFr = (h: number, min: number) => (min ? `${h} h ${String(min).padStart(2, '0')}` : `${h} h`);

/**
 * When the usage limit comes back, in French, from the CLI's English text: « resets 3pm », « resets Oct 14, 3:30pm »,
 * « resets at 15:00 », or the old « …limit reached|1760450400 » (epoch seconds, shown in local time). Null if absent.
 */
export function resetTimeFr(text: string, toLocal: (epochMs: number) => Date = (ms) => new Date(ms)): string | null {
  const epoch = /limit reached\|(\d{10})\b/i.exec(text);
  if (epoch) {
    const d = toLocal(Number(epoch[1]) * 1000);
    return `à ${hourFr(d.getHours(), d.getMinutes())}`;
  }
  const m = /resets?\s+(?:at\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (!m) return null;
  let h = Number(m[3]);
  const min = m[4] ? Number(m[4]) : 0;
  const ampm = m[5]?.toLowerCase();
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  const date = m[1] && m[2] ? `le ${Number(m[2])} ${MONTHS_FR[m[1].toLowerCase()]} ` : '';
  return `${date}à ${hourFr(h, min)}`;
}

const NOT_LOGGED_IN = /not logged in|please run \/login|\/login to|invalid api key|authentication[_ ]error|oauth token (has )?expired|token (has )?expired|unauthori[sz]ed|\b401\b/i;
const USAGE_LIMIT = /usage limit|limit reached|limit (will )?reset|rate[ _-]?limit|5-hour limit|weekly limit|out of (extra )?usage|credit balance|\b429\b/i;
const OVERLOADED = /overloaded|\b529\b/i;

export interface ProcessOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  /** spawn failed (ENOENT...). */
  spawnError?: string;
}

/** The CLI's `--output-format json` result object (the fields used here). */
interface CliResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  modelUsage?: Record<string, { costUSD?: number; outputTokens?: number }>;
}

/** The result object in stdout (the whole text, or its last JSON line). */
export function parseCliJson(stdout: string): CliResult | null {
  const text = stdout.trim();
  if (!text) return null;
  const tryParse = (s: string): CliResult | null => {
    try {
      const v = JSON.parse(s) as unknown;
      return isRecord(v) ? (v as CliResult) : null;
    } catch {
      return null;
    }
  };
  const whole = tryParse(text);
  if (whole) return whole;
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    const v = tryParse(lines[i]);
    if (v && (v.type === 'result' || 'subtype' in v)) return v;
  }
  return null;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Usage of one call. modelUsage is cumulative for the whole session on resumed calls, so after several Haiku turns a
 * Sonnet request would still rank Haiku first by cost: the requested model is preferred when the CLI reports it.
 */
export function usageOf(r: CliResult, requested?: CopilotModel): CopilotUsage {
  const models = Object.entries(r.modelUsage ?? {});
  models.sort((a, b) => num(b[1]?.costUSD) - num(a[1]?.costUSD) || num(b[1]?.outputTokens) - num(a[1]?.outputTokens));
  if (requested) {
    const i = models.findIndex(([id]) => id.toLowerCase().includes(requested));
    if (i > 0) models.unshift(...models.splice(i, 1));
  }
  const usage: CopilotUsage = {
    inputTokens: num(r.usage?.input_tokens),
    outputTokens: num(r.usage?.output_tokens),
    cacheReadTokens: num(r.usage?.cache_read_input_tokens),
    cacheCreationTokens: num(r.usage?.cache_creation_input_tokens),
    sessionCostUsd: num(r.total_cost_usd),
    durationMs: num(r.duration_ms),
  };
  if (models[0]) usage.model = models[0][0];
  return usage;
}

/** Short excerpt of a CLI text for an error message (one line, no paths of the user's home). */
export function excerpt(text: string, home?: string, max = 200): string {
  let t = text.replace(/\s+/g, ' ').trim();
  if (home) t = t.split(home).join('~');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function errorFor(kind: CopilotErrorKind, detail = '', home?: string): { kind: CopilotErrorKind; message: string } {
  const base: Record<CopilotErrorKind, string> = {
    'not-installed': MESSAGES.notInstalled, 'not-logged-in': MESSAGES.notLoggedIn, 'usage-limit': MESSAGES.usageLimit,
    timeout: MESSAGES.timeout, cancelled: MESSAGES.cancelled, schema: MESSAGES.schema, process: MESSAGES.crashed,
  };
  if (kind === 'usage-limit') {
    // The CLI's English text only matters for when the limit comes back.
    const when = detail ? resetTimeFr(detail) : null;
    return { kind, message: when ? `La limite d’utilisation de votre abonnement Claude est atteinte. Elle se renouvelle ${when} : réessayez à ce moment-là.` : base[kind] };
  }
  const d = detail ? excerpt(detail, home) : '';
  return { kind, message: d && kind === 'process' ? `${base[kind]} Détail technique (en anglais) : ${d}` : base[kind] };
}

const SESSION_IN_USE = /already in use|session id .*already|already exists/i;

/** Map a finished CLI process to the bridge result (without requestId / sessionId). Parses stdout even on failure. */
export function interpretRun(p: ProcessOutcome, home?: string, requested?: CopilotModel): Omit<CopilotRunResult, 'requestId' | 'sessionId'> & { cliSessionId?: string } {
  if (p.spawnError) {
    // Node's own exceptions may quote the whole argv (the prompt): never shown as such.
    if (/null bytes|ERR_INVALID_ARG/i.test(p.spawnError)) return { ok: false, error: { kind: 'process', message: MESSAGES.unreadableText } };
    return { ok: false, error: /ENOENT|not found/i.test(p.spawnError) ? errorFor('not-installed') : errorFor('process', p.spawnError.slice(0, 120), home) };
  }
  const r = parseCliJson(p.stdout);
  const usage = r ? usageOf(r, requested) : undefined;
  const base = { ...(usage ? { usage } : {}), ...(typeof r?.result === 'string' ? { resultText: r.result } : {}), ...(r?.session_id ? { cliSessionId: r.session_id } : {}) };
  if (p.cancelled) return { ...base, ok: false, error: errorFor('cancelled') };
  if (p.timedOut) return { ...base, ok: false, error: errorFor('timeout') };
  const text = `${r?.result ?? ''}\n${p.stderr}`;
  if (r && !r.is_error && (r.subtype === 'success' || r.subtype === undefined)) {
    if (r.structured_output === undefined || r.structured_output === null) return { ...base, ok: false, error: errorFor('schema') };
    return { ...base, ok: true, structuredOutput: r.structured_output };
  }
  if (r?.subtype === 'error_max_structured_output_retries') return { ...base, ok: false, error: errorFor('schema') };
  if (NOT_LOGGED_IN.test(text)) return { ...base, ok: false, error: errorFor('not-logged-in') };
  if (USAGE_LIMIT.test(text)) return { ...base, ok: false, error: errorFor('usage-limit', r?.result ?? '', home) };
  if (OVERLOADED.test(text)) return { ...base, ok: false, error: { kind: 'process', message: MESSAGES.overloaded } };
  if (r?.subtype === 'error_max_turns') return { ...base, ok: false, error: { kind: 'process', message: MESSAGES.maxTurns } };
  // --session-id of a session the CLI already has (a first turn killed before it answered): the renderer recognises
  // this message (« déjà ouverte ») and resumes the session instead.
  if (SESSION_IN_USE.test(text)) return { ...base, ok: false, error: { kind: 'process', message: MESSAGES.sessionInUse } };
  const detail = r?.result || p.stderr || (p.exitCode !== null ? `code de sortie ${p.exitCode}` : '');
  return { ...base, ok: false, error: errorFor('process', detail, home) };
}

export interface AuthInfo {
  loggedIn: boolean;
  authMethod?: string;
  subscription?: string;
}

/** `claude auth status` (JSON): only what the app needs — never the e-mail or the organisation. */
export function parseAuthStatus(stdout: string, exitCode: number | null): AuthInfo {
  try {
    const v = JSON.parse(stdout.trim()) as unknown;
    if (isRecord(v)) {
      const info: AuthInfo = { loggedIn: v.loggedIn === true && exitCode === 0 };
      if (typeof v.authMethod === 'string') info.authMethod = v.authMethod;
      if (typeof v.subscriptionType === 'string') info.subscription = v.subscriptionType;
      return info;
    }
  } catch {
    // older CLIs print text
  }
  return { loggedIn: exitCode === 0 && !/not logged in/i.test(stdout) };
}

/** `2.1.287 (Claude Code)` → `2.1.287`. */
export function parseVersion(stdout: string): string | undefined {
  const m = /(\d+\.\d+\.\d+)/.exec(stdout);
  return m ? m[1] : undefined;
}
