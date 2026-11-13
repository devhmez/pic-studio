import { describe, expect, it } from 'vitest';
import { SFR } from '../src/index';
import type { Pic16F84A } from '../src/index';
import { build, buildWithLabels, steps, stepUntilPc } from './helpers';

const GIE = 0x80;
const EEIE = 0x40;
const T0IE = 0x20;
const INTE = 0x10;
const RBIE = 0x08;
const T0IF = 0x04;
const INTF = 0x02;
const RBIF = 0x01;

interface Bench {
  core: Pic16F84A;
  /** Address of the first NOP of main's idle loop. */
  spin: number;
}

/**
 * Interrupt test bench. The ISR counts entries in 0x21 and runs `isrBody` (which must clear the
 * flag); main runs `setup` then idles in `spin: NOP / NOP / NOP / GOTO spin`. Returns with the
 * core at the start of the idle loop.
 */
function bench(setup: string, isrBody: string): Bench {
  const { core, label } = buildWithLabels(`
      ORG 0
      GOTO main
      ORG 4
      INCF 0x21, F
      ${isrBody}
      RETFIE
main:
      ${setup}
spin: NOP
      NOP
      NOP
      GOTO spin
  `);
  const spin = label('spin');
  stepUntilPc(core, spin);
  return { core, spin };
}

