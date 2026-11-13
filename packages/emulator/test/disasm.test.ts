import { describe, expect, it } from 'vitest';
import { assemble, decode, disassemble, disassembleProgram, encode } from '../src/index';

describe('disassembler strings (MPASM style)', () => {
  it.each([
    [encode('SUBWF', 0x0d, 0), 'SUBWF 0x0D, W'],
    [encode('ADDWF', 0x0e, 1), 'ADDWF 0x0E, F'],
    [encode('BTFSC', 0x03, 2), 'BTFSC STATUS, Z'],
    [encode('BTFSS', 0x03, 0), 'BTFSS STATUS, C'],
    [encode('BSF', 0x03, 5), 'BSF STATUS, RP0'],
    [encode('BCF', 0x03, 5), 'BCF STATUS, RP0'],
    [encode('BCF', 0x0b, 7), 'BCF INTCON, GIE'],
    [encode('BTFSS', 0x0b, 2), 'BTFSS INTCON, T0IF'],
    [encode('BSF', 0x06, 0), 'BSF PORTB, 0'],
    [encode('BCF', 0x05, 4), 'BCF PORTA, 4'],
    [encode('MOVWF', 0x06), 'MOVWF PORTB'],
    [encode('CLRF', 0x03), 'CLRF STATUS'],
    [encode('CLRF', 0x00), 'CLRF INDF'],
    [encode('INCF', 0x04, 1), 'INCF FSR, F'],
    [encode('MOVF', 0x02, 0), 'MOVF PCL, W'],
    [encode('ADDWF', 0x02, 1), 'ADDWF PCL, F'],
    [encode('MOVWF', 0x0a), 'MOVWF PCLATH'],
    [encode('MOVWF', 0x01), 'MOVWF TMR0'],
    [encode('MOVWF', 0x08), 'MOVWF EEDATA'],
    [encode('MOVWF', 0x09), 'MOVWF EEADR'],
    [encode('MOVWF', 0x07), 'MOVWF 0x07'],
    [encode('MOVWF', 0x4f), 'MOVWF 0x4F'],
    [encode('MOVWF', 0x50), 'MOVWF 0x50'],
    [encode('MOVLW', 0x06), 'MOVLW 0x06'],
    [encode('MOVLW', 0xff), 'MOVLW 0xFF'],
    [encode('RETLW', 0x3f), 'RETLW 0x3F'],
    [encode('ADDLW', 0x15), 'ADDLW 0x15'],
    [encode('SUBLW', 0x02), 'SUBLW 0x02'],
    [encode('ANDLW', 0x0f), 'ANDLW 0x0F'],
    [encode('IORLW', 0x80), 'IORLW 0x80'],
    [encode('XORLW', 0xaa), 'XORLW 0xAA'],
    [encode('GOTO', 0x004), 'GOTO 0x004'],
    [encode('CALL', 0x123), 'CALL 0x123'],
    [0x0000, 'NOP'],
    [0x0103, 'CLRW'],
    [0x0008, 'RETURN'],
    [0x0009, 'RETFIE'],
    [0x0063, 'SLEEP'],
    [0x0064, 'CLRWDT'],
    [0x0062, 'OPTION'],
    [0x0066, 'TRIS PORTB'],
    [0x3fff, 'ADDLW 0xFF'],
    [0x0001, 'DW 0x0001'],
  ])('%i → %s', (word, text) => {
    expect(disassemble(word)).toBe(text);
  });

  it('names bank-1 registers when told the bank', () => {
    expect(disassemble(encode('MOVWF', 0x86), { bank: 1 })).toBe('MOVWF TRISB');
    expect(disassemble(encode('CLRF', 0x85), { bank: 1 })).toBe('CLRF TRISA');
    expect(disassemble(encode('MOVWF', 0x81), { bank: 1 })).toBe('MOVWF OPTION_REG');
    expect(disassemble(encode('BSF', 0x88, 1), { bank: 1 })).toBe('BSF EECON1, WR');
    expect(disassemble(encode('BCF', 0x81, 7), { bank: 1 })).toBe('BCF OPTION_REG, RBPU');
    expect(disassemble(encode('MOVWF', 0x89), { bank: 1 })).toBe('MOVWF EECON2');
    expect(disassemble(encode('MOVF', 0x0c, 0), { bank: 1 })).toBe('MOVF 0x0C, W');
    expect(disassemble(encode('MOVWF', 0x03), { bank: 1 })).toBe('MOVWF STATUS');
  });

  it('uses register names and labels when given', () => {
    const names: Record<number, string> = { 0x0c: 'resultat', 0x0d: 'a' };
    expect(disassemble(encode('MOVWF', 0x0c), { registerName: (a) => names[a] })).toBe('MOVWF resultat');
    expect(disassemble(encode('MOVF', 0x0d, 0), { registerName: (a) => names[a] })).toBe('MOVF a, W');
    expect(disassemble(encode('GOTO', 0x010), { label: (a) => (a === 0x010 ? 'main' : undefined) })).toBe('GOTO main');
  });

  it('tracks RP0 across a program listing', () => {
    const { program } = assemble(`
      BSF STATUS, RP0
      CLRF TRISB
      BCF STATUS, RP0
      CLRF PORTB
      GOTO $
    `);
    expect(disassembleProgram(program, 0, 5).map((l) => l.text)).toEqual([
      'BSF STATUS, RP0',
      'CLRF TRISB',
      'BCF STATUS, RP0',
      'CLRF PORTB',
      'GOTO 0x004',
    ]);
  });

  it('round-trips through the assembler for every canonical word', () => {
    const words: number[] = [];
    for (let word = 0; word < 0x4000; word++) {
      const d = decode(word);
      if (d.mnemonic === undefined) continue;
      const canonical = disassemble(word);
      if (assemble(canonical).program[0] !== word) {
        // Alternative encodings (don't-care bits) disassemble to the canonical form.
        const again = assemble(canonical).program[0];
        expect(disassemble(again)).toBe(canonical);
      } else {
        words.push(word);
      }
    }
    expect(words.length).toBeGreaterThan(12_000);
  });
});
