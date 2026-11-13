import { describe, expect, it } from 'vitest';
import type { DebugSnapshot } from '../state/types';
import { diffSnapshots, EMPTY_BASELINE, NO_CHANGES, nextBaseline } from './diff';

function snap(patch: Partial<DebugSnapshot> = {}, file: Record<number, number> = {}): DebugSnapshot {
  const f = new Array<number>(256).fill(0);
  for (const [a, v] of Object.entries(file)) f[Number(a)] = v;
  return {
    pc: 0, w: 0, status: 0x18, file: f, stack: [], eeprom: new Array<number>(64).fill(0xff),
    cycles: 0, time: 0, sleeping: false, halted: false, interruptEntry: false, ...patch,
  };
}

describe('diffSnapshots', () => {
  it('reports nothing without a previous snapshot', () => {
    expect(diffSnapshots(null, snap())).toBe(NO_CHANGES);
    const s = snap();
    expect(diffSnapshots(s, s)).toBe(NO_CHANGES);
  });

  it('finds changed registers, W, PC, STATUS bits, EEPROM and stack', () => {
    const a = snap({ pc: 0x12, w: 6, status: 0x18 }, { 0x0c: 6, 0x0d: 6 });
    const b = snap({ pc: 0x13, w: 0, status: 0x1d, stack: [0x20], eeprom: [1, ...new Array<number>(63).fill(0xff)] }, { 0x0c: 6, 0x0d: 6, 0x0e: 0, 0x03: 0x1d });
    const d = diffSnapshots(a, b);
    expect([...d.file]).toEqual([0x03]);
    expect(d.w).toBe(true);
    expect(d.pc).toBe(true);
    expect(d.statusMask).toBe(0x05); // Z and C changed
    expect([...d.eeprom]).toEqual([0]);
    expect(d.stack).toBe(true);
  });

  it('detects a changed stack entry with the same depth', () => {
    expect(diffSnapshots(snap({ stack: [1] }), snap({ stack: [2] })).stack).toBe(true);
    expect(diffSnapshots(snap({ stack: [1] }), snap({ stack: [1] })).stack).toBe(false);
  });
});

describe('nextBaseline', () => {
  it('advances on each paused snapshot', () => {
    const s1 = snap({ pc: 1 });
    const s2 = snap({ pc: 2 });
    let b = nextBaseline(EMPTY_BASELINE, s1, 'paused');
    expect(b).toEqual({ base: null, cur: s1 });
    b = nextBaseline(b, s2, 'paused');
    expect(b).toEqual({ base: s1, cur: s2 });
    expect(nextBaseline(b, s2, 'paused')).toBe(b); // same snapshot: same object (safe during render)
  });

  it('freezes while running so the next pause compares with the last pause', () => {
    const s1 = snap({ pc: 1 });
    const running = snap({ pc: 50 });
    const hit = snap({ pc: 9 });
    let b = nextBaseline(EMPTY_BASELINE, s1, 'paused');
    const frozen = nextBaseline(b, running, 'running');
    expect(frozen).toBe(b);
    b = nextBaseline(frozen, hit, 'paused');
    expect(b).toEqual({ base: s1, cur: hit });
  });

  it('clears when stopped', () => {
    const b = nextBaseline(EMPTY_BASELINE, snap(), 'paused');
    expect(nextBaseline(b, null, 'stopped')).toBe(EMPTY_BASELINE);
    expect(nextBaseline(EMPTY_BASELINE, null, 'stopped')).toBe(EMPTY_BASELINE);
  });
});
