import type { NodeBase, Span } from '../ast';
import { Codes, type DiagnosticBag } from '../diagnostics';
import type { Token } from '../lexer';

/** Thrown to abandon the current statement; the statement parser resynchronises. */
export class ParseError extends Error {}

export class TokenStream {
  pos = 0;
  /** Lower-cased typedef names (identifiers are case-insensitive). */
  readonly typedefs = new Set<string>();

  constructor(
    readonly tokens: Token[],
    readonly source: string,
    readonly diags: DiagnosticBag,
  ) {}

  peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  next(): Token {
    const t = this.tokens[this.pos];
    if (t.kind !== 'eof') this.pos++;
    return t;
  }

  get previous(): Token {
    return this.tokens[Math.max(0, this.pos - 1)];
  }

  atEnd(): boolean {
    return this.peek().kind === 'eof';
  }

  /** Punctuator test. */
  is(value: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === 'punct' && t.value === value;
  }

  /** Keyword test (keywords are lower-case and case-sensitive in MikroC). */
  isKeyword(value: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === 'ident' && t.value === value;
  }

  accept(value: string): boolean {
    if (this.is(value)) {
      this.pos++;
      return true;
    }
    return false;
  }

  acceptKeyword(value: string): boolean {
    if (this.isKeyword(value)) {
      this.pos++;
      return true;
    }
    return false;
  }

  /** Consume a punctuator or report "'x' attendu" at the end of the previous token. */
  expect(value: string): Token {
    if (this.is(value)) return this.next();
    this.errorExpected(`'${value}'`, value === ';' ? Codes.EXPECTED_SEMICOLON : Codes.SYNTAX);
  }

  expectIdent(what = 'Identificateur'): Token {
    const t = this.peek();
    if (t.kind === 'ident') return this.next();
    this.errorExpected(what);
  }

  errorExpected(what: string, code: string = Codes.SYNTAX): never {
    const t = this.peek();
    // MikroC reports a missing ';' after the previous token; other errors at the offending token.
    const span = what === "';'" && this.pos > 0 ? endOf(this.previous.span) : t.span;
    const found = t.kind === 'eof' ? 'fin de fichier' : `'${t.value}'`;
    // French agreement: « Expression attendue », « ';' attendu ».
    const agreed = /^(Expression|Déclaration|Instruction)\b/.test(what) ? 'attendue' : 'attendu';
    this.diags.error(code, `${what} ${agreed}, ${found} trouvé`, span);
    throw new ParseError(what);
  }

  error(code: string, message: string, span: Span): never {
    this.diags.error(code, message, span);
    throw new ParseError(message);
  }

  /** Span covering every token consumed since `startPos` (macro tokens share their invocation span). */
  spanFrom(startPos: number): Span {
    const end = Math.max(startPos + 1, this.pos);
    let first = this.tokens[startPos].span;
    let last = first;
    for (let k = startPos; k < end && k < this.tokens.length; k++) {
      const s = this.tokens[k].span;
      if (s.start < first.start) first = s;
      if (s.end > last.end) last = s;
    }
    return { line: first.line, col: first.col, start: first.start, endLine: last.endLine, endCol: last.endCol, end: last.end };
  }

  /** Common node fields for the tokens consumed since `startPos`. */
  base(startPos: number): NodeBase {
    const span = this.spanFrom(startPos);
    const node: NodeBase = { span, text: this.source.slice(span.start, span.end) };
    const firstTok = this.tokens[startPos];
    if (firstTok.macro !== undefined) {
      const end = Math.max(startPos + 1, this.pos);
      let same = true;
      for (let k = startPos; k < end; k++) {
        if (this.tokens[k].macro === undefined) {
          same = false;
          break;
        }
      }
      if (same && firstTok.span.start === span.start && firstTok.span.end === span.end) node.macro = firstTok.macro;
    }
    return node;
  }

  textOf(span: Span): string {
    return this.source.slice(span.start, span.end);
  }
}

function endOf(s: Span): Span {
  return { line: s.endLine, col: s.endCol, endLine: s.endLine, endCol: s.endCol, start: s.end, end: s.end };
}
