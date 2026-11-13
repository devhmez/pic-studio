import type { Comment, Span } from './ast';
import { Codes, type DiagnosticBag } from './diagnostics';
import { LineIndex } from './span';

/**
 * 'other' is a stray character; it is reported only if it reaches the parser (not in #error or skipped code).
 * Malformed literals are likewise only recorded on the token (`Token.error`); unterminated block comments are
 * reported here since they hide the rest of the file.
 */
export type TokenKind = 'ident' | 'number' | 'char' | 'string' | 'punct' | 'other' | 'eof';

export interface Token {
  kind: TokenKind;
  /** Identifier name, punctuator, or raw literal text. */
  value: string;
  /** Value of number and char literals. */
  num?: number;
  radix?: 2 | 8 | 10 | 16;
  /** Span in the original source. Tokens produced by a macro body carry the span of the macro invocation. */
  span: Span;
  /** Logical line (backslash-newline joins physical lines); used to delimit preprocessor directives. */
  logicalLine: number;
  /** First token of its logical line. */
  atLineStart: boolean;
  /** Whitespace or a comment precedes the token (distinguishes `NAME(` from `NAME (` in #define). */
  spaceBefore: boolean;
  /** Macro whose expansion produced this token. */
  macro?: string;
  /** Macros that must not be expanded again in this token (C preprocessor hide set). */
  hide?: ReadonlySet<string>;
  /**
   * Malformed literal (unterminated quote, bad digits…). Reported by the preprocessor only when the token is part of
   * active code: the text of a skipped #if group or of #error/#warning is not C code (C11 6.10.1p6).
   */
  error?: TokenError;
}

export interface TokenError {
  code: string;
  message: string;
}

export interface LexResult {
  tokens: Token[];
  comments: Comment[];
  lines: LineIndex;
}

const PUNCTUATORS = [
  '>>=', '<<=', '...',
  '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '##',
  '+', '-', '*', '/', '%', '<', '>', '=', '!', '~', '&', '|', '^', '?', ':', ';', ',', '.', '(', ')', '[', ']', '{', '}', '#',
];

const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string) => c >= '0' && c <= '9';

export function lex(text: string, diags: DiagnosticBag): LexResult {
  const lines = new LineIndex(text);
  const tokens: Token[] = [];
  const comments: Comment[] = [];
  let i = 0;
  let logicalLine = 1;
  let atLineStart = true;
  let spaceBefore = false;

  const push = (kind: TokenKind, start: number, end: number, extra: Partial<Token> = {}) => {
    const { error, ...rest } = extra;
    tokens.push({
      kind,
      value: text.slice(start, end),
      span: lines.span(start, end),
      logicalLine,
      atLineStart,
      spaceBefore,
      ...rest,
      ...(error ? { error } : {}),
    });
    atLineStart = false;
    spaceBefore = false;
  };

  const newline = () => {
    logicalLine++;
    atLineStart = true;
    spaceBefore = false;
  };

  while (i < text.length) {
    const c = text[i];

    // Line ends (CRLF, LF, CR)
    if (c === '\r' || c === '\n') {
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      newline();
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\f' || c === '\v') {
      i++;
      spaceBefore = true;
      continue;
    }
    // Backslash-newline joins lines (only meaningful inside #define).
    if (c === '\\' && (text[i + 1] === '\n' || text[i + 1] === '\r')) {
      i += text[i + 1] === '\r' && text[i + 2] === '\n' ? 3 : 2;
      spaceBefore = true;
      continue;
    }

    // Comments
    if (c === '/' && text[i + 1] === '/') {
      const start = i;
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
      const raw = text.slice(start, i);
      comments.push({ kind: 'line', raw, text: raw.slice(2).trim(), span: lines.span(start, i) });
      spaceBefore = true;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const start = i;
      const close = text.indexOf('*/', i + 2);
      const end = close < 0 ? text.length : close + 2;
      if (close < 0) diags.error(Codes.UNTERMINATED, 'Commentaire /* non terminé', lines.span(start, start + 2));
      const raw = text.slice(start, end);
      comments.push({ kind: 'block', raw, text: raw.slice(2, close < 0 ? undefined : -2).trim(), span: lines.span(start, end) });
      // A block comment spanning lines still counts as one logical line break per newline it contains.
      for (let k = start; k < end; k++) {
        const ch = text[k];
        if (ch === '\n' || (ch === '\r' && text[k + 1] !== '\n')) newline();
      }
      i = end;
      spaceBefore = true;
      continue;
    }

    const start = i;

    // Identifiers and keywords
    if (isIdentStart(c)) {
      while (i < text.length && isIdentPart(text[i])) i++;
      push('ident', start, i);
      continue;
    }

    // Numbers
    if (isDigit(c) || (c === '.' && isDigit(text[i + 1] ?? ''))) {
      i = lexNumber(text, i, (end, num, radix, error) => push('number', start, end, { num, radix, error }));
      continue;
    }

    // Character literals
    if (c === "'") {
      const res = scanQuoted(text, i, "'");
      const chars = decodeEscapes(res.body);
      let error: TokenError | undefined;
      if (!res.closed) error = { code: Codes.UNTERMINATED, message: 'Caractère littéral non terminé' };
      else if (chars.length !== 1) error = { code: Codes.SYNTAX, message: `Caractère littéral invalide ${text.slice(start, res.end)}` };
      push('char', start, res.end, { num: (chars[0] ?? 0) & 0xff, error });
      i = res.end;
      continue;
    }

    // String literals
    if (c === '"') {
      const res = scanQuoted(text, i, '"');
      const error = res.closed ? undefined : { code: Codes.UNTERMINATED, message: 'Chaîne de caractères non terminée' };
      push('string', start, res.end, { error });
      i = res.end;
      continue;
    }

    // Punctuators
    const p = PUNCTUATORS.find((q) => text.startsWith(q, i));
    if (p) {
      i += p.length;
      push('punct', start, i);
      continue;
    }

    i++;
    push('other', start, i);
  }

  tokens.push({
    kind: 'eof',
    value: '',
    span: lines.span(text.length, text.length),
    logicalLine: logicalLine + 1,
    atLineStart: true,
    spaceBefore: false,
  });
  return { tokens, comments, lines };
}

