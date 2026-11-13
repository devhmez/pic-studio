import { describe, expect, it } from 'vitest';
import { SchematicBuilder, pinRef } from '../src/builder';
import { importDsn } from '../src/dsn';
import { DutyCycle, LED_MODEL, createCircuitSimulator, diodeCurrents, minLitCurrent } from '../src/simulator';
import { FakeMcu, readBytes } from './helpers';

describe('DutyCycle (LED display brightness)', () => {
  it('shows a step change at once when switching off, after TLITMIN (0.1 ms) when switching on', () => {
    const d = new DutyCycle();
    d.advance(0.1, false);
    d.advance(50e-6, true);
    expect(d.value(true)).toBe(0); // on for less than TLITMIN
    d.advance(60e-6, true);
    expect(d.value(true)).toBe(1);
    d.advance(0.1, true);
    d.advance(4e-6, false);
    expect(d.value(false)).toBe(0);
    expect(d.value(true)).toBe(1); // back on after a 4 µs glitch: the last window's average
  });

  it('ignores a single short glitch on a steady LED', () => {
    const d = new DutyCycle();
    d.advance(0.1, true);
    d.advance(4e-6, false);
    d.advance(4e-6, true);
    expect(d.value(true)).toBe(1);
  });

  it('averages a fast toggle over the last full window', () => {
    const d = new DutyCycle();
    for (let i = 0; i < 40; i++) {
      d.advance(0.0005, true);
      d.advance(0.0005, false);
    }
    expect(d.value(false)).toBeCloseTo(0.5, 9);
    expect(d.value(true)).toBeCloseTo(0.5, 9);
  });

  it('reset() forgets the history', () => {
    const d = new DutyCycle();
    d.advance(0.1, true);
    d.reset();
    expect(d.value(false)).toBe(0);
    expect(d.value(true)).toBe(1);
  });
});

describe('LED brightness while single-stepping', () => {
  it('EXEMPLE1: D1 follows RA0 step by step once the time is past TLITMIN', () => {
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(importDsn(readBytes('cours/EXEMPLE1.DSN')), mcu, 'U1');
    mcu.drive.set('RA0', 1);
    sim.solve();
    sim.advance(0.1);
    mcu.drive.set('RA0', 0);
    sim.solve();
    sim.advance(4e-6);
    expect(sim.visual('D1')).toEqual({ kind: 'LED', lit: false, brightness: 0 });
    mcu.drive.set('RA0', 1);
    sim.solve();
    for (let i = 0; i < 30; i++) sim.advance(4e-6);
    expect(sim.visual('D1')).toEqual({ kind: 'LED', lit: true, brightness: 1 });
  });
});

