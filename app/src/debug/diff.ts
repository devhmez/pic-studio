// "Changed since the last step" bookkeeping for the register view.
import type { DebugSnapshot, SimStatus } from '../state/types';

export interface SnapshotDiff {
  /** File-register addresses (0x00–0xFF) whose value changed. */
  file: Set<number>;
  /** EEPROM byte indexes that changed. */
  eeprom: Set<number>;
  w: boolean;
  pc: boolean;
  /** XOR of the two STATUS values (bit set = flag changed). */
  statusMask: number;
  stack: boolean;
}

export const NO_CHANGES: SnapshotDiff = Object.freeze({
  file: new Set<number>(),
  eeprom: new Set<number>(),
  w: false,
  pc: false,
  statusMask: 0,
  stack: false,
}) as SnapshotDiff;

/** Compare two snapshots. Without a previous snapshot nothing counts as changed. */
export function diffSnapshots(prev: DebugSnapshot | null, cur: DebugSnapshot | null): SnapshotDiff {
  if (!prev || !cur || prev === cur) return NO_CHANGES;
  const file = new Set<number>();
  const n = Math.max(prev.file.length, cur.file.length);
  for (let a = 0; a < n; a++) if ((prev.file[a] ?? 0) !== (cur.file[a] ?? 0)) file.add(a);
  const eeprom = new Set<number>();
  const m = Math.max(prev.eeprom.length, cur.eeprom.length);
  for (let i = 0; i < m; i++) if ((prev.eeprom[i] ?? 0xff) !== (cur.eeprom[i] ?? 0xff)) eeprom.add(i);
  const stack = prev.stack.length !== cur.stack.length || prev.stack.some((v, i) => v !== cur.stack[i]);
  return {
    file,
    eeprom,
    w: prev.w !== cur.w,
    pc: prev.pc !== cur.pc,
    statusMask: (prev.status ^ cur.status) & 0xff,
    stack,
  };
}

/** The two snapshots being compared: the one shown and the one from the previous pause/step. */
export interface Baseline {
  base: DebugSnapshot | null;
  cur: DebugSnapshot | null;
}

export const EMPTY_BASELINE: Baseline = { base: null, cur: null };

/**
 * Advance the baseline when a new snapshot arrives. While running, snapshots stream ~10×/s: the baseline is frozen
 * so that, at the next pause or breakpoint, changes are shown relative to where the user last looked. Stopping clears it.
 * Returns the same object when nothing needs to change (safe to call during render).
 */
export function nextBaseline(prev: Baseline, debug: DebugSnapshot | null, status: SimStatus): Baseline {
  if (status === 'stopped') return prev.base === null && prev.cur === null ? prev : EMPTY_BASELINE;
  if (status === 'running') return prev;
  if (debug === prev.cur) return prev;
  return { base: prev.cur, cur: debug };
}
