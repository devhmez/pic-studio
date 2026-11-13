import { describe, expect, it } from 'vitest';
import { isBitSelector, scanPicTokens, SFR_NAMES } from './vocabulary';

function tokens(text: string): string[] {
  return scanPicTokens(text).map((t) => `${t.kind}:${text.slice(t.from, t.to)}`);
}

describe('MikroC vocabulary', () => {
  it('knows the PIC16F84A registers', () => {
    for (const n of ['PORTA', 'PORTB', 'TRISA', 'TRISB', 'STATUS', 'INTCON', 'OPTION_REG', 'TMR0', 'EEDATA', 'EEADR', 'EECON1', 'PCL', 'PCLATH', 'FSR', 'INDF']) {
      expect(SFR_NAMES.has(n)).toBe(true);
    }
  });

  it('recognises bit selectors', () => {
    for (const s of ['F0', 'F7', 'B3', 'RA0', 'RB3', 'Z', 'C', 'DC', 'GIE', 'INTF', 'rb0', 'f2']) expect(isBitSelector(s)).toBe(true);
    for (const s of ['F32', 'X', 'LED', 'RB8', 'B']) expect(isBitSelector(s)).toBe(false);
  });
});

describe('scanPicTokens', () => {
  it('finds registers and bit selectors in the prof style', () => {
    expect(tokens('TRISA.RA0 = 1;')).toEqual(['sfr:TRISA', 'bit:RA0']);
    expect(tokens('if (STATUS.F2 == 1) { LED_ON(LED_EGAL); }')).toEqual(['sfr:STATUS', 'bit:F2']);
    expect(tokens('#define LED_SUP  PORTB.F0')).toEqual(['sfr:PORTB', 'bit:F0']);
    expect(tokens('PORTB . B3 = 0;')).toEqual(['sfr:PORTB', 'bit:B3']);
  });

  it('is case-insensitive like MikroC identifiers', () => {
    expect(tokens('portb.f1 = 1; delay_ms(10);')).toEqual(['sfr:portb', 'bit:f1', 'builtin:delay_ms']);
  });

  it('finds built-ins and _bit aliases', () => {
    expect(tokens('Delay_ms(500); x = EEPROM_Read(2); RB0_bit = 1;')).toEqual(['builtin:Delay_ms', 'builtin:EEPROM_Read', 'bit:RB0_bit']);
    expect(tokens('if (Button(&PORTB, 0, 1, 1)) Vdelay_ms(t);')).toEqual(['builtin:Button', 'sfr:PORTB', 'builtin:Vdelay_ms']);
  });

  it('finds MikroC keywords, `at` only inside an sbit declaration', () => {
    expect(tokens('sbit LED at PORTB.B0;')).toEqual(['keyword:sbit', 'keyword:at', 'sfr:PORTB', 'bit:B0']);
    expect(tokens('unsigned char t absolute 0x0C;')).toEqual(['keyword:absolute']);
    expect(tokens('void interrupt() {')).toEqual(['keyword:interrupt']);
    expect(tokens('unsigned char at;')).toEqual([]);
  });

  it('ignores preprocessor directive names, members of variables and ordinary identifiers', () => {
    expect(tokens('#define MAX 10')).toEqual([]);
    expect(tokens('x = y.count + LED_SUP;')).toEqual([]);
  });
});
