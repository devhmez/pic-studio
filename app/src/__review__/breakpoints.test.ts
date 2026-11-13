// Review: breakpoints must stay on the same C statement when the student edits the code above them.
import { describe, expect, it } from 'vitest';
import type { Schematic } from '@pic/circuit';
import { createAppStore, type TemplateEntry } from '../state/store';
import { breakpointLines } from '../debug/listing';

const PIC = {
  id: 'U1', kind: 'PIC16F84A' as const, ref: 'U1', value: 'PIC16F84A', at: { x: 0, y: 0 }, rotation: 0 as const,
  props: { clock: '1MHz' },
};
const SCHEMATIC: Schematic = { clockHz: 1_000_000, components: [PIC], wires: [] };
const SOURCE = 'void main() {\n  TRISB = 0;\n  while (1) {\n    PORTB = 1;\n    PORTB = 0;\n  }\n}\n';
const T: TemplateEntry = { id: 'tp-status', title: 'x', chapter: null, description: '', clockHz: 1e6, schematic: SCHEMATIC, program: null, source: SOURCE };

const lineOf = (src: string, text: string): number => src.split('\n').findIndex((l) => l.includes(text)) + 1;

describe('breakpoint remap after an edit above the breakpoint', () => {
  it('keeps the breakpoint on « PORTB = 0; » when a line is inserted above it', () => {
    const store = createAppStore({ storage: null, templates: [T] });
    const app = () => store.getState();
    const r0 = app().compile.result!;
    const target = lineOf(SOURCE, 'PORTB = 0;');
    app().toggleBreakpoint(r0.lineToAddr.get(target)!);
    expect([...breakpointLines(app().sim.breakpoints, r0.addrToLine)]).toEqual([target]);

    // The student adds one statement at the top of main().
    const edited = SOURCE.replace('  TRISB = 0;\n', '  TRISA = 0;\n  TRISB = 0;\n');
    app().setSource(edited);
    const r1 = app().build();
    expect(r1.ok).toBe(true);
    const newTarget = lineOf(edited, 'PORTB = 0;');
    // Actual: the breakpoint now sits on « PORTB = 1; » (same line NUMBER, other statement).
    expect([...breakpointLines(app().sim.breakpoints, r1.addrToLine)]).toEqual([newTarget]);
  });
});

describe('instruction-level breakpoints (set from the Assembleur listing)', () => {
  it('stay on their instruction when the code is rebuilt without any change to the program', () => {
    const store = createAppStore({ storage: null, templates: [T] });
    const app = () => store.getState();
    const r0 = app().compile.result!;
    // An instruction that is not the first one of its C line (e.g. the MOVWF of « PORTB = 1; »).
    const line = lineOf(SOURCE, 'PORTB = 1;');
    const first = r0.lineToAddr.get(line)!;
    const second = first + 1;
    expect(r0.addrToLine.get(second)).toBe(line);
    app().toggleBreakpoint(second);
    expect(app().sim.breakpoints).toEqual([second]);

    // Only a comment is added at the end: same program, same addresses.
    app().setSource(`${SOURCE}// fin\n`);
    const r1 = app().build();
    expect(Array.from(r1.program!)).toEqual(Array.from(r0.program!));
    expect(app().sim.breakpoints).toEqual([second]);
  });
});

describe('breakpoints across a failed intermediate build (auto-build while typing)', () => {
  it('stays on « PORTB = 0; » after the student types a new statement above it', () => {
    const store = createAppStore({ storage: null, templates: [T] });
    const app = () => store.getState();
    const r0 = app().compile.result!;
    app().toggleBreakpoint(r0.lineToAddr.get(lineOf(SOURCE, 'PORTB = 0;'))!);
    // Auto-build fires mid-typing (syntax error), then again once the line is complete.
    app().setSource(SOURCE.replace('  TRISB = 0;\n', '  TRISA = ;\n  TRISB = 0;\n'));
    expect(app().build().ok).toBe(false);
    const done = SOURCE.replace('  TRISB = 0;\n', '  TRISA = 0x1F;\n  TRISB = 0;\n');
    app().setSource(done);
    const r2 = app().build();
    expect(r2.ok).toBe(true);
    const lines = [...breakpointLines(app().sim.breakpoints, r2.addrToLine)];
    expect(lines.map((l) => done.split('\n')[l - 1].trim())).toEqual(['PORTB = 0;']);
  });
});
