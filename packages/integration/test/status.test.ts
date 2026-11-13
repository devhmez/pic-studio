// TP « Manipulation du status » (Ch3): status.c and its correction in the prof's ISIS circuit.
// The loop switches every LED off and on again on each pass, so what ISIS shows is the duty cycle.
import { describe, expect, it } from 'vitest';
import { fixture, fixtureText, runFor, shownLeds, startTp } from './support';

const LEDS = ['X_SUPERIEUR', 'EGALITE', 'X_INFERIEUR'] as const;

/** status.c / status_corrige.c with the initialisation `x = 6; y = 6;` replaced. */
function withValues(file: string, x: number, y: number): string {
  const text = fixtureText(file);
  if (!text.includes('x = 6; y = 6;')) throw new Error(`${file} : initialisation de x et y introuvable`);
  return text.replace('x = 6; y = 6;', `x = ${x}; y = ${y};`);
}

function litAfterSettling(templateSource: string | Uint8Array): string[] {
  const { session } = startTp('tp-status', templateSource);
  runFor(session, 0.1);
  return shownLeds(session, LEDS);
}

describe('TP status — status.c du cours (x = y = 6)', () => {
  it('lights EGALITE and X_SUPERIEUR together: Z = 1 and C = 1 (no borrow), tested by two separate if', () => {
    const { session, compiled } = startTp('tp-status', fixture('status.c'));
    expect(compiled.diagnostics.map((d) => d.code)).toContain('W_SEPARATE_IF_AFTER_FLAG');
    runFor(session, 0.1);
    expect(shownLeds(session, LEDS)).toEqual(['X_SUPERIEUR', 'EGALITE']);
  });

  it('is right whenever x ≠ y (only the equality case shows the bug)', () => {
    expect(litAfterSettling(withValues('status.c', 5, 6))).toEqual(['X_INFERIEUR']);
    expect(litAfterSettling(withValues('status.c', 6, 5))).toEqual(['X_SUPERIEUR']);
  });
});

describe('TP status — correction (else if)', () => {
  it('x = y = 6: only EGALITE', () => {
    const { compiled } = startTp('tp-status', fixture('status_corrige.c'));
    expect(compiled.diagnostics.map((d) => d.code)).not.toContain('W_SEPARATE_IF_AFTER_FLAG');
    expect(litAfterSettling(fixture('status_corrige.c'))).toEqual(['EGALITE']);
  });

  // Slide 7, « Test » table.
  const table = [
    { x: 5, y: 6, led: 'X_INFERIEUR' },
    { x: 6, y: 5, led: 'X_SUPERIEUR' },
    { x: 5, y: 5, led: 'EGALITE' },
    { x: 10, y: 3, led: 'X_SUPERIEUR' },
    { x: 3, y: 10, led: 'X_INFERIEUR' },
  ];
  for (const { x, y, led } of table) {
    it(`x = ${x}, y = ${y} → ${led} only`, () => {
      expect(litAfterSettling(withValues('status_corrige.c', x, y))).toEqual([led]);
    });
  }
});
