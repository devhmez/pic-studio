// Small C expression parser for the assistant's value fields (« var1 - var2 », « 0x0A », « compte + 1 »).
// Names are resolved against the program: variables and constants → var, #define pins → signal, buses → bus,
// PIC registers (PORTB, STATUS.F2…) → reg. Unknown names stay variables (validate() then reports them).
import type { ArithOp, Expr, Program, Radix } from '@pic/program-model';

export type ParseResult = { ok: true; expr: Expr } | { ok: false; error: string };

const REGISTERS = new Set([
  'PORTA', 'PORTB', 'TRISA', 'TRISB', 'STATUS', 'INTCON', 'OPTION_REG', 'TMR0', 'PCL', 'PCLATH', 'FSR', 'INDF',
  'EEDATA', 'EEADR', 'EECON1', 'EECON2', 'W',
]);

type Token =
  | { t: 'num'; value: number; radix: Radix }
  | { t: 'id'; text: string }
  | { t: 'op'; text: string }
  | { t: '('; } | { t: ')'; } | { t: '.'; };

const OPS = ['<<', '>>', '+', '-', '*', '/', '%', '&', '|', '^', '~', '!'];

function tokenize(text: string): Token[] | string {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c)) {
      const m = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]+)/.exec(text.slice(i))!;
      const lit = m[0];
      const lower = lit.toLowerCase();
      if (/[A-Za-z_]/.test(text[i + lit.length] ?? '')) return `Nombre mal écrit : « ${text.slice(i).split(/\s/)[0]} ».`;
      if (lower.startsWith('0x')) out.push({ t: 'num', value: parseInt(lower.slice(2), 16), radix: 16 });
      else if (lower.startsWith('0b')) out.push({ t: 'num', value: parseInt(lower.slice(2), 2), radix: 2 });
      else out.push({ t: 'num', value: parseInt(lit, 10), radix: 10 });
      i += lit.length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))!;
      out.push({ t: 'id', text: m[0] });
      i += m[0].length;
      continue;
    }
    if (c === '(' || c === ')' || c === '.') { out.push({ t: c }); i++; continue; }
    const op = OPS.find((o) => text.startsWith(o, i));
    if (op) { out.push({ t: 'op', text: op }); i += op.length; continue; }
    return `Caractère inattendu : « ${c} ».`;
  }
  return out;
}

const BINARY_LEVELS: readonly (readonly ArithOp[])[] = [
  ['|'], ['^'], ['&'], ['<<', '>>'], ['+', '-'], ['*', '/', '%'],
];

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[], private readonly program: Program) {}

  parse(): Expr {
    const e = this.binary(0);
    if (this.pos < this.tokens.length) throw new Error('Expression incomplète ou en trop après la fin.');
    return e;
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }

  private binary(level: number): Expr {
    if (level >= BINARY_LEVELS.length) return this.unary();
    let left = this.binary(level + 1);
    for (;;) {
      const t = this.peek();
      if (t?.t !== 'op' || !BINARY_LEVELS[level].includes(t.text as ArithOp)) return left;
      this.pos++;
      const right = this.binary(level + 1);
      left = { kind: 'bin', op: t.text as ArithOp, left, right };
    }
  }

  private unary(): Expr {
    const t = this.peek();
    if (t?.t === 'op' && (t.text === '-' || t.text === '~' || t.text === '!')) {
      this.pos++;
      const arg = this.unary();
      // « -5 » stays a unary minus on a number (the generator prints it back as -5).
      return { kind: 'unary', op: t.text, arg };
    }
    return this.primary();
  }

  private primary(): Expr {
    const t = this.tokens[this.pos++];
    if (!t) throw new Error('Valeur manquante.');
    if (t.t === 'num') return t.radix === 10 ? { kind: 'num', value: t.value } : { kind: 'num', value: t.value, radix: t.radix };
    if (t.t === '(') {
      const e = this.binary(0);
      if (this.tokens[this.pos++]?.t !== ')') throw new Error('Parenthèse fermante « ) » manquante.');
      return e;
    }
    if (t.t === 'id') {
      let bit: string | undefined;
      if (this.peek()?.t === '.') {
        this.pos++;
        const b = this.tokens[this.pos++];
        if (b?.t === 'id') bit = b.text;
        else if (b?.t === 'num') bit = String(b.value);
        else throw new Error(`Bit manquant après « ${t.text}. ».`);
      }
      return resolveName(this.program, t.text, bit);
    }
    throw new Error('Valeur attendue.');
  }
}

/** Resolve a name typed by the student (case-insensitive, like MikroC). */
export function resolveName(program: Program, name: string, bit?: string): Expr {
  const lower = name.toLowerCase();
  const upper = name.toUpperCase();
  if (bit !== undefined || REGISTERS.has(upper)) return bit !== undefined ? { kind: 'reg', name: upper, bit: bit.toUpperCase() } : { kind: 'reg', name: upper };
  const variable = program.variables.find((v) => v.name.toLowerCase() === lower) ?? program.constants.find((c) => c.name.toLowerCase() === lower);
  if (variable) return { kind: 'var', name: variable.name };
  const signal = program.signals.find((s) => s.name.toLowerCase() === lower);
  if (signal) return { kind: 'signal', id: signal.id };
  const bus = program.buses.find((b) => b.name.toLowerCase() === lower);
  if (bus) return { kind: 'bus', id: bus.id };
  return { kind: 'var', name };
}

/** Parse a value typed in an assistant field. Never throws. */
export function parseExpr(text: string, program: Program): ParseResult {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, error: 'Valeur vide.' };
  const tokens = tokenize(trimmed);
  if (typeof tokens === 'string') return { ok: false, error: tokens };
  try {
    return { ok: true, expr: new Parser(tokens, program).parse() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Expression non reconnue.' };
  }
}

/** Names the student can type (for <datalist> suggestions). */
export function expressionNames(program: Program): string[] {
  return [
    ...program.variables.map((v) => v.name),
    ...program.constants.map((c) => c.name),
    ...program.signals.map((s) => s.name),
    ...program.buses.map((b) => b.name),
  ];
}

/** Literal typed for a number field: '10', '0x0A', '0b0101' → value and radix (null when invalid). */
export function parseNumberLiteral(text: string): { value: number; radix: Radix } | null {
  const t = text.trim().toLowerCase();
  if (/^0x[0-9a-f]+$/.test(t)) return { value: parseInt(t.slice(2), 16), radix: 16 };
  if (/^0b[01]+$/.test(t)) return { value: parseInt(t.slice(2), 2), radix: 2 };
  if (/^-?[0-9]+$/.test(t)) return { value: parseInt(t, 10), radix: 10 };
  return null;
}
