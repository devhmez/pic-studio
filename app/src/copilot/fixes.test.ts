// Fixes after the adversarial review of the copilot: CLI helpers (environment, NUL characters, French limit
// message, bundled CLI, model label), the session recovery of runTurn, partial proposals, rail stubs in the
// autolayout and the énoncé readers. Fake bridge / pure helpers only: the real CLI is never started.
import { autolayout, buildNetlist, layoutOverlaps, pinKey, wiresThroughBodies } from '@pic/circuit';
import { describe, expect, it } from 'vitest';
import {
  bundledCliCandidates, childEnv, compareVersions, FORCED_ENV, interpretRun, isBundledCli, MESSAGES, resetTimeFr,
  usageOf, validateRunRequest,
} from '../../../electron/copilot/cli';
import type { CopilotBridge, CopilotRunRequest, CopilotRunResult } from '../host/bridge';
import { blankProject, createAppStore } from '../state/store';
import { DEMUX_ANSWER, EXEMPLE2_ANSWER } from './core/answers.fixtures';
import { decodeTextFile, docxXmlToText, tidyText } from './core/enonceText';
import type { KeyValueStorage } from './core/messages';
import { buildUserPrompt } from './core/prompt';
import { readAnswer } from './core/schema';
import { newConversation, runTurn } from './core/turn';
import type { ProjectState } from './core/verify';
import { replaceHint } from './ResultCard';
import { applyPayload, createCopilotStore } from './store';

const SESSION = '0b7e3f7a-8f7e-4b3e-9a51-2a0c5d6e7f80';

function blank(): ProjectState {
  const p = blankProject();
  return { name: 'Nouveau projet', schematic: p.schematic, source: p.source, clockHz: p.clockHz };
}

function memory(): KeyValueStorage {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); } };
}

const USAGE = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0, sessionCostUsd: 0.01, model: 'claude-haiku-4-5-20251001', durationMs: 1000 };

function scripted(replies: Partial<CopilotRunResult>[]) {
  const requests: CopilotRunRequest[] = [];
  const bridge: CopilotBridge = {
    status: async () => ({ available: true, loggedIn: true }),
    run: async (req) => {
      requests.push(req);
      return { requestId: req.requestId, sessionId: req.sessionId, ok: true, ...(replies.shift() ?? {}) };
    },
    cancel: async () => undefined,
  };
  return { bridge, requests };
}

// ------------------------------------------------------------------------------------------------ CLI helpers