function lexNumber(
  text: string,
  i: number,
  emit: (end: number, num: number, radix: 2 | 8 | 10 | 16, error?: TokenError) => void,
): number {
  const start = i;
  let radix: 2 | 8 | 10 | 16 = 10;
  let digitsStart = i;
  if (text[i] === '0' && (text[i + 1] === 'x' || text[i + 1] === 'X')) {
    radix = 16;
    i += 2;
    digitsStart = i;
    while (/[0-9a-fA-F]/.test(text[i] ?? '')) i++;
  } else if (text[i] === '0' && (text[i + 1] === 'b' || text[i + 1] === 'B') && /[01]/.test(text[i + 2] ?? '')) {
    radix = 2;
    i += 2;
    digitsStart = i;
    while (/[0-9]/.test(text[i] ?? '')) i++;
  } else {
    while (isDigit(text[i] ?? '')) i++;
    if (text[start] === '0' && i - start > 1) {
      radix = 8;
      digitsStart = start + 1;
    }
  }
  let isFloat = false;
  if ((radix === 10 || radix === 8) && (text[i] === '.' || text[i] === 'e' || text[i] === 'E')) {
    isFloat = true;
    if (text[i] === '.') {
      i++;
      while (isDigit(text[i] ?? '')) i++;
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') i++;
      while (isDigit(text[i] ?? '')) i++;
    }
  }
  const digits = text.slice(digitsStart, i);
  while (/[uUlLfF]/.test(text[i] ?? '')) i++;
  // Anything glued to the number (e.g. 0b102, 12abc) is a malformed literal.
  let bad = false;
  while (isIdentPart(text[i] ?? '')) {
    i++;
    bad = true;
  }
  if (isFloat) {
    emit(i, 0, 10, { code: Codes.UNSUPPORTED, message: 'Les nombres à virgule flottante ne sont pas supportés' });
    return i;
  }
  const valid = radix === 2 ? /^[01]+$/ : radix === 8 ? /^[0-7]+$/ : radix === 16 ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/;
  if (bad || !valid.test(digits)) {
    emit(i, 0, radix, { code: Codes.BAD_NUMBER, message: `Constante numérique invalide '${text.slice(start, i)}'` });
    return i;
  }
  const value = Number(BigInt(radix === 10 ? digits : `${radix === 16 ? '0x' : radix === 8 ? '0o' : '0b'}${digits}`) & 0xffffffffn);
  emit(i, value, radix);
  return i;
}

function scanQuoted(text: string, i: number, quote: string): { end: number; body: string; closed: boolean } {
  let j = i + 1;
  while (j < text.length && text[j] !== quote && text[j] !== '\n' && text[j] !== '\r') {
    if (text[j] === '\\') j++;
    j++;
  }
  const closed = text[j] === quote;
  return { end: closed ? j + 1 : j, body: text.slice(i + 1, j), closed };
}

/** Decode C escape sequences into character codes. */
export function decodeEscapes(body: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      out.push(body.charCodeAt(i));
      continue;
    }
    const e = body[++i];
    switch (e) {
      case 'n': out.push(10); break;
      case 't': out.push(9); break;
      case 'r': out.push(13); break;
      case 'a': out.push(7); break;
      case 'b': out.push(8); break;
      case 'f': out.push(12); break;
      case 'v': out.push(11); break;
      case 'x': {
        let hex = '';
        while (/[0-9a-fA-F]/.test(body[i + 1] ?? '') && hex.length < 2) hex += body[++i];
        out.push(parseInt(hex || '0', 16));
        break;
      }
      default:
        if (/[0-7]/.test(e ?? '')) {
          let oct = e;
          while (/[0-7]/.test(body[i + 1] ?? '') && oct.length < 3) oct += body[++i];
          out.push(parseInt(oct, 8) & 0xff);
        } else if (e !== undefined) {
          out.push(e.charCodeAt(0));
        }
    }
  }
  return out;
}
