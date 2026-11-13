import { describe, expect, it } from 'vitest';
import { fromDsnPlacement, importDsn, importDsnDetailed } from '../src/dsn';
import { buildNetlist } from '../src/netlist';
import { DSN_FILES, normalizeNets, readBytes, researchCircuits, researchStyleNets } from './helpers';

const research = researchCircuits();

describe('importDsn — the prof\'s five circuits', () => {
  for (const { file } of DSN_FILES) {
    describe(file, () => {
      const { schematic, warnings } = importDsnDetailed(readBytes(`cours/${file}`));
      const netlist = buildNetlist(schematic);

      it('imports without warnings (every pin lands where the ISIS library puts it)', () => {
        expect(warnings).toEqual([]);
      });

      it('rebuilds exactly the netlist decoded in research/05', () => {
        expect(researchStyleNets(schematic, netlist)).toEqual(normalizeNets(research[file].nets));
      });

      it('has no dangling wire end', () => {
        expect(netlist.dangling).toEqual([]);
      });

      it('keeps every component of the research decode', () => {
        const parts = schematic.components.filter((c) => c.kind !== 'POWER' && c.kind !== 'GROUND');
        expect(parts).toHaveLength(research[file].components.length);
      });
    });
  }
});

describe('importDsn — the prof\'s interrupt circuits (chapitre 5)', () => {
  const nets = (file: string) => {
    const { schematic, warnings } = importDsnDetailed(readBytes(`cours/${file}`));
    const netlist = buildNetlist(schematic);
    return {
      warnings,
      dangling: netlist.dangling,
      nets: netlist.nets.filter((n) => n.pins.length > 1).map((n) => n.pins.map((p) => `${p.componentId}.${p.pin}`).sort().join(' ')).sort(),
      schematic,
    };
  };

  it('TP_inte.DSN (TP4): the BUTTON lands on RB0 and +5 V, R1 220 pulls RB0 down, D1 on RB3, 7SEG-BCD on RA0..RA3', () => {
    const r = nets('TP_inte.DSN');
    expect(r.warnings).toEqual([]);
    expect(r.dangling).toEqual([]);
    expect(r.schematic.clockHz).toBe(8_000_000);
    expect(r.nets).toEqual([
      'BTN1.1 R1.1 U1.RB0/INT',
      'BTN1.2 PWR1.VDD',
      'D1.A U1.RB3',
      'D1.K GND1.GND R1.2',
      'SEG1.E0 U1.RA0',
      'SEG1.E1 U1.RA1',
      'SEG1.E2 U1.RA2',
      'SEG1.E3 U1.RA3',
    ]);
  });

  it('trafficint.DSN: LOGICSTATE on RB0/INT, lights on RB2..RB4, 7SEG-BCD-BLUE on RA0..RA3', () => {
    const r = nets('trafficint.DSN');
    expect(r.warnings).toEqual([]);
    expect(r.dangling).toEqual([]);
    expect(r.schematic.clockHz).toBe(8_000_000);
    expect(r.nets).toEqual([
      'LS1.Q0 U1.RB0/INT',
      'SEG1.E0 U1.RA0',
      'SEG1.E1 U1.RA1',
      'SEG1.E2 U1.RA2',
      'SEG1.E3 U1.RA3',
      'TL1.A U1.RB3',
      'TL1.G U1.RB4',
      'TL1.R U1.RB2',
    ]);
  });
});

describe('importDsn — details', () => {
  it('reads U1 CLOCK into clockHz (1 MHz, 8 MHz for the traffic light)', () => {
    expect(importDsn(readBytes('cours/EXEMPLE1.DSN')).clockHz).toBe(1_000_000);
    expect(importDsn(readBytes('cours/traffic lightdesign.DSN')).clockHz).toBe(8_000_000);
  });

  it('converts EXEMPLE1 to grid units with Y down', () => {
    const s = importDsn(readBytes('cours/EXEMPLE1.DSN'));
    const u1 = s.components.find((c) => c.ref === 'U1')!;
    const d1 = s.components.find((c) => c.ref === 'D1')!;
    expect(u1).toMatchObject({ kind: 'PIC16F84A', at: { x: -8, y: -10 }, rotation: 0, value: 'PIC16F84A' });
    expect(u1.props).toEqual({ clock: '1MHz', cfgword: '0x3FFB' });
    expect(d1).toMatchObject({ kind: 'LED', at: { x: 23, y: -7 }, value: 'LED-BLUE', props: { color: 'BLUE' } });
    expect(s.components.find((c) => c.kind === 'GROUND')).toMatchObject({ at: { x: 23, y: -2 }, rotation: 0 });
    expect(s.wires[0].points).toEqual([{ x: 7, y: -10 }, { x: 23, y: -10 }, { x: 23, y: -9 }]);
  });

  it('maps LOGICSTATE states, mirror and rotation (EXEMPLE2, demux)', () => {
    const ex2 = importDsn(readBytes('cours/EXEMPLE2.DSN'));
    expect(ex2.components.find((c) => c.kind === 'LOGICSTATE')).toMatchObject({ mirror: true, rotation: 0, props: { state: 1 } });
    const demux = importDsn(readBytes('cours/tp demux.DSN'));
    const states = demux.components.filter((c) => c.kind === 'LOGICSTATE');
    expect(states.map((c) => [c.rotation, c.props.state])).toEqual([[180, 0], [180, 1]]);
    expect(demux.components.find((c) => c.ref === 'R1')).toMatchObject({ kind: 'RES', value: '220', rotation: 90 });
  });

  it('maps the traffic-light parts (7SEG-BCD-BLUE, TRAFFIC LIGHTS, TORCH_LDR, 1k, POWER)', () => {
    const s = importDsn(readBytes('cours/traffic lightdesign.DSN'));
    const kinds = s.components.map((c) => c.kind).sort();
    expect(kinds).toEqual(['7SEG-BCD', 'GROUND', 'PIC16F84A', 'POWER', 'RES', 'TORCH_LDR', 'TRAFFIC_LIGHTS']);
    expect(s.components.find((c) => c.kind === '7SEG-BCD')!.props).toEqual({ color: 'BLUE' });
    expect(s.components.find((c) => c.kind === 'TORCH_LDR')).toMatchObject({ ref: 'LDR1', props: { level: 0 } });
    expect(s.components.find((c) => c.ref === 'R1')!.value).toBe('1k');
  });

  it('rejects files that are not ISIS schematics', () => {
    expect(() => importDsn(new TextEncoder().encode('hello world'))).toThrow(/DSN invalide/);
  });

  it('converts DSN placements (CCW, Y up, mirror bits) to clockwise screen rotations', () => {
    expect(fromDsnPlacement(0, 0)).toEqual({ rotation: 0 });
    expect(fromDsnPlacement(-900, 0)).toEqual({ rotation: 90 });
    expect(fromDsnPlacement(900, 0)).toEqual({ rotation: 270 });
    expect(fromDsnPlacement(1800, 0)).toEqual({ rotation: 180 });
    expect(fromDsnPlacement(-1800, 0)).toEqual({ rotation: 180 });
    expect(fromDsnPlacement(0, 1)).toEqual({ rotation: 0, mirror: true });
    expect(fromDsnPlacement(0, 2)).toEqual({ rotation: 180, mirror: true });
    expect(fromDsnPlacement(0, 3)).toEqual({ rotation: 180 });
  });
});
