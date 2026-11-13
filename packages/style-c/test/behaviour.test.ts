/// <reference types="node" />
// Every template's generated C, compiled for its clock and simulated in its own schematic (SimSession), behaves as the
// énoncé asks. Sources are templates/<id>.c (checked against generate() by templates.test.ts); variants are generated
// from the program model (e.g. the STATUS test table).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SimSession } from '@pic/circuit';
import { cloneProgram, type AssignStmt, type Program } from '@pic/program-model';
import {
  SLICE_S, lamps, ledBrightness, ledShown, runFor, runUntil, sevenSeg, shownLeds, startTp,
} from '../../integration/test/support';
import { generate } from '../src';
import { tpStatus } from './template-programs';

const LONG = { timeout: 60_000 };

const source = (id: string) => readFileSync(new URL(`../../../templates/${id}.c`, import.meta.url), 'utf8');
const start = (id: string, src: string = source(id)) => startTp(id, src).session;

/** Press `id` at simulated time `at`, hold it `hold` seconds, release. */
function press(session: SimSession, id: string, at: number, hold = 0.1): void {
  runUntil(session, at);
  session.interact(id, { type: 'press' });
  runFor(session, hold);
  session.interact(id, { type: 'release' });
}

function setLogic(session: SimSession, id: string, wanted: 0 | 1): void {
  const v = session.snapshot().visuals[id];
  if (v?.kind !== 'LOGICSTATE') throw new Error(`${id} n'est pas une LOGICSTATE`);
  if (v.state !== wanted) session.interact(id, { type: 'toggle' });
}

describe('templates: compilation', () => {
  const allowed: Record<string, string[]> = {
    // status.c's `STATUS=0;` (CLRF STATUS) sets Z: the compiler's note about it is intended (research 00 §3.7 #5).
    'tp-status': ['I_STATUS_CLEAR_SETS_Z'],
    // The énoncé writes the letters with PORTB = 0x0E… while the green LED on RB5 is driven bit by bit: the linter's
    // reminder that such a write also clears RB5 is intended (the program re-lights RB5 afterwards).
    'tp-vote': ['W_PORT_WRITE_CLEARS_BITS'],
  };
  for (const id of ['tp0-exemple1', 'tp0-exemple2', 'tp1-demux', 'tp-status', 'tp-vote', 'tp-traffic', 'tp-pupitre',
      'tp4-inte', 'ch5-manip-rb0', 'tp-traffic-int', 'tp5-int-rb0', 'ch6-exo-rbie', 'tp6-rbie']) {
    it(`${id}: no error, only the intended warnings`, () => {
      const { compiled } = startTp(id, source(id));
      expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(compiled.diagnostics.map((d) => d.code)).toEqual(allowed[id] ?? []);
    });
  }
});

describe('TP0', () => {
  it('Exemple 1: the blue LED lights and main() ends on the CPU halt', () => {
    const session = start('tp0-exemple1');
    runFor(session, 0.05);
    expect(session.circuit.visual('D1')).toEqual({ kind: 'LED', lit: true, brightness: 1 });
    expect(session.snapshot().cpu.halted).toBe(true);
  });

  it('Exemple 2: the LED follows the LOGICSTATE on RB0', () => {
    const session = start('tp0-exemple2');
    runFor(session, 0.05);
    expect(ledBrightness(session, 'D1')).toBe(1); // LOGICSTATE saved at 1 in the DSN
    for (const level of [0, 1, 0] as const) {
      setLogic(session, 'LS1', level);
      runFor(session, 0.05);
      expect(ledBrightness(session, 'D1')).toBe(level);
    }
  });
});

describe('TP1 démultiplexeur', () => {
  it('lights exactly D(2·L1 + L0), as in Tableau 1.1 (DSN numbering D1..D4 for D0..D3)', () => {
    const session = start('tp1-demux');
    const rows: string[][] = [];
    for (const [l1, l0] of [[0, 0], [0, 1], [1, 0], [1, 1]] as const) {
      setLogic(session, 'LS1', l0);
      setLogic(session, 'LS2', l1);
      runFor(session, 0.05);
      rows.push(shownLeds(session, ['D1', 'D2', 'D3', 'D4']));
    }
    expect(rows).toEqual([['D1'], ['D2'], ['D3'], ['D4']]);
  });
});