describe('RB0/INT external interrupt', () => {
  const setup = (option: number) => `
      BSF STATUS, RP0
      MOVLW ${option}
      MOVWF OPTION_REG
      BCF STATUS, RP0
      MOVLW ${GIE | INTE}
      MOVWF INTCON
  `;

  it('INTEDG = 1: rising edge sets INTF and vectors to 0x0004', () => {
    const { core } = bench(setup(0xff), 'BCF INTCON, INTF');
    core.setInput('RB0', 0);
    steps(core, 5);
    expect(core.peek(0x21)).toBe(0);
    core.setInput('RB0', 1);
    expect(core.peek(SFR.INTCON) & INTF).toBe(INTF);
    steps(core, 8);
    expect(core.peek(0x21)).toBe(1);
    expect(core.peek(SFR.INTCON) & (INTF | GIE)).toBe(GIE);
    core.setInput('RB0', 0); // falling: ignored
    steps(core, 8);
    expect(core.peek(0x21)).toBe(1);
  });

  it('INTEDG = 0: falling edge', () => {
    const { core } = bench(setup(0xbf), 'BCF INTCON, INTF');
    core.setInput('RB0', 1);
    core.setInput('RB0', 0);
    steps(core, 8);
    expect(core.peek(0x21)).toBe(1);
    core.setInput('RB0', 1);
    steps(core, 8);
    expect(core.peek(0x21)).toBe(1);
  });

  it('edges are ignored while RB0 is an output', () => {
    const { core } = bench(`${setup(0xff)}\n BSF STATUS, RP0\n BCF TRISB, 0\n BCF STATUS, RP0`, 'BCF INTCON, INTF');
    core.setInput('RB0', 1);
    expect(core.peek(SFR.INTCON) & INTF).toBe(0);
  });

  it('INTF is set even when INTE = 0 (no interrupt taken)', () => {
    const { core } = bench('MOVLW 0x80\n MOVWF INTCON', 'BCF INTCON, INTF');
    core.setInput('RB0', 1);
    steps(core, 10);
    expect(core.peek(SFR.INTCON) & INTF).toBe(INTF);
    expect(core.peek(0x21)).toBe(0);
  });

  it('latency: the sampled instruction completes, then 2 dummy cycles (own step) start the ISR 3 Tcy later', () => {
    const { core, spin } = bench(setup(0xff), 'BCF INTCON, INTF');
    stepUntilPc(core, spin + 1);
    core.setInput('RB0', 1);
    const r = core.step(); // NOP at spin+1 still executes
    expect(r).toMatchObject({ pc: spin + 1, cycles: 1, interruptEntry: false });
    expect(core.interruptEntryPending).toBe(true);
    expect(core.pc).toBe(spin + 2);
    const entry = core.step(); // forced NOP in place of the instruction at spin+2
    expect(entry).toMatchObject({ pc: spin + 2, opcode: 0x0000, cycles: 2, interruptEntry: true });
    expect(core.interruptEntryPending).toBe(false);
    expect(core.pc).toBe(0x0004);
    expect(core.snapshot().stack).toEqual([spin + 2]);
    expect(core.peek(SFR.INTCON) & GIE).toBe(0);
  });

  it('latency is the same after a 2-cycle instruction; the return address is the jump target', () => {
    const { core, spin } = bench(setup(0xff), 'BCF INTCON, INTF');
    stepUntilPc(core, spin + 3); // GOTO spin
    core.setInput('RB0', 1);
    expect(core.step()).toMatchObject({ pc: spin + 3, cycles: 2 });
    expect(core.step()).toMatchObject({ pc: spin, cycles: 1, interruptEntry: true });
    expect(core.pc).toBe(0x0004);
    expect(core.snapshot().stack).toEqual([spin]);
  });

  it('a flag raised in the first cycle of a 2-cycle instruction is sampled at its second Q1', () => {
    const { core, label } = buildWithLabels(`
      GOTO main
      ORG 4
      GOTO $
main: MOVLW 0x88
      OPTION            ; PSA = 1: TMR0 counts every Tcy
      MOVLW ${GIE | T0IE}
      MOVWF INTCON
      CALL sub          ; TMR0 overflows during the first cycle of CALL
      NOP
sub:  INCF 0x20, F
      RETURN
    `);
    stepUntilPc(core, label('main') + 4);
    core.poke(SFR.TMR0, 0xff);
    const start = core.cycles;
    expect(core.step()).toMatchObject({ cycles: 2, interruptEntry: false });
    expect(core.step()).toMatchObject({ pc: label('sub'), cycles: 2, interruptEntry: true });
    expect(core.cycles - start).toBe(4); // sampled at cycle 2, ISR 3 Tcy later
    expect(core.pc).toBe(0x0004);
    expect(core.snapshot().stack).toEqual([label('main') + 5, label('sub')]);
    expect(core.peek(0x20)).toBe(0);
  });

  it('RETFIE sets GIE in its first cycle: a still-pending interrupt re-enters with no main-line instruction', () => {
    const { core, spin } = bench(setup(0xff), 'NOP'); // ISR forgets to clear INTF
    core.setInput('RB0', 1);
    stepUntilPc(core, 0x0004);
    const back = core.snapshot().stack[0];
    expect(back).toBeGreaterThanOrEqual(spin);
    stepUntilPc(core, 0x0004 + 2); // RETFIE
    const r = core.step();
    expect(r.cycles).toBe(2);
    expect(core.pc).toBe(back);
    expect(core.interruptEntryPending).toBe(true);
    const next = core.step(); // dummy cycles, then the vector again
    expect(next).toMatchObject({ pc: back, cycles: 2, interruptEntry: true });
    expect(core.pc).toBe(0x0004);
    expect(core.snapshot().stack).toEqual([back]);
    expect(core.peek(0x21)).toBe(1);
  });

  it('run() does not stop on a breakpoint at the return address before the vector', () => {
    const { core, spin } = bench(setup(0xff), 'BCF INTCON, INTF');
    stepUntilPc(core, spin + 1);
    core.setInput('RB0', 1);
    // NOP at spin+1 (sampled), dummy cycles, then stop at the ISR's first instruction.
    expect(core.run(100, new Set([spin + 2, 0x0004]))).toBe(3);
    expect(core.pc).toBe(0x0004);
  });

  it('every step reports 1 or 2 cycles, interrupt entry included', () => {
    const { core } = bench(setup(0xff), 'BCF INTCON, INTF');
    let total = 0;
    const start = core.cycles;
    for (let i = 0; i < 200; i++) {
      if (i % 7 === 0) core.setInput('RB0', ((i / 7) & 1) as 0 | 1);
      const c = core.step().cycles;
      expect([1, 2]).toContain(c);
      total += c;
    }
    expect(total).toBe(core.cycles - start);
    expect(core.peek(0x21)).toBeGreaterThan(5);
  });

  it('no interrupt while GIE = 0, taken as soon as GIE is set', () => {
    const { core } = bench(`MOVLW ${INTE}\n MOVWF INTCON`, 'BCF INTCON, INTF');
    core.setInput('RB0', 1);
    steps(core, 10);
    expect(core.peek(0x21)).toBe(0);
    core.poke(SFR.INTCON, core.peek(SFR.INTCON) | GIE);
    steps(core, 8);
    expect(core.peek(0x21)).toBe(1);
  });

  it('clearing GIE in the sampled instruction cancels the vector', () => {
    const core = build(`
      MOVLW ${GIE | INTE}
      MOVWF INTCON
      NOP
      BCF INTCON, GIE   ; 3
      GOTO $
    `);
    stepUntilPc(core, 3);
    core.setInput('RB0', 1);
    core.step();
    expect(core.pc).toBe(4);
    expect(core.snapshot().stack).toEqual([]);
  });
});

