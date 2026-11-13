// State of the « Copilote » drawer (zustand): the conversation of the open project, the request in progress, the
// attached énoncé, and the last application (so it can be undone). The request logic lives in ./core (pure, tested);
// this file wires it to the app store, window.picStudio.copilot and localStorage.
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { Schematic } from '@pic/circuit';
import { generate } from '@pic/style-c';
import { asProgram, finalizeProgram } from '../assistant/model';
import { getHost, type CopilotBridge, type CopilotModel, type CopilotStatus } from '../host/bridge';
import { appStore } from '../state/store';
import type { AppStore, Project } from '../state/types';
import { uuid } from './core/ids';
import {
  conversationKey, loadConversation, recapOf, saveConversation, summarize, toStored,
  type ChatError, type ChatMessage, type KeyValueStorage, type ProposalPayload,
} from './core/messages';
import { newConversation, projectFingerprint, runTurn, type ConversationState, type TurnOutcome, type TurnStage } from './core/turn';
import type { ProjectState } from './core/verify';
import { readEnonce, type LoadedEnonce } from './enonce';

export type Availability =
  | { kind: 'checking' }
  /** No window.picStudio: the browser dev build. */
  | { kind: 'browser' }
  | { kind: 'ready'; status: CopilotStatus }
  | { kind: 'unavailable'; status: CopilotStatus };

export interface ProjectSnapshot {
  schematic: Schematic;
  source: string;
  program: unknown | null;
  sourceOrigin: Project['sourceOrigin'];
  clockHz: number;
}

export interface CopilotState {
  key: string;
  conversation: ConversationState;
  model: CopilotModel;
  messages: ChatMessage[];
  draft: string;
  enonce: LoadedEnonce | null;
  /** Name of the file being read. */
  enonceLoading: string | null;
  /** Message about the énoncé (could not be read...). */
  notice: string | null;
  busy: boolean;
  stage: TurnStage | null;
  availability: Availability;
  /** The last application, until it is undone or another one happens. */
  undo: { messageId: string; snapshot: ProjectSnapshot; fingerprint: string } | null;
  /** CLI session of the request in progress (it may belong to another project's conversation, or be abandoned). */
  requestSession: string | null;
}

export interface CopilotActions {
  refreshStatus(force?: boolean): Promise<void>;
  setDraft(text: string): void;
  setModel(model: CopilotModel): void;
  attachFile(name: string, bytes: Uint8Array): Promise<void>;
  setEnonceText(text: string): void;
  removeEnonce(): void;
  dismissNotice(): void;
  send(): Promise<void>;
  cancel(): void;
  apply(messageId: string): void;
  ignore(messageId: string): void;
  undoApply(): void;
  newConversation(): void;
  /** Follow the open project (another file / template → its own conversation). */
  syncProject(): void;
}

export type CopilotStore = CopilotState & CopilotActions;

export interface CopilotDeps {
  app: StoreApi<AppStore>;
  storage: KeyValueStorage | null;
  bridge(): CopilotBridge | undefined;
  now?(): number;
  /** Let the UI paint between verification steps. */
  yieldToUi?(): Promise<void>;
}

const PREFS_KEY = 'pic-studio.copilot.prefs.v1';
const SAVE_DELAY_MS = 300;

/** French help shown with an error, by kind. */
export function errorHelp(kind: ChatError['kind']): string | null {
  switch (kind) {
    case 'not-installed':
    case 'not-logged-in':
      return 'Après avoir réglé le problème, cliquez sur « Réessayer » en haut du copilote.';
    case 'usage-limit':
      return 'Votre projet n’a pas été modifié. Vous pouvez continuer à utiliser l’Assistant et les modèles de TP en attendant.';
    case 'schema':
      return 'Reformulez la demande, ou choisissez « Plus fiable (Sonnet) » en haut du copilote.';
    default:
      return null;
  }
}

function projectState(p: Project): ProjectState {
  return { name: p.name, schematic: p.schematic, source: p.source, clockHz: p.clockHz, config: p.config };
}

function keyOf(app: AppStore): string {
  return conversationKey({ fileName: app.fileName, ...(app.project.templateId ? { templateId: app.project.templateId } : {}) });
}

const normalize = (s: string) => s.replace(/\r\n?/g, '\n').trim();

/**
 * Put a proposal in the project through the store actions (schematic, clock, program or source). Only the halves the
 * answer proposes are replaced: a circuit-only proposal keeps the student's current code, a code-only one their
 * current schematic.
 */
