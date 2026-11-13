// Moving / rotating parts never short-circuits or cuts a wire silently: the rubber band picks a route that keeps
// exactly the old connections (plus what a moved pin touches where it lands), or the move is refused. And no wire
// ends up doubling back over itself.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildNetlist, validateSchematic, type Schematic, type Wire } from '@pic/circuit';
import { mirrorComponents, moveSelection, rotateComponents } from './editing';

const dir = path.resolve(__dirname, '../../../templates');
const load = (f: string): Schematic => validateSchematic(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).schematic!;

function pairs(s: Schematic): Set<string> {
  const out = new Set<string>();
  for (const n of buildNetlist(s).nets) {
    const ps = n.pins.map((p) => `${p.componentId}:${p.pin}`).sort();
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) out.add(`${ps[i]}~${ps[j]}`);
  }
  return out;
}

/** Nets that may be merged: before the move, and where the moved pins land on the unchanged wires. */
function allowed(before: Schematic, after: Schematic): (pin: string) => string {
  const parent = new Map<string, string>();
  const find = (x: string): string => (parent.has(x) && parent.get(x) !== x ? find(parent.get(x)!) : x);
  const landed: Schematic = { ...before, components: after.components };
  for (const s of [before, landed]) {
    for (const n of buildNetlist(s).nets) {
      const ps = n.pins.map((p) => `${p.componentId}:${p.pin}`);
      for (let i = 1; i < ps.length; i++) { const a = find(ps[0]); const b = find(ps[i]); if (a !== b) parent.set(a, b); }
    }
  }
  return find;
}

function problems(before: Schematic, after: Schematic): string[] {
  const out: string[] = [];
  const now = pairs(after);
  for (const p of pairs(before)) if (!now.has(p)) out.push(`perdu ${p}`);
  const group = allowed(before, after);
  for (const n of buildNetlist(after).nets) {
    const ps = n.pins.map((p) => `${p.componentId}:${p.pin}`);
    if (ps.some((p) => group(p) !== group(ps[0]))) out.push(`court-circuit ${ps.join(' ')}`);
  }
  return out;
}

/** Wires the move changed that turn back over themselves (a, b, c in line, b outside a…c). */
function foldedWires(before: Schematic, after: Schematic): string[] {
  const old = new Map(before.wires.map((w) => [w.id, JSON.stringify(w.points)]));
  const folds = (w: Wire): boolean => w.points.some((b, i) => {
    if (i === 0 || i + 1 >= w.points.length) return false;
    const a = w.points[i - 1];
    const c = w.points[i + 1];
    const inLine = (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y);
    const inside = Math.min(a.x, c.x) <= b.x && b.x <= Math.max(a.x, c.x) && Math.min(a.y, c.y) <= b.y && b.y <= Math.max(a.y, c.y);
    return inLine && !inside;
  });
  return after.wires.filter((w) => old.get(w.id) !== JSON.stringify(w.points) && folds(w))
    .map((w) => `${w.id} ${w.points.map((p) => `(${p.x},${p.y})`).join('')}`);
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.schematic.json'));

describe('moving parts keeps the circuit as drawn', () => {
  it('the review cases: no short (moved, or refused)', () => {
    const cases: [string, string, { x: number; y: number }][] = [
      ['tp-traffic.schematic.json', 'U1', { x: 1, y: 0 }],
      ['tp-status.schematic.json', 'U1', { x: 0, y: 3 }],
      ['tp5-int-rb0.schematic.json', 'BOUTON', { x: -4, y: 0 }],
    ];
    for (const [f, id, delta] of cases) {
      const s = load(f);
      const r = moveSelection(s, { components: [id], wires: [] }, delta);
      expect(problems(s, r), `${f} ${id}`).toEqual([]);
    }
    // One → arrow press on the traffic PIC is possible: the LDR wire moves along instead of being crossed.
    const s = load('tp-traffic.schematic.json');
    const r = moveSelection(s, { components: ['U1'], wires: [] }, { x: 1, y: 0 });
    expect(r).not.toBe(s);
    const nl = buildNetlist(r);
    expect(nl.pinToNet.get('U1:RA3')).not.toBe(nl.pinToNet.get('SEG1:E0'));
  });

  it('a button moved over its own wire: no stub left running back past its pin, its two pins stay apart', () => {
    for (const [f, id, delta] of [
      ['tp5-int-rb0.schematic.json', 'BOUTON', { x: -4, y: 0 }],
      ['tp5-int-rb0.schematic.json', 'BOUTON', { x: -2, y: 0 }],
      ['tp-pupitre.schematic.json', 'VALIDER', { x: -4, y: 0 }],
      ['tp-vote.schematic.json', 'RESULTAT', { x: -2, y: 0 }],
    ] as const) {
      const s = load(f);
      const r = moveSelection(s, { components: [id], wires: [] }, delta);
      expect(r, `${f} ${id}`).not.toBe(s);
      expect(foldedWires(s, r), `${f} ${id}`).toEqual([]);
      // The old wire end, where the button's other pin now lands, is gone: the button is not shorted.
      const nl = buildNetlist(r);
      expect(nl.pinToNet.get(`${id}:1`), `${f} ${id}`).not.toBe(nl.pinToNet.get(`${id}:2`));
    }
    // BOUTON by (-4, 0): RB0 → the moved pin, then on to the pull-up's junction (nothing drawn twice).
    const r = moveSelection(load('tp5-int-rb0.schematic.json'), { components: ['BOUTON'], wires: [] }, { x: -4, y: 0 });
    expect(r.wires.find((w) => w.id === 'W5')!.points).toEqual([{ x: 15, y: 6 }, { x: 30.5, y: 6 }, { x: 34, y: 6 }]);
  });

  for (const f of files) {
    it(`${f}: every single-part move is either refused or exact`, () => {
      const s = load(f);
      const bad: string[] = [];
      let refused = 0; let total = 0;
      for (const c of s.components) {
        for (const delta of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }, { x: 3, y: 0 }, { x: 0, y: -3 }, { x: 2, y: 2 }, { x: -4, y: 1 }]) {
          total++;
          const r = moveSelection(s, { components: [c.id], wires: [] }, delta);
          if (r === s) { refused++; continue; }
          const p = [...problems(s, r), ...foldedWires(s, r).map((w) => `replié ${w}`)];
          if (p.length) bad.push(`${c.id} (${delta.x},${delta.y}) : ${p.slice(0, 2).join(' ; ')}`);
        }
      }
      expect(bad).toEqual([]);
      // Refusals stay the exception.
      expect(refused / total).toBeLessThan(0.25);
    });

    it(`${f}: rotations and mirrors are either refused or exact`, () => {
      const s = load(f);
      const bad: string[] = [];
      for (const c of s.components) {
        for (const r of [rotateComponents(s, [c.id], 90), rotateComponents(s, [c.id], 270), mirrorComponents(s, [c.id])]) {
          if (r === s) continue;
          const p = [...problems(s, r), ...foldedWires(s, r).map((w) => `replié ${w}`)];
          if (p.length) bad.push(`${c.id} : ${p.slice(0, 2).join(' ; ')}`);
        }
      }
      expect(bad).toEqual([]);
    });
  }
});
