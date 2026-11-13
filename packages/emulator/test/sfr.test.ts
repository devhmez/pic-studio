import { describe, expect, it } from 'vitest';
import {
  BIT_SYMBOLS, bitName, EECON1_BITS, INTCON_BITS, isGpr, isImplemented, OPTION_BITS, SFR, SFR_TABLE, sfrAt,
  sfrByName, STATUS_BITS,
} from '../src/index';

describe('SFR table', () => {
  it('has the datasheet addresses', () => {
    expect(SFR).toEqual({
      INDF: 0x00, TMR0: 0x01, PCL: 0x02, STATUS: 0x03, FSR: 0x04, PORTA: 0x05, PORTB: 0x06,
      EEDATA: 0x08, EEADR: 0x09, PCLATH: 0x0a, INTCON: 0x0b,
      OPTION_REG: 0x81, TRISA: 0x85, TRISB: 0x86, EECON1: 0x88, EECON2: 0x89,
    });
  });

  it('maps the bank-1 mirrors', () => {
    for (const [mirror, name] of [[0x80, 'INDF'], [0x82, 'PCL'], [0x83, 'STATUS'], [0x84, 'FSR'], [0x8a, 'PCLATH'], [0x8b, 'INTCON']] as const) {
      expect(sfrAt(mirror)?.name).toBe(name);
    }
    expect(sfrAt(0x07)).toBeUndefined();
    expect(sfrAt(0x87)).toBeUndefined();
    expect(sfrByName('trisb')?.addr).toBe(0x86);
  });

  it('names the bits', () => {
    expect(STATUS_BITS).toEqual({ C: 0, DC: 1, Z: 2, PD: 3, TO: 4, RP0: 5, RP1: 6, IRP: 7 });
    expect(INTCON_BITS).toEqual({ RBIF: 0, INTF: 1, T0IF: 2, RBIE: 3, INTE: 4, T0IE: 5, EEIE: 6, GIE: 7 });
    expect(OPTION_BITS).toEqual({ PS0: 0, PS1: 1, PS2: 2, PSA: 3, T0SE: 4, T0CS: 5, INTEDG: 6, RBPU: 7 });
    expect(EECON1_BITS).toEqual({ RD: 0, WR: 1, WREN: 2, WRERR: 3, EEIF: 4 });
    expect(sfrAt(SFR.STATUS)?.bits).toEqual(['C', 'DC', 'Z', 'PD', 'TO', 'RP0', 'RP1', 'IRP']);
    expect(bitName(0x83, 2)).toBe('Z');
    expect(bitName(SFR.PORTA, 4)).toBe('RA4');
    expect(bitName(SFR.PORTA, 5)).toBeUndefined();
    expect(BIT_SYMBOLS.get('GIE')).toEqual({ register: 'INTCON', bit: 7 });
    expect(BIT_SYMBOLS.get('RB7')).toEqual({ register: 'PORTB', bit: 7 });
  });

  it('every bit name is unique', () => {
    const names = SFR_TABLE.flatMap((s) => s.bits.filter((b) => b !== null));
    expect(new Set(names).size).toBe(names.length);
  });

  it('classifies GPR and unimplemented locations', () => {
    expect(isGpr(0x0c)).toBe(true);
    expect(isGpr(0x4f)).toBe(true);
    expect(isGpr(0xcf)).toBe(true);
    expect(isGpr(0x50)).toBe(false);
    expect(isImplemented(0x07)).toBe(false);
    expect(isImplemented(0x89)).toBe(false); // EECON2 is not a physical register
    expect(isImplemented(0xd0)).toBe(false);
    expect(isImplemented(0x81)).toBe(true);
  });
});
