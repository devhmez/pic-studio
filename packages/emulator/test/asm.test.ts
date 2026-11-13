import { describe, expect, it } from 'vitest';
import { assemble } from '../src/index';

describe('assembler', () => {
  it('assembles labels, $, ORG, EQU, SFR and bit names', () => {
    const r = assemble(`
; comment line
COUNT   EQU 0x20
        ORG 0x000
        GOTO main
        ORG 0x004
isr:    RETFIE
main:   MOVLW D'10'
        MOVWF COUNT
loop    DECFSZ COUNT, F   ; label in column 1 without colon
        GOTO loop
        BSF STATUS, RP0
        CLRF TRISB
        GOTO $
    `);
    expect(r.ok).toBe(true);
    expect(r.labels.get('MAIN')).toBe(5);
    expect(r.labels.get('LOOP')).toBe(7);
    expect([...r.program.subarray(0, 11)]).toEqual([
      0x2805, 0x3fff, 0x3fff, 0x3fff, 0x0009, 0x300a, 0x00a0, 0x0ba0, 0x2807, 0x1683, 0x0186,
    ]);
    expect(r.program[11]).toBe(0x280b);
    expect(r.addrToLine.get(5)).toBe(8);
  });

  it('accepts the usual number formats and expressions', () => {
    const r = assemble(`
      MOVLW 0x1F
      MOVLW H'1F'
      MOVLW B'00011111'
      MOVLW 0b00011111
      MOVLW D'31'
      MOVLW .31
      MOVLW 31
      MOVLW 1Fh
      MOVLW 'A'
      MOVLW (1 << 5) | 3
      MOVLW -1
      MOVLW 40 - 9
    `);
    expect(r.ok).toBe(true);
    expect([...r.program.subarray(0, 12)].map((w) => w & 0xff)).toEqual([
      31, 31, 31, 31, 31, 31, 31, 31, 65, 35, 255, 31,
    ]);
  });

  it('defaults the destination to F and accepts 0/1', () => {
    const r = assemble('INCF 0x20\n INCF 0x20, 0\n INCF 0x20, 1');
    expect([...r.program.subarray(0, 3)]).toEqual([0x0aa0, 0x0a20, 0x0aa0]);
  });

  it('handles __CONFIG, DW, END and ignored directives', () => {
    const r = assemble(`
      LIST p=16F84A
      #include <p16f84a.inc>
      __CONFIG 0x3FF1
      DW 0x1234, 0x0042
      END
      NOP
    `);
    expect(r.ok).toBe(true);
    expect(r.config).toBe(0x3ff1);
    expect([...r.program.subarray(0, 3)]).toEqual([0x1234, 0x0042, 0x3fff]);
  });

  it('reports errors in French with line numbers', () => {
    const r = assemble(`
      FOO 1
      MOVLW nowhere
      MOVLW 1, 2
      BSF PORTB, 9
      MOVLW 300
      ORG 0x400
      NOP
dup:  NOP
dup:  NOP
    `);
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([
      { line: 10, message: 'Étiquette déjà définie : DUP' },
      { line: 2, message: 'Instruction inconnue : FOO' },
      { line: 3, message: 'Symbole non défini : NOWHERE' },
      { line: 4, message: 'MOVLW attend 1 opérande(s), 2 donné(s).' },
      { line: 5, message: 'Numéro de bit hors limites : 9' },
      { line: 6, message: 'Littéral hors limites : 300' },
      { line: 8, message: 'Adresse 1024 hors de la mémoire programme (0x000–0x3FF).' },
      { line: 9, message: 'Adresse 1025 hors de la mémoire programme (0x000–0x3FF).' },
      { line: 10, message: 'Adresse 1026 hors de la mémoire programme (0x000–0x3FF).' },
    ]);
  });
});
