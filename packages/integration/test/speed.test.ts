// Simulated time vs wall-clock time, in the UI worker's 10 ms slices (best of 3 after a warm-up).
// The UI needs at least real time: 1 simulated second per wall-clock second.
import { describe, expect, it } from 'vitest';
import type { SimSession } from '@pic/circuit';
import { SLICE_S, fixture, startTp } from './support';

function speed(session: SimSession, simulatedSeconds: number): number {
  let best = 0;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const start = session.time;
    while (session.time - start < simulatedSeconds) session.runFor(SLICE_S);
    const wall = (performance.now() - t0) / 1000;
    best = Math.max(best, (session.time - start) / wall);
  }
  return best;
}

function report(label: string, ratio: number, clockHz: number): void {
  const ips = (ratio * clockHz) / 4;
  console.info(`${label}: ${ratio.toFixed(1)}× temps réel (${(ips / 1e6).toFixed(1)} M cycles/s)`);
}

// Wall-clock benchmark: only meaningful on an idle machine, so it runs via `npm run bench`, not in the parallel suite.
describe.skipIf(!process.env.BENCH)('vitesse de simulation', () => {
  it('tp-traffic at 8 MHz (day cycle, Delay_ms loops) runs faster than real time', { timeout: 60_000 }, () => {
    const { session, schematic } = startTp('tp-traffic', fixture('traffic.c'));
    session.interact('LDR1', { type: 'setLevel', level: 9 });
    session.runFor(1); // warm-up (JIT)
    const ratio = speed(session, 4);
    report('tp-traffic 8 MHz', ratio, schematic.clockHz);
    expect(ratio).toBeGreaterThan(1);
  });

  it('tp-status at 1 MHz (outputs toggled every few cycles: one circuit solve per change) keeps up with real time', { timeout: 60_000 }, () => {
    const { session, schematic } = startTp('tp-status', fixture('status.c'));
    session.runFor(0.2);
    const ratio = speed(session, 1);
    report('tp-status 1 MHz', ratio, schematic.clockHz);
    expect(ratio).toBeGreaterThan(1);
  });
});
