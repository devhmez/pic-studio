import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '@pic/compiler';
import { compile } from '@pic/compiler';
import { countDiagnostics, countsLabel, diagnosticRange, offsetOf, sortForStrip, toEditorDiagnostics, type LineDoc } from './diagnostics';

/** Tiny stand-in for CodeMirror's Text. */
function docOf(text: string): LineDoc & { slice(a: number, b: number): string } {
  const lines: { from: number; to: number }[] = [];
  let from = 0;
  for (const l of text.split('\n')) {
    lines.push({ from, to: from + l.length });
    from += l.length + 1;
  }
  return { lines: lines.length, line: (n) => lines[n - 1], slice: (a, b) => text.slice(a, b) };
}

const diag = (p: Partial<Diagnostic>): Diagnostic => ({ severity: 'error', code: 'E_TEST', message: 'test', line: 1, col: 1, ...p });

describe('diagnostic ranges', () => {
  const text = 'void main() {\n    x = 1;\n}';
  const doc = docOf(text);
  const slice = doc.slice;

  it('converts 1-based line/col to offsets, clamped', () => {
    expect(offsetOf(doc, 2, 5)).toBe(18);
    expect(offsetOf(doc, 2, 99)).toBe(doc.line(2).to);
    expect(offsetOf(doc, 0, 1)).toBe(0);
    expect(offsetOf(doc, 99, 1)).toBe(doc.line(3).from);
  });

  it('uses the explicit end when there is one', () => {
    expect(diagnosticRange(doc, diag({ line: 2, col: 5, endLine: 2, endCol: 6 }), slice)).toEqual({ from: 18, to: 19 });
  });

  it('widens a collapsed range to the word under it', () => {
    expect(diagnosticRange(doc, diag({ line: 2, col: 5 }), slice)).toEqual({ from: 18, to: 19 });
    expect(diagnosticRange(doc, diag({ line: 1, col: 1, endLine: 1, endCol: 1 }), slice)).toEqual({ from: 0, to: 4 });
  });

  it('marks the previous character at a line end, and one character on punctuation', () => {
    const end = doc.line(2).to;
    expect(diagnosticRange(doc, diag({ line: 2, col: 99 }), slice)).toEqual({ from: end - 1, to: end });
    expect(diagnosticRange(doc, diag({ line: 1, col: 13 }), slice)).toEqual({ from: 12, to: 13 });
  });

  it('maps real compiler messages (French) with a severity label', () => {
    const src = 'void main() {\n  unsigned char x\n}';
    const r = compile(src, {});
    expect(r.ok).toBe(false);
    const d = docOf(src);
    const out = toEditorDiagnostics(d, r.diagnostics, d.slice);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].severity).toBe('error');
    expect(out[0].source).toBe('Erreur');
    expect(out[0].message).toMatch(/attendu/);
    expect(out[0].to).toBeGreaterThan(out[0].from);
  });
});

describe('problems strip helpers', () => {
  const list = [
    diag({ severity: 'warning', line: 3 }),
    diag({ severity: 'error', line: 9 }),
    diag({ severity: 'info', line: 1 }),
    diag({ severity: 'error', line: 2 }),
  ];

  it('counts and labels in French', () => {
    const c = countDiagnostics(list);
    expect(c).toEqual({ error: 2, warning: 1, info: 1 });
    expect(countsLabel(c)).toBe('2 erreurs · 1 avertissement · 1 conseil');
    expect(countsLabel({ error: 0, warning: 0, info: 0 })).toBe('');
  });

  it('sorts errors first, then by position', () => {
    expect(sortForStrip(list).map((d) => `${d.severity}:${d.line}`)).toEqual(['error:2', 'error:9', 'warning:3', 'info:1']);
  });
});
