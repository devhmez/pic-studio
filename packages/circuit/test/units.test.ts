import { describe, expect, it } from 'vitest';
import { formatValue, parseFrequency, parseResistance, parseValue } from '../src/units';

describe('engineering values', () => {
  it('reads the values found in the prof\'s files', () => {
    expect(parseResistance('220')).toBe(220);
    expect(parseResistance('1k')).toBe(1000);
    expect(parseResistance('10k')).toBe(10_000);
    expect(parseResistance('1M')).toBe(1_000_000);
    expect(parseResistance('200K')).toBe(200_000);
    expect(parseFrequency('1MHz')).toBe(1_000_000);
    expect(parseFrequency('8MHz')).toBe(8_000_000);
    expect(parseValue('18m')).toBeCloseTo(0.018);
    expect(parseValue('0.1ms')).toBeCloseTo(0.0001);
    expect(parseValue('2.2V')).toBe(2.2);
    expect(parseValue('10mA')).toBeCloseTo(0.01);
  });

  it('reads RKM and SPICE spellings', () => {
    expect(parseResistance('4k7')).toBeCloseTo(4700);
    expect(parseResistance('4R7')).toBeCloseTo(4.7);
    expect(parseResistance('1meg')).toBe(1_000_000);
    expect(parseResistance('470 Ω')).toBe(470);
    expect(parseFrequency(32768)).toBe(32768);
  });

  it('rejects junk and non-positive resistances', () => {
    expect(parseValue('abc')).toBeNull();
    expect(parseValue('')).toBeNull();
    expect(parseValue('k')).toBeNull();
    expect(parseResistance('0')).toBeNull();
    expect(parseResistance(undefined)).toBeNull();
  });

  it('formats like ISIS', () => {
    expect(formatValue(220)).toBe('220');
    expect(formatValue(10_000)).toBe('10k');
    expect(formatValue(8e6, 'Hz')).toBe('8MHz');
    expect(formatValue(4700)).toBe('4.7k');
  });
});
