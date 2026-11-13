// Review: moving one part of a bundled template must keep every pin on its net (wires must not detach).
import { describe, expect, it } from 'vitest';
import { buildNetlist, validateSchematic, type Schematic } from '@pic/circuit';
import { moveSelection } from '../schematic/editing';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(__dirname, '../../../templates');

/** Pairs of pins that share a net. */
function pairs(s: Schematic): Set<string> {
  const out = new Set<string>();
  for (const n of buildNetlist(s).nets) {
    const ps = n.pins.map((p) => `${p.componentId}:${p.pin}`).sort();
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) out.add(`${ps[i]}~${ps[j]}`);
  }
  return out;
}

describe('rubber band on the bundled templates', () => {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.schematic.json'));
  for (const f of files) {
    it(`${f}: moving a single part never disconnects pins`, () => {
      const s = validateSchematic(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).schematic!;
      const before = pairs(s);
      const lost: string[] = [];
      for (const c of s.components) {
        for (const delta of [{ x: 2, y: 0 }, { x: 0, y: 2 }, { x: 3, y: 3 }]) {
          const after = pairs(moveSelection(s, { components: [c.id], wires: [] }, delta));
          const gone = [...before].filter((p) => !after.has(p));
          if (gone.length) lost.push(`${c.id} by (${delta.x},${delta.y}): ${gone.slice(0, 3).join(', ')}`);
        }
      }
      expect(lost).toEqual([]);
    });
  }
});
