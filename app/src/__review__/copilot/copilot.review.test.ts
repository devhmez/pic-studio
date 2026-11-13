// ADVERSARIAL REVIEW of the copilot (failing tests = defects found). Fake bridge / fake spawn only: the real
// Claude Code CLI is never started. Each test states the expected behaviour; it fails against the current code.
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { createCopilotService, type SpawnFn } from '../../../../electron/copilot/service';
import { ANSWER_JSON_SCHEMA, type CopilotAnswer } from '../../copilot/core/schema';
import { DEMUX_ANSWER, EXEMPLE2_ANSWER } from '../../copilot/core/answers.fixtures';
import { EXEMPLE2 } from '../../copilot/core/fixtures';
import { schematicToCircuit } from '../../copilot/core/circuit';
import type { KeyValueStorage } from '../../copilot/core/messages';
import { docxXmlToText } from '../../copilot/core/enonceText';
import { newConversation, runTurn } from '../../copilot/core/turn';
import { verifyAnswer, type ProjectState } from '../../copilot/core/verify';
import { readEnonce } from '../../copilot/enonce';
import { applyPayload, createCopilotStore } from '../../copilot/store';
import type { CopilotBridge, CopilotRunRequest, CopilotRunResult } from '../../host/bridge';
import { makeLearnContext } from '../../learn/context';
import { blankProject, createAppStore } from '../../state/store';

function memory(): KeyValueStorage {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); } };
}

const USAGE = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0, sessionCostUsd: 0.01, model: 'claude-haiku-4-5-20251001', durationMs: 1000 };

/** Bridge whose run() stays pending until release() — the CLI takes 10–30 s in real life. */
function slowBridge() {
  const requests: CopilotRunRequest[] = [];
  const releases: ((r: CopilotRunResult) => void)[] = [];
  const bridge: CopilotBridge = {
    status: async () => ({ available: true, loggedIn: true }),
    run: (req) => { requests.push(req); return new Promise((r) => { releases.push(r); }); },
    cancel: async () => undefined,
  };
  const release = (i: number, structuredOutput: unknown) => releases[i]({ requestId: requests[i].requestId, sessionId: requests[i].sessionId, ok: true, structuredOutput, usage: USAGE });
  return { bridge, requests, release };
}