describe('TP status (else if)', () => {
  const LEDS = ['X_SUPERIEUR', 'EGALITE', 'X_INFERIEUR'];

  function withValues(x: number, y: number): Program {
    const p = cloneProgram(tpStatus());
    for (const s of p.init) {
      if (s.kind === 'assign' && s.target.kind === 'var') (s as AssignStmt).value = { kind: 'num', value: s.target.name === 'x' ? x : y };
    }
    return p;
  }

  it('the template (x = 5, y = 6, her organigramme) lights X_INFERIEUR only', () => {
    const session = start('tp-status');
    runFor(session, 0.1);
    expect(shownLeds(session, LEDS)).toEqual(['X_INFERIEUR']);
  });

  // Slide 7, « Test » table, plus x = y = 6 (status.c's values: only EGALITE, not EGALITE + X_SUPERIEUR).
  const table = [
    { x: 5, y: 6, led: 'X_INFERIEUR' },
    { x: 6, y: 5, led: 'X_SUPERIEUR' },
    { x: 5, y: 5, led: 'EGALITE' },
    { x: 6, y: 6, led: 'EGALITE' },
    { x: 10, y: 3, led: 'X_SUPERIEUR' },
    { x: 3, y: 10, led: 'X_INFERIEUR' },
  ];
  for (const { x, y, led } of table) {
    it(`x = ${x}, y = ${y} → ${led} only`, () => {
      const session = start('tp-status', generate(withValues(x, y)));
      runFor(session, 0.1);
      expect(shownLeds(session, LEDS)).toEqual([led]);
    });
  }
});

