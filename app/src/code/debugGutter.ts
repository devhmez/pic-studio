// Breakpoint gutter (red dots, click to toggle, disabled on lines without code) and the current execution line
// for the C editor. The panel pushes line-level info with `setDebugLines`; markers are mapped through edits until
// the next build replaces them.
import { RangeSet, RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView, gutter, GutterMarker, type DecorationSet } from '@codemirror/view';

export interface DebugLines {
  /** C line → address of its first instruction (lines that generate code). */
  lineToAddr: ReadonlyMap<number, number>;
  /** Lines holding at least one breakpoint. */
  breakpointLines: ReadonlySet<number>;
  /** Line being executed (paused / stepping), or null. */
  execLine: number | null;
}

class LineMarker extends GutterMarker {
  constructor(readonly line: number, readonly breakpoint: boolean, readonly exec: boolean) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof LineMarker && other.line === this.line && other.breakpoint === this.breakpoint && other.exec === this.exec;
  }
  override toDOM(): Node {
    const el = document.createElement('div');
    el.className = `cm-pic-bp${this.breakpoint ? ' is-set' : ''}${this.exec ? ' is-exec' : ''}`;
    el.title = this.breakpoint
      ? 'Point d’arrêt — cliquer pour le retirer (F9)'
      : 'Cliquer pour ajouter un point d’arrêt sur cette ligne (F9)';
    el.setAttribute('aria-hidden', 'true');
    if (this.exec) {
      const arrow = document.createElement('span');
      arrow.className = 'cm-pic-exec-arrow';
      arrow.textContent = '▶';
      el.appendChild(arrow);
    }
    return el;
  }
}

class SpacerMarker extends GutterMarker {
  override toDOM(): Node {
    const el = document.createElement('div');
    el.className = 'cm-pic-bp';
    return el;
  }
}

interface DebugFieldValue {
  markers: RangeSet<LineMarker>;
  execLine: DecorationSet;
}

export const setDebugLines = StateEffect.define<DebugLines>();
/**
 * Re-flag the existing markers (kept from the last good build and mapped through edits) with a new set of
 * breakpoint lines, numbered like that build. Used while the current text does not compile.
 */
export const setBreakpointLines = StateEffect.define<ReadonlySet<number>>();

const execLineDeco = Decoration.line({ class: 'cm-pic-exec-line' });

function build(doc: Text, info: DebugLines): DebugFieldValue {
  const markers = new RangeSetBuilder<LineMarker>();
  const lines = [...info.lineToAddr.keys()].filter((l) => l >= 1 && l <= doc.lines).sort((a, b) => a - b);
  const all = new Set(lines);
  if (info.execLine !== null) all.add(info.execLine);
  for (const l of [...all].sort((a, b) => a - b)) {
    if (l < 1 || l > doc.lines) continue;
    markers.add(doc.line(l).from, doc.line(l).from, new LineMarker(l, info.breakpointLines.has(l), info.execLine === l));
  }
  const exec = info.execLine !== null && info.execLine >= 1 && info.execLine <= doc.lines
    ? Decoration.set([execLineDeco.range(doc.line(info.execLine).from)])
    : Decoration.none;
  return { markers: markers.finish(), execLine: exec };
}

function reflag(markers: RangeSet<LineMarker>, bpLines: ReadonlySet<number>): RangeSet<LineMarker> {
  const b = new RangeSetBuilder<LineMarker>();
  for (const it = markers.iter(); it.value; it.next()) {
    const m = it.value;
    const bp = bpLines.has(m.line);
    b.add(it.from, it.to, bp === m.breakpoint ? m : new LineMarker(m.line, bp, m.exec));
  }
  return b.finish();
}

const debugField = StateField.define<DebugFieldValue>({
  create: () => ({ markers: RangeSet.empty, execLine: Decoration.none }),
  update(value, tr) {
    let v = value;
    if (tr.docChanged) v = { markers: v.markers.map(tr.changes), execLine: v.execLine.map(tr.changes) };
    for (const e of tr.effects) {
      if (e.is(setDebugLines)) v = build(tr.state.doc, e.value);
      else if (e.is(setBreakpointLines)) v = { ...v, markers: reflag(v.markers, e.value) };
    }
    return v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.execLine),
});

/** Compile-time line number of the marker at the start of the line at `linePos`, or null (no code there). */
function markerLineAt(state: EditorState, linePos: number): number | null {
  for (const it = state.field(debugField).markers.iter(linePos); it.value; it.next()) {
    if (it.from > linePos) break;
    if (it.from === linePos) return it.value.line;
  }
  return null;
}

/** Current markers as plain data (document position, build-time line, flags) — for tests and diagnostics. */
export function debugMarkers(state: EditorState): { pos: number; line: number; breakpoint: boolean; exec: boolean }[] {
  const out: { pos: number; line: number; breakpoint: boolean; exec: boolean }[] = [];
  for (const it = state.field(debugField).markers.iter(); it.value; it.next()) {
    out.push({ pos: it.from, line: it.value.line, breakpoint: it.value.breakpoint, exec: it.value.exec });
  }
  return out;
}

/** Position of the execution line, if any (for scrolling it into view). */
export function execLinePos(state: EditorState): number | null {
  const it = state.field(debugField).execLine.iter();
  return it.value ? it.from : null;
}

/**
 * Breakpoint gutter. `onToggleLine` receives the 1-based line number as it was when the markers were built
 * (i.e. the line number of the compile result), so addresses stay consistent while the user types.
 */
export function debugGutter(onToggleLine: (line: number) => void): Extension {
  const toggleAt = (view: EditorView, pos: number): boolean => {
    const line = markerLineAt(view.state, pos);
    if (line === null) return false;
    onToggleLine(line);
    return true;
  };
  return [
    debugField,
    gutter({
      class: 'cm-pic-bp-gutter',
      markers: (view) => view.state.field(debugField).markers,
      initialSpacer: () => new SpacerMarker(),
      domEventHandlers: {
        mousedown(view, block, event) {
          if ((event as MouseEvent).button !== 0) return false;
          return toggleAt(view, view.state.doc.lineAt(block.from).from);
        },
      },
    }),
  ];
}

/** Toggle the breakpoint of the line holding the main cursor (F9). */
export function toggleBreakpointAtCursor(view: EditorView, onToggleLine: (line: number) => void): boolean {
  const pos = view.state.doc.lineAt(view.state.selection.main.head).from;
  const line = markerLineAt(view.state, pos);
  if (line === null) return false;
  onToggleLine(line);
  return true;
}
