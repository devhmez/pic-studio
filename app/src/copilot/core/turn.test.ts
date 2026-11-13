// The request → answer → verification → automatic correction loop, with a FAKE bridge (never the real CLI).
import { describe, expect, it } from 'vitest';
import type { CopilotBridge, CopilotRunRequest, CopilotRunResult } from '../../host/bridge';
import { blankProject } from '../../state/store';
import { DEMUX_ANSWER, EXEMPLE2_ANSWER, EXEMPLE2_CODE } from './answers.fixtures';
import { EXEMPLE2 } from './fixtures';
import { SYSTEM_PROMPT } from './prompt';
import type { CopilotAnswer } from './schema';
import { MAX_CORRECTIONS, newConversation, projectFingerprint, runTurn, type TurnStage } from './turn';
import type { ProjectState } from './verify';

type Reply = Partial<CopilotRunResult> | ((req: CopilotRunRequest) => Partial<CopilotRunResult>);

/** Fake CLI: answers each run() with the next scripted reply; records the requests. */
function fakeBridge(replies: Reply[]) {
  const requests: CopilotRunRequest[] = [];
  let cost = 0;
  const bridge: CopilotBridge = {
    status: async () => ({ available: true, loggedIn: true, cliVersion: 'fake' }),
    run: async (req) => {
      requests.push(req);
      const next = replies.shift();
      if (!next) throw new Error('no scripted reply');
      const r = typeof next === 'function' ? next(req) : next;
      cost += 0.01;
      return {
        requestId: req.requestId,
        sessionId: req.sessionId,
        ok: true,
        usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000, cacheCreationTokens: 0, sessionCostUsd: cost, model: 'claude-haiku-4-5-20251001', durationMs: 1500 },
        ...r,
      };
    },
    cancel: async () => undefined,
  };
  return { bridge, requests };
}

const answer = (a: CopilotAnswer): Partial<CopilotRunResult> => ({ structuredOutput: a });

function blank(): ProjectState {
  const p = blankProject();
  return { name: 'Nouveau projet', schematic: p.schematic, source: p.source, clockHz: p.clockHz };
}

