import { describe, expect, it } from 'vitest';
import { Pic16F84A, SFR } from '../src/index';
import { build, buildWithLabels, PD, STATUS, steps, stepUntilPc, TO } from './helpers';

const GIE = 0x80;
const INTE = 0x10;
const RBIE = 0x08;
const T0IE = 0x20;
const EEIE = 0x40;
const WDT_ON = 0x3fff;

describe('SLEEP', () => {
  it('clears PD, sets TO, stops the core and freezes TMR0', () => {
    const core = build(`
      BSF STATUS, RP0
      MOVLW 0x88        ; TMR0 every cycle
      MOVWF OPTION_REG
      BCF STATUS, RP0
      SLEEP             ; 4
      MOVLW 0x11        ; 5
      GOTO $
    `);
    steps(core, 5);
    expect(core.sleeping).toBe(true);
    expect(core.peek(STATUS) & (TO | PD)).toBe(TO);
    const tmr0 = core.peek(SFR.TMR0);
    for (let i = 0; i < 100; i++) {
      const r = core.step();
      // No instruction cycle while the oscillator is stopped (api.ts: 0 when sleeping).
      expect(r).toMatchObject({ cycles: 0, pc: 4, opcode: 0x0063 });
    }
    expect(core.peek(SFR.TMR0)).toBe(tmr0);
    expect(core.pc).toBe(5);
    expect(core.w).toBe(0x88);
    expect(core.snapshot().sleeping).toBe(true);
    expect(core.cycles).toBe(105); // simulated time still passes: 1 Tcy per sleeping step
    expect(core.run(1000)).toBe(1000);
  });

  it('wakes on RB0/INT with GIE = 0 and continues after SLEEP (STATUS uuu1 0uuu)', () => {
    const core = build(`
      MOVLW ${INTE}
      MOVWF INTCON
      SLEEP             ; 2
      MOVLW 0x11        ; 3
      GOTO $
    `);
    steps(core, 3);
    expect(core.sleeping).toBe(true);
    steps(core, 50);
    core.setInput('RB0', 1);
    core.step(); // wake-up cycle
    expect(core.sleeping).toBe(false);
    expect(core.pc).toBe(3);
    core.step();
    expect(core.w).toBe(0x11);
    expect(core.peek(STATUS) & (TO | PD)).toBe(TO);
  });

  it('wakes with GIE = 1: executes the instruction after SLEEP, then vectors to 0x0004', () => {
    const { core, label } = buildWithLabels(`
      GOTO main
      ORG 4
      BCF INTCON, INTF
      RETFIE
main: MOVLW ${GIE | INTE}
      MOVWF INTCON
      SLEEP
after:
      MOVLW 0x22
      GOTO $
    `);
    stepUntilPc(core, label('after'));
    expect(core.sleeping).toBe(true);
    core.setInput('RB0', 1);
    core.step(); // wake
    const r = core.step();
    expect(r.pc).toBe(label('after'));
    expect(core.w).toBe(0x22);
    expect(core.step()).toMatchObject({ interruptEntry: true, cycles: 2 });
    expect(core.pc).toBe(0x0004);
    expect(core.snapshot().stack).toEqual([label('after') + 1]);
  });

  it('wakes on an RB7:RB4 change', () => {
    const core = build(`
      MOVF PORTB, W
      MOVLW ${RBIE}
      MOVWF INTCON
      SLEEP
      GOTO $
    `);
    steps(core, 10);
    expect(core.sleeping).toBe(true);
    core.setInput('RB4', 1);
    core.step();
    expect(core.sleeping).toBe(false);
  });

  it('wakes when an EEPROM write completes (EEIE)', () => {
    const core = build(`
      MOVLW ${EEIE}
      MOVWF INTCON
      BSF STATUS, RP0
      BSF EECON1, WREN
      MOVLW 0x55
      MOVWF EECON2
      MOVLW 0xAA
      MOVWF EECON2
      BSF EECON1, WR
      SLEEP
      GOTO $
    `);
    steps(core, 10);
    expect(core.sleeping).toBe(true);
    core.run(2400);
    expect(core.sleeping).toBe(true);
    core.run(200);
    expect(core.sleeping).toBe(false);
  });

  it('Timer0 cannot wake the core (oscillator stopped)', () => {
    const core = build(`
      BSF STATUS, RP0
      MOVLW 0x88
      MOVWF OPTION_REG
      BCF STATUS, RP0
      MOVLW 0xF0
      MOVWF TMR0
      MOVLW ${T0IE}
      MOVWF INTCON
      SLEEP
      GOTO $
    `);
    steps(core, 9);
    expect(core.sleeping).toBe(true);
    const frozen = core.peek(SFR.TMR0);
    core.run(100_000);
    expect(core.sleeping).toBe(true);
    expect(core.peek(SFR.TMR0)).toBe(frozen);
    expect(core.peek(SFR.INTCON) & 0x04).toBe(0);
  });

  it('with an interrupt already pending, SLEEP completes as a NOP', () => {
    const core = build(`
      MOVLW ${INTE | 0x02}  ; INTE + INTF already set
      MOVWF INTCON
      SLEEP
      MOVLW 0x33
      GOTO $
    `);
    steps(core, 3);
    expect(core.sleeping).toBe(false);
    expect(core.peek(STATUS) & (TO | PD)).toBe(TO | PD);
    core.step();
    expect(core.w).toBe(0x33);
  });
});

