import { describe, expect, it } from 'vitest';
import { HexParseError, parseHex, Pic16F84A, writeHex } from '../src/index';

function program(words: number[]): Uint16Array {
  const p = new Uint16Array(1024).fill(0x3fff);
  p.set(words);
  return p;
}

describe('writeHex (INHX8M)', () => {
  it('writes little-endian words at byte address = word address × 2, config at 0x400E', () => {
    const text = writeHex({ program: program([0x3001, 0x2801]), config: 0x3ffb });
    expect(text).toBe(':0400000001300128A2\r\n:02400E00FB3F76\r\n:00000001FF\r\n');
  });

  it('splits records on 16-byte boundaries and skips erased words', () => {
    const words = Array.from({ length: 10 }, (_, i) => 0x3000 + i);
    const p = program(words);
    p[0x20] = 0x0008;
    const lines = writeHex({ program: p }, { eol: '\n' }).trim().split('\n');
    expect(lines.map((l) => l.slice(0, 9))).toEqual([':10000000', ':04001000', ':02004000', ':00000001']);
  });

  it('writes EEPROM data at 0x4200, one byte per word', () => {
    const eeprom = new Uint8Array(64).fill(0xff);
    eeprom[0] = 0x12;
    eeprom[1] = 0x34;
    const text = writeHex({ program: program([]), eeprom }, { eol: '\n' });
    expect(text.split('\n')[0]).toBe(':044200001200340074');
  });
});

describe('parseHex', () => {
  it('reads a MPASM-style file with CRLF line endings', () => {
    const image = parseHex(':0400000001300128A2\r\n:02400E00FB3F76\r\n:00000001FF\r\n');
    expect(image.program[0]).toBe(0x3001);
    expect(image.program[1]).toBe(0x2801);
    expect(image.program[2]).toBe(0x3fff);
    expect(image.config).toBe(0x3ffb);
    expect(image.eeprom).toBeUndefined();
    expect(image.warnings).toEqual([]);
  });

  it('round-trips program, config, EEPROM and user IDs', () => {
    const p = new Uint16Array(1024);
    for (let i = 0; i < 1024; i++) p[i] = (i * 7919 + 13) & 0x3fff;
    const eeprom = new Uint8Array(64).map((_, i) => (i * 37) & 0xff);
    const userId = Uint16Array.from([1, 2, 3, 4]);
    const image = parseHex(writeHex({ program: p, config: 0x3ff1, eeprom, userId }));
    expect(image.program).toEqual(p);
    expect(image.config).toBe(0x3ff1);
    expect(image.eeprom).toEqual(eeprom);
    expect(image.userId).toEqual(userId);
  });

  it('accepts LF endings, blank lines and extended linear address records', () => {
    const image = parseHex('\n:020000040000FA\n:0400000001300128A2\n\n:00000001FF\n');
    expect(image.program[1]).toBe(0x2801);
  });

  it('loads into the core', () => {
    const image = parseHex(writeHex({ program: program([0x3042, 0x2801]), config: 0x3ffb }));
    const core = new Pic16F84A();
    core.load(image.program, image.eeprom, image.config);
    core.step();
    expect(core.w).toBe(0x42);
  });

  it('rejects a bad checksum with a French message', () => {
    expect(() => parseHex(':0400000001300128A3\n:00000001FF')).toThrow(HexParseError);
    expect(() => parseHex(':0400000001300128A3\n:00000001FF')).toThrow(/ligne 1 : somme de contrôle incorrecte/);
  });

  it('rejects malformed records', () => {
    expect(() => parseHex('0400000001300128A2')).toThrow(/doit commencer par ':'/);
    expect(() => parseHex(':04000000013001A2')).toThrow(/longueur incohérente/);
    expect(() => parseHex(':0Z')).toThrow(/caractères hexadécimaux invalides/);
    // Anything after the end-of-file record is ignored.
    expect(() => parseHex(':00000001FF\n:0400000001300128A3')).not.toThrow();
  });

  it('warns about data outside the PIC16F84A memory and a missing EOF record', () => {
    // Word 0x400 (byte 0x0800) does not exist on a 1K part.
    const image = parseHex(':020800000030C6\n');
    expect(image.warnings).toHaveLength(2);
    expect(image.warnings.join(' ')).toMatch(/hors de la mémoire/);
    expect(image.warnings.join(' ')).toMatch(/Fin de fichier/);
  });
});
