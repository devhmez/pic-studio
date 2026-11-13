// TP « Feu tricolore » (Ch4) at 8 MHz in the prof's DSN circuit, with fixtures/traffic.c:
// RA0/RA1/RA2 → TRAFFIC LIGHTS R/A/G; RB0..RB3 → 7SEG-BCD; POWER → TORCH_LDR → RA3 → 1k → GND.
// The sensor is read once per pass of the main loop (after a night blink or a full day cycle).
import { describe, expect, it } from 'vitest';
import type { SimSession } from '@pic/circuit';
import { SLICE_S, fixture, lamps, runUntil, sevenSeg, startTp } from './support';

const LONG = { timeout: 60_000 };
const DARK = 0; // LDR 1 MΩ: RA3 ≈ 5 mV → 0, mode nuit
const DIM = 7; //  LDR 2 kΩ: RA3 ≈ 1.67 V, still below the 2.0 V TTL threshold → 0
const BRIGHT = 9; // LDR 500 Ω: RA3 ≈ 3.33 V → 1, mode jour

interface Segment { start: number; duration: number; lamps: string; seg: number | null }

/**
 * Runs until `until` in worker slices and returns the successive (lamps, display) states with their durations
 * (10 ms resolution). `events` are interactions applied when the clock reaches their time.
 */
function record(session: SimSession, until: number, events: [number, () => void][] = []): Segment[] {
  const out: Segment[] = [];
  const pending = [...events].sort((a, b) => a[0] - b[0]);
  const sample = () => {
    const state = { lamps: lamps(session, 'TL1'), seg: sevenSeg(session, 'SEG1') };
    const last = out[out.length - 1];
    if (!last || last.lamps !== state.lamps || last.seg !== state.seg) out.push({ start: session.time, duration: 0, ...state });
  };
  // No sample at t = 0: PORTB is still all inputs there, so the display reads undefined.
  while (session.time < until - 1e-9) {
    while (pending.length > 0 && pending[0][0] <= session.time + 1e-9) pending.shift()![1]();
    session.runFor(SLICE_S);
    sample();
  }
  out.forEach((s, i) => { s.duration = (out[i + 1]?.start ?? session.time) - s.start; });
  return out;
}

const state = (s: Segment) => `${s.lamps} ${s.seg}`;
const night = ['-A- 10', '--- 10'];
const dayCycle = [
  ...[9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((n) => `R-- ${n}`),
  ...[2, 1, 0].map((n) => `-A- ${n}`),
  ...[9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((n) => `--G ${n}`),
];

describe('TP feu tricolore (8 MHz)', () => {
  it('compiles for the template clock without diagnostics', () => {
    const { compiled, schematic } = startTp('tp-traffic', fixture('traffic.c'));
    expect(schematic.clockHz).toBe(8_000_000);
    expect(compiled.diagnostics).toEqual([]);
  });

  it('night, then a full day cycle (rouge 9→0, orange 2→0, vert 9→0, 1 s per step), then night again', LONG, () => {
    const { session } = startTp('tp-traffic', fixture('traffic.c'));
    expect(session.snapshot().visuals.LDR1).toEqual({ kind: 'TORCH_LDR', level: DARK });
    const segments = record(session, 26, [
      [1.9, () => session.interact('LDR1', { type: 'setLevel', level: BRIGHT })], // seen at the loop top, t ≈ 2 s
      [20.5, () => session.interact('LDR1', { type: 'setLevel', level: DARK })], // seen after the cycle, t ≈ 25 s
    ]);

    expect(segments.map(state)).toEqual([...night, ...night, ...dayCycle, ...night]);
    // Night: the orange lamp blinks 0,5 s on / 0,5 s off.
    for (const s of [...segments.slice(0, 4), segments[27]]) expect(s.duration).toBeCloseTo(0.5, 1);
    // Day: each displayed value stays 1 s.
    for (const s of segments.slice(4, 27)) expect(Math.abs(s.duration - 1)).toBeLessThanOrEqual(0.015);
    expect(segments[4].start).toBeCloseTo(2, 1);
    expect(segments[27].start).toBeCloseTo(25, 1);
  });

  it('dim light (TORCH_LDR level 7) still reads as night through the 1k divider; level 9 switches to day', LONG, () => {
    const { session } = startTp('tp-traffic', fixture('traffic.c'));
    runUntil(session, 0.1);
    session.interact('LDR1', { type: 'setLevel', level: DIM });
    runUntil(session, 1.25);
    expect([lamps(session, 'TL1'), sevenSeg(session, 'SEG1')]).toEqual(['-A-', 0x0a]);
    session.interact('LDR1', { type: 'setLevel', level: BRIGHT });
    runUntil(session, 2.5);
    expect([lamps(session, 'TL1'), sevenSeg(session, 'SEG1')]).toEqual(['R--', 9]);
  });
});

// The prof's own correction posted with the TP (traffic2A12.c): same circuit, but each step lasts 500 ms, the display
// counts UP (PORTB = i, 0..9 / 0..2 / 0..9) and each colour first waits 500 ms showing the previous digit. Simulated
// as written, like Proteus would.
describe('traffic2A12.c (correction du prof)', () => {
  it('compiles for 8 MHz without diagnostics', () => {
    const { compiled } = startTp('tp-traffic', fixture('traffic2A12.c'));
    expect(compiled.diagnostics).toEqual([]);
  });

  it('day: red counts 0..9, orange 0..2, green 0..9, 500 ms per step; night: orange blinks and "A" is shown', LONG, () => {
    const { session } = startTp('tp-traffic', fixture('traffic2A12.c'));
    session.interact('LDR1', { type: 'setLevel', level: BRIGHT });
    const at = (t: number) => { runUntil(session, t); return [lamps(session, 'TL1'), sevenSeg(session, 'SEG1')]; };
    expect(at(0.25)).toEqual(['R--', 0]);
    expect(at(1.75)).toEqual(['R--', 2]);
    expect(at(5.25)).toEqual(['R--', 9]);
    expect(at(6.75)).toEqual(['-A-', 1]);
    expect(at(8.25)).toEqual(['--G', 0]);
    expect(at(12.75)).toEqual(['--G', 9]);
    session.interact('LDR1', { type: 'setLevel', level: DARK });
    expect(at(13.25)).toEqual(['-A-', 0x0a]);
    expect(at(13.75)).toEqual(['---', 0x0a]);
  });
});
