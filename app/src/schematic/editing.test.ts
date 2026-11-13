import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildNetlist, pinTip, validateSchematic, type ComponentInstance, type Schematic } from '@pic/circuit';
import {
  addWire, deleteSelection, duplicateSelection, makeComponent, mirrorComponents, moveSelection, nextIdentity,
  orthogonalRoute, pointOnWire, rotateComponents, schematicExtent, selectInRect, simplifyPolyline, updateComponent,
} from './editing';

const pic: ComponentInstance = { id: 'U1', kind: 'PIC16F84A', ref: 'U1', value: 'PIC16F84A', at: { x: 0, y: 0 }, rotation: 0, props: {} };
const led: ComponentInstance = { id: 'D1', kind: 'LED', ref: 'D1', value: 'LED-RED', at: { x: 30, y: 4 }, rotation: 0, props: { color: 'RED' } };
const gnd: ComponentInstance = { id: 'GND1', kind: 'GROUND', ref: '', at: { x: 30, y: 9 }, rotation: 0, props: {} };

/** RA0 (15,0) → right → down to the LED anode (30,2); LED cathode (30,6) → GND (30,8). */
function circuit(): Schematic {
  return {
    clockHz: 1e6,
    components: [pic, led, gnd],
    wires: [
      { id: 'W1', points: [{ x: 15, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 2 }] },
      { id: 'W2', points: [{ x: 30, y: 6 }, { x: 30, y: 8 }] },
    ],
  };
}

const connected = (s: Schematic, a: [string, string], b: [string, string]): boolean => {
  const nl = buildNetlist(s);
  return nl.pinToNet.get(`${a[0]}:${a[1]}`) === nl.pinToNet.get(`${b[0]}:${b[1]}`);
};

const orthogonal = (s: Schematic): boolean =>
  s.wires.every((w) => w.points.every((p, i) => i === 0 || p.x === w.points[i - 1].x || p.y === w.points[i - 1].y));

describe('placing', () => {
  it('gives the next free reference and id', () => {
    const s = circuit();
    expect(nextIdentity(s, 'LED')).toEqual({ id: 'D2', ref: 'D2' });
    expect(nextIdentity(s, 'GROUND')).toEqual({ id: 'GND2', ref: '' });
    expect(nextIdentity(s, 'LOGICSTATE')).toEqual({ id: 'LS1', ref: '' });
    const r = makeComponent(s, { kind: 'RES' }, { x: 5, y: 5 });
    expect(r).toMatchObject({ id: 'R1', ref: 'R1', value: '10k', rotation: 0 });
    const blue = makeComponent(s, { kind: 'LED', props: { color: 'BLUE' }, value: 'LED-BLUE' }, { x: 0, y: 0 });
    expect(blue).toMatchObject({ value: 'LED-BLUE', props: { color: 'BLUE' } });
  });
});

describe('moving with rubber band', () => {
  it('keeps the wires attached and orthogonal when a part moves', () => {
    const s = moveSelection(circuit(), { components: ['D1'], wires: [] }, { x: 4, y: 3 });
    expect(s.components.find((c) => c.id === 'D1')!.at).toEqual({ x: 34, y: 7 });
    expect(orthogonal(s)).toBe(true);
    expect(connected(s, ['U1', 'RA0'], ['D1', 'A'])).toBe(true);
    expect(connected(s, ['D1', 'K'], ['GND1', 'GND'])).toBe(true);
    expect(buildNetlist(s).dangling).toEqual([]);
    // Untouched parts keep their identity (memoized views do not re-render).
    expect(s.components[0]).toBe(circuit().components[0]);
  });

  it('turns a straight wire into a Z when only one end moves', () => {
    const s0: Schematic = { ...circuit(), wires: [{ id: 'W1', points: [{ x: 15, y: 0 }, { x: 28, y: 0 }] }] };
    const moved = { ...led, at: { x: 28, y: 2 } }; // anode at (28,0)
    const s1 = { ...s0, components: [pic, moved, gnd] };
    const s2 = moveSelection(s1, { components: ['D1'], wires: [] }, { x: 0, y: 5 });
    expect(orthogonal(s2)).toBe(true);
    expect(connected(s2, ['U1', 'RA0'], ['D1', 'A'])).toBe(true);
  });

  it('moves a part and its wire together when both ends follow', () => {
    const s = moveSelection(circuit(), { components: ['D1', 'GND1'], wires: ['W2'] }, { x: 2, y: 0 });
    expect(s.wires.find((w) => w.id === 'W2')!.points).toEqual([{ x: 32, y: 6 }, { x: 32, y: 8 }]);
    expect(connected(s, ['U1', 'RA0'], ['D1', 'A'])).toBe(true);
  });

  it('does nothing for a zero move', () => {
    const s = circuit();
    expect(moveSelection(s, { components: ['D1'], wires: [] }, { x: 0, y: 0 })).toBe(s);
  });
});

