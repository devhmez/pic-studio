import type { Span } from './ast';

/** Maps character offsets to 1-based line/column positions. CRLF, LF and lone CR all end a line. */
export class LineIndex {
  /** Offset of the first character of each line (index 0 = line 1). */
  readonly lineStarts: number[] = [0];

  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 13 /* \r */) {
        if (text.charCodeAt(i + 1) === 10) i++;
        this.lineStarts.push(i + 1);
      } else if (c === 10) {
        this.lineStarts.push(i + 1);
      }
    }
  }

  /** 1-based line containing `offset`. */
  lineOf(offset: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  position(offset: number): { line: number; col: number } {
    const line = this.lineOf(offset);
    return { line, col: offset - this.lineStarts[line - 1] + 1 };
  }

  span(start: number, end: number): Span {
    const a = this.position(start);
    const b = this.position(end);
    return { line: a.line, col: a.col, endLine: b.line, endCol: b.col, start, end };
  }

  /** Text of a 1-based line without its line terminator. */
  lineText(line: number): string {
    const start = this.lineStarts[line - 1] ?? this.text.length;
    const next = this.lineStarts[line] ?? this.text.length;
    return this.text.slice(start, next).replace(/\r?\n$|\r$/, '');
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }
}

/** Smallest span covering both. */
export function unionSpan(a: Span, b: Span): Span {
  const first = a.start <= b.start ? a : b;
  const last = a.end >= b.end ? a : b;
  return { line: first.line, col: first.col, start: first.start, endLine: last.endLine, endCol: last.endCol, end: last.end };
}

export const EMPTY_SPAN: Span = { line: 1, col: 1, endLine: 1, endCol: 1, start: 0, end: 0 };