describe('runTurn', () => {
  it('first turn: new session with the system prompt and schema; a correct answer is verified without correction', async () => {
    const { bridge, requests } = fakeBridge([answer(EXEMPLE2_ANSWER)]);
    const stages: TurnStage[] = [];
    const start = newConversation();
    const out = await runTurn({ request: 'Une LED sur RA0 commandée par un interrupteur sur RB0', project: blank(), model: 'haiku' }, start, { bridge, onStage: (s) => stages.push(s) });
    expect(out.error).toBeUndefined();
    expect(out.corrections).toBe(0);
    expect(out.report?.ok).toBe(true);
    expect(out.report?.style).toBe('prof');
    expect(out.report?.tests.every((t) => t.passed)).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].resume).toBe(false);
    expect(requests[0].sessionId).toBe(start.sessionId);
    expect(requests[0].systemPrompt).toBe(SYSTEM_PROMPT);
    expect(requests[0].model).toBe('haiku');
    expect(requests[0].maxTurns).toBe(3);
    expect(requests[0].prompt).toContain('PROJET ACTUEL : vide');
    expect(out.state.started).toBe(true);
    expect(stages.map((s) => s.step)).toEqual(['thinking', 'verify', 'verify']);
    expect(out.usage.tokens).toBe(4200);
    expect(out.usage.costUsd).toBeCloseTo(0.01);
    expect(out.usage.calls).toBe(1);
  });

  it('sends one correction turn (--resume) with a French report when the code does not compile, and keeps the fix', async () => {
    const broken: CopilotAnswer = { ...EXEMPLE2_ANSWER, code: EXEMPLE2_CODE.replace('LED = 0;\n    // Boucle', 'LED = 0\n    // Boucle') };
    const { bridge, requests } = fakeBridge([answer(broken), answer(EXEMPLE2_ANSWER)]);
    const stages: TurnStage[] = [];
    const out = await runTurn({ request: 'LED + interrupteur', project: blank(), model: 'haiku' }, newConversation(), { bridge, onStage: (s) => stages.push(s) });
    expect(requests).toHaveLength(2);
    expect(requests[1].resume).toBe(true);
    expect(requests[1].sessionId).toBe(requests[0].sessionId);
    expect(requests[1].prompt).toMatch(/VÉRIFICATION AUTOMATIQUE/);
    expect(requests[1].prompt).toMatch(/Compilation MikroC :\n- ligne \d+/);
    expect(out.corrections).toBe(1);
    expect(out.report?.ok).toBe(true);
    expect(out.latest).toBe(true);
    expect(stages).toContainEqual({ step: 'correcting', attempt: 1, max: MAX_CORRECTIONS });
    // Per-request cost = difference of the cumulative totals: 2 calls × 0.01.
    expect(out.usage.costUsd).toBeCloseTo(0.02);
    expect(out.usage.calls).toBe(2);
  });

  it('stops after two corrections and keeps the best attempt with its remaining problems', async () => {
    const wrongTest: CopilotAnswer = {
      ...EXEMPLE2_ANSWER,
      tests: [{ description: 'LED allumée interrupteur à 0', actions: [{ ref: 'LS1', etat: 0 }, { attendre_ms: 10 }], attendu: [{ ref: 'D1', etat: 1 }] }],
    };
    const worse: CopilotAnswer = { ...EXEMPLE2_ANSWER, code: 'void main() { x = 1; }' };
    const { bridge, requests } = fakeBridge([answer(wrongTest), answer(worse), answer(wrongTest)]);
    const out = await runTurn({ request: 'LED', project: blank(), model: 'sonnet' }, newConversation(), { bridge });
    expect(requests).toHaveLength(1 + MAX_CORRECTIONS);
    expect(requests.every((r) => r.model === 'sonnet')).toBe(true);
    expect(out.corrections).toBe(MAX_CORRECTIONS);
    expect(out.report?.ok).toBe(false);
    expect(out.report?.problems.compile).toEqual([]);
    expect(out.report?.problems.tests[0]).toMatch(/LED allumée interrupteur à 0/);
    expect(requests[1].prompt).toMatch(/Tests en simulation :\n- « LED allumée interrupteur à 0 » : D1 : attendue allumée, obtenue éteinte/);
    expect(requests[2].prompt).toMatch(/Compilation MikroC/);
  });

  it('shows the questions the copilot asks instead of a correction, next to its best proposal', async () => {
    const wrong: CopilotAnswer = { ...EXEMPLE2_ANSWER, tests: [{ description: 'faux', actions: [{ ref: 'LS1', etat: 0 }, { attendre_ms: 5 }], attendu: [{ ref: 'D1', etat: 1 }] }] };
    const { bridge } = fakeBridge([answer(wrong), answer({ reponse: 'Le test me semble ambigu.', questions: ['La LED doit-elle s’allumer quand l’interrupteur est à 0 ?'] })]);
    const out = await runTurn({ request: 'LED', project: blank(), model: 'haiku' }, newConversation(), { bridge });
    expect(out.corrections).toBe(1);
    expect(out.report?.problems.tests).toHaveLength(1);
    expect(out.answer?.questions).toEqual(['La LED doit-elle s’allumer quand l’interrupteur est à 0 ?']);
    expect(out.answer?.reponse).toContain('Le test me semble ambigu.');
    expect(out.latest).toBe(false);
  });

  it('returns questions without verifying anything', async () => {
    const { bridge, requests } = fakeBridge([answer({ reponse: 'Il me manque des informations.', questions: ['Sur quelles broches sont les LEDs ?'] })]);
    const out = await runTurn({ request: 'fais le TP', project: blank(), model: 'haiku' }, newConversation(), { bridge });
    expect(requests).toHaveLength(1);
    expect(out.report).toBeNull();
    expect(out.answer?.questions).toEqual(['Sur quelles broches sont les LEDs ?']);
  });

  it('passes CLI errors through (not logged in, usage limit) and maps a missing structured answer to a schema error', async () => {
    for (const kind of ['not-logged-in', 'usage-limit'] as const) {
      const { bridge } = fakeBridge([{ ok: false, usage: undefined, error: { kind, message: 'x' } }]);
      const out = await runTurn({ request: 'a', project: blank(), model: 'haiku' }, newConversation(), { bridge });
      expect(out.error?.kind).toBe(kind);
      expect(out.state.started).toBe(false);
    }
    const { bridge } = fakeBridge([{ structuredOutput: undefined }]);
    const out = await runTurn({ request: 'a', project: blank(), model: 'haiku' }, newConversation(), { bridge });
    expect(out.error?.kind).toBe('schema');
  });

  it('restarts a lost CLI conversation with a recap', async () => {
    const lost: Reply = { ok: false, usage: undefined, error: { kind: 'process', message: 'No conversation found with session ID: 123' } };
    const { bridge, requests } = fakeBridge([lost, answer({ reponse: 'Bonjour !' })]);
    const start = { ...newConversation(), started: true };
    const out = await runTurn({ request: 'et maintenant ?', project: blank(), model: 'haiku', recap: 'Étudiant : bonjour' }, start, { bridge });
    expect(requests).toHaveLength(2);
    expect(requests[0].resume).toBe(true);
    expect(requests[1].resume).toBe(false);
    expect(requests[1].sessionId).not.toBe(start.sessionId);
    expect(requests[1].prompt).toContain('RÉSUMÉ DE LA CONVERSATION PRÉCÉDENTE');
    expect(out.state.sessionId).toBe(requests[1].sessionId);
    expect(out.answer?.reponse).toBe('Bonjour !');
  });

  it('sends the current project with follow-ups, or just a mention when it is the applied proposal', async () => {
    const project: ProjectState = { name: 'P', schematic: (await import('./circuit')).layoutCircuit(EXEMPLE2).schematic, source: EXEMPLE2_ANSWER.code!, clockHz: 1_000_000 };
    const { bridge, requests } = fakeBridge([answer({ reponse: 'ok' }), answer({ reponse: 'ok' })]);
    const conv = { ...newConversation(), started: true };
    await runTurn({ request: 'ajoute une LED sur RB1', project, model: 'haiku' }, conv, { bridge });
    expect(requests[0].prompt).toContain('PROJET ACTUEL :\nCircuit : {"horloge_mhz":1');
    expect(requests[0].prompt).toContain('#define BOUTON PORTB.RB0');
    await runTurn({ request: 'ajoute une LED sur RB1', project, model: 'haiku' }, { ...conv, appliedFingerprint: projectFingerprint(project) }, { bridge });
    expect(requests[1].prompt).toContain('PROJET ACTUEL : ta dernière proposition, appliquée telle quelle.');
    expect(requests[1].prompt).not.toContain('#define BOUTON');
  });

  it('includes the énoncé text and stops when cancelled', async () => {
    let cancelled = false;
    const { bridge, requests } = fakeBridge([() => { cancelled = true; return answer(DEMUX_ANSWER); }]);
    const out = await runTurn(
      { request: '', enonce: { name: 'demux.pdf', text: 'Démultiplexeur 1 vers 4 : L0 sur RA0, L1 sur RA1.' }, project: blank(), model: 'haiku' },
      newConversation(), { bridge, isCancelled: () => cancelled },
    );
    expect(requests[0].prompt).toContain('ÉNONCÉ (texte extrait de « demux.pdf » ; les figures ne sont pas lues) :\n<<<\nDémultiplexeur');
    expect(out.error?.kind).toBe('cancelled');
  });
});
