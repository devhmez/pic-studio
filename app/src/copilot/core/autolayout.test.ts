// autolayout (packages/circuit/src/autolayout.ts) on the course circuits: every requested net is exactly one
// schematic net, nothing overlaps, no wire crosses a body or ends in the air.
// Set AUTOLAYOUT_SVG_DIR=/some/dir to also write each drawing as SVG for a visual check.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  autolayout, buildNetlist, layoutOverlaps, pinKey, resolveEndpoint, schematicToSvg, wiresThroughBodies,
  type AutoPart, type Schematic,
} from '@pic/circuit';
import { describe, expect, it } from 'vitest';
import { schematicToCircuit, toAutoNetlist } from './circuit';
import { COURSE_CIRCUITS, DEMUX, EXEMPLE1, PUPITRE, STATUS, TRAFFIC, VOTE } from './fixtures';
import type { AnswerCircuit } from './schema';

const svgDir = process.env.AUTOLAYOUT_SVG_DIR;

function dump(name: string, s: Schematic): void {
  if (!svgDir) return;
  mkdirSync(svgDir, { recursive: true });
  writeFileSync(join(svgDir, `${name}.svg`), schematicToSvg(s, { pxPerGrid: 14 }));
}

/** Requested nets as sets of "id:pin" (rails as their own key). */
function requestedNets(c: AnswerCircuit): string[][] {
  const net = toAutoNetlist(c);
  const parts = new Map(net.parts.map((p) => [p.ref.toUpperCase(), { ...p, ref: p.ref.toUpperCase() } as AutoPart]));
  const groups: Set<string>[] = [];
  for (const l of net.links) {
    const keys = [l.from, l.to].map((e) => {
      const r = resolveEndpoint(e, parts);
      if ('error' in r) throw new Error(r.error);
      return 'rail' in r ? `rail:${r.rail}` : pinKey(r.ref, r.pin);
    });
    const hit = groups.filter((g) => keys.some((k) => g.has(k)));
    const merged = new Set<string>(keys);
    for (const g of hit) { g.forEach((k) => merged.add(k)); groups.splice(groups.indexOf(g), 1); }
    groups.push(merged);
  }
  return groups.map((g) => [...g]);
}

/** Unusual wirings that take the fallback paths (LDR to GND with a pull-up, a LED between two PIC pins). */
const UNUSUAL: Record<string, AnswerCircuit> = {
  LDR_INVERTED: {
    horloge_mhz: 1,
    composants: [{ ref: 'LDR1', type: 'TORCH_LDR' }, { ref: 'R1', type: 'RES', valeur: '10k' }, { ref: 'D1', type: 'LED' }],
    liaisons: [{ de: 'GND', vers: 'LDR1.2' }, { de: 'LDR1.1', vers: 'U1.RA2' }, { de: 'U1.RA2', vers: 'R1.2' }, { de: 'R1.1', vers: 'VDD' }, { de: 'U1.RB7', vers: 'D1.A' }, { de: 'D1.K', vers: 'GND' }],
  },
  LED_BETWEEN_PINS: {
    horloge_mhz: 1,
    composants: [{ ref: 'D1', type: 'LED', couleur: 'GREEN' }, { ref: 'LS1', type: 'LOGICSTATE' }, { ref: 'C9', type: 'CAP' }],
    liaisons: [{ de: 'U1.RB1', vers: 'D1.A' }, { de: 'D1.K', vers: 'U1.RB2' }, { de: 'LS1', vers: 'U1.RA0' }, { de: 'C9.1', vers: 'VDD' }, { de: 'C9.2', vers: 'GND' }],
  },
};

