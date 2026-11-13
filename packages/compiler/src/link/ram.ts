import type { Frame, Slot } from '../codegen/ir';
import { GPR_END, GPR_START } from '../device';
import type { CallGraph } from './callgraph';

export interface RamResult {
  ok: boolean;
  /** Bytes needed beyond the 68 available, when allocation fails. */
  missing: number;
  /** Distinct GPR bytes used. */
  used: number;
}

const GPR_COUNT = GPR_END - GPR_START + 1;

/**
 * Static RAM allocation. Globals get their own bytes; function and helper frames are overlaid when the call graph
 * proves they are never active at the same time (no recursion, so static frames are safe). Interrupt frames never
 * overlap main-line frames.
 */
export function allocateRam(globals: Frame, graph: CallGraph): RamResult {
  const fixed = new Set<number>();
  for (const s of globals.slots) {
    if (s.fixed === undefined || s.size === 0) continue;
    s.addr = s.fixed;
    for (let i = 0; i < s.size; i++) fixed.add(s.fixed + i);
  }
  const globalBytes = new Set(fixed);
  let missing = 0;
  const place = (slot: Slot, forbidden: Set<number>, into: Set<number>) => {
    if (slot.size === 0 || slot.addr !== undefined) return;
    for (let a = GPR_START; a + slot.size - 1 <= GPR_END; a++) {
      let free = true;
      for (let i = 0; i < slot.size; i++) {
        if (forbidden.has(a + i) || into.has(a + i)) {
          free = false;
          break;
        }
      }
      if (free) {
        slot.addr = a;
        for (let i = 0; i < slot.size; i++) into.add(a + i);
        return;
      }
    }
    missing += slot.size;
  };
  for (const s of globals.slots) place(s, new Set(), globalBytes);

  const unitBytes = new Map<string, Set<number>>();
  for (const u of graph.topologicalOrder()) {
    const forbidden = new Set(globalBytes);
    for (const [other, bytes] of unitBytes) {
      if (graph.conflict(u.name, other)) bytes.forEach((b) => forbidden.add(b));
    }
    const mine = new Set<number>();
    // Declaration order: variables first, then the temporaries created during code generation.
    for (const s of u.frame.slots) place(s, forbidden, mine);
    unitBytes.set(u.name, mine);
  }

  const all = new Set(globalBytes);
  unitBytes.forEach((b) => b.forEach((x) => all.add(x)));
  const used = [...all].filter((a) => a >= GPR_START && a <= GPR_END).length;
  return { ok: missing === 0, missing, used: Math.min(used, GPR_COUNT) };
}