describe('RB7:RB4 port-change interrupt', () => {
  const setup = `
      MOVF PORTB, W     ; latch the current levels
      MOVLW ${GIE | RBIE}
      MOVWF INTCON
  `;

  it('a change on an RB7:RB4 input sets RBIF; the ISR reads PORTB then clears RBIF', () => {
    const { core } = bench(setup, 'MOVF PORTB, W\n MOVWF 0x20\n BCF INTCON, RBIF');
    core.setInput('RB5', 1);
    expect(core.peek(SFR.INTCON) & RBIF).toBe(RBIF);
    steps(core, 30);
    expect(core.peek(0x21)).toBe(1);
    expect(core.peek(0x20)).toBe(0x20);
    core.setInput('RB5', 0);
    steps(core, 30);
    expect(core.peek(0x21)).toBe(2);
  });

  it('clearing RBIF without reading PORTB does not end the mismatch: RBIF comes back', () => {
    const { core } = bench(setup, 'BCF INTCON, RBIF');
    core.setInput('RB7', 1);
    steps(core, 100);
    expect(core.peek(0x21)).toBeGreaterThan(5);
  });

  it('a write of PORTB also ends the mismatch', () => {
    const { core } = bench(setup, 'CLRF PORTB\n BCF INTCON, RBIF');
    core.setInput('RB6', 1);
    steps(core, 100);
    expect(core.peek(0x21)).toBe(1);
  });

  it('ignores RB3:RB0 and RB7:RB4 pins configured as outputs', () => {
    const { core } = bench(`BSF STATUS, RP0\n MOVLW 0x5F\n MOVWF TRISB\n BCF STATUS, RP0\n${setup}`, 'BCF INTCON, RBIF');
    core.setInput('RB1', 1);
    core.setInput('RB2', 1);
    core.setInput('RB5', 1); // output
    core.setInput('RB7', 1); // output
    steps(core, 20);
    expect(core.peek(SFR.INTCON) & RBIF).toBe(0);
    core.setInput('RB6', 1); // input
    expect(core.peek(SFR.INTCON) & RBIF).toBe(RBIF);
  });

  it('a change back to the latched value before servicing still leaves RBIF set', () => {
    const { core } = bench(`MOVF PORTB, W\n MOVLW ${RBIE}\n MOVWF INTCON`, 'BCF INTCON, RBIF');
    core.setInput('RB4', 1);
    core.setInput('RB4', 0);
    expect(core.peek(SFR.INTCON) & RBIF).toBe(RBIF);
  });
});

describe('TMR0 overflow interrupt', () => {
  it('vectors on T0IF; the ISR reloads TMR0 periodically', () => {
    const { core } = bench(`
      BSF STATUS, RP0
      MOVLW 0x88        ; PSA = 1: TMR0 counts every cycle
      MOVWF OPTION_REG
      BCF STATUS, RP0
      MOVLW 0xF0
      MOVWF TMR0
      MOVLW ${GIE | T0IE}
      MOVWF INTCON
    `, 'BCF INTCON, T0IF');
    core.run(1000);
    // 256 cycles per overflow once free-running: about 3-4 interrupts in 1000 cycles.
    expect(core.peek(0x21)).toBeGreaterThanOrEqual(3);
    expect(core.peek(0x21)).toBeLessThanOrEqual(4);
  });
});

describe('EEPROM write-complete interrupt', () => {
  it('EEIF with EEIE and GIE vectors to 0x0004', () => {
    const { core } = bench(`
      MOVLW 1
      MOVWF EEADR
      MOVLW 0x99
      MOVWF EEDATA
      MOVLW ${GIE | EEIE}
      MOVWF INTCON
      BSF STATUS, RP0
      BSF EECON1, WREN
      MOVLW 0x55
      MOVWF EECON2
      MOVLW 0xAA
      MOVWF EECON2
      BSF EECON1, WR
      BCF STATUS, RP0
    `, 'BSF STATUS, RP0\n BCF EECON1, EEIF\n BCF STATUS, RP0');
    core.run(2400);
    expect(core.peek(0x21)).toBe(0);
    core.run(200);
    expect(core.peek(0x21)).toBe(1);
    expect(core.peekEeprom(1)).toBe(0x99);
    core.run(5000);
    expect(core.peek(0x21)).toBe(1);
  });
});