export function applyPayload(app: StoreApi<AppStore>, p: ProposalPayload): void {
  const a = app.getState();
  if (a.sim.status !== 'stopped') a.stop();
  if (p.circuit !== false) {
    a.setSchematic(p.schematic);
    if (app.getState().project.clockHz !== p.clockHz) app.getState().setClock(p.clockHz);
  }
  if (p.code === false) return;
  const clockHz = app.getState().project.clockHz;
  const program = p.program ? asProgram(p.program) : null;
  if (program) {
    const fin = finalizeProgram(program, clockHz);
    let generated: string | null = null;
    try {
      generated = generate(fin);
    } catch {
      generated = null;
    }
    if (generated !== null && normalize(generated) === normalize(p.source)) {
      app.getState().setProgram(fin, generated);
      return;
    }
  }
  // The copilot's own code: the previous program model (template, Assistant) no longer describes it — « Comprendre »
  // and the Assistant must work from this code, so the model is dropped and the code counts as hand-written.
  app.getState().setProgram(null, p.source);
  app.setState((st) => ({ project: { ...st.project, sourceOrigin: 'manual' } }));
}

/** The conversation after a turn: the CLI side from the turn, what the student did meanwhile (apply) kept. */
function mergeConversation(current: ConversationState, out: ConversationState): ConversationState {
  const same = out.sessionId === current.sessionId;
  return { ...out, appliedFingerprint: same ? current.appliedFingerprint : null, appliedRestyled: same && current.appliedRestyled === true };
}

/** Messages with a new reply (a new proposal supersedes the older ones still waiting). */
function withReply(messages: readonly ChatMessage[], reply: ChatMessage): ChatMessage[] {
  return [...messages.map((m) => (reply.proposal && m.proposal?.status === 'pending' ? { ...m, proposal: { ...m.proposal, status: 'ignored' as const } } : m)), reply];
}

/** Put the project back as it was before an application. */
export function restoreSnapshot(app: StoreApi<AppStore>, s: ProjectSnapshot): void {
  const a = app.getState();
  if (a.sim.status !== 'stopped') a.stop();
  a.setSchematic(s.schematic);
  if (app.getState().project.clockHz !== s.clockHz) app.getState().setClock(s.clockHz);
  app.getState().setProgram(s.program, s.source);
  if (s.sourceOrigin === 'manual') app.setState((st) => ({ project: { ...st.project, sourceOrigin: 'manual' } }));
}

function snapshotOf(p: Project): ProjectSnapshot {
  return { schematic: p.schematic, source: p.source, program: p.program, sourceOrigin: p.sourceOrigin, clockHz: p.clockHz };
}

function readPrefs(storage: KeyValueStorage | null): CopilotModel {
  try {
    const v = storage?.getItem(PREFS_KEY);
    return v && (JSON.parse(v) as { model?: string }).model === 'sonnet' ? 'sonnet' : 'haiku';
  } catch {
    return 'haiku';
  }
}

/** The copilot message for a turn's outcome (`project`: the project as it was sent). */
export function replyFor(out: TurnOutcome, project: ProjectState, now: number): ChatMessage {
  const msg: ChatMessage = { id: uuid(), role: 'copilot', text: '', at: now, usage: out.usage };
  if (out.usage.calls === 0) delete msg.usage;
  if (out.corrections > 0) msg.corrections = out.corrections;
  if (out.answer) {
    msg.text = out.answer.reponse || (out.report ? 'Voici ma proposition.' : '');
    if (out.answer.questions?.length) msg.questions = out.answer.questions;
  }
  if (out.report) {
    const r = out.report;
    msg.proposal = {
      summary: summarize(r, project),
      status: 'pending',
      payload: {
        schematic: r.schematic, source: r.source, program: r.program, clockHz: r.clockHz,
        fingerprint: projectFingerprint({ schematic: r.schematic, source: r.source }), latest: out.latest,
        circuit: r.schematicFromAnswer, code: r.sourceFromAnswer, base: projectFingerprint(project),
      },
    };
  }
  if (out.error) msg.error = { kind: out.error.kind, message: out.error.message };
  if (!msg.text && !msg.error && !msg.proposal) msg.text = 'Je n’ai rien à proposer pour cette demande.';
  return msg;
}

