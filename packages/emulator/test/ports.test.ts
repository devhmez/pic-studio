import { describe, expect, it } from 'vitest';
import { PIN_NAMES, Pic16F84A, SFR } from '../src/index';
import { build, runToHalt, steps } from './helpers';

describe('pin drive and direction', () => {
  it('after reset every pin is an input (Z) without pull-up', () => {
    const core = new Pic16F84A();
    for (const pin of PIN_NAMES) {
      expect(core.getDrive(pin)).toBe('Z');
      expect(core.hasWeakPullup(pin)).toBe(false);
    }
    expect(core.pinNames).toEqual(PIN_NAMES);
  });

  it('TRIS bit 0 drives the latch value', () => {
    const core = build(`
      BSF STATUS, RP0
      CLRF TRISB
      MOVLW 0x10
      MOVWF TRISA       ; RA0..RA3 outputs, RA4 input
      BCF STATUS, RP0
      MOVLW 0xA5
      MOVWF PORTB
      MOVLW 0x0A
      MOVWF PORTA
      GOTO $
    `);
    runToHalt(core);
    expect(['RB0', 'RB1', 'RB2', 'RB3', 'RB4', 'RB5', 'RB6', 'RB7'].map((p) => core.getDrive(p as 'RB0'))).toEqual([
      1, 0, 1, 0, 0, 1, 0, 1,
    ]);
    expect(['RA0', 'RA1', 'RA2', 'RA3', 'RA4'].map((p) => core.getDrive(p as 'RA0'))).toEqual([0, 1, 0, 1, 'Z']);
  });

  it('PORTA has 5 bits: bits 7..5 read 0', () => {
    const core = build(`
      BSF STATUS, RP0
      CLRF TRISA
      BCF STATUS, RP0
      MOVLW 0xEF
      MOVWF PORTA
      MOVF PORTA, W
      GOTO $
    `);
    runToHalt(core);
    expect(core.w).toBe(0x0f); // RA4 latch 0 → driven low; bits 7..5 absent
    expect(core.peek(SFR.TRISA)).toBe(0);
    core.poke(SFR.TRISA, 0xff);
    expect(core.peek(SFR.TRISA)).toBe(0x1f);
  });
});

describe('RA4 open drain', () => {
  const program = `
      BSF STATUS, RP0
      BCF TRISA, 4      ; RA4 output
      BCF STATUS, RP0
      BSF PORTA, 4      ; release (high impedance)
      MOVF PORTA, W
      MOVWF 0x20
      BCF PORTA, 4      ; pull low
      MOVF PORTA, W
      MOVWF 0x21
      GOTO $
  `;

  it('drives 0 when the latch is 0 and releases the pin (Z) when it is 1', () => {
    const core = build(program);
    steps(core, 4);
    expect(core.getDrive('RA4')).toBe('Z');
    steps(core, 3);
    expect(core.getDrive('RA4')).toBe(0);
  });

  it('a released RA4 reads the external level (pull-up → 1, nothing → last level 0)', () => {
    let core = build(program);
    runToHalt(core);
    expect(core.peek(0x20) & 0x10).toBe(0); // LED to ground, no pull-up: never reads 1
    core = build(program);
    steps(core, 4);
    core.setInput('RA4', 1); // external pull-up resistor
    runToHalt(core);
    expect(core.peek(0x20) & 0x10).toBe(0x10);
    expect(core.peek(0x21) & 0x10).toBe(0);
  });
});

describe('reading inputs', () => {
  it('input pins read the level given by setInput; Z and X keep the last defined level', () => {
    const core = new Pic16F84A();
    core.setInput('RB3', 1);
    core.setInput('RA2', 1);
    expect(core.peek(SFR.PORTB)).toBe(0x08);
    expect(core.peek(SFR.PORTA)).toBe(0x04);
    core.setInput('RB3', 'Z');
    expect(core.peek(SFR.PORTB)).toBe(0x08);
    core.setInput('RB3', 'X');
    expect(core.peek(SFR.PORTB)).toBe(0x08);
    core.setInput('RB3', 0);
    core.setInput('RB3', 'Z');
    expect(core.peek(SFR.PORTB)).toBe(0x00);
  });

  it('output pins read the driven value, not the net level', () => {
    const core = build(`
      BSF STATUS, RP0
      CLRF TRISB
      BCF STATUS, RP0
      MOVLW 0x01
      MOVWF PORTB
      GOTO $
    `);
    runToHalt(core);
    core.setInput('RB0', 0); // e.g. an LED clamping the net
    expect(core.peek(SFR.PORTB)).toBe(0x01);
  });
});

