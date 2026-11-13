import { describe, expect, it } from 'vitest';
import type { Pic16F84A } from '../src/index';
import { build, C, DC, flags, STATUS, Z } from './helpers';

const REG = 0x20;

interface Init {
  w?: number;
  f?: number;
  /** Initial C/DC/Z bits (TO/PD stay at their reset value 1). */
  cdz?: number;
}

/** Execute one instruction placed at 0x000 with the given W, register 0x20 and flags. */
function exec1(instruction: string, init: Init = {}): { core: Pic16F84A; cycles: number } {
  const core = build(`${instruction}\n GOTO $`);
  core.setW(init.w ?? 0);
  core.poke(REG, init.f ?? 0);
  core.poke(STATUS, 0x18 | (init.cdz ?? 0));
  const { cycles } = core.step();
  return { core, cycles };
}

describe('ADDWF / ADDLW (C, DC, Z)', () => {
  const cases: [number, number, number, number][] = [
    // f, w, result, C|DC|Z
    [0x00, 0x00, 0x00, Z],
    [0x0f, 0x01, 0x10, DC],
    [0x08, 0x07, 0x0f, 0],
    [0x08, 0x08, 0x10, DC],
    [0xff, 0x01, 0x00, C | DC | Z],
    [0x80, 0x80, 0x00, C | Z],
    [0xf0, 0x10, 0x00, C | Z],
    [0xff, 0xff, 0xfe, C | DC],
    [200, 100, 44, C],
    [250, 6, 0, C | DC | Z],
  ];
  it.each(cases)('ADDWF f=%i W=%i → %i', (f, w, result, expected) => {
    const { core, cycles } = exec1(`ADDWF ${REG}, W`, { f, w, cdz: expected ^ (C | DC | Z) });
    expect(core.w).toBe(result);
    expect(core.peek(REG)).toBe(f);
    expect(core.peek(STATUS) & 7).toBe(expected);
    expect(cycles).toBe(1);
  });
  it.each(cases)('ADDLW k=%i W=%i → %i', (k, w, result, expected) => {
    const { core } = exec1(`ADDLW ${k}`, { w, cdz: expected ^ (C | DC | Z) });
    expect(core.w).toBe(result);
    expect(core.peek(STATUS) & 7).toBe(expected);
  });
  it('ADDWF f,F stores in the register and leaves W', () => {
    const { core } = exec1(`ADDWF ${REG}, F`, { f: 0x15, w: 0x10 });
    expect(core.peek(REG)).toBe(0x25);
    expect(core.w).toBe(0x10);
  });
});

describe('SUBWF / SUBLW (C and DC are NOT borrow)', () => {
  const cases: [number, number, number, number][] = [
    // minuend, W, result, C|DC|Z
    [3, 2, 1, C | DC],
    [2, 2, 0, C | DC | Z], // equal operands: C = 1 and Z = 1
    [1, 2, 0xff, 0],
    [0, 0, 0, C | DC | Z],
    [0, 1, 0xff, 0],
    [0x10, 0x01, 0x0f, C], // borrow out of bit 4: DC = 0
    [0x1f, 0x0f, 0x10, C | DC],
    [0x80, 0x7f, 0x01, C],
    [0xff, 0xff, 0, C | DC | Z],
    [0x00, 0xff, 0x01, 0],
  ];
  it.each(cases)('SUBWF f=%i W=%i → %i', (f, w, result, expected) => {
    const { core } = exec1(`SUBWF ${REG}, F`, { f, w, cdz: expected ^ (C | DC | Z) });
    expect(core.peek(REG)).toBe(result);
    expect(core.w).toBe(w);
    expect(core.peek(STATUS) & 7).toBe(expected);
  });
  it.each(cases)('SUBLW k=%i W=%i → %i', (k, w, result, expected) => {
    const { core } = exec1(`SUBLW ${k}`, { w, cdz: expected ^ (C | DC | Z) });
    expect(core.w).toBe(result);
    expect(core.peek(STATUS) & 7).toBe(expected);
  });

  // Prof's TP « Manipulation du status » table, z = x - y compiled as MOVF y,W / SUBWF x,W.
  it.each([
    [5, 6, 0xff, 0, 0],
    [6, 5, 0x01, 1, 0],
    [5, 5, 0x00, 1, 1],
    [10, 3, 0x07, 1, 0],
    [3, 10, 0xf9, 0, 0],
  ])('x=%i y=%i → z=%i C=%i Z=%i', (x, y, z, c, zf) => {
    const core = build(`
      MOVF 0x0D, W
      SUBWF 0x0C, W
      MOVWF 0x0E
      GOTO $
    `);
    core.poke(0x0c, x);
    core.poke(0x0d, y);
    core.step();
    core.step();
    core.step();
    expect(core.peek(0x0e)).toBe(z);
    expect(flags(core).C).toBe(c);
    expect(flags(core).Z).toBe(zf);
  });
});