export function createCopilotStore(deps: CopilotDeps): StoreApi<CopilotStore> {
  const now = deps.now ?? (() => Date.now());
  const yieldToUi = deps.yieldToUi ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
  let cancelled = false;
  let currentRequest: string | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The request in progress and the conversation it belongs to. The CLI takes 10–30 s: meanwhile the student may open
   * another project (the answer then goes to the conversation it was asked in) or start a new conversation (the
   * answer is dropped).
   */
  let inFlight: { key: string; sessionId: string; abandoned: boolean } | null = null;

  const initialKey = keyOf(deps.app.getState());
  const stored = loadConversation(deps.storage, initialKey);

  const store = createStore<CopilotStore>()((set, get) => {
    const saveNow = () => {
      if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
      const s = get();
      saveConversation(deps.storage, s.key, toStored(s.conversation, s.model, s.messages, now()));
    };
    const scheduleSave = () => {
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
    };
    const updateMessage = (id: string, fn: (m: ChatMessage) => ChatMessage) => {
      set((s) => ({ messages: s.messages.map((m) => (m.id === id ? fn(m) : m)) }));
    };

    return {
      key: initialKey,
      conversation: stored?.conversation ?? newConversation(),
      model: readPrefs(deps.storage),
      messages: stored?.messages ?? [],
      draft: '',
      enonce: null,
      enonceLoading: null,
      notice: null,
      busy: false,
      stage: null,
      availability: deps.bridge() ? { kind: 'checking' } : { kind: 'browser' },
      undo: null,
      requestSession: null,

      async refreshStatus(force = false) {
        const bridge = deps.bridge();
        if (!bridge) { set({ availability: { kind: 'browser' } }); return; }
        if (force) set({ availability: { kind: 'checking' } });
        try {
          const status = await bridge.status();
          set({ availability: status.available ? { kind: 'ready', status } : { kind: 'unavailable', status } });
        } catch (e) {
          set({ availability: { kind: 'unavailable', status: { available: false, error: `Le copilote ne répond pas (${e instanceof Error ? e.message : String(e)}).` } } });
        }
      },

      setDraft(text) { set({ draft: text }); },

      setModel(model) {
        set({ model });
        try { deps.storage?.setItem(PREFS_KEY, JSON.stringify({ model })); } catch { /* preference only */ }
        scheduleSave();
      },

      async attachFile(name, bytes) {
        set({ enonceLoading: name, notice: null });
        try {
          const enonce = await readEnonce(name, bytes);
          set({ enonce, enonceLoading: null });
        } catch (e) {
          set({ enonceLoading: null, notice: e instanceof Error ? e.message : String(e) });
        }
      },

      setEnonceText(text) {
        const e = get().enonce;
        if (e) set({ enonce: { ...e, text } });
      },

      removeEnonce() { set({ enonce: null }); },
      dismissNotice() { set({ notice: null }); },

      async send() {
        const s = get();
        if (s.busy) return;
        const request = s.draft.trim();
        const enonce = s.enonce && s.enonce.text.trim() ? s.enonce : null;
        if (!request && !enonce) return;
        const bridge = deps.bridge();
        if (!bridge) {
          set({ notice: 'Le copilote fonctionne dans l’application Mac PIC Studio (pas dans le navigateur).' });
          return;
        }
        const project = projectState(deps.app.getState().project);
        const student: ChatMessage = {
          id: uuid(), role: 'student', at: now(),
          text: request || `Voici l’énoncé « ${enonce!.name} ».`,
          ...(enonce ? { attachment: { name: enonce.name, chars: enonce.text.length, truncated: enonce.truncated } } : {}),
        };
        const recap = recapOf(s.messages);
        cancelled = false;
        currentRequest = null;
        const ticket = { key: s.key, sessionId: s.conversation.sessionId, abandoned: false };
        inFlight = ticket;
        set({ messages: [...s.messages, student], draft: '', enonce: null, notice: null, busy: true, stage: { step: 'thinking' }, requestSession: ticket.sessionId });
        scheduleSave();
        let out: TurnOutcome;
        try {
          out = await runTurn(
            { request, enonce: enonce ? { name: enonce.name, text: enonce.text } : null, project, model: s.model, recap },
            get().conversation,
            {
              bridge,
              onStage: (stage) => { if (!ticket.abandoned) set({ stage }); },
              onRequest: (id) => { currentRequest = id; },
              isCancelled: () => cancelled,
              yieldToUi,
            },
          );
        } catch (e) {
          out = {
            state: get().conversation, answer: null, report: null, corrections: 0, latest: true,
            usage: { tokens: 0, costUsd: 0, durationMs: 0, calls: 0 },
            error: { kind: 'process', message: `Le copilote ne répond pas (${e instanceof Error ? e.message : String(e)}).` },
          };
        }
        currentRequest = null;
        inFlight = null;
        const reply = replyFor(out, project, now());
        const cur = get();
        if (ticket.abandoned) {
          // « Nouvelle conversation » during the request: the answer belongs to the conversation that was cleared.
          set({ busy: false, stage: null, requestSession: null });
          return;
        }
        if (cur.conversation.sessionId === ticket.sessionId) {
          set((st) => ({ conversation: mergeConversation(st.conversation, out.state), messages: withReply(st.messages, reply), busy: false, stage: null, requestSession: null }));
          if (out.error?.kind === 'not-logged-in' || out.error?.kind === 'not-installed') void get().refreshStatus(true);
          saveNow();
          return;
        }
        // Another project is open now: file the answer in the conversation it was asked in (saved when the student
        // switched), never in this one.
        const stored = loadConversation(deps.storage, ticket.key);
        if (stored && stored.conversation.sessionId === ticket.sessionId) {
          saveConversation(deps.storage, ticket.key, toStored(mergeConversation(stored.conversation, out.state), stored.model, withReply(stored.messages, reply), now()));
        }
        set({
          busy: false, stage: null, requestSession: null,
          notice: out.error?.kind === 'cancelled' ? null : 'La réponse à votre demande précédente est arrivée : elle est rangée dans la conversation du projet d’où vous l’avez envoyée.',
        });
      },

      cancel() {
        if (!get().busy) return;
        cancelled = true;
        const bridge = deps.bridge();
        if (bridge && currentRequest) void bridge.cancel(currentRequest);
      },

      apply(messageId) {
        const msg = get().messages.find((m) => m.id === messageId);
        const payload = msg?.proposal?.payload;
        if (!msg?.proposal || !payload || msg.proposal.status !== 'pending') return;
        const snapshot = snapshotOf(deps.app.getState().project);
        applyPayload(deps.app, payload);
        const applied = projectFingerprint(deps.app.getState().project);
        // The next request says « ta dernière proposition » instead of re-sending the project only when the project
        // is exactly that proposal (not when the half it left alone changed since); after the prof-style rewrite the
        // code is sent along, since the copilot wrote another text.
        const asProposed = payload.latest && applied === payload.fingerprint;
        set((s) => ({
          conversation: { ...s.conversation, appliedFingerprint: asProposed ? applied : null, appliedRestyled: asProposed && !!payload.program },
          undo: { messageId, snapshot, fingerprint: applied },
        }));
        updateMessage(messageId, (m) => ({ ...m, proposal: { ...m.proposal!, status: 'applied' } }));
        saveNow();
      },

      ignore(messageId) {
        updateMessage(messageId, (m) => (m.proposal?.status === 'pending' ? { ...m, proposal: { ...m.proposal, status: 'ignored' } } : m));
        saveNow();
      },

      undoApply() {
        const u = get().undo;
        if (!u) return;
        restoreSnapshot(deps.app, u.snapshot);
        set((s) => ({ undo: null, conversation: { ...s.conversation, appliedFingerprint: null, appliedRestyled: false } }));
        updateMessage(u.messageId, (m) => (m.proposal ? { ...m, proposal: { ...m.proposal, status: 'undone' } } : m));
        saveNow();
      },

      newConversation() {
        // A request of this conversation still running is cancelled and its answer dropped (a request filed for
        // another project's conversation goes on).
        if (get().busy && inFlight && inFlight.sessionId === get().conversation.sessionId) {
          inFlight.abandoned = true;
          get().cancel();
        }
        set({ conversation: newConversation(), messages: [], undo: null, notice: null });
        saveNow();
      },

      syncProject() {
        const key = keyOf(deps.app.getState());
        const s = get();
        if (key === s.key) return;
        saveNow();
        const next = loadConversation(deps.storage, key);
        set({
          key,
          conversation: next?.conversation ?? newConversation(),
          messages: next?.messages ?? [],
          undo: null,
          notice: null,
        });
      },
    };
  });

  // Follow the project: another file / template brings its own conversation; a new (unsaved) project starts a new
  // one; saving an unsaved project for the first time keeps the conversation under the file's name.
  deps.app.subscribe((state, prev) => {
    const replaced = state.project !== prev.project && !state.dirty && state.project.schematic !== prev.project.schematic;
    const newKey = keyOf(state);
    const c = store.getState();
    if (newKey !== c.key && !replaced && state.project === prev.project && prev.fileName === null && state.fileName !== null) {
      // First save: move the conversation to the file.
      const old = c.key;
      store.setState({ key: newKey });
      if (inFlight?.key === old) inFlight.key = newKey;
      saveConversation(deps.storage, newKey, toStored(c.conversation, c.model, c.messages, now()));
      try { deps.storage?.removeItem(old); } catch { /* ignore */ }
      return;
    }
    if (replaced && !state.fileName && !state.project.templateId) {
      // « Nouveau projet »: a fresh conversation (the earlier unsaved project is gone).
      store.getState().syncProject();
      store.getState().newConversation();
      return;
    }
    if (newKey !== c.key) store.getState().syncProject();
  });

  return store;
}

function browserStorage(): KeyValueStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** The app's copilot store. */
export const copilotStore: StoreApi<CopilotStore> = createCopilotStore({
  app: appStore,
  storage: browserStorage(),
  bridge: () => getHost()?.copilot,
});

export function useCopilot<T>(selector: (s: CopilotStore) => T): T {
  return useStore(copilotStore, selector);
}

export function getCopilot(): CopilotStore {
  return copilotStore.getState();
}
