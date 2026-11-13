// TP1 « Démultiplexeur 1 vers 4 » (Ch2) in the prof's DSN circuit:
// LS1 → RA0 (L0), LS2 → RA1 (L1); RB0..RB3 → RES 220 → D1 (bleue), D2 (verte), D3 (rouge), D4 (jaune) → GND.
import { describe, expect, it } from 'vitest';
import type { SimSession } from '@pic/circuit';
import { fixture, runFor, shownLeds, startTp } from './support';

const LEDS = ['D1', 'D2', 'D3', 'D4'] as const; // on RB0 (D0) .. RB3 (D3)

function setInputs(session: SimSession, l1: 0 | 1, l0: 0 | 1): void {
  const visuals = session.snapshot().visuals;
  for (const [id, wanted] of [['LS1', l0], ['LS2', l1]] as const) {
    const v = visuals[id];
    if (v?.kind !== 'LOGICSTATE') throw new Error(`${id} n'est pas une LOGICSTATE`);
    if (v.state !== wanted) session.interact(id, { type: 'toggle' });
  }
}

/** Lit LED for each (L1, L0) input combination, in the order 00, 01, 10, 11. */
function truthTable(session: SimSession): string[][] {
  const rows: string[][] = [];
  for (const [l1, l0] of [[0, 0], [0, 1], [1, 0], [1, 1]] as const) {
    setInputs(session, l1, l0);
    runFor(session, 0.05);
    rows.push(shownLeds(session, LEDS));
  }
  return rows;
}

describe('TP1 démultiplexeur', () => {
  it('correction: exactly the LED of output D(2·L1 + L0) is lit, for all four inputs', () => {
    const { session } = startTp('tp1-demux', fixture('demux_corrige.c'));
    expect(truthTable(session)).toEqual([['D1'], ['D2'], ['D3'], ['D4']]);
  });

  it('starts from the DSN states L0 = 0, L1 = 1: output D2 → LED D3 (rouge) through its 220 Ω resistor', () => {
    const { session } = startTp('tp1-demux', fixture('demux_corrige.c'));
    runFor(session, 0.05);
    expect(shownLeds(session, LEDS)).toEqual(['D3']);
    expect(session.circuit.visual('D3')).toEqual({ kind: 'LED', lit: true, brightness: 1 });
  });

  it('demux.c du cours is simulated as written: D1 and D2 swapped for L1 L0 = 01 and 10', () => {
    const { session } = startTp('tp1-demux', fixture('demux.c'));
    expect(truthTable(session)).toEqual([['D1'], ['D3'], ['D2'], ['D4']]);
  });
});
