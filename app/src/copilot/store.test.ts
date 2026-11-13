// The copilot drawer's store with a FAKE bridge and an in-memory storage: a request produces a verified proposal,
// « Appliquer au projet » replaces schematic + code through the app store, « Annuler l'application » restores the
// previous project exactly, conversations follow the project and are persisted (messages only).
import { describe, expect, it } from 'vitest';
import type { CopilotBridge, CopilotRunRequest, CopilotRunResult } from '../host/bridge';
import { createAppStore } from '../state/store';
import { DEMUX_ANSWER, EXEMPLE2_ANSWER } from './core/answers.fixtures';
import type { KeyValueStorage } from './core/messages';
import { createCopilotStore } from './store';

function memory(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); } };
}

function fakeBridge(outputs: unknown[]) {
  const requests: CopilotRunRequest[] = [];
  let cost = 0;
  const bridge: CopilotBridge = {
    status: async () => ({ available: true, loggedIn: true, cliVersion: '2.1.287', subscription: 'max' }),
    run: async (req): Promise<CopilotRunResult> => {
      requests.push(req);
      cost += 0.02;
      return {
        requestId: req.requestId, sessionId: req.sessionId, ok: true, structuredOutput: outputs.shift(),
        usage: { inputTokens: 10_000, outputTokens: 2_000, cacheReadTokens: 400, cacheCreationTokens: 0, sessionCostUsd: cost, model: 'claude-haiku-4-5-20251001', durationMs: 4000 },
      };
    },
    cancel: async () => undefined,
  };
  return { bridge, requests };
}

function setup(outputs: unknown[]) {
  const app = createAppStore({ autosaveDelayMs: 0 });
  app.getState().newProject();
  const storage = memory();
  const fake = fakeBridge(outputs);
  const copilot = createCopilotStore({ app, storage, bridge: () => fake.bridge, yieldToUi: () => Promise.resolve() });
  return { app, storage, copilot, ...fake };
}

