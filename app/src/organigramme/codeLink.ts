// Highlight lines of the Code panel's editor from the organigramme (click on a box → its C lines), without touching
// the code panel's own module: the editor is found from the DOM (EditorView.findFromDOM) and a small line-decoration
// field is appended to it on first use. A text reload in the code panel drops the field; it is added again next time.
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import type { LineRange } from './charts';

const setLines = StateEffect.define<LineRange | null>();

const linesField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (!e.is(setLines)) continue;
      const range = e.value;
      if (!range) return Decoration.none;
      const doc = tr.state.doc;
      const first = Math.max(1, Math.min(doc.lines, range.line));
      const last = Math.max(first, Math.min(doc.lines, range.endLine));
      const marks = [];
      for (let n = first; n <= last; n++) {
        const cls = n === first && n === last ? 'cm-org-line is-first is-last' : n === first ? 'cm-org-line is-first' : n === last ? 'cm-org-line is-last' : 'cm-org-line';
        marks.push(Decoration.line({ class: cls }).range(doc.line(n).from));
      }
      return Decoration.set(marks);
    }
    // Any edit makes the old lines meaningless.
    return tr.docChanged ? Decoration.none : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const theme = EditorView.baseTheme({
  '.cm-org-line': {
    backgroundColor: 'color-mix(in srgb, var(--accent, #0f766e) 13%, transparent)',
    boxShadow: 'inset 3px 0 0 var(--accent, #0f766e)',
  },
});

const extension: Extension = [linesField, theme];

function codeEditor(): EditorView | null {
  if (typeof document === 'undefined') return null;
  const dom = document.querySelector<HTMLElement>('[data-panel="code"] .cm-editor') ?? document.querySelector<HTMLElement>('.code-editor .cm-editor');
  return dom ? EditorView.findFromDOM(dom) : null;
}

/**
 * Highlight `range` in the code editor and scroll it into view (null clears). Returns false when no code editor is
 * on screen.
 */
export function revealCodeLines(range: LineRange | null): boolean {
  const view = codeEditor();
  if (!view) return false;
  if (view.state.field(linesField, false) === undefined) {
    if (!range) return true;
    view.dispatch({ effects: StateEffect.appendConfig.of(extension) });
  }
  const effects: StateEffect<unknown>[] = [setLines.of(range)];
  if (range) {
    const doc = view.state.doc;
    const line = doc.line(Math.max(1, Math.min(doc.lines, range.line)));
    effects.push(EditorView.scrollIntoView(line.from, { y: 'center' }));
  }
  view.dispatch({ effects });
  return true;
}