describe('logic instructions affect Z only', () => {
  it.each([
    ['ANDWF', 0xc2, 0x17, 0x02],
    ['ANDWF', 0xf0, 0x0f, 0x00],
    ['IORWF', 0x13, 0x91, 0x93],
    ['IORWF', 0x00, 0x00, 0x00],
    ['XORWF', 0xaf, 0xb5, 0x1a],
    ['XORWF', 0x5a, 0x5a, 0x00],
  ])('%s f=%i W=%i → %i', (op, f, w, result) => {
    for (const cdz of [0, C | DC]) {
      const { core } = exec1(`${op} ${REG}, W`, { f, w, cdz });
      expect(core.w).toBe(result);
      expect(flags(core).Z).toBe(result === 0 ? 1 : 0);
      expect(core.peek(STATUS) & (C | DC)).toBe(cdz);
    }
  });
  it.each([
    ['ANDLW 0x5F', 0xa3, 0x03],
    ['ANDLW 0x00', 0xff, 0x00],
    ['IORLW 0x35', 0x9a, 0xbf],
    ['IORLW 0x00', 0x00, 0x00],
    ['XORLW 0xAF', 0xb5, 0x1a],
    ['XORLW 0xFF', 0xff, 0x00],
  ])('%s with W=%i → %i', (ins, w, result) => {
    const { core } = exec1(ins, { w, cdz: C | DC });
    expect(core.w).toBe(result);
    expect(flags(core).Z).toBe(result === 0 ? 1 : 0);
    expect(core.peek(STATUS) & (C | DC)).toBe(C | DC);
  });
  it('COMF', () => {
    expect(exec1(`COMF ${REG}, W`, { f: 0x13 }).core.w).toBe(0xec);
    const { core } = exec1(`COMF ${REG}, F`, { f: 0xff, cdz: C | DC });
    expect(core.peek(REG)).toBe(0);
    expect(core.peek(STATUS) & 7).toBe(C | DC | Z);
  });
});

describe('INCF / DECF / MOVF / CLRF / CLRW (Z only)', () => {
  it('INCF wraps 0xFF → 0x00 with Z = 1 and C untouched', () => {
    for (const cdz of [0, C | DC]) {
      const { core } = exec1(`INCF ${REG}, F`, { f: 0xff, cdz });
      expect(core.peek(REG)).toBe(0);
      expect(core.peek(STATUS) & 7).toBe(cdz | Z);
    }
    expect(exec1(`INCF ${REG}, W`, { f: 0x0f, cdz: Z }).core.w).toBe(0x10);
    expect(flags(exec1(`INCF ${REG}, W`, { f: 0x0f, cdz: Z }).core).Z).toBe(0);
  });
  it('DECF 0x01 → 0 sets Z; 0x00 → 0xFF clears Z', () => {
    let { core } = exec1(`DECF ${REG}, F`, { f: 1 });
    expect(core.peek(REG)).toBe(0);
    expect(flags(core).Z).toBe(1);
    ({ core } = exec1(`DECF ${REG}, W`, { f: 0, cdz: Z | C }));
    expect(core.w).toBe(0xff);
    expect(core.peek(REG)).toBe(0);
    expect(core.peek(STATUS) & 7).toBe(C);
  });
  it('MOVF f,W and MOVF f,F test for zero', () => {
    let { core } = exec1(`MOVF ${REG}, W`, { f: 0, w: 0x55 });
    expect(core.w).toBe(0);
    expect(flags(core).Z).toBe(1);
    ({ core } = exec1(`MOVF ${REG}, F`, { f: 0x80, w: 0x55, cdz: Z }));
    expect(core.w).toBe(0x55);
    expect(core.peek(REG)).toBe(0x80);
    expect(flags(core).Z).toBe(0);
  });
  it('CLRF sets Z, CLRW sets Z', () => {
    let { core } = exec1(`CLRF ${REG}`, { f: 0x5a, cdz: C });
    expect(core.peek(REG)).toBe(0);
    expect(core.peek(STATUS) & 7).toBe(C | Z);
    ({ core } = exec1('CLRW', { w: 0x5a }));
    expect(core.w).toBe(0);
    expect(flags(core).Z).toBe(1);
  });
});