/** Pairs of pins that share a net. */
function pinPairs(s: Schematic): Set<string> {
  const out = new Set<string>();
  for (const n of buildNetlist(s).nets) {
    const ps = n.pins.map((p) => `${p.componentId}:${p.pin}`).sort();
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) out.add(`${ps[i]}~${ps[j]}`);
  }
  return out;
}

const lostPairs = (before: Schematic, after: Schematic): string[] => {
  const now = pinPairs(after);
  return [...pinPairs(before)].filter((p) => !now.has(p));
};

describe('moving never disconnects', () => {
  // Pull-up on RA0: R1's wire ends in a T on the RA0 → switch wire (the shape of the vote / pupitre templates).
  const tCircuit = (): Schematic => ({
    clockHz: 1e6,
    components: [
      pic,
      { id: 'LS1', kind: 'LOGICSTATE', ref: '', at: { x: 24, y: 0 }, rotation: 0, props: { state: 0 } },
      { id: 'R1', kind: 'RES', ref: 'R1', value: '10k', at: { x: 20, y: -4 }, rotation: 270, props: {} },
    ],
    wires: [],
  });

  it('keeps a T-joined wire on the wire it joins when the far part moves', () => {
    let s = tCircuit();
    const ls = pinTip(s.components[1], 'Q0')!;
    expect(ls.y).toBe(0);
    s = { ...s, wires: [{ id: 'W1', points: [{ x: 15, y: 0 }, ls] }] };
    const r1 = pinTip(s.components[2], '1')!;
    s = { ...s, wires: [...s.wires, { id: 'W2', points: [r1, { x: r1.x, y: 0 }] }] };
    expect(connected(s, ['R1', '1'], ['U1', 'RA0'])).toBe(true);
    for (const delta of [{ x: 0, y: 2 }, { x: 0, y: -3 }, { x: 3, y: 3 }, { x: -2, y: 5 }]) {
      const moved = moveSelection(s, { components: ['LS1'], wires: [] }, delta);
      expect(lostPairs(s, moved), `LS1 by (${delta.x},${delta.y})`).toEqual([]);
      expect(orthogonal(moved)).toBe(true);
    }
  });

  it('drags a T-joined wire along when the wire it joins is reshaped', () => {
    // The pull-up joins the switch wire close to the switch: past the corner the reshape puts in the middle.
    let s: Schematic = { ...tCircuit(), components: tCircuit().components.map((c) => (c.id === 'R1' ? { ...c, at: { x: 23, y: -4 } } : c)) };
    const ls = pinTip(s.components[1], 'Q0')!;
    const r1 = pinTip(s.components[2], '1')!;
    s = { ...s, wires: [{ id: 'W1', points: [{ x: 15, y: 0 }, ls] }, { id: 'W2', points: [r1, { x: r1.x, y: 0 }] }] };
    for (const delta of [{ x: 0, y: 2 }, { x: 3, y: 3 }, { x: -2, y: 5 }]) {
      const moved = moveSelection(s, { components: ['LS1'], wires: [] }, delta);
      const label = `LS1 by (${delta.x},${delta.y})`;
      expect(lostPairs(s, moved), label).toEqual([]);
      expect(orthogonal(moved), label).toBe(true);
      const w1 = moved.wires.find((w) => w.id === 'W1')!;
      const w2 = moved.wires.find((w) => w.id === 'W2')!;
      // The switch wire takes the tidy Z (no leftover of its old route) and the pull-up follows it down.
      expect(w1.points, label).toHaveLength(4);
      expect(w1.points[w1.points.length - 1], label).toEqual({ x: ls.x + delta.x, y: ls.y + delta.y });
      expect(w2.points, label).toEqual([r1, { x: r1.x, y: delta.y }]);
      expect(moved.wires, label).toHaveLength(2);
    }
  });

  it('keeps the old route when the T-joined wire would have to fold back over its own corner', () => {
    let s: Schematic = { ...tCircuit(), components: tCircuit().components.map((c) => (c.id === 'R1' ? { ...c, at: { x: 23, y: -4 } } : c)) };
    const ls = pinTip(s.components[1], 'Q0')!;
    const r1 = pinTip(s.components[2], '1')!;
    s = { ...s, wires: [{ id: 'W1', points: [{ x: 15, y: 0 }, ls] }, { id: 'W2', points: [r1, { x: r1.x, y: 0 }] }] };
    // Moving the switch up past the resistor's pin: the pull-up cannot simply shorten, so the switch wire keeps
    // running through the junction and gets an extra leg.
    const moved = moveSelection(s, { components: ['LS1'], wires: [] }, { x: 0, y: -3 });
    expect(lostPairs(s, moved)).toEqual([]);
    expect(moved.wires.find((w) => w.id === 'W2')!.points).toEqual([r1, { x: r1.x, y: 0 }]);
    expect(moved.wires.find((w) => w.id === 'W1')!.points).toEqual([{ x: 15, y: 0 }, ls, { x: ls.x, y: -3 }]);
  });

  it('drags every wire of a junction together (pull-up from above, LED from below)', () => {
    let s: Schematic = {
      ...tCircuit(),
      components: [
        ...tCircuit().components.map((c) => (c.id === 'R1' ? { ...c, at: { x: 23, y: -4 } } : c)),
        { id: 'D1', kind: 'LED', ref: 'D1', value: 'LED-RED', at: { x: 30, y: 8 }, rotation: 0, props: { color: 'RED' } },
      ],
    };
    const ls = pinTip(s.components[1], 'Q0')!;
    const r1 = pinTip(s.components[2], '1')!;
    const anode = pinTip(s.components[3], 'A')!;
    s = {
      ...s,
      wires: [
        { id: 'W1', points: [{ x: 15, y: 0 }, ls] },
        { id: 'W2', points: [r1, { x: r1.x, y: 0 }] },
        { id: 'W3', points: [{ x: r1.x, y: 0 }, { x: r1.x, y: anode.y }, anode] },
      ],
    };
    expect(connected(s, ['D1', 'A'], ['U1', 'RA0'])).toBe(true);
    for (const delta of [{ x: 0, y: 2 }, { x: 3, y: 3 }]) {
      const label = `LS1 by (${delta.x},${delta.y})`;
      const moved = moveSelection(s, { components: ['LS1'], wires: [] }, delta);
      expect(lostPairs(s, moved), label).toEqual([]);
      expect(orthogonal(moved), label).toBe(true);
      const junction = { x: r1.x, y: delta.y };
      expect(moved.wires.find((w) => w.id === 'W2')!.points.at(-1), label).toEqual(junction);
      expect(moved.wires.find((w) => w.id === 'W3')!.points[0], label).toEqual(junction);
    }
  });

  it('links a moved pin that sat on a corner in the middle of a wire', () => {
    const s: Schematic = {
      clockHz: 1e6,
      components: [pic, led, gnd],
      // The wire runs from RA0 through the LED anode (a corner) on to (40,2).
      wires: [{ id: 'W1', points: [{ x: 15, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 2 }, { x: 40, y: 2 }] }],
    };
    const anode = pinTip(led, 'A')!;
    expect(anode).toEqual({ x: 30, y: 2 });
    const moved = moveSelection(s, { components: ['D1'], wires: [] }, { x: 2, y: 3 });
    expect(connected(moved, ['D1', 'A'], ['U1', 'RA0'])).toBe(true);
    expect(moved.wires.length).toBe(2);
  });

  const dir = path.resolve(__dirname, '../../../templates');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.schematic.json'));
  for (const f of files) {
    it(`${f}: moving or rotating any single part keeps every connection`, () => {
      const s = validateSchematic(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).schematic!;
      const lost: string[] = [];
      for (const c of s.components) {
        for (const delta of [{ x: 2, y: 0 }, { x: 0, y: 2 }, { x: -3, y: 1 }, { x: 3, y: 3 }, { x: 0, y: -2 }]) {
          const gone = lostPairs(s, moveSelection(s, { components: [c.id], wires: [] }, delta));
          if (gone.length) lost.push(`${c.id} by (${delta.x},${delta.y}): ${gone.slice(0, 3).join(', ')}`);
        }
        const gone = lostPairs(s, rotateComponents(s, [c.id]));
        if (gone.length) lost.push(`${c.id} rotated: ${gone.slice(0, 3).join(', ')}`);
      }
      expect(lost).toEqual([]);
    });
  }
});

