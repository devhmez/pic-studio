import { describe, expect, it } from 'vitest';
import type { Schematic } from '../src/api';
import { SchematicBuilder, pinRef } from '../src/builder';
import { importDsn } from '../src/dsn';
import { pinKey } from '../src/netlist';
import { PROTEUS_PIC_THRESHOLDS, createCircuitSimulator, type CircuitSimulatorEx } from '../src/simulator';
import { FakeMcu, readBytes } from './helpers';

/** PIC at the origin: RA0..RA4 tips at (15, 0..4), RB0..RB7 at (15, 6..13). */
function withPic(): SchematicBuilder {
  const b = new SchematicBuilder();
  b.place('PIC16F84A', { at: { x: 0, y: 0 } });
  return b;
}

const netOf = (sim: CircuitSimulatorEx, componentId: string, pin: string) => sim.netlist.pinToNet.get(pinKey(componentId, pin))!;

function ledOnPin(b: SchematicBuilder, picPin: string, x: number, opts: { resistor?: string } = {}) {
  const y = b.pin('U1', picPin).y;
  const led = b.place('LED', { at: { x, y: y + 4 }, props: { color: 'RED' } });
  if (opts.resistor) {
    const r = b.place('RES', { at: { x: x - 6, y }, value: opts.resistor });
    b.wire(pinRef('U1', picPin), pinRef(r.id, '1'));
    b.wire(pinRef(r.id, '2'), { x, y }, pinRef(led.id, 'A'));
  } else {
    b.wire(pinRef('U1', picPin), { x, y }, pinRef(led.id, 'A'));
  }
  const gnd = b.place('GROUND', { at: { x, y: y + 9 } });
  b.wire(pinRef(led.id, 'K'), pinRef(gnd.id, 'GND'));
  return led.id;
}

describe('LEDs', () => {
  it('lights when the pin drives 1 (EXEMPLE1: RA0 → LED-BLUE → GND, no resistor)', () => {
    const s = importDsn(readBytes('cours/EXEMPLE1.DSN'));
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(s, mcu, 'U1');
    expect(sim.visual('D1')).toEqual({ kind: 'LED', lit: false, brightness: 0 });
    mcu.drive.set('RA0', 1);
    sim.solve();
    expect(sim.visual('D1')).toMatchObject({ kind: 'LED', lit: true });
    expect(sim.netLevel(netOf(sim, 'U1', 'RA0'))).toBe(1);
    mcu.drive.set('RA0', 0);
    sim.solve();
    expect(sim.visual('D1')).toMatchObject({ lit: false });
    mcu.drive.set('RA0', 'Z');
    sim.solve();
    expect(sim.visual('D1')).toMatchObject({ lit: false });
  });

  it('lights through a 220 Ω series resistor (demux wiring)', () => {
    const b = withPic();
    const led = ledOnPin(b, 'RB0/INT', 30, { resistor: '220' });
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(b.build(), mcu, 'U1');
    mcu.drive.set('RB0', 1);
    sim.solve();
    expect(sim.visual(led)).toMatchObject({ lit: true });
    const anode = netOf(sim, led, 'A');
    expect(sim.netLevel(anode)).toBe(1);
    expect(sim.netVoltage(anode)).toBeCloseTo(5);
    mcu.drive.set('RB0', 0);
    sim.solve();
    expect(sim.visual(led)).toMatchObject({ lit: false });
    expect(sim.netLevel(anode)).toBe(0);
  });

  it('demux DSN: each RBn lights its LED through its resistor', () => {
    const s = importDsn(readBytes('cours/tp demux.DSN'));
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(s, mcu, 'U1');
    const map = { RB0: 'D1', RB1: 'D2', RB2: 'D3', RB3: 'D4' } as const;
    for (const [pin, led] of Object.entries(map)) {
      for (const p of Object.keys(map)) mcu.drive.set(p as keyof typeof map, p === pin ? 1 : 0);
      sim.solve();
      for (const other of Object.values(map)) expect((sim.visual(other) as { lit: boolean }).lit).toBe(other === led);
    }
  });

  it('lights with the cathode returned to GND through a resistor, not when reversed', () => {
    const b = withPic();
    const led = b.place('LED', { at: { x: 30, y: 4 } });
    b.wire(pinRef('U1', 'RA0'), { x: 30, y: 0 }, pinRef(led.id, 'A'));
    const r = b.place('RES', { at: { x: 32, y: 6 }, rotation: 90, value: '330' });
    b.wire(pinRef(led.id, 'K'), pinRef(r.id, '1'));
    const gnd = b.place('GROUND', { at: { x: 32, y: 12 } });
    b.wire(pinRef(r.id, '2'), pinRef(gnd.id, 'GND'));
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(b.build(), mcu, 'U1');
    mcu.drive.set('RA0', 1);
    sim.solve();
    expect(sim.visual(led.id)).toMatchObject({ lit: true });

    const rev = withPic();
    const d = rev.place('LED', { at: { x: 30, y: 4 }, rotation: 180 });
    rev.wire(pinRef('U1', 'RA0'), { x: 30, y: 0 }, pinRef(d.id, 'K'));
    const g = rev.place('GROUND', { at: { x: 30, y: 9 } });
    rev.wire(pinRef(d.id, 'A'), pinRef(g.id, 'GND'));
    const mcu2 = new FakeMcu();
    const sim2 = createCircuitSimulator(rev.build(), mcu2, 'U1');
    mcu2.drive.set('RA0', 1);
    sim2.solve();
    expect(sim2.visual(d.id)).toMatchObject({ lit: false });
  });

  it('status DSN: RB0/RB1/RB2 light X_SUPERIEUR / EGALITE / X_INFERIEUR', () => {
    const s = importDsn(readBytes('cours/manipulation status.DSN'));
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(s, mcu, 'U1');
    mcu.drive.set('RB0', 1);
    mcu.drive.set('RB1', 1);
    mcu.drive.set('RB2', 0);
    sim.solve();
    expect(sim.visual('X_SUPERIEUR')).toMatchObject({ lit: true });
    expect(sim.visual('EGALITE')).toMatchObject({ lit: true });
    expect(sim.visual('X_INFERIEUR')).toMatchObject({ lit: false });
  });
});

