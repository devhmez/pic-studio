import type { Dialect, IncludeDirective, MacroDefinition, Span } from './ast';
import { Codes, type DiagnosticBag } from './diagnostics';
import type { LexResult, Token } from './lexer';
import { EMPTY_SPAN, unionSpan } from './span';

export interface PreprocessOptions {
  clockHz: number;
}

export interface PreprocessResult {
  /** Expanded token stream for the parser (ends with 'eof'). */
  tokens: Token[];
  macros: MacroDefinition[];
  includes: IncludeDirective[];
  dialect: Dialect;
  /** Value of `_XTAL_FREQ` when the program defines it (HI-TECH/XC8 delays). */
  xtalFreq?: number;
  /** Physical lines occupied by preprocessor directives. */
  directiveLines: Set<number>;
}

interface Macro {
  name: string;
  params: string[] | null;
  body: Token[];
  record: MacroDefinition | null;
}

interface CondFrame {
  /** Whether the enclosing region is active. */
  parentActive: boolean;
  /** Whether the current branch is active. */
  active: boolean;
  /** Whether some branch of this #if chain has been taken. */
  taken: boolean;
  sawElse: boolean;
  span: Span;
}

const HITECH_HEADERS = new Set(['htc.h', 'xc.h', 'pic.h']);

function synthetic(value: string, kind: Token['kind'] = 'number', num?: number): Token {
  return { kind, value, num, span: EMPTY_SPAN, logicalLine: 0, atLineStart: false, spaceBefore: true };
}

export function preprocess(lexed: LexResult, opts: PreprocessOptions, diags: DiagnosticBag): PreprocessResult {
  return new Preprocessor(lexed, opts, diags).run();
}

class Preprocessor {
  private readonly macros = new Map<string, Macro>();
  private readonly records: MacroDefinition[] = [];
  private readonly includes: IncludeDirective[] = [];
  private readonly directiveLines = new Set<number>();
  private dialect: Dialect = 'mikroc';
  private xtalFreq: number | undefined;
  private readonly output: Token[] = [];
  private pending: Token[] = [];
  private readonly conds: CondFrame[] = [];

  constructor(
    private readonly lexed: LexResult,
    opts: PreprocessOptions,
    private readonly diags: DiagnosticBag,
  ) {
    const fosc = Math.round(opts.clockHz / 1000);
    this.definePredefined('P16F84A', '1', 1);
    this.definePredefined('__FOSC__', String(fosc), fosc);
    this.definePredefined('__MIKROC_PRO_FOR_PIC__', '1', 1);
  }

  private definePredefined(name: string, text: string, num: number): void {
    this.macros.set(name, { name, params: null, body: [synthetic(text, 'number', num)], record: null });
  }

  private get active(): boolean {
    return this.conds.length === 0 || this.conds[this.conds.length - 1].active;
  }

  run(): PreprocessResult {
    const toks = this.lexed.tokens;
    let i = 0;
    while (i < toks.length) {
      const t = toks[i];
      if (t.kind === 'eof') break;
      if (t.kind === 'punct' && t.value === '#' && t.atLineStart) {
        let j = i + 1;
        while (toks[j].kind !== 'eof' && toks[j].logicalLine === t.logicalLine) j++;
        const line = toks.slice(i, j);
        for (let l = t.span.line; l <= line[line.length - 1].span.endLine; l++) this.directiveLines.add(l);
        this.flush();
        this.directive(line);
        i = j;
        continue;
      }
      if (this.active) {
        this.reportLiteralErrors([t]);
        this.pending.push(t);
      }
      i++;
    }
    this.flush();
    for (const c of this.conds) this.diags.error(Codes.PREPROCESSOR, '#endif manquant', c.span);
    const eof = toks[toks.length - 1];
    this.output.push(eof);
    return {
      tokens: this.output,
      macros: this.records,
      includes: this.includes,
      dialect: this.dialect,
      xtalFreq: this.xtalFreq,
      directiveLines: this.directiveLines,
    };
  }