/** Bridge answering immediately with scripted structured outputs. */
function quickBridge(outputs: unknown[]) {
  const requests: CopilotRunRequest[] = [];
  const bridge: CopilotBridge = {
    status: async () => ({ available: true, loggedIn: true }),
    run: async (req) => { requests.push(req); return { requestId: req.requestId, sessionId: req.sessionId, ok: true, structuredOutput: outputs.shift(), usage: USAGE }; },
    cancel: async () => undefined,
  };
  return { bridge, requests };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function blank(): ProjectState {
  const p = blankProject();
  return { name: 'Nouveau projet', schematic: p.schematic, source: p.source, clockHz: p.clockHz };
}

// ------------------------------------------------------------------------------------------------ store races

describe('REVIEW copilot store: the student keeps using the app while the copilot thinks', () => {
  it('switching project during a request must not drop the answer (and its session) into the other project’s conversation', async () => {
    const app = createAppStore({ autosaveDelayMs: 0 });
    app.getState().newProject();
    const { bridge, requests, release } = slowBridge();
    const copilot = createCopilotStore({ app, storage: memory(), bridge: () => bridge, yieldToUi: () => Promise.resolve() });
    copilot.getState().setDraft('Fais le démultiplexeur');
    const sending = copilot.getState().send();
    await tick();
    expect(requests).toHaveLength(1);

    // While the CLI runs (≈ 25 s), the student opens a TP template from the picker.
    await app.getState().loadTemplate('tp-status');
    expect(copilot.getState().key).toBe('pic-studio.copilot.v1:template:tp-status');
    const statusSession = copilot.getState().conversation.sessionId;

    release(0, DEMUX_ANSWER);
    await sending;

    // Expected: tp-status's conversation is untouched. Actual: the demux proposal (a full schematic + code built for
    // the other project) appears in tp-status's chat with « Appliquer au projet », and tp-status's conversation now
    // points to the other project's CLI session (persisted under the tp-status key).
    expect(copilot.getState().messages.filter((m) => m.proposal)).toEqual([]);
    expect(copilot.getState().conversation.sessionId).toBe(statusSession);
  });

  it('« Nouvelle conversation » clicked during a request must really start a new CLI session', async () => {
    const app = createAppStore({ autosaveDelayMs: 0 });
    app.getState().newProject();
    const { bridge, requests, release } = slowBridge();
    const copilot = createCopilotStore({ app, storage: memory(), bridge: () => bridge, yieldToUi: () => Promise.resolve() });
    copilot.getState().setDraft('Bonjour');
    const sending = copilot.getState().send();
    await tick();
    const oldSession = requests[0].sessionId;

    // The header button is not disabled while busy (only the model switch is).
    copilot.getState().newConversation();
    const fresh = copilot.getState().conversation.sessionId;
    expect(fresh).not.toBe(oldSession);

    release(0, { reponse: 'Bonjour !' });
    await sending;
    // Actual: send() writes `conversation: out.state` back → the old session id (started: true) is restored and the
    // next message resumes the old CLI conversation; a stray « Demande annulée. » lands in the emptied chat.
    expect(copilot.getState().conversation.sessionId).toBe(fresh);
    expect(copilot.getState().messages).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ apply

describe('REVIEW apply: a partial proposal must not overwrite the other half with a stale copy', () => {
  it('a circuit-only proposal (card says « Code : inchangé ») keeps the code the student edited since sending', async () => {
    const app = createAppStore({ autosaveDelayMs: 0 });
    await app.getState().loadTemplate('tp0-exemple2');
    const circuit = { ...schematicToCircuit(app.getState().project.schematic).circuit };
    circuit.composants = circuit.composants.map((c) => (c.type === 'LED' ? { ...c, couleur: 'RED' } : c));
    const { bridge } = quickBridge([{ reponse: 'J’ai mis la LED en rouge.', circuit }]);
    const copilot = createCopilotStore({ app, storage: memory(), bridge: () => bridge, yieldToUi: () => Promise.resolve() });
    copilot.getState().setDraft('Mets la LED en rouge');
    await copilot.getState().send();
    const reply = copilot.getState().messages[1];
    expect(reply.proposal?.summary.codeChanged).toBe(false);

    // The student keeps working on the code, then applies the colour change.
    const edited = `${app.getState().project.source}\n// Ma note pour le compte rendu\n`;
    app.getState().setSource(edited);
    copilot.getState().apply(reply.id);

    // Actual: the code is silently reverted to the version captured when the request was sent.
    expect(app.getState().project.source).toBe(edited);
  });

  it('a code-only proposal keeps the schematic the student changed since sending', async () => {
    const app = createAppStore({ autosaveDelayMs: 0 });
    await app.getState().loadTemplate('tp0-exemple2');
    const { bridge } = quickBridge([{ reponse: 'Code inversé.', code: EXEMPLE2_ANSWER.code!.replace('LED = 1;\n        }\n        else {\n            LED = 0;', 'LED = 0;\n        }\n        else {\n            LED = 1;') }]);
    const copilot = createCopilotStore({ app, storage: memory(), bridge: () => bridge, yieldToUi: () => Promise.resolve() });
    copilot.getState().setDraft('Inverse la LED');
    await copilot.getState().send();
    const reply = copilot.getState().messages[1];
    expect(reply.proposal?.summary.circuitChanged).toBe(false);

    // The student moves the LED in the schematic, then applies the code change.
    app.getState().setSchematic((s) => ({ ...s, components: s.components.map((c) => (c.id === 'D1' ? { ...c, at: { x: c.at.x + 5, y: c.at.y } } : c)) }));
    const moved = app.getState().project.schematic;
    copilot.getState().apply(reply.id);
    expect(app.getState().project.schematic).toBe(moved);
  });

  it('applying the copilot’s own code (no prof-style model) must not leave the template’s old program model behind', async () => {
    const app = createAppStore({ autosaveDelayMs: 0 });
    await app.getState().loadTemplate('tp1-demux');
    const before = app.getState().project;
    expect(before.program).not.toBeNull();
    const source = 'void main() {\n    TRISB = 0x00;\n    while(1) {\n        PORTB = 0x0F;\n    }\n}\n';
    applyPayload(app, { schematic: before.schematic, source, program: null, clockHz: before.clockHz, fingerprint: '', latest: true });
    const after = app.getState().project;
    expect(after.source).toBe(source);
    // Actual: project.program is still the demux template's model, so « Comprendre » (Ce TP, walkthrough,
    // « Pourquoi ? ») explains the old demux program while the simulator runs the copilot's code, and the
    // Assistant offers to « régénérer » that old model over it.
    expect(after.program).toBeNull();
    expect(makeLearnContext(after, app.getState().build()).programOrigin).toBe('code');
  });
});

// ------------------------------------------------------------------------------------------------ verification

describe('REVIEW verification', () => {
  it('MCLR tied to VDD (the standard wiring; the system prompt lists MCLR as a U1 pin) is not a circuit error', async () => {
    const answer: CopilotAnswer = { ...EXEMPLE2_ANSWER, circuit: { ...EXEMPLE2, liaisons: [...EXEMPLE2.liaisons, { de: 'U1.MCLR', vers: 'VDD' }] } };
    const report = await verifyAnswer(answer, blank());
    // Actual: « U1.MCLR devrait être relié à VDD mais ne l'est pas sur le schéma. » (ROUTE) → ok = false → the
    // turn burns 2 automatic correction calls and the card still shows « Encore à corriger ».
    expect(report.problems.circuit).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('an input pin tied directly to GND is drawn (no ROUTE error)', async () => {
    const answer: CopilotAnswer = { ...EXEMPLE2_ANSWER, circuit: { ...EXEMPLE2, liaisons: [...EXEMPLE2.liaisons, { de: 'U1.RA4', vers: 'GND' }] } };
    const report = await verifyAnswer(answer, blank());
    expect(report.problems.circuit).toEqual([]);
  });

  it('a proposal with code but no tests is not reported as verified (the drawer promises « vérifiés en simulation »)', async () => {
    const { bridge, requests } = quickBridge([{ ...EXEMPLE2_ANSWER, tests: undefined }, EXEMPLE2_ANSWER]);
    const out = await runTurn({ request: 'LED + interrupteur', project: blank(), model: 'haiku' }, newConversation(), { bridge });
    // Actual: ok = true, no correction asks for the missing tests, and the card shows the green « Vérifiée » chip.
    expect(out.report?.ok === false || requests.length > 1).toBe(true);
  });

  it('a clarifying answer (questions) that also carries an empty "circuit" object does not trigger correction calls', async () => {
    const { bridge, requests } = quickBridge([
      { reponse: 'Il me manque des informations.', questions: ['Sur quelles broches sont les LEDs ?'], circuit: { horloge_mhz: 1, composants: [], liaisons: [] } },
      { reponse: 'Je ne peux pas sans les broches.', questions: ['Sur quelles broches ?'] },
      { reponse: 'idem' },
    ]);
    await runTurn({ request: 'Fais le TP des LEDs', project: blank(), model: 'haiku' }, newConversation(), { bridge });
    // Actual: hasProposal() is true for an empty circuit → « le circuit ne contient aucun composant » → a correction
    // call (subscription usage) to answer a question turn.
    expect(requests).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------------------------------ énoncé / CLI argv

const tmp = mkdtempSync(join(tmpdir(), 'pic-review-copilot-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('REVIEW énoncé text reaching the CLI argv', () => {
  it('a UTF-16 .txt énoncé (Windows Notepad « Unicode ») is decoded without NUL characters', async () => {
    const text = 'Démultiplexeur 1 vers 4 : L0 sur RA0, L1 sur RA1, LEDs sur RB0 à RB3.';
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes[0] = 0xff; bytes[1] = 0xfe;
    for (let i = 0; i < text.length; i++) { bytes[2 + 2 * i] = text.charCodeAt(i) & 0xff; bytes[3 + 2 * i] = text.charCodeAt(i) >> 8; }
    const e = await readEnonce('enonce.txt', bytes);
    expect(e.text).not.toContain('\u0000');
    expect(e.text).toContain('Démultiplexeur');
  });

  it('a NUL character in the prompt gives a French error (or is stripped), not Node’s English spawn exception', async () => {
    // Status probes are faked; the run itself goes through the REAL child_process.spawn of /usr/bin/true (never claude).
    const spawn: SpawnFn = (command, args, options) => {
      if (args[0] === '-p') return nodeSpawn('/usr/bin/true', [...args], options);
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill(): boolean };
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
      setTimeout(() => {
        child.stdout.end(args[0] === 'auth' ? JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) : '2.1.287 (Claude Code)\n');
        child.stderr.end();
        child.emit('close', 0);
      }, 1);
      return child as unknown as ReturnType<SpawnFn>;
    };
    const s = createCopilotService({ stagingRoot: join(tmp, 'staging'), home: '/Users/eleve', env: { PATH: '/usr/bin' }, cliPath: '/Users/eleve/.local/bin/claude', isExecutable: async () => true, spawn });
    const r = await s.run({
      requestId: 'r1', sessionId: '0b7e3f7a-8f7e-4b3e-9a51-2a0c5d6e7f80', resume: false, model: 'haiku', systemPrompt: 'x',
      jsonSchema: ANSWER_JSON_SCHEMA, prompt: "DEMANDE DE L'ÉTUDIANT :\nVoir l'énoncé\n\nÉNONCÉ :\nD\u0000é\u0000m\u0000u\u0000x",
    });
    expect(r.ok).toBe(false);
    // Actual: « Claude Code s’est arrêté de façon inattendue. (The argument 'args[1]' must be a string without null
    // bytes. Received 'DEMANDE DE L\'ÉTUDIANT…') » — wrong diagnosis, English, and it echoes the prompt.
    expect(r.error?.message).not.toMatch(/null bytes|argument/i);
  });
});

describe('REVIEW DOCX extraction', () => {
  it('text around a text box (nested w:p inside w:txbxContent) is kept', () => {
    const xml = '<w:document><w:body>'
      + '<w:p><w:r><w:t>Câbler la LED sur RB0</w:t></w:r>'
      + '<w:r><w:drawing><wps:txbx><w:txbxContent><w:p><w:r><w:t>Figure 1</w:t></w:r></w:p></w:txbxContent></wps:txbx></w:drawing></w:r>'
      + '<w:r><w:t> puis la tester.</w:t></w:r></w:p>'
      + '</w:body></w:document>';
    const text = docxXmlToText(xml);
    // Actual: the inner <w:p> resets the outer paragraph: « Câbler la LED sur RB0 » and « puis la tester. » are lost.
    expect(text).toContain('Câbler la LED sur RB0');
    expect(text).toContain('puis la tester.');
  });
});
