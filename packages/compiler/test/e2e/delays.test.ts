import { describe, expect, it } from 'vitest';
import { onEmulator } from './support';

// Delay_ms / Delay_us must take the requested time of SIMULATED time: cycles × 4 / Fosc.

function measure(src: string, clockHz: number): number {
  const { core } = onEmulator(src, { clockHz });
  // RB0 goes high just before the delay and low right after it.
  let guard = 0;
  while (core.getDrive('RB0') !== 1 && guard++ < 1000) core.step();
  const start = core.cycles;
  const limit = start + 50 * clockHz;
  while (core.getDrive('RB0') === 1 && core.cycles < limit) core.step();
  return ((core.cycles - start) * 4) / clockHz;
}

const pulse = (call: string) => `void main() {
    TRISB = 0x00;
    PORTB.F0 = 1;
    ${call};
    PORTB.F0 = 0;
}`;

describe('Delay_ms / Delay_us (boucles calibrées sur l’horloge du projet)', () => {
  it.each([1_000_000, 4_000_000, 8_000_000, 20_000_000])('Delay_ms(500) dure 500 ms ± 0,5 %% à %i Hz', (clockHz) => {
    const t = measure(pulse('Delay_ms(500)'), clockHz);
    expect(Math.abs(t - 0.5) / 0.5).toBeLessThan(0.005);
  });

  it.each([
    ['Delay_ms(1)', 1e-3, 1_000_000],
    ['Delay_ms(10)', 10e-3, 8_000_000],
    ['Delay_ms(1000)', 1, 1_000_000],
    ['Delay_ms(3000)', 3, 8_000_000],
    ['Delay_us(100)', 100e-6, 4_000_000],
    ['Delay_us(1000)', 1e-3, 1_000_000],
    ['delay_ms(250)', 0.25, 8_000_000],
  ] as const)('%s à %i Hz', (call, seconds, clockHz) => {
    const t = measure(pulse(call), clockHz);
    // The surrounding BSF/BCF add one or two cycles.
    const tolerance = Math.max(0.005 * seconds, (3 * 4) / clockHz);
    expect(Math.abs(t - seconds)).toBeLessThanOrEqual(tolerance);
  });

  it('Vdelay_ms(n) avec une variable dure environ n ms', () => {
    const src = `unsigned int n;
void main() {
    TRISB = 0x00;
    n = 200;
    PORTB.F0 = 1;
    Vdelay_ms(n);
    PORTB.F0 = 0;
}`;
    const t = measure(src, 1_000_000);
    expect(Math.abs(t - 0.2) / 0.2).toBeLessThan(0.02);
  });

  it('HI-TECH __delay_ms utilise _XTAL_FREQ', () => {
    const src = `#include <htc.h>
#define _XTAL_FREQ 8000000
void main() {
    TRISB = 0x00;
    RB0 = 1;
    __delay_ms(100);
    RB0 = 0;
}`;
    const t = measure(src, 8_000_000);
    expect(Math.abs(t - 0.1) / 0.1).toBeLessThan(0.005);
  });

  // MikroC: `void Delay_Cyc(char Cycles_div_by_10);` waits 10 × n instruction cycles, n = 3..255.
  it.each([3, 10, 100, 255])('Delay_Cyc(n) avec une variable n = %i dure 10·n cycles', (n) => {
    const src = `unsigned char n;
void main() {
    TRISB = 0x00;
    n = ${n};
    PORTB.F0 = 1;
    Delay_Cyc(n);
    PORTB.F0 = 0;
}`;
    // + 1 cycle: the BCF that ends the pulse.
    expect(measure(src, 4_000_000) * 1_000_000).toBeCloseTo(10 * n + 1, 6);
  });

  it('Delay_Cyc(25) avec une constante dure 250 cycles', () => {
    expect(measure(pulse('Delay_Cyc(25)'), 4_000_000) * 1_000_000).toBeCloseTo(251, 6);
  });
});