  /** Literal errors found by the lexer, for tokens that are part of active code or of an evaluated directive. */
  private reportLiteralErrors(toks: Token[]): void {
    for (const t of toks) if (t.error) this.diags.error(t.error.code, t.error.message, t.span);
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    for (const t of this.expand(this.pending)) {
      if (t.kind === 'other') this.diags.error(Codes.INVALID_CHAR, `Caractère invalide '${t.value}'`, t.span);
      else this.output.push(t);
    }
    this.pending = [];
  }

  // ---------------------------------------------------------------------------------------------------------
  // Directives

  private directive(line: Token[]): void {
    const hash = line[0];
    const nameTok = line[1];
    const rest = line.slice(2);
    const span = unionSpan(hash.span, line[line.length - 1].span);
    if (!nameTok) return; // null directive '#'
    const name = nameTok.value;

    // Conditionals are processed even in inactive regions (for nesting).
    switch (name) {
      case 'ifdef':
      case 'ifndef': {
        const id = rest[0];
        const parentActive = this.active;
        let cond = false;
        if (parentActive) this.reportLiteralErrors(rest);
        if (!id || id.kind !== 'ident') {
          if (parentActive) this.diags.error(Codes.PREPROCESSOR, `#${name} : nom de macro attendu`, span);
        } else {
          cond = this.macros.has(id.value) === (name === 'ifdef');
        }
        this.conds.push({ parentActive, active: parentActive && cond, taken: cond, sawElse: false, span });
        return;
      }
      case 'if': {
        const parentActive = this.active;
        if (parentActive) this.reportLiteralErrors(rest);
        const cond = parentActive ? this.evalCondition(rest, span) : false;
        this.conds.push({ parentActive, active: parentActive && cond, taken: cond, sawElse: false, span });
        return;
      }
      case 'elif': {
        const top = this.conds[this.conds.length - 1];
        if (!top || top.sawElse) {
          this.diags.error(Codes.PREPROCESSOR, '#elif sans #if correspondant', span);
          return;
        }
        if (top.taken || !top.parentActive) {
          top.active = false;
        } else {
          this.reportLiteralErrors(rest);
          const cond = this.evalCondition(rest, span);
          top.active = cond;
          top.taken = cond;
        }
        return;
      }
      case 'else': {
        const top = this.conds[this.conds.length - 1];
        if (!top || top.sawElse) {
          this.diags.error(Codes.PREPROCESSOR, '#else sans #if correspondant', span);
          return;
        }
        top.sawElse = true;
        top.active = top.parentActive && !top.taken;
        top.taken = true;
        return;
      }
      case 'endif':
        if (!this.conds.pop()) this.diags.error(Codes.PREPROCESSOR, '#endif sans #if correspondant', span);
        return;
    }

    if (!this.active) return;
    // The message of #error/#warning and the text of #pragma are free text, not C tokens.
    if (name !== 'error' && name !== 'warning' && name !== 'pragma') this.reportLiteralErrors(rest);

    switch (name) {
      case 'define':
        this.define(line, span);
        return;
      case 'undef': {
        const id = rest[0];
        if (!id || id.kind !== 'ident') {
          this.diags.error(Codes.PREPROCESSOR, '#undef : nom de macro attendu', span);
          return;
        }
        const m = this.macros.get(id.value);
        if (m?.record) m.record.undefinedAtLine = hash.span.line;
        this.macros.delete(id.value);
        return;
      }
      case 'include':
        this.include(rest, span);
        return;
      case 'pragma':
        this.diags.info(Codes.PRAGMA_IGNORED, '#pragma ignoré', span);
        return;
      case 'error':
        this.diags.error(Codes.PP_ERROR_DIRECTIVE, `#error ${this.textOf(rest)}`.trim(), span);
        return;
      case 'warning':
        this.diags.warning(Codes.PP_WARNING_DIRECTIVE, `#warning ${this.textOf(rest)}`.trim(), span);
        return;
      case 'line':
        return;
      default:
        this.diags.error(Codes.PREPROCESSOR, `Directive de préprocesseur inconnue '#${name}'`, span);
    }
  }