describe('CLI helpers after review', () => {
  it('the child environment drops the Claude Code variables of a parent session but keeps the forced ones', () => {
    const env = childEnv({
      PATH: '/usr/bin', USER: 'eleve', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SIMPLE: '1', CLAUDE_EFFORT: 'high', ANTHROPIC_MODEL: 'x', NODE_OPTIONS: '--inspect', PIC_STUDIO_CLAUDE: '/x',
    }, '/Users/eleve');
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_EFFORT', 'ANTHROPIC_MODEL', 'NODE_OPTIONS']) {
      expect(env[k], k).toBeUndefined();
    }
    for (const [k, v] of Object.entries(FORCED_ENV)) expect(env[k]).toBe(v);
    expect(env.USER).toBe('eleve');
    expect(env.HOME).toBe('/Users/eleve');
  });

  it('control characters (NUL...) are removed from the prompt and the system prompt before spawn', () => {
    const r = validateRunRequest({ requestId: 'r', sessionId: SESSION, prompt: 'D\u0000é\u0001mux\tok\nfin', systemPrompt: 'a\u0000b', jsonSchema: { type: 'object' } });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.prompt).toBe('Démux\tok\nfin');
    expect(r.systemPrompt).toBe('ab');
    const empty = validateRunRequest({ requestId: 'r', sessionId: SESSION, prompt: '\u0000\u0000', jsonSchema: { type: 'object' } });
    expect('error' in empty && empty.error).toBe('Message vide.');
  });

  it('a spawn exception about null bytes becomes a French message that does not echo the prompt', () => {
    const r = interpretRun({ stdout: '', stderr: '', exitCode: null, timedOut: false, cancelled: false, spawnError: "The argument 'args[1]' must be a string without null bytes. Received 'DEMANDE DE L'ÉTUDIANT…'" });
    expect(r.error).toEqual({ kind: 'process', message: MESSAGES.unreadableText });
  });

  it('the usage-limit reset time is given in French', () => {
    expect(resetTimeFr('5-hour limit reached ∙ resets 3pm')).toBe('à 15 h');
    expect(resetTimeFr('You\'ve hit your limit · resets Oct 14, 3:30pm (Europe/Paris)')).toBe('le 14 octobre à 15 h 30');
    expect(resetTimeFr('limit will reset at 12am')).toBe('à 0 h');
    expect(resetTimeFr('Claude AI usage limit reached|1760450400', () => new Date(2025, 9, 14, 16, 0))).toBe('à 16 h');
    expect(resetTimeFr('Rate limited')).toBeNull();
    const r = interpretRun({ stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Weekly limit reached ∙ resets Oct 20, 9am' }), stderr: '', exitCode: 1, timedOut: false, cancelled: false });
    expect(r.error?.kind).toBe('usage-limit');
    expect(r.error?.message).toBe('La limite d’utilisation de votre abonnement Claude est atteinte. Elle se renouvelle le 20 octobre à 9 h : réessayez à ce moment-là.');
  });

  it('a --session-id the CLI already has is reported with a message the renderer recognises', () => {
    const r = interpretRun({ stdout: '', stderr: 'Error: Session ID 0b7e3f7a-8f7e-4b3e-9a51-2a0c5d6e7f80 is already in use.', exitCode: 1, timedOut: false, cancelled: false });
    expect(r.error).toEqual({ kind: 'process', message: MESSAGES.sessionInUse });
  });

  it('the footnote model is the requested one when the session used several models', () => {
    const u = usageOf({ modelUsage: { 'claude-haiku-4-5-20251001': { costUSD: 0.05, outputTokens: 9000 }, 'claude-sonnet-4-5': { costUSD: 0.02, outputTokens: 800 } } }, 'sonnet');
    expect(u.model).toBe('claude-sonnet-4-5');
    expect(usageOf({ modelUsage: { 'claude-haiku-4-5-20251001': { costUSD: 0.05 } } }, 'sonnet').model).toBe('claude-haiku-4-5-20251001');
  });

  it('finds the CLI bundled with the Claude desktop app, newest version first, and explains how to install it otherwise', () => {
    const dirs: Record<string, string[]> = {
      '/Users/eleve/Library/Application Support/Claude/claude-code': ['2.1.293', '2.1.295', '.DS_Store', '2.1.30'],
      '/Users/eleve/Library/Application Support/Claude/claude-code/2.1.295': ['9d6405864fdc'],
      '/Users/eleve/Library/Application Support/Claude/claude-code/2.1.293': ['8433d0d9cd0d'],
      '/Users/eleve/Library/Application Support/Claude/claude-code/2.1.30': ['aaaa'],
    };
    const found = bundledCliCandidates('/Users/eleve', (d) => dirs[d] ?? []);
    expect(found[0]).toBe('/Users/eleve/Library/Application Support/Claude/claude-code/2.1.295/9d6405864fdc/claude.app/Contents/MacOS/claude');
    expect(found).toHaveLength(3);
    expect(isBundledCli(found[0])).toBe(true);
    expect(isBundledCli('/Users/eleve/.local/bin/claude')).toBe(false);
    expect(compareVersions('2.1.30', '2.1.295')).toBeLessThan(0);
    expect(MESSAGES.notInstalled).toContain('curl -fsSL https://claude.ai/install.sh | bash');
    expect(MESSAGES.notInstalled).toContain('l’application Claude seule ne suffit pas');
  });
});

// ------------------------------------------------------------------------------------------------ runTurn