describe('RLF / RRF (C only) and SWAPF (none)', () => {
  it('RLF: datasheet example 1110 0110, C = 0 → W = 1100 1100, C = 1', () => {
    const { core } = exec1(`RLF ${REG}, W`, { f: 0b11100110 });
    expect(core.w).toBe(0b11001100);
    expect(core.peek(REG)).toBe(0b11100110);
    expect(flags(core).C).toBe(1);
  });
  it('RRF: datasheet example 1110 0110, C = 0 → W = 0111 0011, C = 0', () => {
    const { core } = exec1(`RRF ${REG}, W`, { f: 0b11100110, cdz: 0 });
    expect(core.w).toBe(0b01110011);
    expect(flags(core).C).toBe(0);
  });
  it('rotations go through C and never touch Z or DC', () => {
    let { core } = exec1(`RLF ${REG}, F`, { f: 0x80, cdz: 0 });
    expect(core.peek(REG)).toBe(0x00);
    expect(core.peek(STATUS) & 7).toBe(C); // result 0 but Z untouched
    ({ core } = exec1(`RRF ${REG}, F`, { f: 0x01, cdz: C | DC | Z }));
    expect(core.peek(REG)).toBe(0x80);
    expect(core.peek(STATUS) & 7).toBe(C | DC | Z);
    ({ core } = exec1(`RRF ${REG}, F`, { f: 0x00, cdz: C }));
    expect(core.peek(REG)).toBe(0x80);
    expect(core.peek(STATUS) & 7).toBe(0);
  });
  it('SWAPF swaps nibbles without flags', () => {
    const { core } = exec1(`SWAPF ${REG}, F`, { f: 0xa5, cdz: 0 });
    expect(core.peek(REG)).toBe(0x5a);
    expect(core.peek(STATUS) & 7).toBe(0);
    expect(exec1(`SWAPF ${REG}, W`, { f: 0x00, cdz: 0 }).core.peek(STATUS) & 7).toBe(0);
  });
});

describe('instructions without flags', () => {
  it('MOVWF, MOVLW, BCF, BSF leave C/DC/Z', () => {
    for (const ins of [`MOVWF ${REG}`, 'MOVLW 0', `BCF ${REG}, 3`, `BSF ${REG}, 3`, 'NOP']) {
      for (const cdz of [0, C | DC | Z]) {
        expect(exec1(ins, { w: 0, f: 0, cdz }).core.peek(STATUS) & 7).toBe(cdz);
      }
    }
  });
  it('MOVWF / MOVLW move data', () => {
    expect(exec1(`MOVWF ${REG}`, { w: 0x4f }).core.peek(REG)).toBe(0x4f);
    expect(exec1('MOVLW 0x5A').core.w).toBe(0x5a);
  });
  it('BCF / BSF: datasheet examples', () => {
    expect(exec1(`BCF ${REG}, 7`, { f: 0xc7 }).core.peek(REG)).toBe(0x47);
    expect(exec1(`BSF ${REG}, 7`, { f: 0x0a }).core.peek(REG)).toBe(0x8a);
  });
});

describe('skip instructions', () => {
  function skipTest(ins: string, f: number): { skipped: boolean; cycles: number; core: Pic16F84A } {
    const core = build(`
      ${ins}
      MOVLW 1
      MOVLW 2
      GOTO $
    `);
    core.poke(REG, f);
    core.poke(STATUS, 0x18);
    const { cycles } = core.step();
    return { skipped: core.pc === 2, cycles, core };
  }
  it('DECFSZ skips on zero (2 cycles) without touching Z', () => {
    const taken = skipTest(`DECFSZ ${REG}, F`, 1);
    expect(taken.skipped).toBe(true);
    expect(taken.cycles).toBe(2);
    expect(taken.core.peek(REG)).toBe(0);
    expect(flags(taken.core).Z).toBe(0);
    const notTaken = skipTest(`DECFSZ ${REG}, F`, 0);
    expect(notTaken.skipped).toBe(false);
    expect(notTaken.cycles).toBe(1);
    expect(notTaken.core.peek(REG)).toBe(0xff);
    const toW = skipTest(`DECFSZ ${REG}, W`, 1);
    expect(toW.skipped).toBe(true);
    expect(toW.core.w).toBe(0);
    expect(toW.core.peek(REG)).toBe(1);
  });
  it('INCFSZ skips on zero', () => {
    expect(skipTest(`INCFSZ ${REG}, F`, 0xff)).toMatchObject({ skipped: true, cycles: 2 });
    expect(skipTest(`INCFSZ ${REG}, F`, 0xfe)).toMatchObject({ skipped: false, cycles: 1 });
    expect(flags(skipTest(`INCFSZ ${REG}, F`, 0xff).core).Z).toBe(0);
  });
  it('BTFSC / BTFSS', () => {
    expect(skipTest(`BTFSC ${REG}, 3`, 0x00)).toMatchObject({ skipped: true, cycles: 2 });
    expect(skipTest(`BTFSC ${REG}, 3`, 0x08)).toMatchObject({ skipped: false, cycles: 1 });
    expect(skipTest(`BTFSS ${REG}, 7`, 0x80)).toMatchObject({ skipped: true, cycles: 2 });
    expect(skipTest(`BTFSS ${REG}, 7`, 0x7f)).toMatchObject({ skipped: false, cycles: 1 });
  });
});