describe('watchdog timer', () => {
  /** Counts boots in 0x20 (RAM survives a WDT reset); `body` runs before the idle loop. */
  const bootCounter = (body: string): string => `
      INCF 0x20, F
      ${body}
loop: GOTO loop
  `;
  const prescale1to1 = `
      BSF STATUS, RP0
      MOVLW 0x88        ; PSA = 1, PS = 000: WDT 1:1
      MOVWF OPTION_REG
      BCF STATUS, RP0
  `;

  it('is off with the default configuration 0x3FFB', () => {
    const core = build(bootCounter(prescale1to1));
    core.run(1_000_000);
    expect(core.peek(0x20)).toBe(1);
  });

  it('resets the core every 18 ms when enabled (0000 1uuu)', () => {
    const core = build(bootCounter(prescale1to1), { config: WDT_ON });
    expect(core.timing.wdtPeriodCycles).toBe(4500); // 18 ms at 1 MHz
    core.run(4490);
    expect(core.peek(0x20)).toBe(1);
    let total = 4490;
    while (core.peek(0x20) === 1) total += core.step().cycles;
    expect(total).toBeGreaterThanOrEqual(4500);
    expect(total).toBeLessThanOrEqual(4503);
    // Just after the reset (only INCF executed): WDT reset values.
    expect(core.peek(STATUS) & (TO | PD)).toBe(PD);
    expect(core.peek(SFR.OPTION_REG)).toBe(0xff);
    expect(core.peek(SFR.TRISB)).toBe(0xff);
    expect(core.cycles).toBe(1);
  });

  it('follows the clock: 18 ms = 36 000 cycles at 8 MHz', () => {
    const core = new Pic16F84A({ clockHz: 8_000_000 });
    expect(core.timing.wdtPeriodCycles).toBe(36_000);
    expect(core.timing.eepromWriteCycles).toBe(20_000);
  });

  it('CLRWDT in the loop prevents the reset and sets TO and PD', () => {
    const core = build(`
      INCF 0x20, F
      ${prescale1to1}
      BCF STATUS, C
loop: CLRWDT
      GOTO loop
    `, { config: WDT_ON });
    core.run(50_000);
    expect(core.peek(0x20)).toBe(1);
    expect(core.peek(STATUS) & (TO | PD)).toBe(TO | PD);
  });

  it('uses the prescaler when PSA = 1 (1:2 → 36 ms)', () => {
    const core = build(bootCounter(`
      BSF STATUS, RP0
      MOVLW 0x89        ; PSA = 1, PS = 001
      MOVWF OPTION_REG
      BCF STATUS, RP0
    `), { config: WDT_ON });
    core.run(8990);
    expect(core.peek(0x20)).toBe(1);
    core.run(20);
    expect(core.peek(0x20)).toBe(2);
  });

  it('after reset OPTION_REG = 0xFF gives the WDT a 1:128 prescaler (≈ 2.3 s)', () => {
    const core = build(bootCounter(''), { config: WDT_ON });
    core.run(4500 * 127);
    expect(core.peek(0x20)).toBe(1);
    core.run(4500 + 10);
    expect(core.peek(0x20)).toBe(2);
  });

  it('a WDT time-out during SLEEP wakes the core (uuu0 0uuu) instead of resetting it', () => {
    const core = build(`
      INCF 0x20, F
      ${prescale1to1}
      SLEEP
      MOVLW 0x44
      GOTO $
    `, { config: WDT_ON });
    steps(core, 6);
    expect(core.sleeping).toBe(true);
    core.run(4600);
    expect(core.sleeping).toBe(false);
    expect(core.peek(0x20)).toBe(1);
    expect(core.peek(STATUS) & (TO | PD)).toBe(0);
    core.step();
    expect(core.w).toBe(0x44);
  });

  it('a WDT reset in the first cycle of a GOTO (GIE = 1) ends the instruction there', () => {
    const core = build(`
      ${prescale1to1}
      MOVLW ${GIE}
      MOVWF INTCON
      NOP               ; 7 cycles so far: GOTO first cycles end on even counts, 4500 among them
loop: GOTO loop
    `, { config: WDT_ON });
    let last = 0;
    while (core.cycles >= last) {
      last = core.cycles;
      core.step();
    }
    expect(last).toBe(4499);
    expect(core.cycles).toBe(0);
    expect(core.pc).toBe(0);
    expect(core.peek(STATUS) & (TO | PD)).toBe(PD);
  });
});
