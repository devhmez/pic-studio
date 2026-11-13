// DS35007 §5.1: "If TMR0 register is written, the increment is inhibited for the following two
// instruction cycles." The write lands in Q4 of the write cycle (overriding that cycle's increment);
// the two *following* cycles produce no increment, so three reads after MOVWF TMR0 return the
// written value (mid-range reference manual Fig. 11-2: "reads NT0" ×3, then NT0+1, NT0+2).
// The spec also says: "inhibits increment for the next 2 cycles". The implementation counts the
// write cycle itself as one of the two (TMR0_WRITE_INHIBIT includes it), so only ONE cycle after
// the write is actually inhibited.
import { describe, expect, it } from 'vitest';
import { SFR } from '../../src/index';
import { build, steps } from '../helpers';

const T0IF = 0x04;

describe('TMR0 write inhibit (timer mode, no prescaler)', () => {
  it('the three instructions after MOVWF TMR0 read the written value, the fourth reads +1', () => {
    const core = build(`
      BSF STATUS, RP0
      MOVLW 0x88        ; PSA = 1: TMR0 increments every Tcy
      MOVWF OPTION_REG
      BCF STATUS, RP0
      MOVLW 0x40
      MOVWF TMR0        ; write cycle
      MOVF TMR0, W      ; inhibited cycle 1
      MOVF TMR0, W      ; inhibited cycle 2
      MOVF TMR0, W      ; increments resume at the end of this cycle
      MOVF TMR0, W
      MOVF TMR0, W
    `);
    steps(core, 6); // up to and including MOVWF TMR0
    const reads = Array.from({ length: 5 }, () => {
      core.step();
      return core.w;
    });
    expect(reads).toEqual([0x40, 0x40, 0x40, 0x41, 0x42]);
  });

  it('writing 0xFF: two cycles with no increment after the write, overflow at the end of the third', () => {
    const core = build(`
      BSF STATUS, RP0
      MOVLW 0x88
      MOVWF OPTION_REG
      BCF STATUS, RP0
      MOVLW 0xFF
      MOVWF TMR0
      NOP
      NOP
      NOP
      NOP
    `);
    steps(core, 6); // MOVWF TMR0 executed
    core.step(); // following cycle 1: inhibited
    core.step(); // following cycle 2: inhibited
    expect(core.peek(SFR.TMR0)).toBe(0xff);
    expect(core.peek(SFR.INTCON) & T0IF).toBe(0);
    core.step(); // first counted cycle: FF → 00
    expect(core.peek(SFR.TMR0)).toBe(0x00);
    expect(core.peek(SFR.INTCON) & T0IF).toBe(T0IF);
  });
});
