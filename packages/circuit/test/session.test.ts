import { assemble } from '@pic/emulator';
import { describe, expect, it } from 'vitest';
import type { Schematic } from '../src/api';
import { SchematicBuilder, pinRef } from '../src/builder';
import { SimSession } from '../src/session';

/**
 * PIC at the origin (RA0 tip at (15, 0), RB0..RB7 at (15, 6..13)):
 *   RA0 → D1 → GND, LOGICSTATE LS1 (initially 0) → RB0, and RB1 wired straight back to RB2.
 */
function bench(clockHz = 1_000_000): Schematic {
  const b = new SchematicBuilder(clockHz);
  b.place('PIC16F84A', { at: { x: 0, y: 0 } });
  // Right of the LOGICSTATE wire: a cathode wire ending on it would be a T-join to GND.
  const led = b.place('LED', { at: { x: 60, y: 4 }, props: { color: 'RED' } });
  b.wire(pinRef('U1', 'RA0'), { x: 60, y: 0 }, pinRef(led.id, 'A'));
  const gnd = b.place('GROUND', { at: { x: 60, y: 9 } });
  b.wire(pinRef(led.id, 'K'), pinRef(gnd.id, 'GND'));
  const ls = b.place('LOGICSTATE', { at: { x: 40, y: 6 }, props: { state: 0 } });
  b.wire(pinRef('U1', 'RB0/INT'), pinRef(ls.id, 'Q0'));
  b.wire(pinRef('U1', 'RB1'), { x: 17, y: 7 }, { x: 17, y: 8 }, pinRef('U1', 'RB2'));
  return b.build();
}

function program(source: string): Uint16Array {
  const r = assemble(source);
  if (!r.ok) throw new Error(r.errors.map((e) => `${e.line}: ${e.message}`).join('\n'));
  return r.program;
}

/** RA0 follows the LOGICSTATE on RB0. */
const FOLLOW = `
      BSF STATUS, RP0
      BCF TRISA, 0
      BCF STATUS, RP0
loop: BTFSC PORTB, 0
      GOTO on
      BCF PORTA, 0
      GOTO loop
on:   BSF PORTA, 0
      GOTO loop
`;
const ON_LABEL = 7;

/** 8-cycle loop with RA0 high for 2 cycles: a 25 % duty cycle. */
const PWM_25 = `
      BSF STATUS, RP0
      BCF TRISA, 0
      BCF STATUS, RP0
loop: BSF PORTA, 0
      NOP
      BCF PORTA, 0
      NOP
      NOP
      NOP
      GOTO loop
`;

/** Drives RB1 and, in the very next instruction, reads it back through the wire on RB2. */
const LOOPBACK = `
      BSF STATUS, RP0
      BCF TRISB, 1
      BCF TRISA, 0
      BCF STATUS, RP0
      BSF PORTB, 1
      BTFSC PORTB, 2
      BSF PORTA, 0
      GOTO $
`;

const led = (s: SimSession) => s.snapshot().visuals.D1 as { kind: 'LED'; lit: boolean; brightness: number };