  private textOf(toks: Token[]): string {
    if (toks.length === 0) return '';
    return this.lexed.lines.text.slice(toks[0].span.start, toks[toks.length - 1].span.end);
  }

  /** Replacement text as written, with comments removed (each one acts as a single space) and lines joined. */
  private bodyText(body: Token[]): string {
    if (body.length === 0) return '';
    const start = body[0].span.start;
    const end = body[body.length - 1].span.end;
    const piece = (from: number, to: number) => this.lexed.lines.text.slice(from, to).replace(/\\\r?\n|\\\r/g, ' ');
    let out = '';
    let pos = start;
    for (const c of this.lexed.comments) {
      if (c.span.start < start || c.span.end > end) continue;
      out = `${(out + piece(pos, c.span.start).trimStart()).trimEnd()} `;
      pos = c.span.end;
    }
    return (out + piece(pos, end).trimStart()).trim();
  }

  private define(line: Token[], span: Span): void {
    const nameTok = line[2];
    if (!nameTok || nameTok.kind !== 'ident') {
      this.diags.error(Codes.PREPROCESSOR, '#define : nom de macro attendu', span);
      return;
    }
    let k = 3;
    let params: string[] | null = null;
    const open = line[k];
    if (open && open.kind === 'punct' && open.value === '(' && !open.spaceBefore) {
      params = [];
      k++;
      let ok = false;
      while (k < line.length) {
        const p = line[k];
        if (p.value === ')') {
          ok = true;
          k++;
          break;
        }
        if (p.kind === 'ident' || p.value === '...') params.push(p.value === '...' ? '__VA_ARGS__' : p.value);
        else if (p.value !== ',') break;
        k++;
      }
      if (!ok) {
        this.diags.error(Codes.PREPROCESSOR, `#define ${nameTok.value} : liste de paramètres invalide`, span);
        return;
      }
    }
    const body = line.slice(k);
    const bodyText = this.bodyText(body);
    const existing = this.macros.get(nameTok.value);
    if (existing && (existing.record === null || existing.record.body !== bodyText || JSON.stringify(existing.params) !== JSON.stringify(params))) {
      this.diags.warning(Codes.MACRO_REDEFINED, `Macro '${nameTok.value}' redéfinie`, nameTok.span);
    }
    const record: MacroDefinition = {
      name: nameTok.value,
      params,
      body: bodyText,
      line: line[0].span.line,
      span,
      leadingComments: [],
    };
    this.records.push(record);
    this.macros.set(nameTok.value, { name: nameTok.value, params, body, record });
    if (nameTok.value === '_XTAL_FREQ') {
      const v = this.evalExpression(this.expand(body), span);
      if (v !== null) this.xtalFreq = v;
    }
  }

