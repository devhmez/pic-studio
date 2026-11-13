import { describe, expect, it } from 'vitest';
import { SFR } from '../src/index';
import type { Pic16F84A } from '../src/index';
import { build, buildWithLabels, runToHalt, stepUntilPc } from './helpers';

const RD = 0x01;
const WR = 0x02;
const WREN = 0x04;
const WRERR = 0x08;
const EEIF = 0x10;

const READ_PROGRAM = `
      MOVLW 5
      MOVWF EEADR
      BSF STATUS, RP0
      BSF EECON1, RD
      BCF STATUS, RP0
      MOVF EEDATA, W
      GOTO $
`;

function writeProgram(unlock: string, wren = true): string {
  return `
      MOVLW 0x07
      MOVWF EEADR
      MOVLW 0xC3
      MOVWF EEDATA
      BSF STATUS, RP0
      ${wren ? 'BSF EECON1, WREN' : 'NOP'}
      ${unlock}
start:
      BSF EECON1, WR
      BCF EECON1, WREN
wait: BTFSC EECON1, WR
      GOTO wait
      BCF STATUS, RP0
      GOTO $
  `;
}

const UNLOCK = `
      MOVLW 0x55
      MOVWF EECON2
      MOVLW 0xAA
      MOVWF EECON2
`;

describe('data EEPROM read', () => {
  it('RD copies EE[EEADR] into EEDATA immediately and RD reads back 0', () => {
    const image = new Uint8Array(64).fill(0xff);
    image[5] = 0x3c;
    const core = build(READ_PROGRAM, { eeprom: image });
    runToHalt(core);
    expect(core.w).toBe(0x3c);
    expect(core.peek(SFR.EECON1) & RD).toBe(0);
  });

  it('erased locations read 0xFF (Proteus MODDATA=64,255)', () => {
    const core = build(READ_PROGRAM);
    runToHalt(core);
    expect(core.w).toBe(0xff);
  });

  it('EEADR wraps on 64 bytes', () => {
    const image = new Uint8Array(64);
    image[1] = 0x11;
    const core = build(READ_PROGRAM.replace('MOVLW 5', 'MOVLW 0x41'), { eeprom: image });
    runToHalt(core);
    expect(core.w).toBe(0x11);
  });

  it('EECON2 reads 0', () => {
    const core = build('BSF STATUS, RP0\n MOVLW 0x55\n MOVWF EECON2\n MOVF EECON2, W\n GOTO $');
    runToHalt(core);
    expect(core.w).toBe(0);
  });
});

describe('data EEPROM write', () => {
  /** Run up to and including `start: BSF EECON1, WR`. */
  function startWrite(program: string): { core: Pic16F84A; start: number; startCycle: number } {
    const { core, label } = buildWithLabels(program);
    const start = label('start');
    stepUntilPc(core, start);
    const startCycle = core.cycles;
    core.step();
    return { core, start, startCycle };
  }

  it('the 55h/AAh sequence + WR starts a write that ends 10 ms later (WR cleared, EEIF set)', () => {
    const { core, startCycle } = startWrite(writeProgram(UNLOCK));
    expect(core.peek(SFR.EECON1) & WR).toBe(WR);
    expect(core.peekEeprom(7)).toBe(0xff);
    let before = core.cycles;
    while (core.peek(SFR.EECON1) & WR) {
      before = core.cycles;
      core.step();
    }
    expect(before - startCycle).toBeLessThan(2500);
    expect(core.cycles - startCycle).toBeGreaterThanOrEqual(2500); // 10 ms at 1 MHz
    expect(core.cycles - startCycle).toBeLessThanOrEqual(2502);
    expect(core.peekEeprom(7)).toBe(0xc3);
    expect(core.peek(SFR.EECON1) & (EEIF | WREN | WR)).toBe(EEIF);
    expect(core.snapshot().eeprom[7]).toBe(0xc3);
  });

  it('takes 10 ms of simulated time at 8 MHz as well', () => {
    const { core } = buildWithLabels(writeProgram(UNLOCK), { clockHz: 8_000_000 });
    core.run(19_990);
    expect(core.peekEeprom(7)).toBe(0xff);
    core.run(100);
    expect(core.peekEeprom(7)).toBe(0xc3);
  });

  it('does nothing without WREN', () => {
    const { core } = startWrite(writeProgram(UNLOCK, false));
    expect(core.peek(SFR.EECON1) & WR).toBe(0);
    core.run(5000);
    expect(core.peekEeprom(7)).toBe(0xff);
    expect(core.peek(SFR.EECON1) & EEIF).toBe(0);
  });

  it.each([
    ['no unlock sequence', ''],
    ['AAh before 55h', 'MOVLW 0xAA\n MOVWF EECON2\n MOVLW 0x55\n MOVWF EECON2'],
    ['55h only', 'MOVLW 0x55\n MOVWF EECON2'],
    ['wrong second byte', 'MOVLW 0x55\n MOVWF EECON2\n MOVLW 0xAB\n MOVWF EECON2'],
  ])('does nothing with %s', (_label, unlock) => {
    const { core } = startWrite(writeProgram(unlock));
    expect(core.peek(SFR.EECON1) & WR).toBe(0);
    core.run(5000);
    expect(core.peekEeprom(7)).toBe(0xff);
  });

  it('each write needs a new unlock sequence', () => {
    const { core, start } = startWrite(writeProgram(UNLOCK));
    core.run(3000);
    expect(core.peekEeprom(7)).toBe(0xc3);
    core.poke(SFR.EEDATA, 0x5a);
    core.poke(SFR.EECON1, WREN);
    core.poke(SFR.STATUS, core.peek(SFR.STATUS) | 0x20);
    core.setPc(start); // BSF EECON1, WR again, without the unlock sequence
    core.step();
    expect(core.peek(SFR.EECON1) & WR).toBe(0);
  });

  it('WR cannot be cleared by software', () => {
    const { core } = startWrite(writeProgram(UNLOCK));
    core.poke(SFR.STATUS, core.peek(SFR.STATUS) | 0x20);
    expect(core.peek(SFR.EECON1) & WR).toBe(WR);
    core.step(); // BCF EECON1, WREN keeps WR
    expect(core.peek(SFR.EECON1) & (WR | WREN)).toBe(WR);
  });

  it('a MCLR reset during the write aborts it and sets WRERR', () => {
    const { core } = startWrite(writeProgram(UNLOCK));
    core.run(100);
    core.reset('mclr');
    expect(core.peek(SFR.EECON1) & (WRERR | WR)).toBe(WRERR);
    // The program restarts and begins a new write, which needs another 10 ms.
    core.run(2000);
    expect(core.peekEeprom(7)).toBe(0xff);
  });
});