describe('rotate, mirror, delete', () => {
  it('rotation keeps the attached wires on the pins', () => {
    const s = rotateComponents(circuit(), ['D1']);
    const d1 = s.components.find((c) => c.id === 'D1')!;
    expect(d1.rotation).toBe(90);
    expect(orthogonal(s)).toBe(true);
    expect(connected(s, ['U1', 'RA0'], ['D1', 'A'])).toBe(true);
    expect(connected(s, ['D1', 'K'], ['GND1', 'GND'])).toBe(true);
    expect(rotateComponents(s, ['D1'], 270).components.find((c) => c.id === 'D1')!.rotation).toBe(0);
  });

  it('mirror toggles', () => {
    const s = mirrorComponents(circuit(), ['GND1']);
    expect(s.components.find((c) => c.id === 'GND1')!.mirror).toBe(true);
    expect(mirrorComponents(s, ['GND1']).components.find((c) => c.id === 'GND1')!.mirror).toBeUndefined();
  });

  it('deleting a part removes its wires', () => {
    const s = deleteSelection(circuit(), { components: ['GND1'], wires: [] });
    expect(s.components.map((c) => c.id)).toEqual(['U1', 'D1']);
    expect(s.wires.map((w) => w.id)).toEqual(['W1']);
    expect(deleteSelection(circuit(), { components: [], wires: ['W1'] }).wires.map((w) => w.id)).toEqual(['W2']);
  });

  it('updates a component without touching the others', () => {
    const s0 = circuit();
    const s = updateComponent(s0, 'D1', (c) => ({ ...c, props: { color: 'GREEN' }, value: 'LED-GREEN' }));
    expect(s.components[1].value).toBe('LED-GREEN');
    expect(s.components[0]).toBe(s0.components[0]);
    expect(updateComponent(s0, 'nope', (c) => ({ ...c }))).toBe(s0);
  });
});