  private include(rest: Token[], span: Span): void {
    let path = '';
    let system = false;
    if (rest[0]?.kind === 'string') {
      path = rest[0].value.slice(1, -1);
    } else if (rest[0]?.value === '<') {
      const close = rest.findIndex((t) => t.value === '>');
      if (close > 0) {
        path = this.lexed.lines.text.slice(rest[0].span.end, rest[close].span.start).trim();
        system = true;
      }
    }
    if (!path) {
      this.diags.error(Codes.PREPROCESSOR, '#include : nom de fichier attendu', span);
      return;
    }
    this.includes.push({ path, system, line: span.line, span });
    const base = path.toLowerCase().split(/[\\/]/).pop() ?? '';
    if (HITECH_HEADERS.has(base)) {
      this.dialect = 'hitech';
      return;
    }
    if (base === 'built_in.h') return;
    this.diags.warning(Codes.INCLUDE_IGNORED, `Fichier d'inclusion '${path}' ignoré`, span);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Macro expansion (C preprocessor rescanning with hide sets)

  expand(input: Token[]): Token[] {
    const out: Token[] = [];
    const stack = input.slice().reverse();
    while (stack.length > 0) {
      const t = stack.pop()!;
      if (t.kind !== 'ident' || t.hide?.has(t.value)) {
        out.push(t);
        continue;
      }
      const m = this.macros.get(t.value);
      if (!m) {
        out.push(t);
        continue;
      }
      if (m.params === null) {
        const repl = this.substitute(m, t, t.span, []);
        for (let k = repl.length - 1; k >= 0; k--) stack.push(repl[k]);
        continue;
      }
      const next = stack[stack.length - 1];
      if (!next || next.kind !== 'punct' || next.value !== '(') {
        out.push(t);
        continue;
      }
      stack.pop();
      const args: Token[][] = [[]];
      let depth = 0;
      let close: Token | undefined;
      while (stack.length > 0) {
        const a = stack.pop()!;
        if (a.kind === 'eof') break;
        if (a.kind === 'punct' && a.value === '(') depth++;
        if (a.kind === 'punct' && a.value === ')') {
          if (depth === 0) {
            close = a;
            break;
          }
          depth--;
        }
        if (a.kind === 'punct' && a.value === ',' && depth === 0 && !(m.params.includes('__VA_ARGS__') && args.length >= m.params.length)) {
          args.push([]);
          continue;
        }
        args[args.length - 1].push(a);
      }
      if (!close) {
        this.diags.error(Codes.PREPROCESSOR, `')' attendu dans l'appel de la macro '${m.name}'`, t.span);
        return out;
      }
      const span = unionSpan(t.span, close.span);
      const given = args.length === 1 && args[0].length === 0 ? 0 : args.length;
      if (given !== m.params.length) {
        this.diags.error(
          Codes.PREPROCESSOR,
          `La macro '${m.name}' attend ${m.params.length} argument(s), ${given} fourni(s)`,
          span,
        );
        continue;
      }
      const repl = this.substitute(m, t, span, args);
      for (let k = repl.length - 1; k >= 0; k--) stack.push(repl[k]);
    }
    return out;
  }

  private substitute(m: Macro, nameTok: Token, span: Span, args: Token[][]): Token[] {
    const hide = new Set(nameTok.hide ?? []);
    hide.add(m.name);
    const macroName = nameTok.macro ?? m.name;
    const paramIndex = (t: Token) => (t.kind === 'ident' && m.params ? m.params.indexOf(t.value) : -1);
    const clone = (t: Token): Token => ({ ...t, span, macro: macroName, hide, atLineStart: false, spaceBefore: true });
    const result: Token[] = [];
    const body = m.body;
    for (let k = 0; k < body.length; k++) {
      const b = body[k];
      // Stringizing: # param
      if (b.kind === 'punct' && b.value === '#' && k + 1 < body.length && paramIndex(body[k + 1]) >= 0) {
        const arg = args[paramIndex(body[k + 1])];
        const raw = arg.length ? this.lexed.lines.text.slice(arg[0].span.start, arg[arg.length - 1].span.end) : '';
        result.push({ ...clone(b), kind: 'string', value: JSON.stringify(raw) });
        k++;
        continue;
      }
      // Token pasting: a ## b
      if (b.kind === 'punct' && b.value === '##' && result.length > 0 && k + 1 < body.length) {
        const left = result.pop()!;
        const nextTok = body[k + 1];
        const pi = paramIndex(nextTok);
        const rightToks = pi >= 0 ? args[pi] : [nextTok];
        const glued = left.value + (rightToks[0]?.value ?? '');
        const isNum = /^[0-9]/.test(glued);
        result.push({
          ...clone(left),
          kind: isNum ? 'number' : 'ident',
          value: glued,
          num: isNum ? Number(glued) : undefined,
        });
        for (const r of rightToks.slice(1)) result.push(clone(r));
        k++;
        continue;
      }
      const pi = paramIndex(b);
      if (pi >= 0) {
        const pasted = body[k + 1]?.value === '##' || body[k - 1]?.value === '##';
        const arg = pasted ? args[pi] : this.expand(args[pi]);
        for (const a of arg) result.push({ ...a, hide: new Set([...(a.hide ?? []), ...hide]) });
        continue;
      }
      result.push(clone(b));
    }
    return result;
  }

  // ---------------------------------------------------------------------------------------------------------
  // #if expressions

  private evalCondition(toks: Token[], span: Span): boolean {
    const replaced: Token[] = [];
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      if (t.kind === 'ident' && t.value === 'defined') {
        let id = toks[k + 1];
        let skip = 1;
        if (id?.value === '(') {
          id = toks[k + 2];
          skip = toks[k + 3]?.value === ')' ? 3 : 2;
        }
        const val = id && id.kind === 'ident' && this.macros.has(id.value) ? 1 : 0;
        replaced.push({ ...t, kind: 'number', value: String(val), num: val });
        k += skip;
        continue;
      }
      replaced.push(t);
    }
    const v = this.evalExpression(this.expand(replaced), span);
    return v !== null && v !== 0;
  }