describe('runTurn session recovery', () => {
  it('a first turn killed by the timeout counts as started (the next request resumes)', async () => {
    const { bridge } = scripted([{ ok: false, error: { kind: 'timeout', message: 'trop long' } }]);
    const out = await runTurn({ request: 'a', project: blank(), model: 'haiku' }, newConversation(), { bridge });
    expect(out.error?.kind).toBe('timeout');
    expect(out.state.started).toBe(true);
  });

  it('« session already in use » on a first turn: the same session is resumed instead', async () => {
    const { bridge, requests } = scripted([
      { ok: false, error: { kind: 'process', message: MESSAGES.sessionInUse } },
      { structuredOutput: { reponse: 'Bonjour !' }, usage: USAGE },
    ]);
    const start = newConversation();
    const out = await runTurn({ request: 'Bonjour', project: blank(), model: 'haiku' }, start, { bridge });
    expect(out.error).toBeUndefined();
    expect(requests.map((r) => r.resume)).toEqual([false, true]);
    expect(requests[1].sessionId).toBe(start.sessionId);
    expect(out.state.sessionId).toBe(start.sessionId);
  });

  it('a question turn whose "circuit" is empty is not a proposal', () => {
    const r = readAnswer({ reponse: 'Quelles broches ?', questions: ['Sur quelles broches ?'], circuit: { horloge_mhz: 1, composants: [], liaisons: [] }, code: '  ' })!;
    expect(r.answer).toEqual({ reponse: 'Quelles broches ?', questions: ['Sur quelles broches ?'] });
    expect(r.problems).toEqual([]);
  });

  it('after a prof-style rewrite was applied, the follow-up carries the code the student sees (not the circuit)', () => {
    const text = buildUserPrompt({ request: 'Change la ligne 12', project: null, projectIsLastProposal: true, appliedCode: 'void main() {\n}\n' });
    expect(text).toContain('réécrit dans le style du professeur');
    expect(text).toContain('void main() {\n}');
    expect(buildUserPrompt({ request: 'x', project: null, projectIsLastProposal: true })).toContain('appliquée telle quelle');
  });
});

// ------------------------------------------------------------------------------------------------ store / apply

