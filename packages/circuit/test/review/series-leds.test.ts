// Two LEDs in series from a 5 V output to GND: 2 × VF (2.2 V, LED library default) = 4.4 V < 5 V, so in Proteus
// (LEDA model: conducts above VF) both LEDs light. The simulator models an LED as a pure load whose cathode must
// reach 0 "directly or through a resistor", so the node between the two LEDs is floating ('Z') and neither lights.
import { describe, expect, it } from 'vitest';
import { SchematicBuilder, pinRef } from '../../src/builder';
import { pinKey } from '../../src/netlist';
import { createCircuitSimulator } from '../../src/simulator';
import { FakeMcu } from '../helpers';

describe('LEDs in series', () => {
  it('RA0 → LED → LED → GND lights both LEDs when RA0 drives 1', () => {
    const b = new SchematicBuilder();
    b.place('PIC16F84A', { at: { x: 0, y: 0 } });
    const top = b.place('LED', { at: { x: 30, y: 4 } }); // A (30,2), K (30,6)
    const bottom = b.place('LED', { at: { x: 30, y: 8 } }); // A (30,6) touches the first cathode, K (30,10)
    b.wire(pinRef('U1', 'RA0'), { x: 30, y: 0 }, pinRef(top.id, 'A'));
    const gnd = b.place('GROUND', { at: { x: 30, y: 13 } });
    b.wire(pinRef(bottom.id, 'K'), pinRef(gnd.id, 'GND'));
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(b.build(), mcu, 'U1');
    expect(sim.netlist.dangling).toEqual([]);
    expect(sim.netlist.pinToNet.get(pinKey(top.id, 'K'))).toBe(sim.netlist.pinToNet.get(pinKey(bottom.id, 'A')));

    mcu.drive.set('RA0', 1);
    sim.solve();
    expect(sim.visual(top.id)).toMatchObject({ lit: true });
    expect(sim.visual(bottom.id)).toMatchObject({ lit: true });

    mcu.drive.set('RA0', 0);
    sim.solve();
    expect(sim.visual(top.id)).toMatchObject({ lit: false });
    expect(sim.visual(bottom.id)).toMatchObject({ lit: false });
  });
});