describe('SimSession', () => {
  it('runs the program against the circuit: an interaction reaches the program in the next slice', () => {
    const s = new SimSession(bench(), program(FOLLOW));
    s.runFor(0.01);
    expect(led(s)).toEqual({ kind: 'LED', lit: false, brightness: 0 });
    s.interact('LS1', { type: 'toggle' });
    expect(s.snapshot().visuals.LS1).toEqual({ kind: 'LOGICSTATE', state: 1 });
    s.runFor(0.01);
    expect(led(s)).toEqual({ kind: 'LED', lit: true, brightness: 1 });
    s.interact('LS1', { type: 'toggle' });
    s.runFor(0.001);
    expect(led(s).lit).toBe(false);
    // Two changes within one 20 ms brightness window read as blinking: dark once a full window has passed.
    s.runFor(0.02);
    expect(led(s)).toMatchObject({ lit: false, brightness: 0 });
  });

  it('re-solves the circuit after the instruction that changed the pins, inside a slice', () => {
    const s = new SimSession(bench(), program(LOOPBACK));
    s.runFor(0.001);
    expect(led(s).lit).toBe(true);
    expect(s.snapshot().cpu.halted).toBe(true);
  });

  it('step() keeps the circuit in step too', () => {
    const s = new SimSession(bench(), program(LOOPBACK));
    for (let i = 0; i < 7; i++) s.step();
    expect(led(s).lit).toBe(true);
    expect(s.cycles).toBe(7);
  });

  it('credits LED brightness with the time spent in each state (duty cycle)', () => {
    const s = new SimSession(bench(), program(PWM_25));
    for (let i = 0; i < 5; i++) s.runFor(0.01);
    expect(led(s).brightness).toBeCloseTo(0.25, 3);
  });

  it('keeps simulated time exact across slices that are not a whole number of cycles', () => {
    const s = new SimSession(bench(), program(PWM_25)); // 1 MHz: Tcy = 4 µs
    let cycles = 0;
    for (let i = 0; i < 1000; i++) cycles += s.runFor(10e-6).cycles; // 2.5 cycles per call
    expect(Math.abs(cycles - 2500)).toBeLessThanOrEqual(1);
    expect(s.cycles).toBe(cycles);
    expect(s.time).toBeCloseTo(cycles * 4e-6, 12);
    for (let i = 0; i < 4; i++) s.runFor(0.25);
    expect(Math.abs(s.time - 1.01)).toBeLessThanOrEqual(4e-6);
  });

  it('uses the given clock: 8 MHz runs 2 M instruction cycles per simulated second', () => {
    const s = new SimSession(bench(8_000_000), program(PWM_25), 8_000_000);
    const r = s.runFor(0.1);
    expect(Math.abs(r.cycles - 200_000)).toBeLessThanOrEqual(1);
    expect(r.seconds).toBeCloseTo(r.cycles * 0.5e-6, 12);
  });

  it('stops on a breakpoint and resumes past it on the next slice', () => {
    const s = new SimSession(bench(), program(FOLLOW));
    s.setBreakpoints([ON_LABEL]);
    expect(s.runFor(0.01)).toMatchObject({ breakpoint: null });
    s.interact('LS1', { type: 'toggle' });
    const hit = s.runFor(0.01);
    expect(hit.breakpoint).toBe(ON_LABEL);
    expect(hit.cycles).toBeLessThan(10);
    expect(s.mcu.pc).toBe(ON_LABEL);
    const next = s.runFor(0.01);
    expect(next.breakpoint).toBe(ON_LABEL);
    expect(next.cycles).toBeGreaterThan(0);
    s.setBreakpoints([]);
    expect(s.runFor(0.01).breakpoint).toBeNull();
  });

  it('reports a breakpoint at the current PC when the previous slice ran out of time exactly on it', () => {
    const s = new SimSession(bench(), program(FOLLOW));
    s.interact('LS1', { type: 'toggle' });
    s.runFor(6 * 4e-6); // BSF, BCF, BCF, BTFSC, GOTO on (2 cycles): PC = on
    expect(s.mcu.pc).toBe(ON_LABEL);
    s.setBreakpoints([ON_LABEL]);
    expect(s.runFor(0.01)).toEqual({ cycles: 0, seconds: 0, breakpoint: ON_LABEL });
    expect(s.runFor(0.01).cycles).toBeGreaterThan(0);
  });

  it('resumes past a breakpoint at the PC the user stepped to', () => {
    const s = new SimSession(bench(), program(FOLLOW));
    s.interact('LS1', { type: 'toggle' });
    while (s.mcu.pc !== ON_LABEL) s.step();
    s.setBreakpoints([ON_LABEL]);
    const r = s.runFor(0.01);
    expect(r.breakpoint).toBe(ON_LABEL);
    expect(r.cycles).toBe(6); // BSF, GOTO loop, BTFSC, GOTO on: one pass of the loop
  });

  it('keeps counting time through a watchdog reset of the core', () => {
    // Config 0x3FFF: WDT on. With the prescaler moved to TMR0 and no CLRWDT, the core resets every 18 ms.
    const noClrwdt = `
      BSF STATUS, RP0
      CLRF OPTION_REG
      BCF STATUS, RP0
      GOTO $
    `;
    const s = new SimSession(bench(), program(noClrwdt), 1_000_000, { config: 0x3fff });
    s.runFor(0.05);
    expect(s.time).toBeCloseTo(0.05, 5);
    expect(s.mcu.cycles).toBeLessThan(s.cycles);
  });

  it('reset() is a power-on reset of the core and restores the schematic states', () => {
    const s = new SimSession(bench(), program(FOLLOW));
    s.interact('LS1', { type: 'toggle' });
    s.runFor(0.01);
    s.reset();
    const snap = s.snapshot();
    expect(snap).toMatchObject({ time: 0, cycles: 0, cpu: { pc: 0 } });
    expect(snap.visuals.LS1).toEqual({ kind: 'LOGICSTATE', state: 0 });
    expect(snap.visuals.D1).toMatchObject({ lit: false });
  });

  it('snapshot() is plain data the worker can post', () => {
    const s = new SimSession(bench(), program(FOLLOW));
    s.runFor(0.001);
    const snap = s.snapshot();
    expect(structuredClone(snap)).toEqual(snap);
    expect(Object.keys(snap.visuals).sort()).toEqual(['D1', 'LS1']);
    const ra0 = s.circuit.netlist.pinToNet.get('U1:RA0')!;
    expect(snap.nets[ra0]).toBe(0);
    expect(snap.cpu.status & 0x18).toBe(0x18); // TO, PD after power-on
  });

  it('refuses a schematic without a PIC16F84A', () => {
    const b = new SchematicBuilder();
    b.place('GROUND', { at: { x: 0, y: 0 } });
    expect(() => new SimSession(b.build(), new Uint16Array(1024))).toThrow(/aucun PIC16F84A/);
  });
});
