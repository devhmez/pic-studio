// Review: a rebuild that produces the very same machine code (comment edit) must not reset a paused simulation.
import { describe, expect, it } from 'vitest';
import type { Schematic } from '@pic/circuit';
import { createAppStore, type TemplateEntry } from '../state/store';
import { SimEngine } from '../sim/engine';
import type { ToWorker } from '../sim/protocol';

const PIC = {
  id: 'U1', kind: 'PIC16F84A' as const, ref: 'U1', value: 'PIC16F84A', at: { x: 0, y: 0 }, rotation: 0 as const,
  props: { clock: '1MHz' },
};
const SCHEMATIC: Schematic = { clockHz: 1_000_000, components: [PIC], wires: [] };
const SOURCE = 'unsigned char n;\nvoid main() {\n  TRISB = 0;\n  n = 0;\n  while (1) {\n    n = n + 1;\n    PORTB = n;\n  }\n}\n';
const T: TemplateEntry = { id: 'tp-status', title: 'x', chapter: null, description: '', clockHz: 1e6, schematic: SCHEMATIC, program: null, source: SOURCE };

describe('paused simulation and a comment-only edit', () => {
  it('keeps stepping from where it was', () => {
    const store = createAppStore({ storage: null, templates: [T] });
    const engine = new SimEngine({ post: (m) => store.receive(m), now: () => 0, schedule: () => {} });
    const posted: ToWorker['type'][] = [];
    store.attachSim({ post: (m) => { posted.push(m.type); engine.handle(m); } });
    const app = () => store.getState();

    for (let i = 0; i < 12; i++) app().stepLine();
    const cyclesBefore = app().sim.debug!.cycles;
    expect(cyclesBefore).toBeGreaterThan(10);

    // The student documents the line in the editor; the auto-build produces identical machine code.
    app().setSource(SOURCE.replace('n = n + 1;', 'n = n + 1; // compteur'));
    const r = app().build();
    expect(r.ok).toBe(true);
    posted.length = 0;
    app().stepLine();
    expect(posted).not.toContain('load');
    expect(app().sim.debug!.cycles).toBeGreaterThan(cyclesBefore);
  });
});
