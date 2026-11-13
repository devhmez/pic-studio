// Compiler diagnostics → editor ranges and the problems strip summary (pure; no CodeMirror imports).
import type { Diagnostic as CompilerDiagnostic, Severity } from '@pic/compiler';

/** Minimal document interface (CodeMirror's Text satisfies it). */
export interface LineDoc {
  readonly lines: number;
  line(n: number): { from: number; to: number };
}

export interface EditorDiagnostic {
  from: number;
  to: number;
  severity: Severity;
  message: string;
  /** Label shown in the hover tooltip. */
  source: string;
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  error: 'Erreur',
  warning: 'Avertissement',
  info: 'Conseil',
};

/** Document offset of a 1-based line/column, clamped to the document and the line. */
export function offsetOf(doc: LineDoc, line: number, col: number): number {
  const n = Math.min(Math.max(1, line), doc.lines);
  const l = doc.line(n);
  return Math.min(l.from + Math.max(0, col - 1), l.to);
}

/**
 * Editor range of a compiler diagnostic. Empty or collapsed ranges are widened to the word at the position (or to
 * the end of the line, or the previous character at a line end) so the squiggle is always visible.
 */
export function diagnosticRange(doc: LineDoc, d: CompilerDiagnostic, text: (from: number, to: number) => string): { from: number; to: number } {
  const from = offsetOf(doc, d.line, d.col);
  let to = d.endLine !== undefined && d.endCol !== undefined ? offsetOf(doc, d.endLine, d.endCol) : from;
  if (to > from) return { from, to };
  const n = Math.min(Math.max(1, d.line), doc.lines);
  const line = doc.line(n);
  const rest = text(from, line.to);
  const word = /^[A-Za-z0-9_]+/.exec(rest);
  if (word) to = from + word[0].length;
  else if (from < line.to) to = from + 1;
  else if (from > line.from) return { from: from - 1, to: from };
  return { from, to: Math.max(from, to) };
}

/** Map compiler diagnostics onto the document. */
export function toEditorDiagnostics(
  doc: LineDoc,
  diags: readonly CompilerDiagnostic[],
  text: (from: number, to: number) => string,
): EditorDiagnostic[] {
  if (doc.lines === 0) return [];
  return diags.map((d) => ({ ...diagnosticRange(doc, d, text), severity: d.severity, message: d.message, source: SEVERITY_LABEL[d.severity] }));
}

export interface DiagnosticCounts {
  error: number;
  warning: number;
  info: number;
}

export function countDiagnostics(diags: readonly CompilerDiagnostic[]): DiagnosticCounts {
  const c: DiagnosticCounts = { error: 0, warning: 0, info: 0 };
  for (const d of diags) c[d.severity]++;
  return c;
}

/** '2 erreurs · 1 avertissement' (empty string when there is nothing). */
export function countsLabel(c: DiagnosticCounts): string {
  const parts: string[] = [];
  if (c.error) parts.push(`${c.error} erreur${c.error > 1 ? 's' : ''}`);
  if (c.warning) parts.push(`${c.warning} avertissement${c.warning > 1 ? 's' : ''}`);
  if (c.info) parts.push(`${c.info} conseil${c.info > 1 ? 's' : ''}`);
  return parts.join(' · ');
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Problems sorted for the strip: errors first, then by position. */
export function sortForStrip(diags: readonly CompilerDiagnostic[]): CompilerDiagnostic[] {
  return [...diags].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.line - b.line || a.col - b.col);
}
