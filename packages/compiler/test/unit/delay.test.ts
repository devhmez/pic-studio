import { describe, expect, it } from 'vitest';
import { loopCycles, planLoop } from '../../src/codegen/delay';
import { addrOfLine, onMiniSim, runToAddr } from '../support/harness';

/** Brute-force execution of the shared-label DECFSZ/GOTO loop (setup included). */
function simulateLoop(counts: number[]): number {
  const r = counts.map((c) => c & 0xff);
  let cycles = 2 * counts.length;
  let i = 0;
  for (;;) {
    r[i] = (r[i] - 1) & 0xff;
    if (r[i] !== 0) {
      cycles += 3; // DECFSZ + GOTO L
      i = 0;
      continue;
    }
    cycles += 2; // DECFSZ skips
    i++;
    if (i === counts.length) return cycles;
  }
}

describe('boucles de temporisation', () => {
  it('la formule fermée correspond à l’exécution pas à pas', () => {
    for (const counts of [[1], [2], [256], [5, 1], [1, 2], [3, 7], [256, 2], [10, 3, 2], [1, 1, 2], [200, 5, 3]]) {
      expect(loopCycles(counts), counts.join(',')).toBe(simulateLoop(counts));
    }
  });

  it('un plan exact existe pour toutes les durées jusqu’à 50 millions de cycles', () => {
    const ns = [0, 1, 2, 9, 10, 11, 100, 767, 768, 769, 770, 771, 772, 773, 774, 1000, 65535, 125_000, 196_609, 1_000_000, 4_999_999, 50_000_000];
    for (let n = 0; n < 3000; n += 7) ns.push(n);
    for (const n of ns) {
      const plan = planLoop(n);
      expect(plan, `n = ${n}`).not.toBeNull();
      const total = (plan!.counts.length ? loopCycles(plan!.counts) : 0) + plan!.pad;
      expect(total, `n = ${n}`).toBe(n);
      expect(plan!.pad).toBeLessThanOrEqual(9);
    }
  });

  it.each([0, 1, 2, 3, 4, 5, 9, 10, 11, 12, 13, 50, 100, 767, 770, 772, 1000, 5000, 65535, 200_000])(
    'Delay_us(%i) à 4 MHz prend exactement ce nombre de cycles',
    (n) => {
      const src = `void main() {\n    TRISB = 0x00;\n    PORTB.F0 = 1;\n    Delay_us(${n});\n    PORTB.F0 = 0;\n}`;
      const { r, sim } = onMiniSim(src, { clockHz: 4_000_000 });
      const bsf = r.listing.find((l) => l.text === 'BSF PORTB, 0')!.addr!;
      runToAddr(sim, bsf + 1);
      const bcf = addrOfLine(r, 'PORTB.F0 = 0;');
      const spent = n === 0 ? 0 : runToAddr(sim, bcf);
      expect(sim.pc).toBe(bcf);
      expect(spent).toBe(n);
    },
  );
});