describe('inputs', () => {
  it('LOGICSTATE drives the MCU input and toggles (EXEMPLE2: STATE=1 on RB0)', () => {
    const s = importDsn(readBytes('cours/EXEMPLE2.DSN'));
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(s, mcu, 'U1');
    expect(mcu.input('RB0')).toBe(1); // pushed by the constructor's first solve
    expect(sim.visual('LS1')).toEqual({ kind: 'LOGICSTATE', state: 1 });
    sim.interact('LS1', { type: 'toggle' });
    expect(mcu.input('RB0')).toBe(0);
    expect(sim.visual('LS1')).toEqual({ kind: 'LOGICSTATE', state: 0 });
  });

  it('demux DSN: the two LOGICSTATEs start at RA0 = 0 and RA1 = 1', () => {
    const mcu = new FakeMcu();
    createCircuitSimulator(importDsn(readBytes('cours/tp demux.DSN')), mcu, 'U1');
    expect(mcu.input('RA0')).toBe(0);
    expect(mcu.input('RA1')).toBe(1);
  });

  function buttonPullDown(): Schematic {
    // RA0 node ─ BUTTON ─ POWER, node ─ RES 10k ─ GROUND (pupitre VALIDER wiring).
    const b = withPic();
    const btn = b.place('BUTTON', { at: { x: 23, y: 0 }, ref: 'VALIDER' });
    b.wire(pinRef('U1', 'RA0'), pinRef(btn.id, '1'));
    const pwr = b.place('POWER', { at: { x: 25, y: -7 } });
    b.wire(pinRef(btn.id, '2'), pinRef(pwr.id, 'VDD'));
    const r = b.place('RES', { at: { x: 20, y: -3 }, rotation: 270, value: '10k' });
    b.wire(pinRef(r.id, '1'), { x: 20, y: 0 });
    const gnd = b.place('GROUND', { at: { x: 17, y: -5 } });
    b.wire(pinRef(r.id, '2'), { x: 20, y: -8 }, { x: 17, y: -8 }, pinRef(gnd.id, 'GND'));
    return b.build();
  }

  it('BUTTON + 10k pull-down reads 0 released and 1 pressed', () => {
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(buttonPullDown(), mcu, 'U1');
    expect(sim.netlist.dangling).toEqual([]);
    expect(mcu.input('RA0')).toBe(0);
    expect(sim.netVoltage(netOf(sim, 'U1', 'RA0'))).toBeCloseTo(0);
    sim.interact('VALIDER', { type: 'press' });
    expect(sim.visual('VALIDER')).toEqual({ kind: 'BUTTON', pressed: true });
    expect(mcu.input('RA0')).toBe(1);
    sim.interact('VALIDER', { type: 'release' });
    expect(mcu.input('RA0')).toBe(0);
  });

  it('an unconnected input reads Z (floating, grey)', () => {
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(buttonPullDown(), mcu, 'U1');
    expect(mcu.input('RA1')).toBe('Z');
    expect(sim.netLevel(netOf(sim, 'U1', 'RA1'))).toBe('Z');
    expect(sim.netVoltage(netOf(sim, 'U1', 'RA1'))).toBeNull();
  });

  it('PORTB weak pull-up reads 1, and a button to GND pulls it to 0', () => {
    const b = withPic();
    const btn = b.place('BUTTON', { at: { x: 20, y: 10 } });
    b.wire(pinRef('U1', 'RB4'), pinRef(btn.id, '1'));
    const gnd = b.place('GROUND', { at: { x: 22, y: 12 } });
    b.wire(pinRef(btn.id, '2'), pinRef(gnd.id, 'GND'));
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(b.build(), mcu, 'U1');
    expect(mcu.input('RB4')).toBe('Z');
    mcu.pullup.add('RB4');
    sim.solve();
    expect(mcu.input('RB4')).toBe(1);
    expect(sim.netVoltage(netOf(sim, 'U1', 'RB4'))).toBeCloseTo(5);
    sim.interact(btn.id, { type: 'press' });
    expect(mcu.input('RB4')).toBe(0);
    mcu.pullup.delete('RB4');
    sim.interact(btn.id, { type: 'release' });
    expect(mcu.input('RB4')).toBe('Z');
  });

  it('RA4 is open drain: released it floats unless pulled up (Schmitt-trigger input)', () => {
    const b = withPic();
    const r = b.place('RES', { at: { x: 20, y: 4 }, value: '10k' });
    b.wire(pinRef('U1', 'RA4/T0CKI'), pinRef(r.id, '1'));
    const pwr = b.place('POWER', { at: { x: 23, y: 2 } });
    b.wire(pinRef(r.id, '2'), pinRef(pwr.id, 'VDD'));
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(b.build(), mcu, 'U1');
    expect(mcu.input('RA4')).toBe(1);
    mcu.drive.set('RA4', 0);
    sim.solve();
    expect(mcu.input('RA4')).toBe(0);
    mcu.drive.set('RA4', 'Z');
    sim.solve();
    expect(mcu.input('RA4')).toBe(1);
  });
});