describe('applying proposals after review', () => {
  it('older saved payloads (no circuit / code flags) still replace both halves', async () => {
    const app = createAppStore({ autosaveDelayMs: 0 });
    await app.getState().loadTemplate('tp0-exemple2');
    const other = createAppStore({ autosaveDelayMs: 0 });
    await other.getState().loadTemplate('tp1-demux');
    const p = other.getState().project;
    applyPayload(app, { schematic: p.schematic, source: p.source, program: p.program, clockHz: p.clockHz, fingerprint: '', latest: true });
    expect(app.getState().project.schematic).toBe(p.schematic);
    expect(app.getState().project.source).toBe(p.source);
  });

  it('the card says which half is replaced, and that the student’s later changes to the other half are kept', () => {
    expect(replaceHint(true, true, false)).toBe('Remplace le schéma et le code actuels (annulable).');
    expect(replaceHint(true, false, true)).toContain('votre code actuel est gardé');
    expect(replaceHint(false, true, true)).toContain('votre schéma actuel est gardé');
  });

  it('a proposal stores which halves it changes and the project it was asked about', async () => {
    const app = createAppStore({ autosaveDelayMs: 0 });
    app.getState().newProject();
    const { bridge } = scripted([{ structuredOutput: DEMUX_ANSWER, usage: USAGE }]);
    const copilot = createCopilotStore({ app, storage: memory(), bridge: () => bridge, yieldToUi: () => Promise.resolve() });
    copilot.getState().setDraft('Fais le démultiplexeur');
    await copilot.getState().send();
    const payload = copilot.getState().messages[1].proposal?.payload;
    expect(payload?.circuit).toBe(true);
    expect(payload?.code).toBe(true);
    expect(payload?.base).toMatch(/\S/);
  });

  it('the answer to a request sent from another project is filed in that project’s conversation', async () => {
    const app = createAppStore({ autosaveDelayMs: 0 });
    app.getState().newProject();
    const storage = memory();
    const requests: CopilotRunRequest[] = [];
    let release: (r: CopilotRunResult) => void = () => undefined;
    const bridge: CopilotBridge = {
      status: async () => ({ available: true, loggedIn: true }),
      run: (req) => { requests.push(req); return new Promise((r) => { release = r; }); },
      cancel: async () => undefined,
    };
    const copilot = createCopilotStore({ app, storage, bridge: () => bridge, yieldToUi: () => Promise.resolve() });
    const firstKey = copilot.getState().key;
    copilot.getState().setDraft('Fais le démultiplexeur');
    const sending = copilot.getState().send();
    await new Promise((r) => setTimeout(r, 0));
    await app.getState().loadTemplate('tp-status');
    expect(copilot.getState().requestSession).toBe(requests[0].sessionId);
    expect(copilot.getState().requestSession).not.toBe(copilot.getState().conversation.sessionId);
    release({ requestId: requests[0].requestId, sessionId: requests[0].sessionId, ok: true, structuredOutput: DEMUX_ANSWER, usage: USAGE });
    await sending;
    expect(copilot.getState().busy).toBe(false);
    expect(copilot.getState().notice).toMatch(/rangée dans la conversation/);
    const stored = JSON.parse(storage.getItem(firstKey)!) as { messages: { role: string; proposal?: unknown }[]; conversation: { started: boolean } };
    expect(stored.messages.map((m) => m.role)).toEqual(['student', 'copilot']);
    expect(stored.messages[1].proposal).toBeDefined();
    expect(stored.conversation.started).toBe(true);
    // Back on the first project, the answer is there.
    app.getState().newProject();
    expect(copilot.getState().key).toBe(firstKey);
  });

  it('a code-only proposal applied while the clock changed uses the current clock', async () => {
    const app = createAppStore({ autosaveDelayMs: 0 });
    await app.getState().loadTemplate('tp0-exemple2');
    const { bridge } = scripted([{ structuredOutput: { reponse: 'Code.', code: EXEMPLE2_ANSWER.code }, usage: USAGE }]);
    const copilot = createCopilotStore({ app, storage: memory(), bridge: () => bridge, yieldToUi: () => Promise.resolve() });
    copilot.getState().setDraft('Réécris le code');
    await copilot.getState().send();
    app.getState().setClock(4_000_000);
    copilot.getState().apply(copilot.getState().messages[1].id);
    expect(app.getState().project.clockHz).toBe(4_000_000);
  });
});

// ------------------------------------------------------------------------------------------------ autolayout

