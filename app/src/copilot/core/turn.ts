// One student request, end to end: ask the CLI (through the bridge), verify the answer (circuit, compilation,
// prof-style rewrite, code/circuit consistency, simulated tests), and when something is wrong send up to two
// automatic correction turns (--resume) with a compact French report. Returns the best answer seen.
// Pure logic: the bridge is injected (a fake in the tests, window.picStudio.copilot in the Mac app).
import type { CopilotBridge, CopilotErrorKind, CopilotModel, CopilotRunResult } from '../../host/bridge';
import { fingerprint, uuid } from './ids';
import { buildCorrectionPrompt, buildUserPrompt, SYSTEM_PROMPT, type PromptEnonce, type PromptProject } from './prompt';
import { ANSWER_JSON_SCHEMA, hasProposal, readAnswer, type CopilotAnswer } from './schema';
import { addCall, emptyUsage, type TurnUsage } from './usage';
import { verifyAnswer, type ProjectState, type VerifyReport, type VerifyStep } from './verify';
import { isEmptySchematic, schematicToCircuit } from './circuit';

/** Automatic correction turns after the first answer. */
export const MAX_CORRECTIONS = 2;
export const DEFAULT_TIMEOUT_MS = 180_000;

export interface ConversationState {
  /** UUID of the CLI session (--session-id on the first turn, --resume after). */
  sessionId: string;
  /** The first turn went through: later turns resume the session. */
  started: boolean;
  /** Cumulative session cost after the last call (to compute per-request costs). */
  costBaseline: number;
  /** Fingerprint of the last proposal the student applied (the project is not re-sent while unchanged). */
  appliedFingerprint: string | null;
  /** That proposal was applied with its code rewritten in the prof's style (the copilot has not seen that text). */
  appliedRestyled?: boolean;
}

export const newConversation = (): ConversationState => ({ sessionId: uuid(), started: false, costBaseline: 0, appliedFingerprint: null });

export type TurnStage =
  | { step: 'reading' }
  | { step: 'thinking' }
  | { step: 'verify'; what: VerifyStep }
  | { step: 'correcting'; attempt: number; max: number };

export interface TurnInput {
  request: string;
  enonce?: PromptEnonce | null;
  project: ProjectState;
  model: CopilotModel;
  /** Short recap of the conversation, used only if a lost CLI session has to be restarted. */
  recap?: string;
}

export interface TurnDeps {
  bridge: CopilotBridge;
  onStage?(stage: TurnStage): void;
  /** Called with each CLI request id (the UI cancels through it). */
  onRequest?(requestId: string): void;
  isCancelled?(): boolean;
  yieldToUi?(): Promise<void>;
  timeoutMs?: number;
}

export interface TurnOutcome {
  state: ConversationState;
  /** Best answer (null on error before any answer). */
  answer: CopilotAnswer | null;
  /** Verification of `answer` when it proposes changes. */
  report: VerifyReport | null;
  /** Automatic corrections that were sent. */
  corrections: number;
  /** `answer` is the copilot's latest message (not an earlier, better attempt): it knows exactly this version. */
  latest: boolean;
  usage: TurnUsage;
  error?: { kind: CopilotErrorKind; message: string };
}

/** Fingerprint of a project as the copilot sees it (circuit connectivity + code). */
export function projectFingerprint(p: Pick<ProjectState, 'schematic' | 'source'>): string {
  return fingerprint(`${JSON.stringify(schematicToCircuit(p.schematic).circuit)}\n${p.source.replace(/\r\n?/g, '\n').trim()}`);
}

const MINIMAL_MAIN = /^\s*void\s+main\s*\(\s*\)\s*\{\s*\}\s*$/;

/** The project as the prompt carries it, or null when it is empty. */
export function promptProject(p: ProjectState): PromptProject | null {
  const emptyCode = MINIMAL_MAIN.test(p.source) || p.source.trim() === '';
  if (isEmptySchematic(p.schematic) && emptyCode) return null;
  const { circuit, autres } = schematicToCircuit(p.schematic);
  return { circuit, others: autres, code: p.source };
}

const LOST_SESSION = /no conversation found|session .*not found|could not find (a )?(conversation|session)/i;
/** --session-id refused because the CLI already has that session (a first turn killed before it answered). */
const SESSION_IN_USE = /déjà ouverte|already in use/i;
/** Failures that happen after the CLI started the turn. */
const REACHED_CLI: ReadonlySet<CopilotErrorKind> = new Set(['timeout', 'cancelled', 'schema']);