describe('traffic light DSN', () => {
  const setup = (opts = {}) => {
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(importDsn(readBytes('cours/traffic lightdesign.DSN')), mcu, 'U1', opts);
    return { mcu, sim, ra3: netOf(sim, 'U1', 'RA3') };
  };

  it('LDR divider (POWER → LDR → RA3 → 1k → GND) gives V = 5·1k/(R+1k)', () => {
    const { sim, ra3 } = setup();
    const ohms = [1e6, 200e3, 100e3, 50e3, 20e3, 10e3, 5e3, 2e3, 1e3, 500];
    ohms.forEach((r, level) => {
      sim.interact('LDR1', { type: 'setLevel', level });
      expect(sim.netVoltage(ra3)).toBeCloseTo((5 * 1000) / (r + 1000), 6);
    });
  });

  it('RA3 flips to 1 at torch level 8 going up and back to 0 at level 5 going down (TTL 0.8/2.0 V + hysteresis)', () => {
    const { mcu, sim } = setup();
    const up: unknown[] = [];
    for (let level = 0; level <= 9; level++) {
      sim.interact('LDR1', { type: 'setLevel', level });
      up.push(mcu.input('RA3'));
    }
    expect(up).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
    const down: unknown[] = [];
    for (let level = 9; level >= 0; level--) {
      sim.interact('LDR1', { type: 'setLevel', level });
      down.push(mcu.input('RA3'));
    }
    expect(down).toEqual([1, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
    expect(sim.visual('LDR1')).toEqual({ kind: 'TORCH_LDR', level: 0 });
  });

  it('with the Proteus PIC thresholds (VTH 2.5 V) level 7 still reads 0', () => {
    const { mcu, sim } = setup({ ttl: PROTEUS_PIC_THRESHOLDS });
    sim.interact('LDR1', { type: 'setLevel', level: 7 });
    expect(mcu.input('RA3')).toBe(0);
    sim.interact('LDR1', { type: 'setLevel', level: 9 });
    expect(mcu.input('RA3')).toBe(1);
  });

  it('7SEG-BCD shows 0x0A for RB3..RB0 = 1010 and nothing when an input floats', () => {
    const { mcu, sim } = setup();
    expect(sim.visual('SEG1')).toEqual({ kind: '7SEG-BCD', value: null });
    mcu.drive.set('RB3', 1);
    mcu.drive.set('RB2', 0);
    mcu.drive.set('RB1', 1);
    mcu.drive.set('RB0', 0);
    sim.solve();
    expect(sim.visual('SEG1')).toEqual({ kind: '7SEG-BCD', value: 0x0a });
    mcu.drive.set('RB2', 1);
    mcu.drive.set('RB0', 1);
    sim.solve();
    expect(sim.visual('SEG1')).toEqual({ kind: '7SEG-BCD', value: 0x0f });
    mcu.drive.set('RB1', 'Z');
    sim.solve();
    expect(sim.visual('SEG1')).toEqual({ kind: '7SEG-BCD', value: null });
  });

  it('traffic lamps follow RA0 (red), RA1 (amber), RA2 (green)', () => {
    const { mcu, sim } = setup();
    expect(sim.visual('TL1')).toEqual({ kind: 'TRAFFIC_LIGHTS', red: false, amber: false, green: false });
    mcu.drive.set('RA0', 1);
    mcu.drive.set('RA1', 0);
    mcu.drive.set('RA2', 0);
    sim.solve();
    expect(sim.visual('TL1')).toEqual({ kind: 'TRAFFIC_LIGHTS', red: true, amber: false, green: false });
    mcu.drive.set('RA0', 0);
    mcu.drive.set('RA1', 1);
    sim.solve();
    expect(sim.visual('TL1')).toEqual({ kind: 'TRAFFIC_LIGHTS', red: false, amber: true, green: false });
    mcu.drive.set('RA1', 0);
    mcu.drive.set('RA2', 1);
    sim.solve();
    expect(sim.visual('TL1')).toEqual({ kind: 'TRAFFIC_LIGHTS', red: false, amber: false, green: true });
  });
});

describe('contention', () => {
  it('an output fighting a LOGICSTATE resolves to X', () => {
    const b = withPic();
    const ls = b.place('LOGICSTATE', { at: { x: 22, y: 6 }, mirror: true, props: { state: 0 } });
    b.wire(pinRef('U1', 'RB0/INT'), pinRef(ls.id, 'Q0'));
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(b.build(), mcu, 'U1');
    expect(mcu.input('RB0')).toBe(0);
    mcu.drive.set('RB0', 1);
    sim.solve();
    expect(sim.netLevel(netOf(sim, 'U1', 'RB0/INT'))).toBe('X');
    expect(mcu.input('RB0')).toBe('X');
    mcu.drive.set('RB0', 0);
    sim.solve();
    expect(mcu.input('RB0')).toBe(0);
  });

  it('a button shorting POWER to GROUND makes the rail X; a node fed only through a resistor from it is X too', () => {
    const b = withPic();
    const btn = b.place('BUTTON', { at: { x: 40, y: 20 } });
    const pwr = b.place('POWER', { at: { x: 36, y: 18 } });
    const gnd = b.place('GROUND', { at: { x: 44, y: 22 } });
    b.wire(pinRef(pwr.id, 'VDD'), pinRef(btn.id, '1'));
    b.wire(pinRef(btn.id, '2'), pinRef(gnd.id, 'GND'));
    const r = b.place('RES', { at: { x: 20, y: 2 }, value: '1k' });
    b.wire(pinRef('U1', 'RA2'), pinRef(r.id, '1'));
    const pwr2 = b.place('POWER', { at: { x: 23, y: 0 } });
    b.wire(pinRef(r.id, '2'), pinRef(pwr2.id, 'VDD'));
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(b.build(), mcu, 'U1');
    expect(mcu.input('RA2')).toBe(1);
    sim.interact(btn.id, { type: 'press' });
    expect(sim.netLevel('VDD')).toBe('X');
    expect(sim.netLevel('GND')).toBe('X');
    expect(mcu.input('RA2')).toBe('X');
  });
});

describe('LED brightness (duty cycle over advance windows)', () => {
  it('averages the lit time over 20 ms windows', () => {
    const s = importDsn(readBytes('cours/EXEMPLE1.DSN'));
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(s, mcu, 'U1');
    mcu.drive.set('RA0', 1);
    sim.solve();
    expect(sim.visual('D1')).toEqual({ kind: 'LED', lit: true, brightness: 1 }); // nothing averaged yet
    sim.advance(0.1);
    expect(sim.visual('D1')).toMatchObject({ brightness: 1 });
    // 25 % duty cycle at 1 kHz: 0.25 ms on, 0.75 ms off.
    for (let i = 0; i < 100; i++) {
      mcu.drive.set('RA0', 1); sim.solve(); sim.advance(0.00025);
      mcu.drive.set('RA0', 0); sim.solve(); sim.advance(0.00075);
    }
    expect((sim.visual('D1') as { brightness: number }).brightness).toBeCloseTo(0.25, 6);
    // status.c-style off/on loop with no delay: lit almost all the time.
    for (let i = 0; i < 1000; i++) {
      mcu.drive.set('RA0', 0); sim.solve(); sim.advance(1e-6);
      mcu.drive.set('RA0', 1); sim.solve(); sim.advance(50e-6);
    }
    expect((sim.visual('D1') as { brightness: number }).brightness).toBeGreaterThan(0.95);
    mcu.drive.set('RA0', 0);
    sim.solve();
    sim.advance(0.05);
    expect(sim.visual('D1')).toEqual({ kind: 'LED', lit: false, brightness: 0 });
  });
});

describe('7SEG-CC (direct segments)', () => {
  it('lights the segments driven high when K is grounded or left unconnected', () => {
    const b = withPic();
    const seg = b.place('7SEG-CC', { at: { x: 30, y: 5 } });
    const pins = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    pins.forEach((p, i) => b.wire(pinRef('U1', i === 0 ? 'RB0/INT' : `RB${i}`), pinRef(seg.id, p)));
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(b.build(), mcu, 'U1');
    const h = 0x76; // 'H' from status2026 p.13
    for (let i = 0; i < 8; i++) mcu.drive.set(i === 0 ? 'RB0' : (`RB${i}` as 'RB1'), ((h >> i) & 1) as 0 | 1);
    sim.solve();
    expect(sim.visual(seg.id)).toEqual({ kind: '7SEG-CC', segments: 0x76 });
  });
});

describe('API behaviour', () => {
  it('throws on unknown ids, ignores interactions that do not apply', () => {
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(importDsn(readBytes('cours/EXEMPLE2.DSN')), mcu, 'U1');
    expect(() => sim.interact('nope', { type: 'toggle' })).toThrow(/inconnu/);
    expect(() => sim.visual('nope')).toThrow(/inconnu/);
    expect(() => sim.netLevel('nope')).toThrow(/inconnu/);
    expect(() => sim.interact('D1', { type: 'toggle' })).not.toThrow();
    expect(sim.visual('U1')).toEqual({ kind: 'NONE' });
    expect(() => createCircuitSimulator(importDsn(readBytes('cours/EXEMPLE2.DSN')), mcu, 'D1')).toThrow(/introuvable/);
  });

  it('reset() restores the saved LOGICSTATE / LDR states', () => {
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(importDsn(readBytes('cours/EXEMPLE2.DSN')), mcu, 'U1');
    sim.interact('LS1', { type: 'toggle' });
    expect(mcu.input('RB0')).toBe(0);
    sim.reset();
    expect(mcu.input('RB0')).toBe(1);
  });

  it('pushes every connected GPIO on each solve, even when nothing changed', () => {
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(importDsn(readBytes('cours/EXEMPLE1.DSN')), mcu, 'U1');
    const before = mcu.history.length;
    sim.solve();
    expect(mcu.history.length - before).toBe(13);
  });
});
