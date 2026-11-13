/// <reference types="node" />
// Golden test of /templates/*.schematic.json. Regenerate with:
//   UPDATE_TEMPLATES=1 npx vitest run packages/circuit/test/templates.test.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Schematic } from '../src/api';
import { buildNetlist, pinKey } from '../src/netlist';
import { parseSchematicJson, serializeSchematic } from '../src/schematic-io';
import { createCircuitSimulator } from '../src/simulator';
import { FakeMcu, repoPath } from './helpers';
import { TEMPLATE_SOURCES } from './template-sources';

const UPDATE = process.env.UPDATE_TEMPLATES === '1';
const pathOf = (file: string) => repoPath(`templates/${file}.schematic.json`);

if (UPDATE) {
  for (const t of TEMPLATE_SOURCES) writeFileSync(pathOf(t.file), serializeSchematic(t.build(), t.meta));
}

const load = (file: string): Schematic => parseSchematicJson(readFileSync(pathOf(file), 'utf8'));

describe('templates on disk', () => {
  for (const t of TEMPLATE_SOURCES) {
    describe(t.file, () => {
      it('matches its source (importer output / builder)', () => {
        expect(readFileSync(pathOf(t.file), 'utf8')).toBe(serializeSchematic(t.build(), t.meta));
      });
      it('loads, has no dangling wire end, and every pin lands on the grid', () => {
        const s = load(t.file);
        expect(buildNetlist(s).dangling).toEqual([]);
        expect(s.components.find((c) => c.kind === 'PIC16F84A')?.id).toBe('U1');
      });
    });
  }
});

/** Members of the net of a pin, as sorted "id.pin" strings. */
function netMembers(s: Schematic, componentId: string, pin: string): string[] {
  const nl = buildNetlist(s);
  const id = nl.pinToNet.get(pinKey(componentId, pin));
  const net = nl.nets.find((n) => n.id === id)!;
  return net.pins.map((p) => `${p.componentId}.${p.pin}`).sort();
}

describe('tp-vote', () => {
  const s = load('tp-vote');

  it('wires the énoncé pin plan', () => {
    expect(netMembers(s, 'U1', 'RA0')).toEqual(['R1.1', 'U1.RA0', 'VOTE_A.1']);
    expect(netMembers(s, 'U1', 'RA1')).toEqual(['R2.1', 'U1.RA1', 'VOTE_B.1']);
    expect(netMembers(s, 'U1', 'RA3')).toEqual(['R3.1', 'RESULTAT.1', 'U1.RA3']);
    expect(netMembers(s, 'U1', 'RA2')).toEqual(['CONFIRMATION.A', 'U1.RA2']);
    expect(netMembers(s, 'U1', 'RB0/INT')).toEqual(['SEG1.E0', 'U1.RB0/INT']);
    expect(netMembers(s, 'U1', 'RB3')).toEqual(['SEG1.E3', 'U1.RB3']);
    expect(netMembers(s, 'U1', 'RB5')).toEqual(['EGALITE.A', 'U1.RB5']);
    expect(netMembers(s, 'VOTE_A', '2')).toContain('PWR1.VDD');
    expect(netMembers(s, 'R1', '2')).toContain('GND1.GND');
    expect(s.components.filter((c) => c.kind === 'RES').map((c) => c.value)).toEqual(['10k', '10k', '10k']);
  });

  it('behaves: buttons read 0 released / 1 pressed, 7SEG shows F, LEDs light', () => {
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(s, mcu, 'U1');
    expect([mcu.input('RA0'), mcu.input('RA1'), mcu.input('RA3')]).toEqual([0, 0, 0]);
    sim.interact('VOTE_B', { type: 'press' });
    expect([mcu.input('RA0'), mcu.input('RA1'), mcu.input('RA3')]).toEqual([0, 1, 0]);
    sim.interact('VOTE_B', { type: 'release' });
    sim.interact('RESULTAT', { type: 'press' });
    expect(mcu.input('RA3')).toBe(1);
    for (const [pin, v] of [['RB0', 1], ['RB1', 1], ['RB2', 1], ['RB3', 1], ['RB5', 1], ['RA2', 1]] as const) mcu.drive.set(pin, v);
    sim.solve();
    expect(sim.visual('SEG1')).toEqual({ kind: '7SEG-BCD', value: 0x0f });
    expect(sim.visual('CONFIRMATION')).toMatchObject({ lit: true });
    expect(sim.visual('EGALITE')).toMatchObject({ lit: true });
  });
});

describe('tp-pupitre', () => {
  const s = load('tp-pupitre');

  it('wires the TP2 capture', () => {
    expect(netMembers(s, 'U1', 'RA0')).toEqual(['R1.1', 'U1.RA0', 'VALIDER.1']);
    expect(netMembers(s, 'U1', 'RA1')).toEqual(['D4.A', 'U1.RA1']);
    expect(netMembers(s, 'U1', 'RA2')).toEqual(['D2.A', 'U1.RA2']);
    expect(netMembers(s, 'U1', 'RA3')).toEqual(['D3.A', 'U1.RA3']);
    expect(netMembers(s, 'U1', 'RA4/T0CKI')).toEqual(['DEMARRER.Q0', 'U1.RA4/T0CKI']);
    for (let k = 0; k < 8; k++) {
      expect(netMembers(s, 'U1', k === 0 ? 'RB0/INT' : `RB${k}`)).toContain(`LS${k + 1}.Q0`);
    }
    // Common cathode bus and the VALIDER pull-down share the global GND rail.
    expect(netMembers(s, 'D2', 'K')).toEqual(['D2.K', 'D3.K', 'D4.K', 'GND1.GND', 'GND2.GND', 'R1.2']);
  });

  it('behaves: answers 0xCA on PORTB, DEMARRER and VALIDER reach RA4 / RA0, LEDs light', () => {
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(s, mcu, 'U1');
    const answer = 0xca;
    for (let k = 0; k < 8; k++) if ((answer >> k) & 1) sim.interact(`LS${k + 1}`, { type: 'toggle' });
    const portb = [0, 1, 2, 3, 4, 5, 6, 7].reduce((acc, k) => acc | ((mcu.input(`RB${k}` as 'RB0') === 1 ? 1 : 0) << k), 0);
    expect(portb).toBe(0xca);
    expect(mcu.input('RA4')).toBe(0);
    sim.interact('DEMARRER', { type: 'toggle' });
    expect(mcu.input('RA4')).toBe(1);
    expect(mcu.input('RA0')).toBe(0);
    sim.interact('VALIDER', { type: 'press' });
    expect(mcu.input('RA0')).toBe(1);
    mcu.drive.set('RA3', 1);
    sim.solve();
    expect(sim.visual('D3')).toMatchObject({ lit: true });
    expect(sim.visual('D2')).toMatchObject({ lit: false });
  });
});
