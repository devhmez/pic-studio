import { describe, expect, it } from 'vitest';
import { DiagnosticBag } from '../../src/diagnostics';
import { lex } from '../../src/lexer';
import { preprocess } from '../../src/preprocessor';

function pp(src: string, clockHz = 1_000_000) {
  const diags = new DiagnosticBag();
  const lexed = lex(src, diags);
  const res = preprocess(lexed, { clockHz }, diags);
  const text = res.tokens.filter((t) => t.kind !== 'eof').map((t) => t.value).join(' ');
  return { ...res, text, diags: diags.items, src };
}

describe('préprocesseur', () => {
  it('macros objet (alias de broches et constantes)', () => {
    const r = pp('#define LED PORTB.F0\n#define MAX 10\nLED = MAX;');
    expect(r.text).toBe('PORTB . F0 = 10 ;');
  });

  it('macros fonction du prof : LED_ON(pin) (pin = 1) et LED_ON() sans paramètre', () => {
    const r = pp('#define LED_EGAL PORTB.F1\n#define LED_ON(pin)  (pin = 1)\n#define LED_OFF() PORTB.F0 = 0\nLED_ON(LED_EGAL); LED_OFF();');
    expect(r.text).toBe('( PORTB . F1 = 1 ) ; PORTB . F0 = 0 ;');
    expect(r.diags).toEqual([]);
  });

  it('les jetons issus d’une macro portent le texte d’origine de l’appel', () => {
    const r = pp('#define LED_EGAL PORTB.F1\n#define LED_ON(pin)  (pin = 1)\n    LED_ON(LED_EGAL);');
    const toks = r.tokens.filter((t) => t.kind !== 'eof');
    const paren = toks[0];
    expect(paren.macro).toBe('LED_ON');
    expect(r.src.slice(paren.span.start, paren.span.end)).toBe('LED_ON(LED_EGAL)');
    const portb = toks.find((t) => t.value === 'PORTB')!;
    expect(portb.macro).toBe('LED_EGAL');
    expect(r.src.slice(portb.span.start, portb.span.end)).toBe('LED_EGAL');
  });

  it('enregistre les définitions (nom, paramètres, corps, ligne)', () => {
    const r = pp('\n   #define L0 PORTA.RA0\n#define LED_ON(pin)  (pin = 1)   // allume\n#define F() x\n#undef L0\n');
    expect(r.macros.map((m) => ({ name: m.name, params: m.params, body: m.body, line: m.line, undef: m.undefinedAtLine }))).toEqual([
      { name: 'L0', params: null, body: 'PORTA.RA0', line: 2, undef: 5 },
      { name: 'LED_ON', params: ['pin'], body: '(pin = 1)', line: 3, undef: undefined },
      { name: 'F', params: [], body: 'x', line: 4, undef: undefined },
    ]);
    expect([...r.directiveLines].sort()).toEqual([2, 3, 4, 5]);
  });

  it('#undef retire la macro', () => {
    expect(pp('#define A 1\n#undef A\nA').text).toBe('A');
  });

  it('#ifdef P16F84A, #if __FOSC__ (kHz), #elif, #else, #ifndef imbriqués', () => {
    const src = [
      '#ifdef P16F84A', 'a', '#else', 'b', '#endif',
      '#if __FOSC__ == 8000', 'c', '#elif __FOSC__ == 1000', 'd', '#else', 'e', '#endif',
      '#ifndef INCONNU', '#if defined(P16F84A) && !defined(X)', 'f', '#endif', '#endif',
      '#if 0', '#if 1', 'g', '#endif', '#else', 'h', '#endif',
    ].join('\n');
    expect(pp(src).text).toBe('a d f h');
    expect(pp(src, 8_000_000).text).toBe('a c f h');
  });

  it('#include : built_in.h ignoré, <htc.h> active le mode HI-TECH, autres fichiers signalés', () => {
    expect(pp('#include "built_in.h"\nx').diags).toEqual([]);
    const h = pp('#include <htc.h>\nx');
    expect(h.dialect).toBe('hitech');
    expect(h.includes).toMatchObject([{ path: 'htc.h', system: true, line: 1 }]);
    expect(pp('#include <xc.h>').dialect).toBe('hitech');
    expect(pp('#include "lcd.h"').diags[0]).toMatchObject({ code: 'W_INCLUDE_IGNORED', severity: 'warning' });
  });

  it('_XTAL_FREQ est lu pour __delay_ms', () => {
    expect(pp('#define _XTAL_FREQ 8000000').xtalFreq).toBe(8_000_000);
  });

  it('pas de récursion infinie (ensemble de masquage)', () => {
    expect(pp('#define A B\n#define B A\nA').text).toBe('A');
    expect(pp('#define f(x) f(x+1)\nf(1)').text).toBe('f ( 1 + 1 )');
  });

  it('opérateurs # et ##', () => {
    expect(pp('#define S(x) #x\nS(PORTB)').text).toBe('"PORTB"');
    expect(pp('#define BIT(n) RB##n##_bit\nBIT(3)').text).toBe('RB3_bit');
  });

  it('erreurs de directives en français', () => {
    expect(pp('#if 1\nx').diags[0]).toMatchObject({ code: 'E_PREPROCESSOR', message: '#endif manquant' });
    expect(pp('#endif').diags[0]).toMatchObject({ message: '#endif sans #if correspondant' });
    expect(pp('x = 3 @ 4;').diags[0]).toMatchObject({ code: 'E_INVALID_CHAR', message: "Caractère invalide '@'", line: 1, col: 7 });
    expect(pp('#foo').diags[0]).toMatchObject({ message: "Directive de préprocesseur inconnue '#foo'" });
    expect(pp('#error Horloge non supportée').diags[0]).toMatchObject({ severity: 'error', message: '#error Horloge non supportée' });
    expect(pp('#define M(a,b) a\nM(1)').diags[0]).toMatchObject({ message: "La macro 'M' attend 2 argument(s), 1 fourni(s)" });
    expect(pp('#define A 1\n#define A 2').diags[0]).toMatchObject({ code: 'W_MACRO_REDEFINED' });
  });

  it('les directives inactives sont ignorées', () => {
    const r = pp('#ifdef RIEN\n#define X 1\n#error ne doit pas apparaître\n#endif\nX');
    expect(r.text).toBe('X');
    expect(r.diags).toEqual([]);
  });

  it('littéraux mal formés : signalés dans le code actif seulement', () => {
    expect(pp("#if 0\nl'LED 0b102\n#endif").diags).toEqual([]);
    expect(pp("#warning Ce n'est pas le bon PIC").diags.map((d) => d.code)).toEqual(['W_PP_WARNING']);
    expect(pp("c = 'A;").diags[0]).toMatchObject({ code: 'E_UNTERMINATED', message: 'Caractère littéral non terminé', line: 1, col: 5 });
    expect(pp('#define N 0b102').diags[0]).toMatchObject({ code: 'E_BAD_NUMBER' });
    expect(pp("#if 'A\n#endif").diags[0]).toMatchObject({ code: 'E_UNTERMINATED' });
  });
});