  private evalExpression(toks: Token[], span: Span): number | null {
    let pos = 0;
    const fail = (): never => {
      throw new Error('pp-expr');
    };
    const peek = () => toks[pos];
    const take = (v: string) => {
      if (peek()?.value === v && peek()?.kind === 'punct') {
        pos++;
        return true;
      }
      return false;
    };
    const primary = (): number => {
      const t = toks[pos++];
      if (!t) return fail();
      if (t.kind === 'number' || t.kind === 'char') return t.num ?? 0;
      if (t.kind === 'ident') return 0; // undefined identifiers evaluate to 0
      if (t.kind === 'punct') {
        if (t.value === '(') {
          const v = ternary();
          if (!take(')')) fail();
          return v;
        }
        if (t.value === '!') return primary() ? 0 : 1;
        if (t.value === '~') return ~primary();
        if (t.value === '-') return -primary();
        if (t.value === '+') return primary();
      }
      return fail();
    };
    const levels: string[][] = [
      ['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%'],
    ];
    const binary = (level: number): number => {
      if (level >= levels.length) return primary();
      let left = binary(level + 1);
      for (;;) {
        const op = peek();
        if (!op || op.kind !== 'punct' || !levels[level].includes(op.value)) return left;
        pos++;
        const right = binary(level + 1);
        left = applyPpOp(op.value, left, right);
      }
    };
    const ternary = (): number => {
      const c = binary(0);
      if (take('?')) {
        const a = ternary();
        if (!take(':')) fail();
        const b = ternary();
        return c ? a : b;
      }
      return c;
    };
    try {
      const v = ternary();
      if (pos !== toks.length) fail();
      return v;
    } catch {
      this.diags.error(Codes.PREPROCESSOR, 'Expression de préprocesseur invalide', span);
      return null;
    }
  }
}

function applyPpOp(op: string, a: number, b: number): number {
  switch (op) {
    case '||': return a || b ? 1 : 0;
    case '&&': return a && b ? 1 : 0;
    case '|': return a | b;
    case '^': return a ^ b;
    case '&': return a & b;
    case '==': return a === b ? 1 : 0;
    case '!=': return a !== b ? 1 : 0;
    case '<': return a < b ? 1 : 0;
    case '>': return a > b ? 1 : 0;
    case '<=': return a <= b ? 1 : 0;
    case '>=': return a >= b ? 1 : 0;
    case '<<': return a << b;
    case '>>': return a >> b;
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return b === 0 ? 0 : Math.trunc(a / b);
    case '%': return b === 0 ? 0 : a % b;
  }
  return 0;
}
