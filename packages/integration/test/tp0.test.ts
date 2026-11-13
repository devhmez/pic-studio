// TP0 (Ch1): the prof's EXEMPLE1 / EXEMPLE2 in their own ISIS circuits.
import { describe, expect, it } from 'vitest';
import { fixture, ledBrightness, runFor, startTp } from './support';

describe('TP0 — EXEMPLE1 : allumer une LED (RA0)', () => {
  it('lights D1 and ends on the GOTO $ MikroC places after main', () => {
    const { session } = startTp('tp0-exemple1', fixture('EXEMPLE1.c'));
    runFor(session, 0.05);
    expect(session.circuit.visual('D1')).toEqual({ kind: 'LED', lit: true, brightness: 1 });
    expect(session.snapshot().cpu.halted).toBe(true);
  });
});

describe('TP0 — EXEMPLE2 : commander une LED par un bouton', () => {
  it('D1 follows the LOGICSTATE on RB0, toggle after toggle', () => {
    const { session } = startTp('tp0-exemple2', fixture('EXEMPLE2.c'));
    runFor(session, 0.05);
    // The LOGICSTATE is saved at 1 in the DSN.
    expect(session.snapshot().visuals.LS1).toEqual({ kind: 'LOGICSTATE', state: 1 });
    expect(ledBrightness(session, 'D1')).toBe(1);
    for (const expected of [0, 1, 0, 1]) {
      session.interact('LS1', { type: 'toggle' });
      runFor(session, 0.05);
      expect(session.snapshot().visuals.LS1).toEqual({ kind: 'LOGICSTATE', state: expected });
      expect(session.circuit.visual('D1')).toEqual({ kind: 'LED', lit: expected === 1, brightness: expected });
    }
  });

  it('reacts within a few instruction cycles of the click', () => {
    const { session } = startTp('tp0-exemple2', fixture('EXEMPLE2.c'));
    runFor(session, 0.01);
    session.interact('LS1', { type: 'toggle' });
    runFor(session, 50e-6); // ~12 instruction cycles at 1 MHz: one pass of the polling loop
    expect(session.circuit.visual('D1')).toMatchObject({ lit: false });
  });
});
