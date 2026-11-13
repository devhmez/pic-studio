// DS35007 §6 (INT pin interrupt timing figure): interrupt flags are "sampled here (every Q1)", i.e. at
// the Q1 of EVERY instruction cycle, and "the latency is the same for one or two cycle instructions".
// The core samples only at the first cycle of each instruction (pic16f84a.ts exec(): `sampled` is
// computed once before the instruction). A flag raised during the first cycle of a 2-cycle
// instruction (here a TMR0 overflow inside GOTO) is therefore missed at the second cycle's Q1:
// the NEXT main-line instruction executes before the ISR, the ISR starts 1 Tcy late (latency 4
// instead of 3 for a 1-cycle instruction), and the pushed return address is one word too far.
// This hits MikroC's `while(1)` / `GOTO $` loops with Timer0 interrupts.
import { describe, expect, it } from 'vitest';
import { SFR } from '../../src/index';
import { buildWithLabels } from '../helpers';

describe('interrupt sampling inside a 2-cycle instruction', () => {
  it('a TMR0 overflow in the first cycle of GOTO vectors right after the GOTO', () => {
    const { core, label } = buildWithLabels(`
      GOTO main
      ORG 4
isr:  GOTO $
main: GOTO target
      NOP
target:
      INCF 0x20, F      ; must not run before the ISR
      GOTO $
    `);
    core.step(); // GOTO main
    expect(core.pc).toBe(label('main'));
    // Debugger pokes: no TMR0 write inhibit, no prescaler (PSA = 1), GIE + T0IE.
    core.poke(SFR.OPTION_REG, 0x88);
    core.poke(SFR.INTCON, 0xa0);
    core.poke(SFR.TMR0, 0xff); // overflows on the first instruction cycle of GOTO target
    const start = core.cycles;

    let guard = 0;
    while (core.pc !== 0x0004 && guard++ < 10) core.step();

    expect(core.pc).toBe(0x0004);
    // Sampled at Q1 of GOTO's second cycle: GOTO completes, 2 dummy cycles, ISR → 4 Tcy after GOTO started.
    expect(core.cycles - start).toBe(4);
    expect(core.snapshot().stack).toEqual([label('target')]);
    expect(core.peek(0x20)).toBe(0);
  });
});
