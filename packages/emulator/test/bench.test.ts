// Performance: run() must sustain at least 5 million instructions per second in Node.
import { describe, expect, it } from 'vitest';
import type { Pic16F84A } from '../src/index';
import { build } from './helpers';

const REQUIRED_IPS = 5_000_000;

/** Best-of-3 instructions per second for a loop of `oneCycle` 1-cycle instructions + GOTO. */
function measure(core: Pic16F84A, oneCycle: number): number {
  const instructionsPerCycle = (oneCycle + 1) / (oneCycle + 2);
  core.run(2_000_000); // warm-up (JIT)
  let best = 0;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const cycles = core.run(10_000_000);
    const seconds = (performance.now() - t0) / 1000;
    best = Math.max(best, (cycles * instructionsPerCycle) / seconds);
  }
  return best;
}

// Wall-clock benchmark: only meaningful on an idle machine, so it runs via `npm run bench`, not in the parallel suite.
describe.skipIf(!process.env.BENCH)('performance', () => {
  it(`run() executes at least ${REQUIRED_IPS / 1e6} M instructions/s (ALU + port loop)`, () => {
    const core = build(`
      BSF STATUS, RP0
      CLRF TRISB
      BCF STATUS, RP0
loop: MOVF 0x20, W
      ADDWF 0x21, F
      SUBWF 0x22, F
      INCF 0x23, F
      DECF 0x24, F
      RLF 0x25, F
      XORWF 0x26, F
      ANDLW 0x7F
      IORLW 0x01
      MOVWF PORTB
      BSF PORTB, 7
      BCF PORTB, 7
      BTFSC STATUS, Z
      NOP
      GOTO loop
    `);
    const ips = measure(core, 14);
    console.info(`PIC16F84A emulator: ${(ips / 1e6).toFixed(1)} M instructions/s`);
    expect(ips).toBeGreaterThan(REQUIRED_IPS);
  });

  it('keeps the rate with Timer0 interrupts and an IO listener', () => {
    const core = build(`
      GOTO main
      ORG 4
      BCF INTCON, T0IF
      INCF 0x30, F
      RETFIE
main: BSF STATUS, RP0
      MOVLW 0x88
      MOVWF OPTION_REG
      CLRF TRISB
      BCF STATUS, RP0
      MOVLW 0xA0
      MOVWF INTCON
loop: INCF PORTB, F
      NOP
      NOP
      NOP
      GOTO loop
    `);
    let changes = 0;
    core.onIoChange = () => changes++;
    const ips = measure(core, 4);
    console.info(`with interrupts + IO listener: ${(ips / 1e6).toFixed(1)} M instructions/s`);
    expect(changes).toBeGreaterThan(0);
    expect(core.peek(0x30)).toBeGreaterThan(0);
    expect(ips).toBeGreaterThan(REQUIRED_IPS);
  });
});
