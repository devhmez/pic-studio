// Storing the assistant's edits: every change regenerates the C in the prof's style (code panel and organigramme
// follow), with a small undo / redo history that survives closing the drawer.
import type { Program } from '@pic/program-model';
import { generate } from '@pic/style-c';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { notify } from '../shell/toast';
import { getApp, useApp } from '../state/store';
import { asProgram, finalizeProgram } from './model';

interface Entry {
  before: Program;
  after: Program;
}

interface History {
  past: Entry[];
  future: Entry[];
}

const LIMIT = 60;

export const historyStore = createStore<History>(() => ({ past: [], future: [] }));

/** Undo / redo availability for the current program (a history left by another project does not count). */
export function useHistory(): { canUndo: boolean; canRedo: boolean } {
  const stored = useApp((s) => s.project.program);
  const lastAfter = useStore(historyStore, (h) => h.past[h.past.length - 1]?.after ?? null);
  const nextBefore = useStore(historyStore, (h) => h.future[h.future.length - 1]?.before ?? null);
  return { canUndo: lastAfter !== null && lastAfter === stored, canRedo: nextBefore !== null && nextBefore === stored };
}

function clearHistory(): void {
  historyStore.setState({ past: [], future: [] });
}

/** Generate the code for `program` and store both. Returns the stored program, or null if generation failed. */
function store(program: Program): Program | null {
  const app = getApp();
  const fin = finalizeProgram(program, app.project.clockHz);
  let source: string;
  try {
    source = generate(fin);
  } catch (e) {
    notify(`Le code n’a pas pu être écrit : ${e instanceof Error ? e.message : String(e)}`, 'error');
    return null;
  }
  app.setProgram(fin, source);
  return fin;
}

/** Apply an assistant edit (recorded for « Annuler »). */
export function commitProgram(next: Program): boolean {
  const before = asProgram(getApp().project.program);
  if (before === next) return true;
  const after = store(next);
  if (!after) return false;
  if (before) {
    const { past } = historyStore.getState();
    historyStore.setState({ past: [...past.slice(-(LIMIT - 1)), { before, after }], future: [] });
  } else {
    clearHistory();
  }
  return true;
}

/** Replace the program without history (new model from the schematic or from the code). */
export function resetProgram(next: Program): boolean {
  clearHistory();
  return store(next) !== null;
}

/** The history only applies while the stored program is the one it produced (another project clears it). */
function inSync(entry: Entry | undefined): entry is Entry {
  return !!entry && getApp().project.program === entry.after;
}

export function undo(): void {
  const { past, future } = historyStore.getState();
  const top = past[past.length - 1];
  if (!inSync(top)) {
    clearHistory();
    return;
  }
  const restored = store(top.before);
  if (!restored) return;
  historyStore.setState({ past: past.slice(0, -1), future: [...future, { before: restored, after: top.after }] });
}

export function redo(): void {
  const { past, future } = historyStore.getState();
  const top = future[future.length - 1];
  if (!top || getApp().project.program !== top.before) {
    if (top) clearHistory();
    return;
  }
  const after = store(top.after);
  if (!after) return;
  historyStore.setState({ past: [...past, { before: top.before, after }], future: future.slice(0, -1) });
}
