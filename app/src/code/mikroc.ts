// MikroC PRO for PIC language support on top of @codemirror/lang-cpp: PIC16F84A register names, bit selectors,
// MikroC built-ins and keywords (sbit, absolute, interrupt…) highlighted by an overlay, plus the editor theme.
import { cpp } from '@codemirror/lang-cpp';
import { HighlightStyle, indentUnit, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { scanPicTokens, type PicTokenKind } from './vocabulary';

// ---------------------------------------------------------------------------------------------------------------
// Overlay highlighting

const MARKS: Record<PicTokenKind, Decoration> = {
  sfr: Decoration.mark({ class: 'cm-pic-sfr' }),
  bit: Decoration.mark({ class: 'cm-pic-bit' }),
  builtin: Decoration.mark({ class: 'cm-pic-builtin' }),
  keyword: Decoration.mark({ class: 'cm-pic-kw' }),
};

const SKIP_NODES = new Set(['LineComment', 'BlockComment', 'String', 'RawString', 'CharLiteral', 'SystemLibString']);

function buildOverlay(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    // Extend to whole lines so the `sbit … at` look-behind and dotted selectors see their context.
    const start = view.state.doc.lineAt(from).from;
    const end = view.state.doc.lineAt(to).to;
    const text = view.state.sliceDoc(start, end);
    for (const tok of scanPicTokens(text)) {
      const pos = start + tok.from;
      const node = tree.resolveInner(pos, 1);
      let skip = false;
      for (let n: typeof node | null = node; n; n = n.parent) if (SKIP_NODES.has(n.name)) { skip = true; break; }
      if (!skip) builder.add(pos, start + tok.to, MARKS[tok.kind]);
    }
  }
  return builder.finish();
}

/** Highlights SFRs, bit selectors, built-ins and MikroC keywords on top of the C++ grammar. */
export const picOverlay = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildOverlay(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = buildOverlay(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// ---------------------------------------------------------------------------------------------------------------
// Theme: classic embedded-IDE readability (bold keywords, green italic comments, coloured numbers) on our tokens.
// Colours come from --syn-* variables defined in CodePanel.css with light and dark variants.

export const picHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.modifier, t.operatorKeyword, t.moduleKeyword], color: 'var(--syn-keyword)', fontWeight: '700' },
  { tag: [t.standard(t.typeName), t.typeName], color: 'var(--syn-type)', fontWeight: '700' },
  { tag: [t.lineComment, t.blockComment, t.comment, t.docComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.number, t.integer, t.float, t.bool, t.null], color: 'var(--syn-number)' },
  { tag: [t.string, t.character, t.special(t.string), t.escape], color: 'var(--syn-string)' },
  { tag: t.processingInstruction, color: 'var(--syn-preproc)', fontWeight: '700' },
  { tag: t.meta, color: 'var(--syn-meta)' },
  { tag: t.special(t.name), color: 'var(--syn-macro)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-function)' },
  { tag: t.function(t.definition(t.variableName)), color: 'var(--syn-function)', fontWeight: '700' },
  { tag: t.propertyName, color: 'var(--syn-bit)' },
  { tag: [t.labelName], color: 'var(--syn-macro)' },
  { tag: t.invalid, color: 'var(--danger)' },
]);

export const picEditorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--code-font-size, 13px)', backgroundColor: 'var(--surface)', color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', overflow: 'auto' },
  '.cm-content': { padding: '6px 0', caretColor: 'var(--text)' },
  '.cm-line': { padding: '0 12px 0 6px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)', borderLeftWidth: '1.5px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'var(--code-selection)' },
  '.cm-activeLine': { backgroundColor: 'var(--code-active-line)' },
  '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--faint)', border: 'none', borderRight: '1px solid var(--line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--code-active-line)', color: 'var(--muted)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 4px', minWidth: '3ch', fontVariantNumeric: 'tabular-nums' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--accent-soft)', outline: '1px solid var(--accent)', color: 'inherit' },
  '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'var(--danger-soft)', color: 'inherit' },
  '.cm-selectionMatch': { backgroundColor: 'var(--code-selection-match)' },
  '.cm-searchMatch': { backgroundColor: 'var(--warning-soft)', outline: '1px solid var(--warning)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent-soft)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--line-strong)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)', fontFamily: 'var(--font-ui)' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', maxHeight: '16em' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--accent-text)' },
  '.cm-completionDetail': { fontStyle: 'normal', color: 'var(--faint)', marginLeft: '1em', fontFamily: 'var(--font-ui)', fontSize: 'var(--fs-xs)' },
  '.cm-tooltip-autocomplete ul li[aria-selected] .cm-completionDetail': { color: 'inherit', opacity: '.8' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '700' },
  '.cm-completionInfo': { padding: '6px 10px', maxWidth: '320px', fontFamily: 'var(--font-ui)', fontSize: 'var(--fs-sm)', lineHeight: '1.45' },
  '.cm-tooltip-lint': { padding: '0' },
  '.cm-diagnostic': { padding: '6px 10px', fontFamily: 'var(--font-ui)', fontSize: 'var(--fs-sm)', borderLeftWidth: '4px' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--danger)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--warning)' },
  '.cm-diagnostic-info': { borderLeftColor: 'var(--accent)' },
  '.cm-diagnosticSource': { fontSize: 'var(--fs-xs)', color: 'var(--faint)', opacity: '1' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--danger)', textUnderlineOffset: '3px', textDecorationSkipInk: 'none' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--warning)', textUnderlineOffset: '3px', textDecorationSkipInk: 'none' },
  '.cm-lintRange-info': { backgroundImage: 'none', textDecoration: 'underline dotted var(--accent)', textUnderlineOffset: '3px' },
  '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
  '.cm-panel.cm-search': { fontFamily: 'var(--font-ui)', fontSize: 'var(--fs-sm)', padding: '6px 8px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontSize: 'var(--fs-sm)' },
  '.cm-textfield': { backgroundColor: 'var(--surface)', border: '1px solid var(--line-strong)', borderRadius: '4px', color: 'var(--text)' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--surface)', border: '1px solid var(--line-strong)', borderRadius: '4px', color: 'var(--text)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--surface-hover)', border: '1px solid var(--line)', color: 'var(--muted)' },
});

/** Language + highlighting bundle for the MikroC editor. */
export function mikroC(): Extension {
  return [
    cpp(),
    indentUnit.of('    '),
    syntaxHighlighting(picHighlightStyle),
    picOverlay,
    picEditorTheme,
  ];
}
