// Feeds the store's simulation state to the trace recorder for the « Rendu du TP », and remembers the last live
// snapshot so the export can still show the schematic as it was when the student stopped the simulation.
import type { Schematic, SessionSnapshot } from '@pic/circuit';
import { appStore } from '../state/store';
import type { AppState, SimStatus } from '../state/types';
import { TraceRecorder, type TraceLog } from './trace';

/** The last snapshot of a run, with what it was computed from. */
export interface LiveCapture {
  snapshot: SessionSnapshot;
  status: Exclude<SimStatus, 'stopped'>;
  /** Schematic and source of the project when the snapshot arrived (the capture is stale once they change). */
  schematic: Schematic;
  source: string;
}

/** A recorded run with the code it ran. */
export interface RecordedRun {
  log: TraceLog;
  source: string;
}

const recorder = new TraceRecorder();
let lastLive: LiveCapture | null = null;
let runSource = '';
let lastLog: TraceLog | null = null;
let unsubscribe: (() => void) | null = null;

function observe(state: AppState): void {
  const { sim, project } = state;
  recorder.observe(sim.status, sim.snapshot);
  const log = recorder.current();
  if (log !== lastLog) {
    // A new run (or a reset) started: remember the code it runs.
    lastLog = log;
    runSource = project.source;
  }
  if (sim.status !== 'stopped' && sim.snapshot && sim.snapshot !== lastLive?.snapshot) {
    lastLive = { snapshot: sim.snapshot, status: sim.status, schematic: project.schematic, source: project.source };
  } else if (sim.status !== 'stopped' && lastLive && lastLive.status !== sim.status) {
    lastLive = { ...lastLive, status: sim.status };
  }
}

/** Start recording (idempotent). Called once when the export menu module loads, i.e. at startup. */
export function startTraceRecording(): void {
  if (unsubscribe) return;
  observe(appStore.getState());
  unsubscribe = appStore.subscribe((state) => observe(state));
}

/** The current or last simulation run, or null when nothing ran since the app started. */
export function recordedRun(): RecordedRun | null {
  const log = recorder.current();
  return log ? { log, source: runSource } : null;
}

/** The last live snapshot (running, paused, or the moment the simulation was stopped). */
export function lastLiveCapture(): LiveCapture | null {
  return lastLive;
}

/** Forget everything (tests, new project). */
export function clearTrace(): void {
  recorder.clear();
  lastLive = null;
  lastLog = null;
  runSource = '';
}