describe('PORTB weak pull-ups (OPTION_REG.RBPU = 0)', () => {
  const enablePullups = `
      BSF STATUS, RP0
      BCF OPTION_REG, RBPU
      MOVLW 0xF0
      MOVWF TRISB       ; RB7..RB4 inputs, RB3..RB0 outputs
      BCF STATUS, RP0
      GOTO $
  `;

  it('apply to input pins of PORTB only', () => {
    const core = build(enablePullups);
    runToHalt(core);
    expect(core.hasWeakPullup('RB7')).toBe(true);
    expect(core.hasWeakPullup('RB4')).toBe(true);
    expect(core.hasWeakPullup('RB0')).toBe(false); // output
    expect(core.hasWeakPullup('RA0')).toBe(false); // PORTA has none
  });

  it('a floating input with its pull-up reads 1', () => {
    const core = build(enablePullups);
    core.setInput('RB6', 'Z');
    expect(core.peek(SFR.PORTB) & 0x40).toBe(0); // pull-ups not enabled yet
    runToHalt(core);
    expect(core.peek(SFR.PORTB) & 0x40).toBe(0x40);
    core.setInput('RB6', 0); // a closed push-button to ground wins
    expect(core.peek(SFR.PORTB) & 0x40).toBe(0);
    core.setInput('RB6', 'Z');
    expect(core.peek(SFR.PORTB) & 0x40).toBe(0x40);
  });

  it('unconnected inputs (never reported by the circuit) read 1 once pull-ups are on', () => {
    const core = build(enablePullups);
    expect(core.peek(SFR.PORTB) & 0xf0).toBe(0);
    runToHalt(core);
    expect(core.peek(SFR.PORTB) & 0xf0).toBe(0xf0);
  });

  it('report the pull-up change as an IO change', () => {
    const core = build(enablePullups);
    core.step();
    expect(core.step().ioChanged).toBe(true);
  });
});

describe('read-modify-write on PORTB', () => {
  it('BSF on an output bit copies the level of an input pin into its latch', () => {
    const core = build(`
      BSF STATUS, RP0
      MOVLW 0xFE
      MOVWF TRISB       ; RB0 output, RB1 input
      BCF STATUS, RP0
      CLRF PORTB        ; latch = 0x00
      BSF PORTB, 0      ; reads pins (RB1 = 1), writes 0x03
      BSF STATUS, RP0
      MOVLW 0xFC
      MOVWF TRISB       ; now RB1 is an output too
      BCF STATUS, RP0
      GOTO $
    `);
    core.setInput('RB1', 1);
    runToHalt(core);
    expect(core.getDrive('RB0')).toBe(1);
    expect(core.getDrive('RB1')).toBe(1); // never written by the program
  });

  it('without the input high, the latch bit stays 0', () => {
    const core = build(`
      BSF STATUS, RP0
      MOVLW 0xFE
      MOVWF TRISB
      BCF STATUS, RP0
      CLRF PORTB
      BSF PORTB, 0
      BSF STATUS, RP0
      MOVLW 0xFC
      MOVWF TRISB
      BCF STATUS, RP0
      GOTO $
    `);
    runToHalt(core);
    expect(core.getDrive('RB1')).toBe(0);
  });
});

describe('StepResult.ioChanged', () => {
  it('is true only when a latch or TRIS value changes', () => {
    const core = build(`
      BSF STATUS, RP0   ; 0
      CLRF TRISB        ; 1 → TRISB changes
      BCF STATUS, RP0   ; 2
      MOVLW 0x01        ; 3
      MOVWF PORTB       ; 4 → latch changes
      MOVWF PORTB       ; 5 → same value
      MOVWF 0x20        ; 6
      GOTO $
    `);
    const changed = Array.from({ length: 7 }, () => core.step().ioChanged);
    expect(changed).toEqual([false, true, false, false, true, false, false]);
  });
});
