import { describe, expect, it } from 'vitest';
import {
  bin, binGrouped, bitOf, formatClock, formatCycleTime, formatTime, frenchDecimal, groupThousands, hex, hex0x, hexH, plural,
} from './format';

const NNBSP = ' ';

describe('hex formatting', () => {
  it('pads and upper-cases', () => {
    expect(hex(4, 3)).toBe('004');
    expect(hex(0x1683, 4)).toBe('1683');
    expect(hex(0xab, 2)).toBe('AB');
    expect(hex(0x3ff, 3)).toBe('3FF');
  });
  it('writes C literals like the prof (lower-case x, upper-case digits)', () => {
    expect(hex0x(6)).toBe('0x06');
    expect(hex0x(0x12, 4)).toBe('0x0012');
    expect(hex0x(255)).toBe('0xFF');
  });
  it('writes course addresses with an h suffix', () => {
    expect(hexH(0)).toBe('0000h');
    expect(hexH(4)).toBe('0004h');
    expect(hexH(0x3ff)).toBe('03FFh');
  });
});

describe('binary formatting', () => {
  it('prints MSB first with fixed width', () => {
    expect(bin(6)).toBe('00000110');
    expect(bin(0x19)).toBe('00011001'); // her MPLAB watch: STATUS 25 after 200 + 100
    expect(bin(0x1f, 5)).toBe('11111');
    expect(bin(0x1ff, 8)).toBe('11111111');
  });
  it('groups nibbles', () => {
    expect(binGrouped(6)).toBe('0000 0110');
    expect(binGrouped(0xabcd, 16)).toBe('1010 1011 1100 1101');
    expect(binGrouped(5, 5)).toBe('0 0101');
  });
  it('reads single bits', () => {
    expect(bitOf(0b100, 2)).toBe(1);
    expect(bitOf(0b100, 1)).toBe(0);
  });
});

describe('French number and time formatting', () => {
  it('groups thousands with narrow no-break spaces', () => {
    expect(groupThousands(0)).toBe('0');
    expect(groupThousands(999)).toBe('999');
    expect(groupThousands(1234)).toBe(`1${NNBSP}234`);
    expect(groupThousands(1234567)).toBe(`1${NNBSP}234${NNBSP}567`);
    expect(groupThousands(-1500)).toBe(`-1${NNBSP}500`);
  });
  it('uses a decimal comma and trims zeros', () => {
    expect(frenchDecimal(1.5, 3)).toBe('1,5');
    expect(frenchDecimal(2, 3)).toBe('2');
    expect(frenchDecimal(12.3456, 2)).toBe('12,35');
    expect(frenchDecimal(-0.25, 2)).toBe('-0,25');
    expect(frenchDecimal(-0.0001, 2)).toBe('0');
  });
  it('picks the readable time unit', () => {
    expect(formatTime(0)).toBe('0 s');
    expect(formatTime(4e-6)).toBe('4 µs');
    expect(formatTime(0.0125)).toBe('12,5 ms');
    expect(formatTime(0.5)).toBe('500 ms');
    expect(formatTime(2.5)).toBe('2,5 s');
    expect(formatTime(Number.NaN)).toBe('0 s');
  });
  it('formats the clock and the instruction cycle (4 oscillator periods)', () => {
    expect(formatClock(1_000_000)).toBe('1 MHz');
    expect(formatClock(8_000_000)).toBe('8 MHz');
    expect(formatClock(32_768)).toBe('32,768 kHz');
    expect(formatCycleTime(1_000_000)).toBe('4 µs');
    expect(formatCycleTime(8_000_000)).toBe('0,5 µs');
  });
  it('pluralises', () => {
    expect(plural(1, 'erreur')).toBe('1 erreur');
    expect(plural(3, 'erreur')).toBe('3 erreurs');
    expect(plural(0, 'mot')).toBe('0 mot');
  });
});