describe('TP vote', () => {
  it('shows « F » for 0,5 s at power-on, LEDs off', () => {
    const session = start('tp-vote');
    runUntil(session, 0.2);
    expect(sevenSeg(session, 'SEG1')).toBe(0x0f);
    expect([ledShown(session, 'CONFIRMATION'), ledShown(session, 'EGALITE')]).toEqual([false, false]);
  });

  it('A ×2, B ×1, Résultat → « A »; each vote blinks the confirmation LED 0,5 s / 0,5 s', LONG, () => {
    const session = start('tp-vote');
    press(session, 'VOTE_A', 0.6);
    runUntil(session, 0.85);
    expect(ledShown(session, 'CONFIRMATION')).toBe(true);
    runUntil(session, 1.35);
    expect(ledShown(session, 'CONFIRMATION')).toBe(false);
    press(session, 'VOTE_A', 1.7);
    press(session, 'VOTE_B', 2.8);
    press(session, 'RESULTAT', 3.9);
    expect(sevenSeg(session, 'SEG1')).toBe(0x0a);
    runUntil(session, 6);
    expect(sevenSeg(session, 'SEG1')).toBe(0x0a);
  });

  it('égalité → « E » and the green LED blinks three times', LONG, () => {
    const session = start('tp-vote');
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

  it('var1 < var2 → « B » (shown b)', LONG, () => {
    const session = start('tp-vote');
    press(session, 'VOTE_B', 0.6);
    press(session, 'RESULTAT', 1.7);
    runFor(session, 0.2);
    expect(sevenSeg(session, 'SEG1')).toBe(0x0b);
  });

  it('a button held for 3 s counts one vote, and the counters restart after each result', LONG, () => {
    const session = start('tp-vote');
    press(session, 'VOTE_A', 0.6, 3);
    press(session, 'VOTE_B', 3.7);
    press(session, 'RESULTAT', 4.8);
    runFor(session, 0.2);
    expect(sevenSeg(session, 'SEG1')).toBe(0x0e);
    press(session, 'VOTE_B', 9);
    press(session, 'RESULTAT', 10.1);
    runFor(session, 0.2);
    expect(sevenSeg(session, 'SEG1')).toBe(0x0b);
  });
});

describe('TP feu tricolore (8 MHz)', () => {
  interface Segment { start: number; duration: number; state: string }

  function record(session: SimSession, until: number, events: [number, () => void][]): Segment[] {
    const out: Segment[] = [];
    const pending = [...events];
    while (session.time < until - 1e-9) {
      while (pending.length > 0 && pending[0][0] <= session.time + 1e-9) pending.shift()![1]();
      session.runFor(SLICE_S);
      const state = `${lamps(session, 'TL1')} ${sevenSeg(session, 'SEG1')}`;
      if (out[out.length - 1]?.state !== state) out.push({ start: session.time, duration: 0, state });
    }
    out.forEach((s, i) => { s.duration = (out[i + 1]?.start ?? session.time) - s.start; });
    return out;
  }

  it('night (orange blinks, « A »), then a day cycle 9→0 / 2→0 / 9→0 at 1 s per step, then night', LONG, () => {
    const session = start('tp-traffic');
    const segments = record(session, 26, [
      [1.9, () => session.interact('LDR1', { type: 'setLevel', level: 9 })],
      [20.5, () => session.interact('LDR1', { type: 'setLevel', level: 0 })],
    ]);
    const night = ['-A- 10', '--- 10'];
    const day = [
      ...[9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((n) => `R-- ${n}`),
      ...[2, 1, 0].map((n) => `-A- ${n}`),
      ...[9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((n) => `--G ${n}`),
    ];
    expect(segments.map((s) => s.state)).toEqual([...night, ...night, ...day, ...night]);
    for (const s of segments.slice(0, 4)) expect(s.duration).toBeCloseTo(0.5, 1);
    for (const s of segments.slice(4, 27)) expect(Math.abs(s.duration - 1)).toBeLessThanOrEqual(0.015);
  });
});

describe('TP pupitre de jeu', () => {
  const LEDS = ['D3', 'D2', 'D4']; // YES (RA3), NO (RA2), GAME OVER (RA1)

  function answer(session: SimSession, value: number): void {
    for (let k = 0; k < 8; k++) setLogic(session, `LS${k + 1}`, ((value >> k) & 1) as 0 | 1);
  }

  it('waits for DEMARRER, then answers 0xCA → YES for 3 s', LONG, () => {
    const session = start('tp-pupitre');
    answer(session, 0xca);
    press(session, 'VALIDER', 0.2);
    runFor(session, 0.3);
    expect(shownLeds(session, LEDS)).toEqual([]); // not started yet
    runUntil(session, 1);
    setLogic(session, 'DEMARRER', 1);
    press(session, 'VALIDER', 1.2);
    runUntil(session, 2.5);
    expect(shownLeds(session, LEDS)).toEqual(['D3']);
    runUntil(session, 4.4);
    expect(shownLeds(session, LEDS)).toEqual([]);
  });

  it('DEMARRER still at 1 after GAME OVER: no new game until it goes back to 0 and up again', LONG, () => {
    const session = start('tp-pupitre');
    answer(session, 0xc8);
    setLogic(session, 'DEMARRER', 1);
    for (const t of [0.2, 3.5, 6.8]) press(session, 'VALIDER', t);
    runUntil(session, 13.5); // GAME OVER shown from ≈10 s to ≈13 s
    expect(shownLeds(session, LEDS)).toEqual([]);
    // DEMARRER is latched at 1: VALIDER must not start a fresh set of three tries.
    press(session, 'VALIDER', 14);
    runUntil(session, 15.5);
    expect(shownLeds(session, LEDS)).toEqual([]);
    // Switched off and on again: a new game.
    setLogic(session, 'DEMARRER', 0);
    runFor(session, 0.1);
    setLogic(session, 'DEMARRER', 1);
    press(session, 'VALIDER', 16);
    runUntil(session, 17);
    expect(shownLeds(session, LEDS)).toEqual(['D2']);
  });

  it('three wrong answers → NO three times, then GAME OVER for 3 s', LONG, () => {
    const session = start('tp-pupitre');
    answer(session, 0xc8);
    setLogic(session, 'DEMARRER', 1);
    const states: string[][] = [];
    for (const t of [0.2, 3.5, 6.8]) {
      press(session, 'VALIDER', t);
      runFor(session, 1.5);
      states.push(shownLeds(session, LEDS));
    }
    runUntil(session, 11.3);
    states.push(shownLeds(session, LEDS));
    runUntil(session, 13.5);
    states.push(shownLeds(session, LEDS));
    expect(states).toEqual([['D2'], ['D2'], ['D2'], ['D4'], []]);
  });

  it('a correct answer after two mistakes wins (no GAME OVER)', LONG, () => {
    const session = start('tp-pupitre');
    answer(session, 0x00);
    setLogic(session, 'DEMARRER', 1);
    press(session, 'VALIDER', 0.2);
    press(session, 'VALIDER', 3.5);
    runUntil(session, 6.6);
    answer(session, 0xca);
    press(session, 'VALIDER', 6.8);
    runUntil(session, 8);
    expect(shownLeds(session, LEDS)).toEqual(['D3']);
    runUntil(session, 11.3);
    expect(shownLeds(session, LEDS)).toEqual([]);
  });
});

describe('TP5 interruption RB0/INT', () => {
  it('each press (rising edge) toggles the red LED while the green one keeps blinking every 500 ms', LONG, () => {
    const session = start('tp5-int-rb0');
    runUntil(session, 0.25);
    expect([ledShown(session, 'D1'), ledShown(session, 'D2')]).toEqual([false, true]);
    runUntil(session, 0.75);
    expect(ledShown(session, 'D2')).toBe(false);
    press(session, 'BOUTON', 0.8, 0.05);
    runUntil(session, 0.95);
    expect(ledShown(session, 'D1')).toBe(true);
    // The release (falling edge) does not interrupt; a second press toggles back.
    runUntil(session, 1.2);
    expect(ledShown(session, 'D1')).toBe(true);
    press(session, 'BOUTON', 1.3, 0.3);
    runUntil(session, 1.7);
    expect(ledShown(session, 'D1')).toBe(false);
    // The blink keeps its rhythm: on during [1.0, 1.5), off during [1.5, 2.0).
    runUntil(session, 2.25);
    expect(ledShown(session, 'D2')).toBe(true);
  });

  it('the interrupt routine sits at 0004h', () => {
    const { compiled } = startTp('tp5-int-rb0', source('tp5-int-rb0'));
    expect(compiled.listing.find((l) => l.addr === 4)).toBeDefined();
  });
});

describe('TP6 interruption sur changement de RB4..RB7', () => {
  it('copies RB4..RB7 onto RA0..RA3 at every change', LONG, () => {
    const session = start('tp6-rbie');
    const leds = ['D1', 'D2', 'D3', 'D4'];
    runUntil(session, 0.1);
    expect(shownLeds(session, leds)).toEqual([]);
    setLogic(session, 'LS1', 1);
    runFor(session, 0.1);
    expect(shownLeds(session, leds)).toEqual(['D1']);
    setLogic(session, 'LS3', 1);
    setLogic(session, 'LS4', 1);
    runFor(session, 0.1);
    expect(shownLeds(session, leds)).toEqual(['D1', 'D3', 'D4']);
    setLogic(session, 'LS1', 0);
    runFor(session, 0.1);
    expect(shownLeds(session, leds)).toEqual(['D3', 'D4']);
  });

  it('without the interrupt enable, nothing is copied after start-up (the main loop does nothing)', () => {
    const src = source('tp6-rbie').replace('INTCON.RBIE = 1;', 'INTCON.RBIE = 0;');
    const session = start('tp6-rbie', src);
    runFor(session, 0.05);
    setLogic(session, 'LS2', 1);
    runFor(session, 0.1);
    expect(shownLeds(session, ['D1', 'D2', 'D3', 'D4'])).toEqual([]);
  });

  it('shows the switches from power-up, before any change (initial copy)', () => {
    // RBIE off: only the initialisation can have copied them.
    const session = start('tp6-rbie', source('tp6-rbie').replace('INTCON.RBIE = 1;', 'INTCON.RBIE = 0;'));
    setLogic(session, 'LS1', 1);
    setLogic(session, 'LS3', 1);
    runFor(session, 0.05);
    expect(shownLeds(session, ['D1', 'D2', 'D3', 'D4'])).toEqual(['D1', 'D3']);
  });
});

describe('TP4 interruption INTE (montage TP_inte.DSN, 8 MHz)', () => {
  it('counts 0..9 every 500 ms; a press blinks the LED 3 times while the count waits, then the count resumes where it was', LONG, () => {
    const session = start('tp4-inte');
    runUntil(session, 0.25);
    expect([sevenSeg(session, 'SEG1'), ledShown(session, 'D1')]).toEqual([0, false]);
    runUntil(session, 1.1);
    expect(sevenSeg(session, 'SEG1')).toBe(2);
    press(session, 'BTN1', 1.2, 0.1);
    // 3 blinks: on [1.2, 1.7), off [1.7, 2.2), on [2.2, 2.7)... the display stays on 2.
    for (const [t, lit] of [[1.45, true], [1.95, false], [2.45, true], [2.95, false], [3.45, true], [3.95, false]] as const) {
      runUntil(session, t);
      expect([sevenSeg(session, 'SEG1'), ledShown(session, 'D1')], `t = ${t}`).toEqual([2, lit]);
    }
    // Back in main inside Delay_ms(500) of the digit 2 (0.3 s were left): 3 shows at about 4.5 s.
    runUntil(session, 4.4);
    expect(sevenSeg(session, 'SEG1')).toBe(2);
    runUntil(session, 4.6);
    expect([sevenSeg(session, 'SEG1'), ledShown(session, 'D1')]).toEqual([3, false]);
  });

  it('without INTCON.INTF = 0 the routine starts again for ever: the LED keeps blinking, the count is frozen', LONG, () => {
    const session = start('tp4-inte', source('tp4-inte').replace('INTCON.INTF = 0;', ''));
    press(session, 'BTN1', 1.2, 0.1);
    const seen = new Set<boolean>();
    for (let t = 4.5; t < 8; t += 0.25) {
      runUntil(session, t);
      expect(sevenSeg(session, 'SEG1')).toBe(2);
      seen.add(ledShown(session, 'D1'));
    }
    expect([...seen].sort()).toEqual([false, true]);
  });

  it('the prof\'s own int2A10.c runs the same way in her circuit', LONG, () => {
    const session = startTp('tp4-inte', readFileSync(new URL('../../compiler/test/fixtures/int2A10.c', import.meta.url))).session;
    runUntil(session, 1.1);
    expect(sevenSeg(session, 'SEG1')).toBe(2);
    press(session, 'BTN1', 1.2, 0.1);
    runUntil(session, 1.45);
    expect([sevenSeg(session, 'SEG1'), ledShown(session, 'D1')]).toEqual([2, true]);
    runUntil(session, 4.6);
    expect([sevenSeg(session, 'SEG1'), ledShown(session, 'D1')]).toEqual([3, false]);
  });
});

describe('Manipulation du cours : interruption RB0 (LEDs RA1 / RA2)', () => {
  it('the green LED blinks; a press switches it off and blinks the red one twice, then the green blink goes on', LONG, () => {
    const session = start('ch5-manip-rb0');
    runUntil(session, 0.25);
    expect(shownLeds(session, ['D1', 'D2'])).toEqual(['D2']);
    press(session, 'BOUTON', 0.8, 0.05);
    for (const [t, leds] of [[1.0, ['D1']], [1.5, []], [2.0, ['D1']], [2.5, []]] as const) {
      runUntil(session, t);
      expect(shownLeds(session, ['D1', 'D2']), `t = ${t}`).toEqual(leds);
    }
    // Interrupted 0,2 s before the end of an "off" half-period: green lights again at about 2.8 + 0.2 = 3.0 s.
    runUntil(session, 3.25);
    expect(shownLeds(session, ['D1', 'D2'])).toEqual(['D2']);
  });
});

describe('Exercice du cours : compteur et boutons RB4..RB7 (RBIE)', () => {
  it('a press on B6 shows 6 for 500 ms, then the count goes on; the release interrupt shows nothing', LONG, () => {
    const session = start('ch6-exo-rbie');
    runUntil(session, 1.1);
    expect(sevenSeg(session, 'SEG1')).toBe(2);
    press(session, 'B6', 1.2, 0.1);
    runUntil(session, 1.45);
    expect(sevenSeg(session, 'SEG1')).toBe(6);
    runUntil(session, 2.1);
    expect(sevenSeg(session, 'SEG1')).toBe(3);
    // Long press on B5 (held 1,2 s): 5 is shown once for 500 ms, the count goes on while B5 is held, the release
    // interrupt shows nothing.
    runUntil(session, 3.2);
    session.interact('B5', { type: 'press' });
    const shown: number[] = [];
    for (let t = 3.25; t < 6; t += 0.05) {
      if (Math.abs(t - 4.4) < 0.025) session.interact('B5', { type: 'release' });
      runUntil(session, t);
      shown.push(sevenSeg(session, 'SEG1') ?? -1);
    }
    expect(shown.slice(0, 9).every((v) => v === 5)).toBe(true); // 3.25 … 3.65
    expect([...new Set(shown)]).toEqual([5, 6, 7, 8, 9]);
  });

  it('every button shows its own number', LONG, () => {
    const session = start('ch6-exo-rbie');
    let t = 0.3;
    for (const k of [4, 5, 6, 7]) {
      press(session, `B${k}`, t, 0.05);
      runUntil(session, t + 0.25);
      expect(sevenSeg(session, 'SEG1'), `B${k}`).toBe(k);
      t += 1.2;
    }
  });

  it('without RBIE the buttons do nothing', LONG, () => {
    const session = start('ch6-exo-rbie', source('ch6-exo-rbie').replace('INTCON.RBIE = 1;', 'INTCON.RBIE = 0;'));
    press(session, 'B7', 1.2, 0.1);
    runUntil(session, 1.45);
    expect(sevenSeg(session, 'SEG1')).toBe(2);
  });
});

describe('Feu tricolore avec interruption (montage trafficint.DSN, 8 MHz)', () => {
  it('day cycle in main; the capteur falling to 0 runs the night mode in the interrupt until it goes back to 1', LONG, () => {
    const session = start('tp-traffic-int');
    runUntil(session, 0.05);
    setLogic(session, 'LS1', 1); // jour : front montant, pas d'interruption
    runUntil(session, 2.5);
    expect([lamps(session, 'TL1'), sevenSeg(session, 'SEG1')]).toEqual(['R--', 7]);
    runUntil(session, 3.3);
    setLogic(session, 'LS1', 0); // nuit : front descendant → interruption
    runUntil(session, 3.55);
    expect([lamps(session, 'TL1'), sevenSeg(session, 'SEG1')]).toEqual(['-A-', 0x0a]);
    runUntil(session, 4.05);
    expect(lamps(session, 'TL1')).toBe('---');
    runUntil(session, 5.1);
    setLogic(session, 'LS1', 1);
    // The night loop tests the capteur at the start of each 1 s blink: it ends at ≈ 5.3 s, lamps off and "A" shown.
    runUntil(session, 5.5);
    expect([lamps(session, 'TL1'), sevenSeg(session, 'SEG1')]).toEqual(['---', 0x0a]);
    // Main finishes the 0,7 s left of its step (digit 6), then rewrites the lamps with the next digit.
    runUntil(session, 6.5);
    expect([lamps(session, 'TL1'), sevenSeg(session, 'SEG1')]).toEqual(['R--', 5]);
  });
});
