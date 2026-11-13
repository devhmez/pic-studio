// The prof's MPLAB/HI-TECH watch-window vectors (status2026 p.9–10) and TP « Manipulation du status ».
import { describe, expect, it } from 'vitest';
import { SFR } from '../src/index';
import { build, runToHalt, steps } from './helpers';

/**
 * Hand-assembled HI-TECH C:
 *   unsigned char a = A;  // 0x0D
 *   unsigned char b = B;  // 0x0E
 *   unsigned char resultat; // 0x0C
 *   CARRY = 0; ZERO = 0;
 *   while (1) { resultat = a + b; }
 */
function mplabProgram(a: number, b: number): string {
  return `
      MOVLW ${a}
      MOVWF 0x0D        ; a
      MOVLW ${b}
      MOVWF 0x0E        ; b
      BCF STATUS, C     ; CARRY = 0
      BCF STATUS, Z     ; ZERO = 0
loop: MOVF 0x0D, W
      ADDWF 0x0E, W
      MOVWF 0x0C        ; resultat
      GOTO loop
  `;
}

describe('MPLAB watch-window vectors', () => {
  it('a = 200, b = 100 → resultat = 44, STATUS = 0x19 (25)', () => {
    const core = build(mplabProgram(200, 100));
    steps(core, 9);
    expect(core.peek(0x0d)).toBe(200);
    expect(core.peek(0x0e)).toBe(100);
    expect(core.peek(0x0c)).toBe(44);
    expect(core.peek(SFR.STATUS)).toBe(0x19);
    // Still the same on every loop iteration.
    steps(core, 40);
    expect(core.peek(0x0c)).toBe(44);
    expect(core.snapshot().file[0x03]).toBe(25);
  });

  it('a = 250, b = 6 → resultat = 0, STATUS = 0x1F (31)', () => {
    const core = build(mplabProgram(250, 6));
    steps(core, 9);
    expect(core.peek(0x0c)).toBe(0);
    expect(core.peek(SFR.STATUS)).toBe(0x1f);
    steps(core, 40);
    expect(core.snapshot().file[0x03]).toBe(31);
  });
});

/**
 * TP STATUS: z = x - y then LED_SUP (RB0), LED_EGAL (RB1), LED_INF (RB2).
 * `cascade` = the organigramme's if / else if / else; otherwise status.c's two independent ifs.
 */
function statusProgram(cascade: boolean): string {
  const tests = cascade
    ? `
      BTFSS STATUS, Z   ; if (STATUS.F2 == 1)
      GOTO notEqual
      BSF PORTB, 1      ;   LED_EGAL
      GOTO done
notEqual:
      BTFSS STATUS, C   ; else if (STATUS.F0 == 1)
      GOTO less
      BSF PORTB, 0      ;   LED_SUP
      GOTO done
less: BSF PORTB, 2      ; else LED_INF
`
    : `
      BTFSS STATUS, Z   ; if (STATUS.F2 == 1)
      GOTO second
      BSF PORTB, 1      ;   LED_EGAL
second:
      BTFSS STATUS, C   ; if (STATUS.F0 == 1)  -- separate if
      GOTO less
      BSF PORTB, 0      ;   LED_SUP
      GOTO done
less: BSF PORTB, 2      ; else LED_INF
`;
  return `
      BSF STATUS, RP0
      CLRF TRISB        ; TRISB = 0x00
      BCF STATUS, RP0
      CLRF PORTB
      MOVF 0x0D, W      ; y
      SUBWF 0x0C, W     ; x - y
      MOVWF 0x0E        ; z
${tests}
done: GOTO $
  `;
}

function leds(cascade: boolean, x: number, y: number): number {
  const core = build(statusProgram(cascade));
  core.poke(0x0c, x);
  core.poke(0x0d, y);
  runToHalt(core);
  return (['RB0', 'RB1', 'RB2'] as const).reduce((acc, pin, i) => acc | ((core.getDrive(pin) === 1 ? 1 : 0) << i), 0);
}

const SUP = 0b001;
const EGAL = 0b010;
const INF = 0b100;

describe('TP « Manipulation du status » test table', () => {
  it.each([
    [5, 6, INF],
    [6, 5, SUP],
    [5, 5, EGAL],
    [10, 3, SUP],
    [3, 10, INF],
  ])('else-if cascade: x=%i y=%i lights exactly one LED', (x, y, expected) => {
    expect(leds(true, x, y)).toBe(expected);
  });

  it('status.c with two independent ifs lights EGAL and SUP when x = y (C = 1, no borrow)', () => {
    expect(leds(false, 6, 6)).toBe(EGAL | SUP);
    expect(leds(false, 5, 6)).toBe(INF);
    expect(leds(false, 6, 5)).toBe(SUP);
  });
});
