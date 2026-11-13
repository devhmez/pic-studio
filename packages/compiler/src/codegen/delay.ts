import type { Emitter } from './emitter';
import type { FileRef } from './ir';

/**
 * Cycle-exact busy waits made of nested DECFSZ/GOTO loops sharing one loop label (the classic MikroC/MPASM shape):
 *
 *       MOVLW a_k / MOVWF r_k   ... MOVLW a_1 / MOVWF r_1
 *   L:  DECFSZ r_1,F / GOTO L / DECFSZ r_2,F / GOTO L / ... / DECFSZ r_k,F / GOTO L
 *
 * A counter loaded with 0 counts 256. With D_k = a_k and D_i = a_i + 256·(D_(i+1) − 1), the loop takes
 *   2k + Σ (3·D_i − z_i) cycles, where z_i = D_(i+1) for i < k and z_k = 1.
 * The remainder (0..few cycles) is padded with `GOTO $+1` (2 cycles) and NOP (1 cycle).
 */

export interface LoopPlan {
  counts: number[]; // a_1..a_k, each 1..256
  pad: number;
}

/** Cycles taken by a k-level loop with the given counts (setup included, padding excluded). */
export function loopCycles(counts: readonly number[]): number {
  const k = counts.length;
  const D: number[] = new Array(k);
  D[k - 1] = counts[k - 1];
  for (let i = k - 2; i >= 0; i--) D[i] = counts[i] + 256 * (D[i + 1] - 1);
  let total = 2 * k;
  for (let i = 0; i < k; i++) total += 3 * D[i] - (i < k - 1 ? D[i + 1] : 1);
  return total;
}

const MAX_PAD = 6;

/** Best plan for exactly `n` cycles using up to three nested counters, or null if `n` is too large. */
export function planLoop(n: number): LoopPlan | null {
  if (n <= MAX_PAD + 3) return { counts: [], pad: n };
  let best: LoopPlan | null = null;
  const consider = (counts: number[]) => {
    const pad = n - loopCycles(counts);
    if (pad < 0) return;
    if (!best || pad < best.pad) best = { counts, pad };
  };
  // Solve the innermost counter a_1 directly: cycles grow by exactly 3 per unit of a_1.
  const solveInner = (outer: number[]) => {
    const base = loopCycles([1, ...outer]);
    const a1 = Math.max(1, Math.min(256, 1 + Math.floor((n - base) / 3)));
    consider([a1, ...outer]);
  };
  solveInner([]);
  if (best && (best as LoopPlan).pad <= MAX_PAD) return best;
  for (let a2 = 1; a2 <= 256; a2++) {
    if (loopCycles([1, a2]) > n) break;
    solveInner([a2]);
    if (best && (best as LoopPlan).pad <= 2) return best;
  }
  if (best && (best as LoopPlan).pad <= MAX_PAD) return best;
  for (let a3 = 1; a3 <= 256; a3++) {
    if (loopCycles([1, 1, a3]) > n) break;
    if (loopCycles([256, 256, a3]) + MAX_PAD < n) continue;
    for (let a2 = 1; a2 <= 256; a2++) {
      if (loopCycles([1, a2, a3]) > n) break;
      solveInner([a2, a3]);
      if (best && (best as LoopPlan).pad <= 2) return best;
    }
  }
  return best && (best as LoopPlan).pad <= MAX_PAD ? best : null;
}

const MAX_THREE_LEVEL = loopCycles([256, 256, 256]);

/** Emit a busy wait of exactly `n` instruction cycles. `counters` must provide 4 scratch bytes. */
export function emitDelayCycles(em: Emitter, n: number, counters: FileRef[]): void {
  n = Math.max(0, Math.round(n));
  if (n === 0) return;
  em.bank0();
  if (n <= MAX_THREE_LEVEL) {
    const plan = planLoop(n);
    if (plan) {
      emitPlan(em, plan, counters);
      return;
    }
  }
  // Outer counter around a three-level loop: total = 2 + m·(c + 3) − 1 + pad.
  const m = Math.min(256, Math.ceil((n - 1) / (MAX_THREE_LEVEL + 3)));
  const inner = Math.floor((n - 1) / m) - 3;
  const rest = n - 1 - m * (inner + 3);
  const outer = counters[3];
  em.movlw(m & 0xff);
  em.movwf(outer);
  const loop = em.newLabel();
  em.label(loop);
  emitDelayCycles(em, inner, counters.slice(0, 3));
  em.file('DECFSZ', outer, 1);
  em.goto(loop);
  emitDelayCycles(em, rest, counters);
}

function emitPlan(em: Emitter, plan: LoopPlan, counters: FileRef[]): void {
  const k = plan.counts.length;
  if (k > 0) {
    for (let i = k - 1; i >= 0; i--) {
      em.movlw(plan.counts[i] & 0xff);
      em.movwf(counters[i]);
    }
    const loop = em.newLabel();
    em.label(loop);
    for (let i = 0; i < k; i++) {
      em.file('DECFSZ', counters[i], 1);
      em.goto(loop);
    }
  }
  emitPad(em, plan.pad);
}

export function emitPad(em: Emitter, cycles: number): void {
  for (let i = 0; i < Math.floor(cycles / 2); i++) em.goto({ rel: 1 });
  if (cycles % 2) em.none('NOP');
}

/** Instruction cycles for a delay in microseconds at the given oscillator frequency (Tcy = 4 / Fosc). */
export function cyclesForMicroseconds(us: number, clockHz: number): number {
  return Math.round((us * clockHz) / 4_000_000);
}