export async function runTurn(input: TurnInput, start: ConversationState, deps: TurnDeps): Promise<TurnOutcome> {
  let state: ConversationState = { ...start };
  let usage = emptyUsage();
  const cancelled = () => deps.isCancelled?.() === true;
  const cancelledError = { kind: 'cancelled' as const, message: 'Demande annulée.' };

  const call = async (prompt: string): Promise<CopilotRunResult> => {
    const requestId = uuid();
    deps.onRequest?.(requestId);
    const result = await deps.bridge.run({
      requestId,
      sessionId: state.sessionId,
      resume: state.started,
      prompt,
      systemPrompt: SYSTEM_PROMPT,
      jsonSchema: ANSWER_JSON_SCHEMA,
      model: input.model,
      maxTurns: 3,
      timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (result.usage) {
      const next = addCall(usage, result.usage, state.costBaseline);
      usage = next.total;
      state = { ...state, costBaseline: next.baseline };
    }
    // The session exists on the CLI side as soon as a call reached the model, even when it failed or was killed
    // before printing anything (timeout, cancel): later turns resume it. If the CLI had not created it after all,
    // the resume fails with « No conversation found » and a new session is started (LOST_SESSION below).
    if (result.ok || result.usage || (result.error && REACHED_CLI.has(result.error.kind))) state = { ...state, started: true };
    return result;
  };

  const current = input.project;
  const fp = projectFingerprint(current);
  const userPrompt = (recap?: string) => buildUserPrompt({
    request: input.request,
    enonce: input.enonce ?? null,
    project: promptProject(current),
    projectIsLastProposal: state.started && state.appliedFingerprint === fp,
    ...(state.appliedRestyled ? { appliedCode: current.source } : {}),
    ...(recap ? { recap } : {}),
  });

  deps.onStage?.({ step: 'thinking' });
  let result = await call(userPrompt());
  if (!result.ok && !state.started && result.error?.kind === 'process' && SESSION_IN_USE.test(result.error.message)) {
    // The CLI already has this session: resume it instead of creating it again.
    state = { ...state, started: true };
    result = await call(userPrompt());
  }
  if (!result.ok && state.started && result.error?.kind === 'process' && LOST_SESSION.test(result.error.message)) {
    // The CLI no longer knows this conversation (transcripts purged): start a new one with a recap.
    state = newConversation();
    result = await call(userPrompt(input.recap));
  }
  if (cancelled()) return { state, answer: null, report: null, corrections: 0, latest: true, usage, error: cancelledError };
  if (!result.ok) return { state, answer: null, report: null, corrections: 0, latest: true, usage, error: result.error ?? { kind: 'process', message: 'Le copilote n’a pas répondu.' } };

  let parsed = readAnswer(result.structuredOutput);
  if (!parsed) {
    return { state, answer: null, report: null, corrections: 0, latest: true, usage, error: { kind: 'schema', message: 'Le copilote a répondu dans un format inattendu. Réessayez (ou passez au modèle « Plus fiable »).' } };
  }
  if (!hasProposal(parsed.answer)) return { state, answer: parsed.answer, report: null, corrections: 0, latest: true, usage };

  const verify = (answer: CopilotAnswer, problems: string[]) => verifyAnswer(answer, current, {
    onStep: (what) => deps.onStage?.({ step: 'verify', what }),
    ...(deps.yieldToUi ? { yieldToUi: deps.yieldToUi } : {}),
    answerProblems: problems,
  });

  let best = { answer: parsed.answer, report: await verify(parsed.answer, parsed.problems) };
  let last = best;
  let corrections = 0;
  while (!last.report.ok && corrections < MAX_CORRECTIONS) {
    if (cancelled()) return { state, answer: best.answer, report: best.report, corrections, latest: best === last, usage, error: cancelledError };
    corrections++;
    deps.onStage?.({ step: 'correcting', attempt: corrections, max: MAX_CORRECTIONS });
    result = await call(buildCorrectionPrompt(last.report.problems, corrections, MAX_CORRECTIONS));
    if (cancelled()) return { state, answer: best.answer, report: best.report, corrections, latest: best === last, usage, error: cancelledError };
    if (!result.ok) {
      // Keep what we have; the correction failure is reported next to it.
      return { state, answer: best.answer, report: best.report, corrections, latest: best === last, usage, ...(result.error ? { error: result.error } : {}) };
    }
    parsed = readAnswer(result.structuredOutput);
    if (!parsed) break;
    if (!hasProposal(parsed.answer)) {
      // The copilot answered the report with questions or a remark instead of a fix: show them with the best proposal.
      const extra = parsed.answer;
      const text = [best.answer.reponse, extra.reponse].filter((t) => t && t.trim()).join('\n\n');
      return {
        state, report: best.report, corrections, latest: false, usage,
        answer: { ...best.answer, reponse: text, ...(extra.questions?.length ? { questions: extra.questions } : {}) },
      };
    }
    // A correction may only fix the code (or only the circuit): complete it with the previous proposal.
    const merged: CopilotAnswer = {
      ...parsed.answer,
      ...(parsed.answer.circuit ? {} : last.answer.circuit ? { circuit: last.answer.circuit } : {}),
      ...(parsed.answer.code ? {} : last.answer.code ? { code: last.answer.code } : {}),
      ...(parsed.answer.tests ? {} : last.answer.tests ? { tests: last.answer.tests } : {}),
    };
    last = { answer: merged, report: await verify(merged, parsed.problems) };
    if (last.report.score <= best.report.score) best = last;
  }
  return { state, answer: best.answer, report: best.report, corrections, latest: best === last, usage };
}
