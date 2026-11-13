// Records the debugger steps (the last 10) with their explanation, whichever control triggered them (toolbar,
// F7 / F8, the Assembleur panel or the « Pas à pas » tab). It watches the store: two consecutive paused debug
// snapshots of the same build make one step. Also keeps, per output pin, the last C line that wrote it, for the
// « Pourquoi ? » helper.
import type { ComponentVisual } from '@pic/circuit';
import type { CompileResultEx } from '@pic/compiler';
import type { PinName } from '@pic/program-model';
import { create } from 'zustand';
import { appStore, getApp } from '../state/store';
import type { AppState, DebugSnapshot } from '../state/types';
import { makeLearnContext } from './context';
import { explainStep, type StepExplanation } from './explain';

export const HISTORY_SIZE = 10;
/** A debug snapshot arriving this soon after a pause belongs to the pause, not to a step. */
const PAUSE_SNAPSHOT_MS = 300;

export interface StepEntry {
  id: number;
  build: CompileResultEx;
  prev: DebugSnapshot;
  cur: DebugSnapshot;
  partsBefore?: Readonly<Record<string, ComponentVisual>>;
  partsAfter?: Readonly<Record<string, ComponentVisual>>;
  explanation: StepExplanation;
}

export interface StepHistoryState {
  /** Most recent first. */
  entries: StepEntry[];
  lastWrites: ReadonlyMap<PinName, { line: number; value: 0 | 1 }>;
}

export const stepHistory = create<StepHistoryState>(() => ({ entries: [], lastWrites: new Map() }));

export function useStepHistory<T>(selector: (s: StepHistoryState) => T): T {
  return stepHistory(selector);
}

export function clearStepHistory(): void {
  stepHistory.setState({ entries: [], lastWrites: new Map() });
}

let nextId = 1;
let base: { debug: DebugSnapshot; parts?: Readonly<Record<string, ComponentVisual>> } | null = null;
let pausedAt = 0;
let wSource: string | undefined;

function buildOf(s: AppState): CompileResultEx | null {
  return s.sim.loadedBuild ?? (s.compile.result?.ok ? s.compile.result : null);
}

/** Turn two snapshots into a history entry (exported for tests). */
export function recordStep(prev: DebugSnapshot, cur: DebugSnapshot, build: CompileResultEx, partsBefore?: Readonly<Record<string, ComponentVisual>>, partsAfter?: Readonly<Record<string, ComponentVisual>>): StepEntry | null {
  if (!build.program) return null;
  const app = getApp();
  const ctx = makeLearnContext(app.project, build);
  let explanation: StepExplanation;
  try {
    explanation = explainStep({
      prev, cur, program: build.program, listing: build.listing, addrToLine: build.addrToLine,
      clockHz: app.project.clockHz, config: build.config, naming: ctx.naming,
      pinLabel: ctx.pinLabel, inputSource: ctx.inputSource, partName: ctx.partName,
      partsBefore, partsAfter, wSource,
    });
  } catch {
    return null;
  }
  wSource = explanation.wSource;
  const entry: StepEntry = { id: nextId++, build, prev, cur, partsBefore, partsAfter, explanation };
  stepHistory.setState((h) => {
    const lastWrites = new Map(h.lastWrites);
    if (explanation.kind === 'reset') lastWrites.clear();
    for (const w of explanation.pinWrites) lastWrites.set(w.pin as PinName, { line: w.line, value: w.value });
    const entries = explanation.kind === 'reset' ? [entry] : [entry, ...h.entries].slice(0, HISTORY_SIZE);
    return { entries, lastWrites };
  });
  return entry;
}

function onChange(s: AppState, prev: AppState): void {
  const sim = s.sim;
  if (sim.status === 'stopped') {
    base = null;
    wSource = undefined;
    if (stepHistory.getState().entries.length || stepHistory.getState().lastWrites.size) clearStepHistory();
    return;
  }
  if (sim.loadedBuild !== prev.sim.loadedBuild && prev.sim.loadedBuild !== null) {
    // Another program was loaded: earlier steps refer to other addresses.
    clearStepHistory();
    base = null;
    wSource = undefined;
  }
  if (prev.sim.status === 'running' && sim.status === 'paused') pausedAt = Date.now();
  if (sim.debug === prev.sim.debug || !sim.debug) return;
  const cur = sim.debug;
  const parts = sim.snapshot?.visuals;
  if (sim.status === 'running') {
    base = { debug: cur, parts };
    wSource = undefined;
    return;
  }
  const build = buildOf(s);
  if (!base || !build) {
    base = { debug: cur, parts };
    return;
  }
  const delta = cur.cycles - base.debug.cycles;
  if (pausedAt && Date.now() - pausedAt < PAUSE_SNAPSHOT_MS && delta > 2) {
    // The last snapshot of a run that was just paused: it becomes the starting point of the next step.
    pausedAt = 0;
    base = { debug: cur, parts };
    wSource = undefined;
    return;
  }
  pausedAt = 0;
  const before = base;
  base = { debug: cur, parts };
  recordStep(before.debug, cur, build, before.parts, parts);
}

let installed = false;

/**
 * Start recording (idempotent). Called when the learn module loads, i.e. the first time the drawer opens; from
 * then on steps are recorded even while the drawer is closed.
 */
export function installStepRecorder(): void {
  if (installed) return;
  installed = true;
  const s = appStore.getState();
  if (s.sim.status === 'paused' && s.sim.debug) base = { debug: s.sim.debug, parts: s.sim.snapshot?.visuals };
  appStore.subscribe(onChange);
}