describe('wiring', () => {
  it('routes with one corner and simplifies', () => {
    expect(orthogonalRoute({ x: 0, y: 0 }, { x: 5, y: 3 }, 'h')).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 3 }]);
    expect(orthogonalRoute({ x: 0, y: 0 }, { x: 5, y: 3 }, 'v')).toEqual([{ x: 0, y: 0 }, { x: 0, y: 3 }, { x: 5, y: 3 }]);
    expect(simplifyPolyline([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }]))
      .toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }]);
    // A pin sitting on an interior vertex keeps that vertex.
    expect(simplifyPolyline([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 5, y: 0 }], new Set(['2000000,0']))).toHaveLength(3);
  });

  it('adds a wire between two pins and makes a T junction on a wire', () => {
    let s = circuit();
    const ra1 = pinTip(pic, 'RA1')!;
    s = addWire(s, [ra1, { x: 20, y: ra1.y }, { x: 20, y: 0 }]);
    expect(s.wires).toHaveLength(3);
    expect(s.wires[2].id).toBe('W3');
    expect(connected(s, ['U1', 'RA1'], ['D1', 'A'])).toBe(true);
    expect(buildNetlist(s).junctions).toContainEqual({ x: 20, y: 0 });
    expect(addWire(s, [{ x: 1, y: 1 }, { x: 1, y: 1 }])).toBe(s);
  });

  it('finds the nearest grid point on a wire', () => {
    const w = circuit().wires[0];
    expect(pointOnWire({ x: 21.3, y: 0.2 }, w)).toMatchObject({ at: { x: 21, y: 0 }, segment: 0 });
    expect(pointOnWire({ x: 30.4, y: 1.2 }, w)).toMatchObject({ at: { x: 30, y: 1 }, segment: 1 });
  });
});

describe('selection helpers', () => {
  it('marquee selects whole parts and wires', () => {
    const sel = selectInRect(circuit(), { x: 25, y: -1, w: 10, h: 12 });
    expect(sel.components).toEqual(['D1', 'GND1']);
    expect(sel.wires).toEqual(['W2']);
  });

  it('duplicates with fresh ids', () => {
    const { schematic, selection } = duplicateSelection(circuit(), { components: ['D1', 'U1'], wires: ['W2'] }, { x: 5, y: 0 });
    expect(selection.components).toEqual(['D2']); // never a second PIC
    expect(selection.wires).toEqual(['W3']);
    expect(schematic.components.find((c) => c.id === 'D2')!.at).toEqual({ x: 35, y: 4 });
  });

  it('measures the drawing', () => {
    const r = schematicExtent(circuit())!;
    expect(r.x).toBeLessThanOrEqual(0);
    expect(r.x + r.w).toBeGreaterThan(30);
    expect(schematicExtent({ clockHz: 1, components: [], wires: [] })).toBeNull();
  });
});
