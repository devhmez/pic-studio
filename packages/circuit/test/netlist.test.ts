import { describe, expect, it } from 'vitest';
import type { Schematic } from '../src/api';
import { SchematicBuilder, pinRef } from '../src/builder';
import { importDsn } from '../src/dsn';
import { buildNetlist, describeNet, pinKey } from '../src/netlist';
import { readBytes } from './helpers';

/** Two resistors far apart; tests add wires between them. */
function twoResistors(): SchematicBuilder {
  const b = new SchematicBuilder();
  b.place('RES', { at: { x: 0, y: 0 } }); // R1: pins (-2,0) (3,0)
  b.place('RES', { at: { x: 20, y: 10 } }); // R2: pins (18,10) (23,10)
  return b;
}

const sameNet = (s: Schematic, a: [string, string], b: [string, string]) => {
  const nl = buildNetlist(s);
  return nl.pinToNet.get(pinKey(...a)) === nl.pinToNet.get(pinKey(...b));
};

describe('buildNetlist', () => {
  it('connects pins through wire endpoints and interior vertices', () => {
    const b = twoResistors();
    b.wire(pinRef('R1', '2'), { x: 10, y: 0 }, { x: 10, y: 10 }, pinRef('R2', '1'));
    const s = b.build();
    expect(sameNet(s, ['R1', '2'], ['R2', '1'])).toBe(true);
    expect(sameNet(s, ['R1', '1'], ['R2', '1'])).toBe(false);
    expect(buildNetlist(s).dangling).toEqual([]);
  });

  it('joins a wire whose endpoint lands on another wire segment (T-junction) and marks the dot', () => {
    const b = twoResistors();
    b.wire(pinRef('R1', '2'), { x: 15, y: 0 }, { x: 15, y: 10 }, pinRef('R2', '1'));
    b.place('RES', { at: { x: 12, y: -5 }, rotation: 90 }); // R3 pin 1 at (12,-7), pin 2 at (12,-2)
    b.wire(pinRef('R3', '2'), { x: 12, y: 0 }); // ends in the middle of the first wire
    const s = b.build();
    const nl = buildNetlist(s);
    expect(sameNet(s, ['R3', '2'], ['R2', '1'])).toBe(true);
    expect(nl.junctions).toEqual([{ x: 12, y: 0 }]);
    expect(nl.dangling).toEqual([]);
  });

  it('does not join crossing wires, nor a pin tip lying inside a segment', () => {
    const b = twoResistors();
    b.wire(pinRef('R1', '2'), { x: 30, y: 0 }); // passes through nothing
    b.wire({ x: 10, y: -5 }, { x: 10, y: 5 }); // crosses the first wire at (10,0), both ends dangling
    b.wire({ x: 15, y: 10 }, { x: 30, y: 10 }); // runs over R2's pins (18,10) and (23,10) without a vertex there
    const s = b.build();
    const nl = buildNetlist(s);
    expect(nl.wireToNet.get('W1')).not.toBe(nl.wireToNet.get('W2'));
    expect(sameNet(s, ['R2', '1'], ['R2', '2'])).toBe(false);
    expect(nl.dangling).toEqual([
      { x: 30, y: 0 }, { x: 10, y: -5 }, { x: 10, y: 5 }, { x: 15, y: 10 }, { x: 30, y: 10 },
    ]);
  });

  it('puts every POWER on the global VDD rail and every GROUND on GND', () => {
    const b = twoResistors();
    b.place('POWER', { at: { x: -2, y: -2 } }); // node (-2,-1)
    b.wire({ x: -2, y: -1 }, pinRef('R1', '1'));
    b.place('POWER', { at: { x: 23, y: 8 } }); // node (23,9): not wired → still the VDD rail
    b.place('GROUND', { at: { x: 3, y: 2 } }); // node (3,1)
    b.wire(pinRef('R1', '2'), { x: 3, y: 1 });
    b.place('GROUND', { at: { x: 18, y: 12 } }); // node (18,11)
    b.wire(pinRef('R2', '1'), { x: 18, y: 11 });
    const s = b.build();
    const nl = buildNetlist(s);
    const vdd = nl.nets.find((n) => n.id === 'VDD')!;
    const gnd = nl.nets.find((n) => n.id === 'GND')!;
    expect(vdd.rail).toBe('VDD');
    expect(gnd.rail).toBe('GND');
    expect(describeNet(vdd, s.components)).toEqual(['R1.1', 'PWR1.VDD', 'PWR2.VDD']);
    expect(describeNet(gnd, s.components)).toEqual(['R1.2', 'R2.1', 'GND1.GND', 'GND2.GND']);
  });

  it('connects pin tips that touch directly', () => {
    const b = new SchematicBuilder();
    b.place('RES', { at: { x: 0, y: 0 } });
    b.place('RES', { at: { x: 5, y: 0 } }); // pin 1 at (3,0) = R1 pin 2
    expect(sameNet(b.build(), ['R1', '2'], ['R2', '1'])).toBe(true);
  });

  it('gives every visible pin a net (singletons included) and skips the hidden PIC VDD/VSS', () => {
    const s = importDsn(readBytes('cours/EXEMPLE1.DSN'));
    const nl = buildNetlist(s);
    expect(nl.pinToNet.size).toBe(16 + 2 + 1); // PIC visible pins + LED + GROUND
    expect(nl.pinToNet.has(pinKey('U1', 'VDD'))).toBe(false);
    const ra1 = nl.nets.find((n) => n.id === nl.pinToNet.get(pinKey('U1', 'RA1')))!;
    expect(ra1.pins).toEqual([{ componentId: 'U1', pin: 'RA1' }]);
    expect(nl.wireToNet.get('W1')).toBe(nl.pinToNet.get(pinKey('U1', 'RA0')));
  });

  it('places junction dots where the prof\'s ISIS captures show them', () => {
    expect(buildNetlist(importDsn(readBytes('cours/manipulation status.DSN'))).junctions).toEqual([{ x: 21, y: 5 }]);
    expect(buildNetlist(importDsn(readBytes('cours/EXEMPLE1.DSN'))).junctions).toEqual([]);
  });
});
