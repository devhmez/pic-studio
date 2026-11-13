import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { debugGutter, debugMarkers, execLinePos, setBreakpointLines, setDebugLines } from './debugGutter';

const DOC = 'void main() {\n    TRISB = 0;\n    // rien\n    PORTB = 1;\n}\n';

function stateWith(lineToAddr: [number, number][], bp: number[], exec: number | null) {
  const state = EditorState.create({ doc: DOC, extensions: debugGutter(() => {}) });
  return state.update({
    effects: setDebugLines.of({ lineToAddr: new Map(lineToAddr), breakpointLines: new Set(bp), execLine: exec }),
  }).state;
}

describe('breakpoint gutter state', () => {
  it('puts a marker on every line that generates code, flagged with breakpoints and the exec line', () => {
    const s = stateWith([[2, 4], [4, 6]], [4], 2);
    expect(debugMarkers(s)).toEqual([
      { pos: s.doc.line(2).from, line: 2, breakpoint: false, exec: true },
      { pos: s.doc.line(4).from, line: 4, breakpoint: true, exec: false },
    ]);
    expect(execLinePos(s)).toBe(s.doc.line(2).from);
  });

  it('keeps markers on their lines while text is inserted above (build-time line numbers kept)', () => {
    const s0 = stateWith([[2, 4], [4, 6]], [4], 2);
    const s1 = s0.update({ changes: { from: 0, insert: '// en-tête\n' } }).state;
    const m = debugMarkers(s1);
    expect(m.map((x) => s1.doc.lineAt(x.pos).number)).toEqual([3, 5]);
    expect(m.map((x) => x.line)).toEqual([2, 4]);
    expect(s1.doc.lineAt(execLinePos(s1)!).number).toBe(3);
  });

  it('re-flags kept markers without moving them (code that does not compile yet)', () => {
    const s0 = stateWith([[2, 4], [4, 6]], [4], null);
    const s1 = s0.update({ changes: { from: 0, insert: '\n' } }).state;
    const s2 = s1.update({ effects: setBreakpointLines.of(new Set([2])) }).state;
    expect(debugMarkers(s2).map((x) => [s2.doc.lineAt(x.pos).number, x.breakpoint])).toEqual([[3, true], [5, false]]);
  });

  it('ignores lines outside the document and clears with an empty update', () => {
    const s = stateWith([[2, 4], [99, 8]], [], 99);
    expect(debugMarkers(s).map((x) => x.line)).toEqual([2]);
    expect(execLinePos(s)).toBeNull();
    const cleared = s.update({ effects: setDebugLines.of({ lineToAddr: new Map(), breakpointLines: new Set(), execLine: null }) }).state;
    expect(debugMarkers(cleared)).toEqual([]);
  });
});