describe('LED conduction (LEDA: VF 2.2 V)', () => {
  /** RA0 → chain of LEDs (anode up) at x = 30 → GROUND; `reversed` flips the LED at that index. */
  function chain(count: number, opts: { resistorAfter?: number; reversed?: number } = {}) {
    const b = new SchematicBuilder();
    b.place('PIC16F84A', { at: { x: 0, y: 0 } });
    b.wire(pinRef('U1', 'RA0'), { x: 30, y: 0 }, { x: 30, y: 2 });
    // Each part's top pin sits on the previous part's bottom pin (y).
    let y = 2;
    const leds: string[] = [];
    for (let i = 0; i < count; i++) {
      const led = b.place('LED', { at: { x: 30, y: y + 2 }, rotation: opts.reversed === i ? 180 : 0 });
      leds.push(led.id);
      y += 4;
      if (opts.resistorAfter === i) {
        b.place('RES', { at: { x: 30, y: y + 2 }, rotation: 90, value: '220' }); // pins (30, y), (30, y + 5)
        y += 5;
      }
    }
    const gnd = b.place('GROUND', { at: { x: 30, y: y + 3 } }); // pin (30, y + 2)
    b.wire({ x: 30, y }, pinRef(gnd.id, 'GND'));
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(b.build(), mcu, 'U1');
    mcu.drive.set('RA0', 1);
    sim.solve();
    const lit = leds.map((id) => (sim.visual(id) as { lit: boolean }).lit);
    return { sim, lit };
  }

  it('two LEDs in series light from a 5 V output, three do not (3 × 2.2 V > 5 V)', () => {
    const two = chain(2);
    expect(two.sim.netlist.dangling).toEqual([]);
    expect(two.lit).toEqual([true, true]);
    const three = chain(3);
    expect(three.sim.netlist.dangling).toEqual([]);
    expect(three.lit).toEqual([false, false, false]);
  });

  it('LED → 220 Ω → LED lights both; a reversed LED in the chain blocks it', () => {
    const withResistor = chain(2, { resistorAfter: 0 });
    expect(withResistor.sim.netlist.dangling).toEqual([]);
    expect(withResistor.lit).toEqual([true, true]);
    expect(chain(2, { reversed: 1 }).lit).toEqual([false, false]);
  });

  it('an LED fed by a 10k pull-up from POWER lights; one on a contended node goes dark', () => {
    const b = new SchematicBuilder();
    b.place('PIC16F84A', { at: { x: 0, y: 0 } });
    const r = b.place('RES', { at: { x: 40, y: 5 }, rotation: 90, value: '10k' }); // pins (40, 3), (40, 8)
    const pwr = b.place('POWER', { at: { x: 40, y: 1 } });
    b.wire(pinRef(pwr.id, 'VDD'), pinRef(r.id, '1'));
    const led = b.place('LED', { at: { x: 40, y: 10 } });
    const gnd = b.place('GROUND', { at: { x: 40, y: 15 } });
    b.wire(pinRef(led.id, 'K'), pinRef(gnd.id, 'GND'));

    const ls = b.place('LOGICSTATE', { at: { x: 22, y: 6 }, mirror: true, props: { state: 1 } });
    b.wire(pinRef('U1', 'RB0/INT'), pinRef(ls.id, 'Q0'));
    const led3 = b.place('LED', { at: { x: 18, y: 10 } }); // A (18, 8), T-joined to the RB0 wire
    b.wire({ x: 18, y: 6 }, pinRef(led3.id, 'A'));
    const gnd3 = b.place('GROUND', { at: { x: 18, y: 15 } });
    b.wire(pinRef(led3.id, 'K'), pinRef(gnd3.id, 'GND'));
    const led2 = b.place('LED', { at: { x: 30, y: 10 } }); // A (30, 8)
    b.wire(pinRef('U1', 'RB1'), { x: 30, y: 7 }, pinRef(led2.id, 'A'));
    const gnd2 = b.place('GROUND', { at: { x: 30, y: 15 } });
    b.wire(pinRef(led2.id, 'K'), pinRef(gnd2.id, 'GND'));

    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(b.build(), mcu, 'U1');
    expect(sim.netlist.dangling).toEqual([]);
    expect(sim.visual(led.id)).toMatchObject({ lit: true });
    expect(sim.visual(led3.id)).toMatchObject({ lit: true });
    mcu.drive.set('RB1', 1);
    sim.solve();
    expect(sim.visual(led2.id)).toMatchObject({ lit: true });
    // RB0 (output 0) fights the LOGICSTATE at 1: the node is X and its LED goes dark.
    mcu.drive.set('RB0', 0);
    sim.solve();
    expect(mcu.input('RB0')).toBe('X');
    expect(sim.visual(led3.id)).toMatchObject({ lit: false });
  });

  it('diodeCurrents: VF threshold, series chains, ROFF leakage and reverse bias', () => {
    // Nodes: 0 = 5 V, 1 = middle (free), 2 = 0 V.
    const fixed = Float64Array.from([5, NaN, 0]);
    const series = diodeCurrents(3, [], [{ anode: 0, cathode: 1 }, { anode: 1, cathode: 2 }], fixed);
    expect([...series].map((i) => i * 1000)).toEqual([expect.closeTo(100, 6), expect.closeTo(100, 6)]); // 0.6 V / 6 Ω
    // A forward LED behind a reversed one only carries the reversed LED's ROFF leakage (28 µA): not lit.
    const blocked = diodeCurrents(3, [], [{ anode: 1, cathode: 0 }, { anode: 1, cathode: 2 }], fixed);
    expect(blocked[0]).toBe(0);
    expect(blocked[1]).toBeGreaterThan(0);
    expect(blocked[1]).toBeLessThan(minLitCurrent(LED_MODEL));
    // 2.1 V across a single LED: below VF.
    expect([...diodeCurrents(2, [], [{ anode: 0, cathode: 1 }], Float64Array.from([2.1, 0]))]).toEqual([0]);
    // 220 Ω from 5 V: (5 − 2.2) / 223 ≈ 12.6 mA.
    const r220 = diodeCurrents(3, [{ a: 0, b: 1, g: 1 / 220 }], [{ anode: 1, cathode: 2 }], fixed);
    expect(r220[0]).toBeCloseTo(2.8 / 223, 9);
  });
});
