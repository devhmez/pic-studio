// Review: after a successful rebuild while paused, the panels must keep mapping the PC through the program the core
// really runs (not through the new build), and the C line onto the edited text.
import { describe, expect, it } from 'vitest';
import type { Schematic } from '@pic/circuit';
import { createAppStore, type TemplateEntry } from '../state/store';
import { SimEngine } from '../sim/engine';
import { execLineFor } from '../debug/listing';
import { selectPausedLine, selectShowingRunningProgram, selectShownBuild } from '../debug/running';

const PIC = {
  id: 'U1', kind: 'PIC16F84A' as const, ref: 'U1', value: 'PIC16F84A', at: { x: 0, y: 0 }, rotation: 0 as const,
  props: { clock: '1MHz' },
};
const SCHEMATIC: Schematic = { clockHz: 1_000_000, components: [PIC], wires: [] };
const SOURCE = 'void main() {\n  TRISB = 0;\n  while (1) {\n    PORTB = 1;\n    PORTB = 0;\n  }\n}\n';
const T: TemplateEntry = { id: 'tp-status', title: 'x', chapter: null, description: '', clockHz: 1e6, schematic: SCHEMATIC, program: null, source: SOURCE };

describe('outdated program while paused', () => {
  it('shows the instruction and the C line that the paused core is really on', () => {
    const store = createAppStore({ storage: null, templates: [T] });
    let clock = 0;
    const engine = new SimEngine({ post: (m) => store.receive(m), now: () => clock, schedule: () => {} });
    store.attachSim({ post: (m) => engine.handle(m) });
    const app = () => store.getState();

    app().stepLine();
    app().stepLine();
    app().stepLine();
    const before = app().compile.result!;
    const dbg = app().sim.debug!;
    const lineBefore = execLineFor(dbg.pc, dbg.stack, before.addrToLine);
    const wordAtPc = before.program![dbg.pc];

    // Student inserts a statement at the top of main() while paused; the auto-build succeeds.
    app().setSource(SOURCE.replace('  TRISB = 0;\n', '  TRISA = 0;\n  TRISA = 0;\n  TRISB = 0;\n'));
    const after = app().build();
    expect(after.ok).toBe(true);
    expect(app().sim.status).toBe('paused');
    expect(store.isProgramOutdated(app())).toBe(true);

    // What the Code / Assembleur / Organigramme panels compute: the running build's listing, and its C line mapped
    // onto the edited text.
    expect(selectShowingRunningProgram(app())).toBe(true);
    const shownWord = selectShownBuild(app())!.program![dbg.pc];
    const shownLine = selectPausedLine(app());
    // The core still executes the old program: the highlighted listing row must be that instruction.
    const editedLines = app().project.source.split('\n');
    expect({
      word: shownWord,
      // The arrow must sit on the statement being executed, not on another one.
      line: editedLines[shownLine! - 1].trim(),
    }).toEqual({ word: wordAtPc, line: SOURCE.split('\n')[lineBefore! - 1].trim() });
  });
});