describe('copilot store', () => {
  it('sends a request, shows a verified proposal, applies it and undoes it exactly', async () => {
    const { app, copilot, requests, storage } = setup([DEMUX_ANSWER]);
    await copilot.getState().refreshStatus();
    expect(copilot.getState().availability.kind).toBe('ready');
    const before = app.getState().project;

    copilot.getState().setDraft('Fais le démultiplexeur 1 vers 4');
    await copilot.getState().send();
    const s = copilot.getState();
    expect(s.busy).toBe(false);
    expect(requests).toHaveLength(1);
    expect(s.messages.map((m) => m.role)).toEqual(['student', 'copilot']);
    const reply = s.messages[1];
    expect(reply.proposal?.status).toBe('pending');
    expect(reply.proposal?.summary.tests.every((t) => t.passed)).toBe(true);
    expect(reply.usage?.tokens).toBe(12_400);
    expect(reply.usage?.costUsd).toBeCloseTo(0.02);
    // Nothing changes before « Appliquer ».
    expect(app.getState().project).toBe(before);

    copilot.getState().apply(reply.id);
    const applied = app.getState().project;
    expect(applied.schematic.components.some((c) => c.id === 'D3')).toBe(true);
    expect(applied.source).toContain('// Boucle principale');
    expect(applied.sourceOrigin).toBe('generated');
    expect(applied.program).not.toBeNull();
    expect(copilot.getState().messages[1].proposal?.status).toBe('applied');
    expect(copilot.getState().conversation.appliedFingerprint).not.toBeNull();

    copilot.getState().undoApply();
    const restored = app.getState().project;
    expect(restored.schematic).toEqual(before.schematic);
    expect(restored.source).toBe(before.source);
    expect(restored.program).toBe(before.program);
    expect(restored.sourceOrigin).toBe(before.sourceOrigin);
    expect(restored.clockHz).toBe(before.clockHz);
    expect(copilot.getState().messages[1].proposal?.status).toBe('undone');
    expect(copilot.getState().undo).toBeNull();

    // Persisted for this project, without usage figures.
    const raw = [...storage.data.entries()].find(([k]) => k.startsWith('pic-studio.copilot.v1:'));
    expect(raw?.[1]).toContain('Fais le démultiplexeur');
    expect(raw?.[1]).not.toContain('"usage"');
  });

  it('applies the clock of the circuit (8 MHz) and the follow-up mentions the applied proposal instead of re-sending it', async () => {
    const traffic = { ...EXEMPLE2_ANSWER, circuit: { ...EXEMPLE2_ANSWER.circuit!, horloge_mhz: 8 } };
    const { app, copilot, requests } = setup([traffic, { reponse: 'D’accord.' }]);
    copilot.getState().setDraft('LED + interrupteur à 8 MHz');
    await copilot.getState().send();
    copilot.getState().apply(copilot.getState().messages[1].id);
    expect(app.getState().project.clockHz).toBe(8_000_000);
    expect(app.getState().project.schematic.clockHz).toBe(8_000_000);
    copilot.getState().setDraft('Merci');
    await copilot.getState().send();
    expect(requests[1].resume).toBe(true);
    // The circuit is not re-sent; the code is, since it was rewritten in the prof's style (the copilot wrote another
    // text and the student will talk about the lines they see).
    expect(requests[1].prompt).toContain('PROJET ACTUEL : ta dernière proposition, appliquée ; son code a été réécrit dans le style du professeur');
    expect(requests[1].prompt).toContain(app.getState().project.source.trim());
    expect(requests[1].prompt).not.toContain('Circuit :');
  });

  it('a new proposal supersedes the one still waiting; ignore and new conversation work', async () => {
    const { copilot } = setup([EXEMPLE2_ANSWER, DEMUX_ANSWER]);
    copilot.getState().setDraft('a');
    await copilot.getState().send();
    copilot.getState().setDraft('b');
    await copilot.getState().send();
    const [, first, , second] = copilot.getState().messages;
    expect(first.proposal?.status).toBe('ignored');
    expect(second.proposal?.status).toBe('pending');
    copilot.getState().ignore(second.id);
    expect(copilot.getState().messages[3].proposal?.status).toBe('ignored');
    const session = copilot.getState().conversation.sessionId;
    copilot.getState().newConversation();
    expect(copilot.getState().messages).toEqual([]);
    expect(copilot.getState().conversation.sessionId).not.toBe(session);
  });

  it('keeps one conversation per project and starts afresh on « Nouveau projet »', async () => {
    const { app, copilot } = setup([{ reponse: 'Bonjour' }]);
    copilot.getState().setDraft('Bonjour');
    await copilot.getState().send();
    expect(copilot.getState().messages).toHaveLength(2);
    await app.getState().loadTemplate('tp1-demux');
    expect(copilot.getState().key).toBe('pic-studio.copilot.v1:template:tp1-demux');
    expect(copilot.getState().messages).toEqual([]);
    app.getState().newProject();
    expect(copilot.getState().key).toBe('pic-studio.copilot.v1:unsaved');
    // The unsaved project's earlier conversation was dropped with that project.
    expect(copilot.getState().messages).toEqual([]);
  });

  it('explains when there is no Mac app host, and does not send', async () => {
    const app = createAppStore({ autosaveDelayMs: 0 });
    const copilot = createCopilotStore({ app, storage: memory(), bridge: () => undefined });
    expect(copilot.getState().availability.kind).toBe('browser');
    copilot.getState().setDraft('test');
    await copilot.getState().send();
    expect(copilot.getState().messages).toEqual([]);
    expect(copilot.getState().notice).toMatch(/application Mac/);
  });

  it('turns a bridge failure into a French error message', async () => {
    const app = createAppStore({ autosaveDelayMs: 0 });
    const bridge: CopilotBridge = {
      status: async () => ({ available: true }),
      run: async (req) => ({ requestId: req.requestId, sessionId: req.sessionId, ok: false, error: { kind: 'usage-limit', message: 'Limite atteinte.' } }),
      cancel: async () => undefined,
    };
    const copilot = createCopilotStore({ app, storage: memory(), bridge: () => bridge, yieldToUi: () => Promise.resolve() });
    copilot.getState().setDraft('x');
    await copilot.getState().send();
    const reply = copilot.getState().messages[1];
    expect(reply.error).toEqual({ kind: 'usage-limit', message: 'Limite atteinte.' });
    expect(reply.proposal).toBeUndefined();
  });
});
