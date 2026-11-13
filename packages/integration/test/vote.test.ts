// TP « Boîtier de vote » (Ch3) with fixtures/vote.c in the tp-vote circuit:
// BUTTONs to +5 V with 10k pull-downs on RA0 (VOTE_A), RA1 (VOTE_B), RA3 (RESULTAT); RA2 → CONFIRMATION;
// RB0..RB3 → 7SEG-BCD; RB5 → EGALITE (verte). The program waits for each button to be released.
import { describe, expect, it } from 'vitest';
import type { SimSession } from '@pic/circuit';
import { fixture, ledShown, runFor, runUntil, sevenSeg, startTp } from './support';

const LONG = { timeout: 30_000 };

/** Press `id` at simulated time `at`, hold it `hold` seconds, release. */
function press(session: SimSession, id: string, at: number, hold = 0.1): void {
  runUntil(session, at);
  session.interact(id, { type: 'press' });
  runFor(session, hold);
  session.interact(id, { type: 'release' });
}

function startVote(): SimSession {
  return startTp('tp-vote', fixture('vote.c')).session;
}

describe('TP vote', () => {
  it('compiles; the only remark is the linter noting that PORTB = 0x0F also clears RB5', () => {
    const { compiled } = startTp('tp-vote', fixture('vote.c'));
    expect(compiled.diagnostics.map((d) => d.code)).toEqual(['W_PORT_WRITE_CLEARS_BITS']);
  });

  it('shows « F » for 0,5 s at power-on, LEDs off', () => {
    const session = startVote();
    runUntil(session, 0.2);
    expect(sevenSeg(session, 'SEG1')).toBe(0x0f);
    expect([ledShown(session, 'CONFIRMATION'), ledShown(session, 'EGALITE')]).toEqual([false, false]);
  });

  it('Vote A ×2, Vote B ×1, Résultat → « A » (0x0A); each vote blinks the confirmation LED 0,5 s / 0,5 s', LONG, () => {
    const session = startVote();
    press(session, 'VOTE_A', 0.6);
    runUntil(session, 0.85);
    expect(ledShown(session, 'CONFIRMATION')).toBe(true);
    runUntil(session, 1.35);
    expect(ledShown(session, 'CONFIRMATION')).toBe(false);
    press(session, 'VOTE_A', 1.7);
    press(session, 'VOTE_B', 2.8);
    runUntil(session, 3.05);
    expect(ledShown(session, 'CONFIRMATION')).toBe(true);
    expect(sevenSeg(session, 'SEG1')).toBe(0x0f);
    press(session, 'RESULTAT', 3.9);
    expect(sevenSeg(session, 'SEG1')).toBe(0x0a);
    runUntil(session, 6);
    expect(sevenSeg(session, 'SEG1')).toBe(0x0a); // the result stays displayed (a 7SEG-BCD cannot be blanked)
    expect([ledShown(session, 'CONFIRMATION'), ledShown(session, 'EGALITE')]).toEqual([false, false]);
  });

  it('égalité → « E » (0x0E) and the green LED blinks three times', LONG, () => {
    const session = startVote();
    press(session, 'VOTE_A', 0.6);
    press(session, 'VOTE_B', 1.7);
    press(session, 'RESULTAT', 2.8);
    const blinks: boolean[] = [];
    for (let k = 0; k < 8; k++) {
      runUntil(session, 2.8 + 0.25 + 0.5 * k);
      blinks.push(ledShown(session, 'EGALITE'));
      expect(sevenSeg(session, 'SEG1')).toBe(0x0e);
    }
    expect(blinks).toEqual([true, false, true, false, true, false, false, false]);
  });

  it('var1 < var2 → « b » (0x0B)', LONG, () => {
    const session = startVote();
    press(session, 'VOTE_A', 0.6);
    press(session, 'VOTE_B', 1.7);
    press(session, 'VOTE_B', 2.8);
    press(session, 'RESULTAT', 3.9);
    runFor(session, 0.2);
    expect(sevenSeg(session, 'SEG1')).toBe(0x0b);
  });

  it('a button held for 3 s counts one vote (wait for release)', LONG, () => {
    const session = startVote();
    press(session, 'VOTE_A', 0.6, 3);
    press(session, 'VOTE_B', 3.7);
    press(session, 'RESULTAT', 4.8);
    runFor(session, 0.2);
    expect(sevenSeg(session, 'SEG1')).toBe(0x0e); // 1 - 1
  });

  it('a press during the confirmation blink is not counted (« éviter les doubles appuis »)', LONG, () => {
    const session = startVote();
    press(session, 'VOTE_A', 0.6);
    press(session, 'VOTE_B', 0.9); // released at 1.0 s, while RA2 still blinks for vote A
    press(session, 'RESULTAT', 1.8);
    runFor(session, 0.2);
    expect(sevenSeg(session, 'SEG1')).toBe(0x0a); // 1 - 0
  });

  it('starts a new cycle after each result: the counters are back to 0', LONG, () => {
    const session = startVote();
    press(session, 'VOTE_A', 0.6);
    press(session, 'RESULTAT', 1.7);
    runFor(session, 0.2);
    expect(sevenSeg(session, 'SEG1')).toBe(0x0a);
    press(session, 'VOTE_B', 2.5);
    press(session, 'RESULTAT', 3.6);
    runFor(session, 0.2);
    expect(sevenSeg(session, 'SEG1')).toBe(0x0b); // 0 - 1, not 1 - 1
  });
});
