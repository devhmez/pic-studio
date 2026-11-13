import { describe, expect, it } from 'vitest';
import { decode, decodeOp, encode, INSTRUCTIONS, instructionInfo, Op, type Mnemonic } from '../src/index';

describe('instruction set table', () => {
  it('has the 35 PIC16F84A instructions plus the 2 legacy ones', () => {
    expect(INSTRUCTIONS.filter((i) => !i.legacy)).toHaveLength(35);
    expect(INSTRUCTIONS.filter((i) => i.legacy).map((i) => i.mnemonic)).toEqual(['OPTION', 'TRIS']);
  });

  it('lists the datasheet status bits and cycle counts', () => {
    const status = (m: string): string => instructionInfo(m)!.status.join(',');
    for (const m of ['ADDWF', 'ADDLW', 'SUBWF', 'SUBLW']) expect(status(m)).toBe('C,DC,Z');
    for (const m of ['ANDWF', 'ANDLW', 'IORWF', 'IORLW', 'XORWF', 'XORLW', 'CLRF', 'CLRW', 'COMF', 'DECF', 'INCF', 'MOVF']) {
      expect(status(m)).toBe('Z');
    }
    expect(status('RLF')).toBe('C');
    expect(status('RRF')).toBe('C');
    for (const m of ['CLRWDT', 'SLEEP']) expect(status(m)).toBe('TO,PD');
    for (const m of ['MOVWF', 'MOVLW', 'SWAPF', 'NOP', 'BCF', 'BSF', 'BTFSC', 'BTFSS', 'DECFSZ', 'INCFSZ', 'CALL', 'GOTO', 'RETURN', 'RETLW', 'RETFIE']) {
      expect(status(m)).toBe('');
    }
    for (const m of ['CALL', 'GOTO', 'RETURN', 'RETLW', 'RETFIE']) expect(instructionInfo(m)!.cycles).toBe(2);
    expect(INSTRUCTIONS.filter((i) => i.skip).map((i) => i.mnemonic).sort()).toEqual(['BTFSC', 'BTFSS', 'DECFSZ', 'INCFSZ']);
  });
});

describe('encoding (DS35007 Table 7-2)', () => {
  it.each<[Mnemonic, number, number, number]>([
    ['ADDWF', 0x0d, 0, 0x070d],
    ['ADDWF', 0x0d, 1, 0x078d],
    ['ANDWF', 0x20, 1, 0x05a0],
    ['CLRF', 0x06, 0, 0x0186],
    ['COMF', 0x0c, 1, 0x098c],
    ['DECF', 0x0c, 1, 0x038c],
    ['DECFSZ', 0x0c, 1, 0x0b8c],
    ['INCF', 0x0c, 1, 0x0a8c],
    ['INCFSZ', 0x0c, 1, 0x0f8c],
    ['IORWF', 0x0c, 0, 0x040c],
    ['MOVF', 0x0c, 0, 0x080c],
    ['MOVWF', 0x06, 0, 0x0086],
    ['RLF', 0x0c, 1, 0x0d8c],
    ['RRF', 0x0c, 1, 0x0c8c],
    ['SUBWF', 0x0d, 0, 0x020d],
    ['SWAPF', 0x0c, 1, 0x0e8c],
    ['XORWF', 0x0c, 0, 0x060c],
    ['BCF', 0x03, 5, 0x1283],
    ['BSF', 0x03, 5, 0x1683],
    ['BTFSC', 0x03, 2, 0x1903],
    ['BTFSS', 0x03, 0, 0x1c03],
    ['ADDLW', 0x15, 0, 0x3e15],
    ['ANDLW', 0x5f, 0, 0x395f],
    ['CALL', 0x123, 0, 0x2123],
    ['GOTO', 0x7ff, 0, 0x2fff],
    ['IORLW', 0x35, 0, 0x3835],
    ['MOVLW', 0x06, 0, 0x3006],
    ['RETLW', 0x3f, 0, 0x343f],
    ['SUBLW', 0x02, 0, 0x3c02],
    ['XORLW', 0xaf, 0, 0x3aaf],
  ])('%s %i,%i = %i', (m, a, b, word) => {
    expect(encode(m, a, b)).toBe(word);
  });

  it('operand-less instructions', () => {
    expect(encode('NOP')).toBe(0x0000);
    expect(encode('CLRW')).toBe(0x0103);
    expect(encode('RETURN')).toBe(0x0008);
    expect(encode('RETFIE')).toBe(0x0009);
    expect(encode('SLEEP')).toBe(0x0063);
    expect(encode('CLRWDT')).toBe(0x0064);
    expect(encode('OPTION')).toBe(0x0062);
    expect(encode('TRIS', 6)).toBe(0x0066);
  });

  it('bank-1 register addresses keep their 7 low bits', () => {
    expect(encode('MOVWF', 0x86)).toBe(0x0086);
    expect(encode('BSF', 0x88, 1)).toBe(0x1488);
  });
});

describe('decoding', () => {
  it('round-trips every canonical encoding', () => {
    for (let word = 0; word < 0x4000; word++) {
      const d = decode(word);
      if (d.mnemonic === undefined) continue;
      const info = instructionInfo(d.mnemonic)!;
      const operands: [number, number] =
        info.form === 'fd' ? [d.f, d.d]
          : info.form === 'fb' ? [d.f, d.b]
            : info.form === 'k8' || info.form === 'k11' ? [d.k, 0]
              : [d.f, 0];
      const again = encode(d.mnemonic, ...operands);
      expect(decode(again)).toEqual(d);
    }
  });

  it('treats the don\'t-care bits like the silicon', () => {
    expect(decodeOp(0x0020)).toBe(Op.NOP);
    expect(decodeOp(0x0060)).toBe(Op.NOP);
    expect(decodeOp(0x0100)).toBe(Op.CLRW);
    expect(decodeOp(0x017f)).toBe(Op.CLRW);
    expect(decodeOp(0x3100)).toBe(Op.MOVLW);
    expect(decodeOp(0x3700)).toBe(Op.RETLW);
    expect(decodeOp(0x3d00)).toBe(Op.SUBLW);
    expect(decodeOp(0x3fff)).toBe(Op.ADDLW); // erased flash
  });

  it('marks unassigned opcodes as INVALID (executed as NOP)', () => {
    for (const word of [0x0001, 0x0007, 0x000a, 0x0010, 0x0061, 0x0068, 0x3b00]) {
      expect(decodeOp(word)).toBe(Op.INVALID);
      expect(decode(word).mnemonic).toBeUndefined();
    }
  });

  it('extracts f, d, b and k', () => {
    expect(decode(0x078d)).toMatchObject({ mnemonic: 'ADDWF', f: 0x0d, d: 1 });
    expect(decode(0x1683)).toMatchObject({ mnemonic: 'BSF', f: 0x03, b: 5 });
    expect(decode(0x2fff)).toMatchObject({ mnemonic: 'GOTO', k: 0x7ff });
    expect(decode(0x34ff)).toMatchObject({ mnemonic: 'RETLW', k: 0xff });
    expect(decode(0x0066)).toMatchObject({ mnemonic: 'TRIS', f: 6 });
  });
});
