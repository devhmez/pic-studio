// Proteus resolves POWER / GROUND terminals at power strength (VSM states PHI / PLO), above the strong
// drive of a PIC output or a LOGICSTATE: a pin shorted to a rail by a closed BUTTON is simply pulled to that
// rail, and the rail itself (an ideal 0 V / 5 V source) never changes. Only a rail-to-rail short is a conflict.
// The simulator treats rails like any other strong driver, so one shorted pin turns the whole global rail
// into 'X' and every unrelated part on that rail (LED cathodes, pull-downs...) goes undefined.
import { describe, expect, it } from 'vitest';
import { SchematicBuilder, pinRef } from '../../src/builder';
import { pinKey } from '../../src/netlist';
import { createCircuitSimulator } from '../../src/simulator';
import { FakeMcu } from '../helpers';

/** RA0 → LED → GND, and RB0 → BUTTON → GND (a Ch5 RB0/INT button, here on a pin mistakenly left as output). */
function ledAndButtonToGround() {
  const b = new SchematicBuilder();
  b.place('PIC16F84A', { at: { x: 0, y: 0 } });
  const led = b.place('LED', { at: { x: 30, y: 4 } });
  b.wire(pinRef('U1', 'RA0'), { x: 30, y: 0 }, pinRef(led.id, 'A'));
  const g1 = b.place('GROUND', { at: { x: 30, y: 9 } });
  b.wire(pinRef(led.id, 'K'), pinRef(g1.id, 'GND'));
  const btn = b.place('BUTTON', { at: { x: 20, y: 6 } });
  b.wire(pinRef('U1', 'RB0/INT'), pinRef(btn.id, '1'));
  const g2 = b.place('GROUND', { at: { x: 22, y: 8 } });
  b.wire(pinRef(btn.id, '2'), pinRef(g2.id, 'GND'));
  return { schematic: b.build(), led: led.id, btn: btn.id };
}

describe('POWER / GROUND rails dominate strong drivers (Proteus power strength)', () => {
  it('a button shorting an output driving 1 to GND leaves the GND rail at 0 and unrelated LEDs lit', () => {
    const { schematic, led, btn } = ledAndButtonToGround();
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(schematic, mcu, 'U1');
    expect(sim.netlist.dangling).toEqual([]);
    mcu.drive.set('RA0', 1);
    mcu.drive.set('RB0', 1);
    sim.solve();
    expect(sim.visual(led)).toMatchObject({ lit: true });

    sim.interact(btn, { type: 'press' });
    // The ideal ground rail is still 0 V: the LED on RA0 (cathode on the rail) keeps shining.
    expect(sim.netLevel('GND')).toBe(0);
    expect(sim.visual(led)).toMatchObject({ lit: true });
    // The shorted pin itself is pulled to the rail.
    expect(mcu.input('RB0')).toBe(0);
  });

  it('a button shorting an output driving 0 to POWER leaves the VDD rail at 1 for the other buttons', () => {
    // RA0 → BUTTON → POWER (output 0 by mistake); RA1 → BUTTON → POWER with 10k pull-down (a normal vote input).
    const b = new SchematicBuilder();
    b.place('PIC16F84A', { at: { x: 0, y: 0 } });
    const bad = b.place('BUTTON', { at: { x: 23, y: 0 } });
    b.wire(pinRef('U1', 'RA0'), pinRef(bad.id, '1'));
    const p1 = b.place('POWER', { at: { x: 25, y: -7 } });
    b.wire(pinRef(bad.id, '2'), pinRef(p1.id, 'VDD'));
    const good = b.place('BUTTON', { at: { x: 40, y: 1 } });
    b.wire(pinRef('U1', 'RA1'), pinRef(good.id, '1'));
    const p2 = b.place('POWER', { at: { x: 42, y: -7 } });
    b.wire(pinRef(good.id, '2'), pinRef(p2.id, 'VDD'));
    const r = b.place('RES', { at: { x: 34, y: 5 }, rotation: 90, value: '10k' }); // pin 1 (34,3), pin 2 (34,8)
    b.wire(pinRef(r.id, '1'), { x: 34, y: 1 });
    const g = b.place('GROUND', { at: { x: 34, y: 10 } });
    b.wire(pinRef(r.id, '2'), pinRef(g.id, 'GND'));
    const s = b.build();

    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(s, mcu, 'U1');
    expect(sim.netlist.dangling).toEqual([]);
    expect(sim.netlist.pinToNet.get(pinKey(r.id, '1'))).toBe(sim.netlist.pinToNet.get(pinKey('U1', 'RA1')));
    mcu.drive.set('RA0', 0);
    sim.solve();
    sim.interact(good.id, { type: 'press' });
    expect(mcu.input('RA1')).toBe(1);

    sim.interact(bad.id, { type: 'press' });
    expect(sim.netLevel('VDD')).toBe(1);
    expect(mcu.input('RA1')).toBe(1); // the vote button on RA1 must not become undefined
  });

  it('a POWER-to-GROUND short is still a conflict (control case)', () => {
    const b = new SchematicBuilder();
    b.place('PIC16F84A', { at: { x: 0, y: 0 } });
    const btn = b.place('BUTTON', { at: { x: 40, y: 20 } });
    const pwr = b.place('POWER', { at: { x: 36, y: 18 } });
    const gnd = b.place('GROUND', { at: { x: 44, y: 22 } });
    b.wire(pinRef(pwr.id, 'VDD'), pinRef(btn.id, '1'));
    b.wire(pinRef(btn.id, '2'), pinRef(gnd.id, 'GND'));
    const sim = createCircuitSimulator(b.build(), new FakeMcu(), 'U1');
    sim.interact(btn.id, { type: 'press' });
    expect(sim.netLevel('VDD')).toBe('X');
  });
});
