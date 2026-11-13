import { describe, expect, it } from 'vitest';
import { compile } from '@pic/compiler';
import { addressesByLine, diffLineMap, mapLine, remapAddresses, sameProgram } from './builds';

const SOURCE = 'void main() {\n  TRISB = 0;\n  while (1) {\n    PORTB = 1;\n    PORTB = 0;\n  }\n}\n';
const lineOf = (src: string, text: string): number => src.split('\n').findIndex((l) => l.includes(text)) + 1;

describe('diffLineMap', () => {
  it('follows lines inserted and deleted above', () => {
    const map = diffLineMap('a\nb\nc\nd', 'x\na\nb\nd');
    expect([1, 2, 3, 4].map(map)).toEqual([2, 3, null, 4]);
  });

  it('pairs a line edited in place with its new text', () => {
    const map = diffLineMap('a\n  n = n + 1;\nc', 'a\n  n = n + 1; // compteur\nc');
    expect([1, 2, 3].map(map)).toEqual([1, 2, 3]);
  });

  it('ignores line-ending and trailing-space differences', () => {
    const map = diffLineMap('a  \r\nb\r\nc', 'z\na\nb\nc');
    expect([1, 2, 3].map(map)).toEqual([2, 3, 4]);
  });

  it('reports out-of-range lines as removed', () => {
    const map = diffLineMap('a\nb', 'a\nb');
    expect(map(0)).toBeNull();
    expect(map(3)).toBeNull();
  });
});

describe('remapAddresses', () => {
  it('keeps addresses when the machine code is the same', () => {
    const a = compile(SOURCE);
    const b = compile(SOURCE.replace('PORTB = 1;', 'PORTB = 1; // allumer'));
    expect(sameProgram(a, b)).toBe(true);
    const bps = [a.lineToAddr.get(4)! + 1];
    expect(remapAddresses(bps, a, b)).toBe(bps);
  });

  it('moves an address with its statement and keeps its rank inside the line', () => {
    const a = compile(SOURCE);
    const edited = SOURCE.replace('  TRISB = 0;\n', '  TRISA = 0;\n  TRISB = 0;\n');
    const b = compile(edited);
    expect(sameProgram(a, b)).toBe(false);
    const oldLine = lineOf(SOURCE, 'PORTB = 1;');
    const newLine = lineOf(edited, 'PORTB = 1;');
    const second = addressesByLine(a).get(oldLine)![1];
    expect(remapAddresses([second], a, b)).toEqual([addressesByLine(b).get(newLine)![1]]);
    expect(mapLine(oldLine, a, b)).toBe(newLine);
  });

  it('drops addresses whose statement was deleted', () => {
    const a = compile(SOURCE);
    const b = compile(SOURCE.replace('    PORTB = 0;\n', ''));
    expect(remapAddresses([a.lineToAddr.get(lineOf(SOURCE, 'PORTB = 0;'))!], a, b)).toEqual([]);
  });
});