describe('autolayout: PIC pins tied straight to a rail', () => {
  const cases = {
    MCLR_VDD: [{ from: 'U1.MCLR', to: 'VDD' }],
    RA4_GND: [{ from: 'U1.RA4', to: 'GND' }],
    RB3_GND_BETWEEN_LEDS: [{ from: 'U1.RB3', to: 'GND' }],
    SEVERAL: [{ from: 'U1.MCLR', to: 'VDD' }, { from: 'U1.RA2', to: 'VDD' }, { from: 'U1.RB7', to: 'GND' }],
  };
  for (const [name, extra] of Object.entries(cases)) {
    it(`${name}: drawn with its own terminal, nothing overlaps or crosses`, () => {
      const lay = autolayout({
        parts: [{ ref: 'D1', kind: 'LED', color: 'RED' }, { ref: 'D2', kind: 'LED', color: 'GREEN' }, { ref: 'D3', kind: 'LED' }, { ref: 'LS1', kind: 'LOGICSTATE' }],
        links: [
          { from: 'U1.RB2', to: 'D1.A' }, { from: 'D1.K', to: 'GND' }, { from: 'U1.RB4', to: 'D2.A' }, { from: 'D2.K', to: 'GND' },
          { from: 'U1.RB5', to: 'D3.A' }, { from: 'D3.K', to: 'GND' }, { from: 'LS1', to: 'U1.RA0' }, ...extra,
        ],
      });
      expect(lay.problems).toEqual([]);
      const nl = buildNetlist(lay.schematic);
      expect(nl.dangling).toEqual([]);
      expect(layoutOverlaps(lay.schematic)).toEqual([]);
      expect(wiresThroughBodies(lay.schematic)).toEqual([]);
      for (const l of extra) {
        const pin = l.from.slice(3) === 'RA4' ? 'RA4/T0CKI' : l.from.slice(3);
        expect(nl.pinToNet.get(pinKey('U1', pin)), l.from).toBe(l.to);
      }
      expect(nl.pinToNet.get(pinKey('U1', 'RB2'))).toBe(nl.pinToNet.get(pinKey('D1', 'A')));
    });
  }

  it('a reserved reference is explained case by case', () => {
    const lay = autolayout({ parts: [{ ref: 'U1', kind: 'LED' }, { ref: 'GND', kind: 'LED' }, { ref: 'VDD', kind: 'LED' }, { ref: 'RB0', kind: 'LED' }, { ref: 'D1', kind: 'LED' }, { ref: 'D1', kind: 'LED' }], links: [] });
    const msgs = lay.problems.filter((p) => p.code === 'DUPLICATE_REF').map((p) => p.message);
    expect(msgs).toEqual([
      'La référence « U1 » ne peut pas être utilisée : elle est réservée au PIC.',
      'La référence « GND » ne peut pas être utilisée : ce nom est réservé à la masse.',
      'La référence « VDD » ne peut pas être utilisée : ce nom est réservé à l’alimentation.',
      'La référence « RB0 » ne peut pas être utilisée : c’est le nom d’une broche du PIC.',
      'La référence « D1 » ne peut pas être utilisée : un autre composant la porte déjà.',
    ]);
  });
});

// ------------------------------------------------------------------------------------------------ énoncé

describe('énoncé text after review', () => {
  it('decodes UTF-16 BE and UTF-8 with a BOM', () => {
    const text = 'Énoncé : LED sur RB0';
    const be = new Uint8Array(2 + text.length * 2);
    be[0] = 0xfe; be[1] = 0xff;
    for (let i = 0; i < text.length; i++) { be[2 + 2 * i] = text.charCodeAt(i) >> 8; be[3 + 2 * i] = text.charCodeAt(i) & 0xff; }
    expect(decodeTextFile(be)).toBe(text);
    const utf8 = new TextEncoder().encode(text);
    expect(decodeTextFile(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]))).toBe(text);
    expect(decodeTextFile(utf8)).toBe(text);
    // UTF-16LE without a BOM.
    const le = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) { le[2 * i] = text.charCodeAt(i) & 0xff; le[2 * i + 1] = text.charCodeAt(i) >> 8; }
    expect(decodeTextFile(le)).toBe(text);
  });

  it('control characters never reach the prompt', () => {
    expect(tidyText('a\u0000b\u0007c\td\r\ne')).toBe('abc\td\ne');
  });

  it('DOCX: the Fallback copy of a text box is skipped, list items in nested paragraphs keep their bullet', () => {
    const xml = '<w:document><w:body>'
      + '<w:p><w:r><w:t>Avant</w:t></w:r><mc:AlternateContent><mc:Choice><w:drawing><w:txbxContent><w:p><w:r><w:t>Boîte</w:t></w:r></w:p></w:txbxContent></w:drawing></mc:Choice>'
      + '<mc:Fallback><w:pict><w:txbxContent><w:p><w:r><w:t>Boîte</w:t></w:r></w:p></w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent><w:r><w:t> après</w:t></w:r></w:p>'
      + '<w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>Point</w:t></w:r></w:p>'
      + '</w:body></w:document>';
    expect(docxXmlToText(xml)).toBe('Boîte\nAvant après\n• Point');
  });
});
