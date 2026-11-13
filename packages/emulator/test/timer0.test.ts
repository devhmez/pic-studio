import { describe, expect, it } from 'vitest';
import { SFR } from '../src/index';
import type { Pic16F84A } from '../src/index';
import { build, steps } from './helpers';

const T0IF = 0x04;

/** Configure OPTION_REG, then write `tmr0` into TMR0 at address 5. The rest of flash is ADDLW 0xFF (1 cycle each). */
function timerProgram(option: number, tmr0 = 0): Pic16F84A {
  const core = build(`
      BSF STATUS, RP0
      MOVLW ${option}
      MOVWF OPTION_REG
      BCF STATUS, RP0
      MOVLW ${tmr0}
      MOVWF TMR0        ; 5
  `);
  steps(core, 5); // up to and excluding the TMR0 write
  return core;
}

describe('Timer0, timer mode (T0CS = 0)', () => {
  // DS35007 §5.1: no increment in "the following two instruction cycles" after a write (the write
  // cycle's own increment is overridden too); DS33023 TMR0 timing figure: "reads NT0" three times.
  it('the three instructions after MOVWF TMR0 read the written value, then +1 per cycle', () => {
    const core = build(`
      BSF STATUS, RP0
      MOVLW 0x88        ; PSA = 1 (no prescaler for TMR0)
      MOVWF OPTION_REG
      BCF STATUS, RP0
      MOVLW 0x40
      MOVWF TMR0
      MOVF TMR0, W
      MOVF TMR0, W
      MOVF TMR0, W
      MOVF TMR0, W
      MOVF TMR0, W
    `);
    steps(core, 6);
    const reads = Array.from({ length: 5 }, () => {
      core.step();
      return core.w;
    });
    expect(reads).toEqual([0x40, 0x40, 0x40, 0x41, 0x42]);
  });

  it.each([
    ['1:1 (PSA = 1)', 0x88, 1],
    ['1:2', 0x80, 2],
    ['1:4', 0x81, 4],
    ['1:8', 0x82, 8],
    ['1:16', 0x83, 16],
    ['1:256', 0x87, 256],
  ])('increments at rate %s', (_label, option, ratio) => {
    const core = timerProgram(option);
    let k = 0;
    for (let m = 0; m < 900; m++) {
      k += core.step().cycles;
      // The write cycle and the two following ones do not count (prescaler included).
      const expected = Math.floor(Math.max(0, k - 3) / ratio) & 0xff;
      expect(core.peek(SFR.TMR0)).toBe(expected);
    }
  });

  it('overflow FF → 00 sets T0IF', () => {
    const core = timerProgram(0x88, 0xfe);
    core.step(); // write 0xFE (inhibit)
    core.step(); // inhibit
    core.step(); // inhibit
    expect(core.peek(SFR.TMR0)).toBe(0xfe);
    core.step();
    expect(core.peek(SFR.TMR0)).toBe(0xff);
    expect(core.peek(SFR.INTCON) & T0IF).toBe(0);
    core.step();
    expect(core.peek(SFR.TMR0)).toBe(0x00);
    expect(core.peek(SFR.INTCON) & T0IF).toBe(T0IF);
  });

  it('a write to TMR0 clears the prescaler when assigned to Timer0', () => {
    const core = timerProgram(0x87, 0);
    steps(core, 101);
    expect(core.snapshot().tmr0Prescaler).toBe(98); // write cycle + 2 inhibited, then 98 counted
    core.setPc(5); // write TMR0 again
    core.step();
    expect(core.snapshot().tmr0Prescaler).toBe(0);
  });

  it('does not count external edges in timer mode', () => {
    const core = timerProgram(0x88, 0);
    core.step();
    core.setInput('RA4', 1);
    core.setInput('RA4', 0);
    core.setInput('RA4', 1);
    expect(core.peek(SFR.TMR0)).toBe(0);
  });
});

describe('Timer0, counter mode (T0CS = 1, RA4/T0CKI)', () => {
  function counter(option: number): Pic16F84A {
    const core = timerProgram(option, 0);
    steps(core, 3); // write + inhibit window
    return core;
  }

  it('T0SE = 0 counts rising edges', () => {
    const core = counter(0xa8);
    steps(core, 10);
    expect(core.peek(SFR.TMR0)).toBe(0); // instruction cycles are not counted
    for (let i = 0; i < 3; i++) {
      core.setInput('RA4', 1);
      core.setInput('RA4', 0);
    }
    expect(core.peek(SFR.TMR0)).toBe(3);
  });

  it('T0SE = 1 counts falling edges', () => {
    const core = counter(0xb8);
    core.setInput('RA4', 1);
    expect(core.peek(SFR.TMR0)).toBe(0);
    core.setInput('RA4', 0);
    expect(core.peek(SFR.TMR0)).toBe(1);
  });

  it('floating T0CKI keeps its level (no spurious edge)', () => {
    const core = counter(0xa8);
    core.setInput('RA4', 1);
    core.setInput('RA4', 'Z');
    core.setInput('RA4', 1);
    expect(core.peek(SFR.TMR0)).toBe(1);
  });

  it('edges go through the prescaler when PSA = 0', () => {
    const core = counter(0xa1); // 1:4
    for (let i = 0; i < 9; i++) {
      core.setInput('RA4', 1);
      core.setInput('RA4', 0);
    }
    expect(core.peek(SFR.TMR0)).toBe(2);
    expect(core.snapshot().tmr0Prescaler).toBe(9);
  });

  it('overflow sets T0IF', () => {
    const core = counter(0xa8);
    core.poke(SFR.TMR0, 0xff);
    core.setInput('RA4', 1);
    expect(core.peek(SFR.TMR0)).toBe(0);
    expect(core.peek(SFR.INTCON) & T0IF).toBe(T0IF);
  });

  it('edges during the two cycles following a TMR0 write are lost', () => {
    const core = timerProgram(0xa8, 0x10);
    core.step(); // MOVWF TMR0
    core.setInput('RA4', 1); // during following cycle 1
    core.setInput('RA4', 0);
    expect(core.peek(SFR.TMR0)).toBe(0x10);
    core.step();
    core.setInput('RA4', 1); // during following cycle 2
    core.setInput('RA4', 0);
    expect(core.peek(SFR.TMR0)).toBe(0x10);
    core.step();
    core.setInput('RA4', 1);
    expect(core.peek(SFR.TMR0)).toBe(0x11);
  });
});
