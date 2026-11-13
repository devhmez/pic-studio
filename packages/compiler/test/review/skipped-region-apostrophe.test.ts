import { describe, expect, it } from 'vitest';
import { compile } from '../../src/compile';

// Text in a skipped #if group, and the message of #error/#warning, is not C code (C11 6.10.1p6: the rest of a
// skipped group's tokens are ignored). The lexer reports an unterminated character literal for every apostrophe in
// such text before the preprocessor decides the group is inactive, so a French guard message such as
// "l'horloge" makes the whole program fail to compile even though the guard is false.
// (lexer.ts itself says stray characters "in #error or skipped code" must not be reported.)

const errors = (src: string) => compile(src).diagnostics.filter((d) => d.severity === 'error');

describe('apostrophes dans les zones inactives du préprocesseur', () => {
  it('#error dans un #if faux (horloge correcte) : aucune erreur', () => {
    const src = `#if __FOSC__ != 1000
#error Réglez l'horloge du projet sur 1 MHz
#endif
void main() { TRISB = 0; PORTB = 1; }`;
    expect(errors(src)).toEqual([]);
    expect(compile(src, { clockHz: 1_000_000 }).ok).toBe(true);
  });

  it('#warning dans un #ifdef non défini : aucune erreur', () => {
    const src = `#ifdef P16F877A
#warning Ce n'est pas le bon PIC
#endif
void main() { TRISB = 0; PORTB = 1; }`;
    expect(errors(src)).toEqual([]);
  });

  it('texte libre dans #if 0 : aucune erreur', () => {
    const src = `#if 0
Ancienne version : l'LED clignotait
#endif
void main() { TRISB = 0; PORTB = 1; }`;
    expect(errors(src)).toEqual([]);
  });
});