describe('autolayout — course circuits', () => {
  for (const [name, circuit] of Object.entries({ ...COURSE_CIRCUITS, ...UNUSUAL })) {
    it(`${name}: exact nets, no overlap, no dangling wire, wires around bodies`, () => {
      const { schematic, problems } = autolayout(toAutoNetlist(circuit));
      dump(name, schematic);
      expect(problems).toEqual([]);
      const nl = buildNetlist(schematic);
      expect(nl.dangling).toEqual([]);
      expect(layoutOverlaps(schematic)).toEqual([]);
      expect(wiresThroughBodies(schematic)).toEqual([]);
      // Each requested net is one schematic net, distinct from the others; rails reach GND / VDD.
      const seen = new Set<string>();
      for (const group of requestedNets(circuit)) {
        const rail = group.find((k) => k.startsWith('rail:'))?.slice(5);
        const ids = new Set(group.filter((k) => !k.startsWith('rail:')).map((k) => nl.pinToNet.get(k)));
        expect(ids.size, group.join(' ')).toBe(1);
        const [id] = [...ids];
        expect(id).toBeDefined();
        if (rail) expect(id).toBe(rail);
        else {
          expect(seen.has(id!), `${id} shared`).toBe(false);
          expect(id === 'GND' || id === 'VDD').toBe(false);
        }
        seen.add(id!);
      }
      // Coordinates stay on the 0.5 grid and wires are orthogonal.
      for (const w of schematic.wires) {
        for (let i = 0; i + 1 < w.points.length; i++) {
          const a = w.points[i]; const b = w.points[i + 1];
          expect(a.x === b.x || a.y === b.y).toBe(true);
          expect(Number.isInteger(a.x * 2) && Number.isInteger(a.y * 2)).toBe(true);
        }
      }
    });
  }

  it('puts U1 at the origin with the requested clock, and keeps the refs as component ids', () => {
    const { schematic, ids } = autolayout(toAutoNetlist(TRAFFIC));
    const pic = schematic.components.find((c) => c.kind === 'PIC16F84A')!;
    expect(pic.at).toEqual({ x: 0, y: 0 });
    expect(pic.props.clock).toBe('8MHz');
    expect(schematic.clockHz).toBe(8_000_000);
    expect(ids.FEU).toBe('FEU');
    expect(schematic.components.find((c) => c.id === 'LDR1')?.props.level).toBe(9);
  });

  it('draws outputs to the right in pin order with one shared GROUND for the LED cathodes', () => {
    const { schematic } = autolayout(toAutoNetlist(STATUS));
    const leds = ['X_SUPERIEUR', 'EGALITE', 'X_INFERIEUR'].map((id) => schematic.components.find((c) => c.id === id)!);
    expect(leds.every((c) => c.at.x > 15)).toBe(true);
    expect(leds[0].at.y).toBeLessThan(leds[1].at.y);
    expect(leds[1].at.y).toBeLessThan(leds[2].at.y);
    expect(schematic.components.filter((c) => c.kind === 'GROUND')).toHaveLength(1);
  });

  it('places the LDR divider on the left of the PIC and the displays on the right', () => {
    const { schematic } = autolayout(toAutoNetlist(TRAFFIC));
    const ldr = schematic.components.find((c) => c.kind === 'TORCH_LDR')!;
    expect(ldr.at.x).toBeLessThan(0);
    expect(schematic.components.find((c) => c.kind === '7SEG-BCD')!.at.x).toBeGreaterThan(15);
    expect(schematic.components.find((c) => c.kind === 'TRAFFIC_LIGHTS')!.at.x).toBeGreaterThan(15);
  });

  it('gives each button its pull-down resistor to GND and its POWER terminal (vote, pupitre)', () => {
    for (const c of [VOTE, PUPITRE]) {
      const { schematic } = autolayout(toAutoNetlist(c));
      const nl = buildNetlist(schematic);
      for (const b of schematic.components.filter((x) => x.kind === 'BUTTON')) {
        expect(nl.pinToNet.get(pinKey(b.id, '1'))).toBe('VDD');
      }
    }
  });

  it('reports unknown parts, pins and shorts in French and still draws the rest', () => {
    const { schematic, problems } = autolayout({
      parts: [{ ref: 'D1', kind: 'LED' }, { ref: 'R1', kind: 'RES', value: '220' }],
      links: [
        { from: 'U1.RA0', to: 'D1.A' }, { from: 'D1.K', to: 'GND' }, { from: 'D9.A', to: 'GND' }, { from: 'R1.3', to: 'U1.RB0' },
        { from: 'U1.RA9', to: 'D1.A' }, { from: 'VDD', to: 'R1.1' }, { from: 'R1.1', to: 'GND' },
      ],
    });
    const codes = problems.map((p) => p.code);
    expect(codes).toContain('UNKNOWN_PART');
    expect(codes).toContain('UNKNOWN_PIN');
    expect(codes).toContain('SHORT');
    expect(problems.find((p) => p.code === 'UNKNOWN_PART')?.message).toMatch(/D9/);
    expect(schematic.components.some((c) => c.id === 'D1')).toBe(true);
  });

  it('accepts the aliases the copilot may write (RB0, LS1 without pin, cathode, VCC, masse)', () => {
    const { problems } = autolayout({
      parts: [{ ref: 'LS1', kind: 'LOGICSTATE' }, { ref: 'D1', kind: 'LED', color: 'verte' }, { ref: 'F', kind: 'TRAFFIC_LIGHTS' }],
      links: [
        { from: 'ls1', to: 'RB0' }, { from: 'u1.ra0', to: 'd1.anode' }, { from: 'D1.cathode', to: 'masse' },
        { from: 'U1.RA1', to: 'F.ROUGE' }, { from: 'U1.RA2', to: 'F.O' }, { from: 'U1.RA3', to: 'F.V' },
      ],
    });
    expect(problems).toEqual([]);
  });

  it('is deterministic', () => {
    const a = autolayout(toAutoNetlist(DEMUX)).schematic;
    const b = autolayout(toAutoNetlist(DEMUX)).schematic;
    expect(b).toEqual(a);
  });

  it('round-trips through the compact format sent with follow-up requests', () => {
    for (const c of [EXEMPLE1, DEMUX, TRAFFIC, VOTE]) {
      const first = autolayout(toAutoNetlist(c)).schematic;
      const { circuit, autres } = schematicToCircuit(first);
      expect(autres).toEqual([]);
      const again = autolayout(toAutoNetlist(circuit));
      expect(again.problems).toEqual([]);
      // Same connectivity: identical partition of the part pins.
      const partition = (s: Schematic) => {
        const nl = buildNetlist(s);
        return nl.nets.map((n) => n.pins.filter((p) => !['GROUND', 'POWER'].includes(s.components.find((x) => x.id === p.componentId)!.kind))
          .map((p) => `${p.componentId}:${p.pin}`).sort().join(' ')).filter((x) => x.includes(' ') || x.startsWith('U1')).sort();
      };
      expect(partition(again.schematic)).toEqual(partition(first));
    }
  });
});
