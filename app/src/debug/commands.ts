// Debugger commands and their keyboard shortcuts, shared by the toolbar, the Code and Assembleur panels and the
// shell's global shortcuts (captured on window). handleDebugKey() is the fallback when the panels are hosted
// without that shell; it ignores events another handler already consumed (defaultPrevented).
//
// Keys: F5 run / continue, ⇧F5 stop, F6 pause, F8 (or F10) next C line, F7 (or F11) next instruction, F9 breakpoint.
// F7 / F8 are MikroC's « Step Into » / « Step Over » keys; on a Mac they are fn+F7 / fn+F8. F11 is kept as an
// alias, but macOS gives it to « Afficher le bureau » by default, so it is never the one advertised.
import { appStore, getApp } from '../state/store';
import { notify } from '../shell/toast';

export interface DebugShortcut {
  /** KeyboardEvent.key values that trigger the command (the first one is advertised). */
  keys: readonly string[];
  /** Label shown in tooltips. */
  label: string;
}

export const SHORTCUTS = {
  run: { keys: ['F5'], label: 'F5' },
  pause: { keys: ['F6'], label: 'F6' },
  stepLine: { keys: ['F8', 'F10'], label: 'F8' },
  stepInstruction: { keys: ['F7', 'F11'], label: 'F7' },
  breakpoint: { keys: ['F9'], label: 'F9' },
} as const satisfies Record<string, DebugShortcut>;

// ------------------------------------------------------------------------------------------------ reload guard

/** Asks the student a yes / no question; replaceable in tests and by the Electron shell. */
export type ConfirmFn = (message: string) => boolean;

const browserConfirm: ConfirmFn = (message) =>
  typeof window === 'undefined' || typeof window.confirm !== 'function' ? true : window.confirm(message);
let confirmFn: ConfirmFn = browserConfirm;

/** Replace the confirmation dialog (null restores the default). */
export function setConfirmHandler(fn: ConfirmFn | null): void {
  confirmFn = fn ?? browserConfirm;
}

export const RELOAD_QUESTION = 'Le code a changé depuis le lancement de la simulation.\n\n'
  + 'Charger le nouveau programme ? La simulation repartira du début : temps, RAM et sorties remis à zéro.\n'
  + '(Annuler : rien ne change, la simulation reste en pause.)';

/**
 * Before a run or a step: when the simulator still holds an older program than the code (a real change, not a
 * comment), ask before reloading it, since the reload restarts the simulation from a power-on reset.
 * Returns false when the student declines.
 */
export function confirmReloadIfOutdated(): boolean {
  const app = getApp();
  if (app.sim.status === 'stopped') return true;
  // The auto-build may not have run yet after the last keystroke.
  if (app.compile.stale) app.build();
  const s = getApp();
  // A failed build is reported by the store itself (« corrigez les erreurs »).
  if (!s.compile.result?.ok || !appStore.isProgramOutdated(s)) return true;
  if (!confirmFn(RELOAD_QUESTION)) return false;
  notify('Nouveau programme chargé : la simulation repart du début.', 'info');
  return true;
}

// ------------------------------------------------------------------------------------------------ commands

export function run(): void {
  if (getApp().sim.status === 'running') return;
  if (confirmReloadIfOutdated()) getApp().run();
}

/** Continue when paused or stopped, pause when running. */
export function continueOrPause(): void {
  if (getApp().sim.status === 'running') getApp().pause();
  else run();
}

export function stepInstruction(): void {
  if (confirmReloadIfOutdated()) getApp().stepInstruction();
}

export function stepLine(): void {
  if (confirmReloadIfOutdated()) getApp().stepLine();
}

interface KeyLike {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

const has = (s: DebugShortcut, key: string): boolean => s.keys.includes(key);

/**
 * Run the debugger command bound to a function key (no ⌘ / Ctrl / ⌥). Returns true when the key is one of them.
 * Shared by the shell's global shortcuts and handleDebugKey().
 */
export function runDebugKey(e: Pick<KeyLike, 'key' | 'shiftKey'>): boolean {
  const { key } = e;
  if (has(SHORTCUTS.run, key)) {
    if (e.shiftKey) getApp().stop();
    else run();
  } else if (has(SHORTCUTS.pause, key)) getApp().pause();
  else if (has(SHORTCUTS.stepLine, key)) stepLine();
  else if (has(SHORTCUTS.stepInstruction, key)) stepInstruction();
  else return false;
  return true;
}

/** Handle the debugger keys on a panel's keydown when nothing upstream did. Returns true when consumed. */
export function handleDebugKey(e: KeyLike): boolean {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (!runDebugKey(e)) return false;
  e.preventDefault();
  return true;
}
