// Debugger-facing API: snapshot, peek/poke without side effects, run() with breakpoints and IO callback.
import { describe, expect, it } from 'vitest';
import { Pic16F84A, SFR } from '../src/index';
import { build, buildWithLabels, steps, stepUntilPc } from './helpers';

describe('snapshot', () => {
  it('shows every address through the bank map', () => {
    const core = build(`
      MOVLW 0x2A
      MOVWF 0x0C
      MOVWF 0x4F
      CALL sub
      GOTO $
sub:  CALL sub2
sub2: GOTO $
    `);
    steps(core, 6);
    const s = core.snapshot();
    expect(s.file).toHaveLength(256);
    expect(s.file[0x0c]).toBe(0x2a);
    expect(s.file[0x8c]).toBe(0x2a);
    expect(s.file[0xcf]).toBe(0x2a);
    expect(s.file[0x83]).toBe(s.status);
    expect(s.file[0x07]).toBe(0);
    expect(s.file[0x50]).toBe(0);
    expect(s.stack).toEqual([4, 6]); // bottom … top
    expect(s.pc).toBe(6);
    expect(s.w).toBe(0x2a);
    expect(s.halted).toBe(true);
    expect(s.eeprom).toHaveLength(64);
  });

  it('is a copy', () => {
    const core = new Pic16F84A();
    const s = core.snapshot();
    s.file[0x20] = 1;
    s.eeprom[0] = 1;
    expect(core.peek(0x20)).toBe(0);
    expect(core.peekEeprom(0)).toBe(0xff);
  });
});

describe('peek / poke', () => {
  it('peek of PORTB does not end the RB-change mismatch, a program read does', () => {
    const { core, label } = buildWithLabels(`
      MOVF PORTB, W     ; latch the levels
idle: GOTO idle
clear:
      BCF INTCON, RBIF
      GOTO idle
read: MOVF PORTB, W
      BCF INTCON, RBIF
      GOTO idle
    `);
    core.step();
    core.setInput('RB4', 1);
    expect(core.peek(SFR.INTCON) & 1).toBe(1);
    core.peek(SFR.PORTB);
    core.setPc(label('clear'));
    core.step();
    expect(core.peek(SFR.INTCON) & 1).toBe(1); // mismatch still present after a peek
    core.setPc(label('read'));
    steps(core, 2);
    expect(core.peek(SFR.INTCON) & 1).toBe(0);
  });

  it('poke TMR0 neither clears the prescaler nor starts the write inhibit', () => {
    const core = build(`
      BSF STATUS, RP0
      MOVLW 0x87
      MOVWF OPTION_REG
      BCF STATUS, RP0
    `);
    steps(core, 14);
    const pre = core.snapshot().tmr0Prescaler;
    expect(pre).toBe(12); // counts Tcy from the OPTION_REG write cycle on
    core.poke(SFR.TMR0, 0x80);
    expect(core.snapshot().tmr0Prescaler).toBe(pre);
    core.step();
    expect(core.snapshot().tmr0Prescaler).toBe(pre + 1);
  });

  it('poke STATUS can set TO/PD (debugger only); poke PCL changes the PC low byte', () => {
    const core = new Pic16F84A();
    core.poke(SFR.STATUS, 0x07);
    expect(core.peek(0x83)).toBe(0x07);
    core.setPc(0x123);
    core.poke(SFR.PCL, 0x45);
    expect(core.pc).toBe(0x145);
  });

  it('poke INDF writes through FSR', () => {
    const core = new Pic16F84A();
    core.poke(SFR.FSR, 0x30);
    core.poke(SFR.INDF, 0x99);
    expect(core.peek(0x30)).toBe(0x99);
    expect(core.peek(SFR.INDF)).toBe(0x99);
  });
});

describe('run()', () => {
  const loop = `
      CLRF 0x20         ; 0
loop: INCF 0x20, F      ; 1
      NOP               ; 2
      GOTO loop         ; 3
  `;

  it('executes at least the requested cycles', () => {
    const core = build(loop);
    const done = core.run(1000);
    expect(done).toBeGreaterThanOrEqual(1000);
    expect(done).toBeLessThanOrEqual(1001);
    expect(core.cycles).toBe(done);
    expect(core.run(0)).toBe(0);
  });

  it('stops before a breakpoint and resumes over it', () => {
    const core = build(loop);
    const bp = new Set([2]);
    expect(core.run(1000, bp)).toBe(2); // CLRF, INCF
    expect(core.pc).toBe(2);
    expect(core.peek(0x20)).toBe(1);
    expect(core.run(1000, bp)).toBe(4); // NOP, GOTO, INCF, then stop again at 2
    expect(core.pc).toBe(2);
    expect(core.peek(0x20)).toBe(2);
    expect(core.run(10, new Set())).toBeGreaterThanOrEqual(10);
  });

  it('calls onIoChange after each instruction that changes the IO', () => {
    const core = build(`
      BSF STATUS, RP0
      CLRF TRISB
      BCF STATUS, RP0
loop: BSF PORTB, 0
      BCF PORTB, 0
      GOTO loop
    `);
    const seen: number[] = [];
    core.onIoChange = () => seen.push(core.getDrive('RB0') === 1 ? 1 : 0);
    core.run(3 + 4 * 10);
    expect(seen.slice(0, 5)).toEqual([0, 1, 0, 1, 0]); // TRISB write, then each toggle
    expect(seen.length).toBeGreaterThanOrEqual(20);
  });

  it('lets the circuit answer within the slice (setInput from the callback)', () => {
    const core = build(`
      BSF STATUS, RP0
      MOVLW 0xFE
      MOVWF TRISB       ; RB0 output, RB1 input
      BCF STATUS, RP0
loop: BSF PORTB, 0
      BTFSS PORTB, 1    ; wire RB0 → RB1
      GOTO loop
      MOVLW 0x77
      GOTO $
    `);
    core.onIoChange = () => core.setInput('RB1', core.getDrive('RB0') === 1 ? 1 : 0);
    core.run(20);
    expect(core.w).toBe(0x77);
  });

  it('step() and run() keep the same cycle accounting', () => {
    const a = build(loop);
    const b = build(loop);
    a.run(500);
    stepUntilPc(b, a.pc);
    while (b.cycles < a.cycles) b.step();
    expect(b.cycles).toBe(a.cycles);
    expect(b.peek(0x20)).toBe(a.peek(0x20));
  });
});
