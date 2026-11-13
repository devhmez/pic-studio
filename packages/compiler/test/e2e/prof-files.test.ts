import { describe, expect, it } from 'vitest';
import { codes, duty, fixture, runFor, runToHalt } from '../support/harness';
import { fixtureText, onEmulator, statusLeds } from './support';

// The prof's files compiled and run on @pic/emulator, checked against what Proteus shows.

describe('status.c (correction du prof, deux if indépendants)', () => {
  it('compile sans erreur et signale le if indépendant', () => {
    const { r } = onEmulator(fixture('status.c'));
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(codes(r)).toContain('W_SEPARATE_IF_AFTER_FLAG');
  });

  it('x = y = 6 allume EGAL (RB1) ET SUP (RB0) : le bug est reproduit fidèlement', () => {
    const { core } = onEmulator(fixture('status.c'));
    expect(statusLeds(core)).toEqual({ sup: true, egal: true, inf: false });
  });

  // Same program with the slide-7 values: the separate `if` only differs from the organigramme when x = y.
  const variant = (x: number, y: number) => fixtureText('status.c').replace('x = 6; y = 6;', `x = ${x}; y = ${y};`);
  it.each([
    [5, 6, { sup: false, egal: false, inf: true }],
    [6, 5, { sup: true, egal: false, inf: false }],
    [5, 5, { sup: true, egal: true, inf: false }],
    [10, 3, { sup: true, egal: false, inf: false }],
    [3, 10, { sup: false, egal: false, inf: true }],
  ])('x = %i, y = %i', (x, y, expected) => {
    const { core } = onEmulator(variant(x, y));
    expect(statusLeds(core)).toEqual(expected);
  });
});

describe('status corrigé (else if, conforme à l’organigramme)', () => {
  it('x = y = 6 allume seulement EGAL (RB1)', () => {
    const { r, core } = onEmulator(fixture('status_corrige.c'));
    expect(codes(r)).not.toContain('W_SEPARATE_IF_AFTER_FLAG');
    expect(statusLeds(core)).toEqual({ sup: false, egal: true, inf: false });
  });

  const variant = (x: number, y: number) => fixtureText('status_corrige.c').replace('x = 6; y = 6;', `x = ${x}; y = ${y};`);
  it.each([
    [5, 6, 'INF'],
    [6, 5, 'SUP'],
    [5, 5, 'EGAL'],
    [10, 3, 'SUP'],
    [3, 10, 'INF'],
  ])('tableau de la diapo 7 : x = %i, y = %i → LED_%s', (x, y, which) => {
    const { core } = onEmulator(variant(x, y));
    expect(statusLeds(core)).toEqual({ sup: which === 'SUP', egal: which === 'EGAL', inf: which === 'INF' });
  });
});

describe('démultiplexeur 1 vers 4', () => {
  const outputs = (core: ReturnType<typeof onEmulator>['core']) => {
    runFor(core, 500);
    return (['RB0', 'RB1', 'RB2', 'RB3'] as const).map((p) => (duty(core, p, 400) > 0.5 ? 1 : 0)).join('');
  };
  const drive = (core: ReturnType<typeof onEmulator>['core'], l1: 0 | 1, l0: 0 | 1) => {
    core.setInput('RA1', l1);
    core.setInput('RA0', l0);
  };

  // Tableau 1.1: (L1,L0) = 00 → D0, 01 → D1, 10 → D2, 11 → D3. Outputs listed RB0 RB1 RB2 RB3.
  it.each([
    [0, 0, '1000'],
    [0, 1, '0100'],
    [1, 0, '0010'],
    [1, 1, '0001'],
  ] as const)('version corrigée : L1 = %i, L0 = %i → %s', (l1, l0, expected) => {
    const { core } = onEmulator(fixture('demux_corrige.c'));
    drive(core, l1, l0);
    expect(outputs(core)).toBe(expected);
  });

  // demux.c as posted swaps D1 and D2 (second branch tests L0 == 0 && L1 == 1): simulated faithfully.
  it.each([
    [0, 0, '1000'],
    [0, 1, '0010'],
    [1, 0, '0100'],
    [1, 1, '0001'],
  ] as const)('demux.c du prof (D1/D2 inversées) : L1 = %i, L0 = %i → %s', (l1, l0, expected) => {
    const { core } = onEmulator(fixture('demux.c'));
    drive(core, l1, l0);
    expect(outputs(core)).toBe(expected);
  });

  it('suit les changements des entrées pendant la simulation', () => {
    const { core } = onEmulator(fixture('demux_corrige.c'));
    drive(core, 0, 0);
    expect(outputs(core)).toBe('1000');
    drive(core, 1, 1);
    expect(outputs(core)).toBe('0001');
    drive(core, 0, 1);
    expect(outputs(core)).toBe('0100');
  });
});

describe('TP0 : EXEMPLE1 et EXEMPLE2', () => {
  it('EXEMPLE1 allume RA0 puis s’arrête (GOTO $, sorties figées)', () => {
    const { core } = onEmulator(fixture('EXEMPLE1.c'));
    runToHalt(core);
    expect(core.getDrive('RA0')).toBe(1);
    runFor(core, 100);
    expect(core.getDrive('RA0')).toBe(1);
  });

  it('EXEMPLE2 : la LED RA0 suit le bouton (LOGICSTATE) sur RB0', () => {
    const { core } = onEmulator(fixture('EXEMPLE2.c'));
    core.setInput('RB0', 1);
    runFor(core, 200);
    expect(duty(core, 'RA0', 200)).toBeGreaterThan(0.9);
    core.setInput('RB0', 0);
    runFor(core, 200);
    expect(duty(core, 'RA0', 200)).toBe(0);
    core.setInput('RB0', 1);
    runFor(core, 200);
    expect(duty(core, 'RA0', 200)).toBeGreaterThan(0.9);
    expect(core.getDrive('RB0')).toBe('Z');
  });
});
