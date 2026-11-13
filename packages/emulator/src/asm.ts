// Minimal MPASM-style assembler for the PIC16F84A: labels, ORG, EQU, DW, __CONFIG, END,
// SFR and bit names, W/F destinations and integer expressions with `$`.
// Default radix is decimal (MPASM's default is hex): write 0x1F, H'1F', B'0101', D'10' or 'A'.
import { encode, instructionInfo, type Mnemonic } from './isa';
import { BIT_SYMBOLS, DEFAULT_CONFIG, PROGRAM_WORDS, SFR } from './sfr';

export interface AsmDiagnostic {
  /** 1-based source line. */
  line: number;
  /** Message in French. */
  message: string;
}

export interface AsmResult {
  ok: boolean;
  /** 1024 words; 0x3FFF where nothing was assembled. */
  program: Uint16Array;
  config: number;
  errors: AsmDiagnostic[];
  labels: ReadonlyMap<string, number>;
  /** Program address → 1-based source line. */
  addrToLine: ReadonlyMap<number, number>;
}

const BUILTIN_SYMBOLS: ReadonlyMap<string, number> = new Map<string, number>([
  ['W', 0],
  ['F', 1],
  ...Object.entries(SFR),
  ...[...BIT_SYMBOLS].map(([name, { bit }]) => [name, bit] as [string, number]),
]);

const IGNORED_DIRECTIVES = new Set(['LIST', 'NOLIST', 'PROCESSOR', '#INCLUDE', 'INCLUDE', 'ERRORLEVEL', 'TITLE']);

class AsmError extends Error {}

// ---------------------------------------------------------------- expressions

type Token = { kind: 'num'; value: number } | { kind: 'id'; name: string } | { kind: 'op'; op: string };

const NUMBER_PATTERNS: readonly [RegExp, (m: RegExpExecArray) => number][] = [
  [/^0x([0-9a-f]+)/i, (m) => parseInt(m[1], 16)],
  [/^0b([01]+)/i, (m) => parseInt(m[1], 2)],
  [/^h'([0-9a-f]+)'/i, (m) => parseInt(m[1], 16)],
  [/^b'([01]+)'/i, (m) => parseInt(m[1], 2)],
  [/^d'([0-9]+)'/i, (m) => parseInt(m[1], 10)],
  [/^o'([0-7]+)'/i, (m) => parseInt(m[1], 8)],
  [/^a?'(.)'/i, (m) => m[1].charCodeAt(0) & 0xff],
  [/^\.([0-9]+)/, (m) => parseInt(m[1], 10)],
  [/^([0-9][0-9a-f]*)h\b/i, (m) => parseInt(m[1], 16)],
  [/^([0-9]+)/, (m) => parseInt(m[1], 10)],
];

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let rest = text.trim();
  outer: while (rest.length > 0) {
    for (const [re, value] of NUMBER_PATTERNS) {
      const m = re.exec(rest);
      if (m) {
        tokens.push({ kind: 'num', value: value(m) });
        rest = rest.slice(m[0].length).trimStart();
        continue outer;
      }
    }
    const id = /^(\$|[A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
    if (id) {
      tokens.push({ kind: 'id', name: id[1].toUpperCase() });
      rest = rest.slice(id[0].length).trimStart();
      continue;
    }
    const op = /^(<<|>>|[-+*/|&^~()])/.exec(rest);
    if (!op) throw new AsmError(`Caractère inattendu dans l'expression : '${rest[0]}'`);
    tokens.push({ kind: 'op', op: op[1] });
    rest = rest.slice(op[0].length).trimStart();
  }
  return tokens;
}

const BINARY_PRECEDENCE: Readonly<Record<string, number>> = {
  '|': 1, '^': 2, '&': 3, '<<': 4, '>>': 4, '+': 5, '-': 5, '*': 6, '/': 6,
};

function evaluate(text: string, lookup: (name: string) => number | undefined): number {
  const tokens = tokenize(text);
  if (tokens.length === 0) throw new AsmError('Opérande manquant.');
  let pos = 0;
  const primary = (): number => {
    const t = tokens[pos++];
    if (t === undefined) throw new AsmError('Expression incomplète.');
    if (t.kind === 'num') return t.value;
    if (t.kind === 'id') {
      const v = lookup(t.name);
      if (v === undefined) throw new AsmError(`Symbole non défini : ${t.name}`);
      return v;
    }
    if (t.op === '-') return -primary();
    if (t.op === '~') return ~primary();
    if (t.op === '(') {
      const v = binary(0);
      const close = tokens[pos++];
      if (close?.kind !== 'op' || close.op !== ')') throw new AsmError('Parenthèse fermante manquante.');
      return v;
    }
    throw new AsmError(`Opérateur inattendu : ${t.op}`);
  };
  const binary = (minPrec: number): number => {
    let left = primary();
    for (;;) {
      const t = tokens[pos];
      if (t?.kind !== 'op') break;
      const prec = BINARY_PRECEDENCE[t.op];
      if (prec === undefined || prec <= minPrec) break;
      pos++;
      const right = binary(prec);
      switch (t.op) {
        case '|': left |= right; break;
        case '^': left ^= right; break;
        case '&': left &= right; break;
        case '<<': left <<= right; break;
        case '>>': left >>= right; break;
        case '+': left += right; break;
        case '-': left -= right; break;
        case '*': left *= right; break;
        case '/':
          if (right === 0) throw new AsmError('Division par zéro.');
          left = Math.trunc(left / right);
          break;
      }
    }
    return left;
  };
  const value = binary(0);
  if (pos !== tokens.length) throw new AsmError('Expression mal formée.');
  return value;
}

// ---------------------------------------------------------------- source lines

interface SourceLine {
  line: number;
  label?: string;
  mnemonic?: string;
  operands: string[];
}

function stripComment(text: string): string {
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "'") inQuote = !inQuote;
    else if (text[i] === ';' && !inQuote) return text.slice(0, i);
  }
  return text;
}

function splitOperands(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  const parts: string[] = [];
  let depth = 0;
  let inQuote = false;
  let start = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === "'") inQuote = !inQuote;
    else if (!inQuote && c === '(') depth++;
    else if (!inQuote && c === ')') depth--;
    else if (!inQuote && depth === 0 && c === ',') {
      parts.push(trimmed.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(trimmed.slice(start).trim());
  return parts;
}

function isKeyword(word: string): boolean {
  const w = word.toUpperCase();
  return instructionInfo(w) !== undefined || ['ORG', 'END', 'DW', '__CONFIG', 'EQU'].includes(w) || IGNORED_DIRECTIVES.has(w);
}

function parseLine(text: string, line: number): SourceLine {
  const code = stripComment(text).replace(/\s+$/, '');
  const out: SourceLine = { line, operands: [] };
  const m = /^(\s*)([^\s,]+)?\s*(.*)$/.exec(code);
  if (!m || m[2] === undefined) return out;
  let first = m[2];
  let rest = m[3];
  const indented = m[1].length > 0;
  if (first.endsWith(':') || (!indented && !isKeyword(first))) {
    out.label = first.replace(/:$/, '').toUpperCase();
    const next = /^([^\s,]+)?\s*(.*)$/.exec(rest)!;
    if (next[1] === undefined) return out;
    first = next[1];
    rest = next[2];
  }
  out.mnemonic = first.toUpperCase();
  out.operands = splitOperands(rest);
  return out;
}

// ---------------------------------------------------------------- assembler

export function assemble(source: string): AsmResult {
  const lines = source.split(/\r\n|\n|\r/).map((text, i) => parseLine(text, i + 1));
  const errors: AsmDiagnostic[] = [];
  const symbols = new Map<string, number>();
  const labels = new Map<string, number>();
  const lookupWith = (here: number) => (name: string): number | undefined =>
    name === '$' ? here : symbols.get(name) ?? BUILTIN_SYMBOLS.get(name);

  // Pass 1: addresses of labels and EQU constants.
  let addr = 0;
  for (const l of lines) {
    try {
      if (l.mnemonic === 'END') break;
      if (l.mnemonic === 'EQU') {
        if (!l.label) throw new AsmError('EQU sans nom de symbole.');
        symbols.set(l.label, evaluate(l.operands[0] ?? '', lookupWith(addr)));
        continue;
      }
      if (l.label) {
        if (symbols.has(l.label)) throw new AsmError(`Étiquette déjà définie : ${l.label}`);
        symbols.set(l.label, addr);
        labels.set(l.label, addr);
      }
      if (l.mnemonic === 'ORG') addr = evaluate(l.operands[0] ?? '', lookupWith(addr));
      else if (l.mnemonic === 'DW') addr += Math.max(1, l.operands.length);
      else if (l.mnemonic !== undefined && instructionInfo(l.mnemonic)) addr++;
    } catch (e) {
      errors.push({ line: l.line, message: (e as Error).message });
    }
  }

  // Pass 2: encode.
  const program = new Uint16Array(PROGRAM_WORDS).fill(0x3fff);
  const addrToLine = new Map<number, number>();
  let config = DEFAULT_CONFIG;
  addr = 0;
  const emit = (word: number, line: number): void => {
    const at = addr++;
    if (at < 0 || at >= PROGRAM_WORDS) {
      throw new AsmError(`Adresse ${at} hors de la mémoire programme (0x000–0x3FF).`);
    }
    program[at] = word & 0x3fff;
    addrToLine.set(at, line);
  };
  for (const l of lines) {
    if (l.mnemonic === undefined || l.mnemonic === 'EQU') continue;
    if (l.mnemonic === 'END') break;
    const value = (text: string | undefined): number => evaluate(text ?? '', lookupWith(addr));
    try {
      if (l.mnemonic === 'ORG') addr = value(l.operands[0]);
      else if (l.mnemonic === '__CONFIG') config = value(l.operands[0]) & 0x3fff;
      else if (l.mnemonic === 'DW') for (const op of l.operands) emit(value(op), l.line);
      else if (IGNORED_DIRECTIVES.has(l.mnemonic)) continue;
      else emit(encodeLine(l, value), l.line);
    } catch (e) {
      errors.push({ line: l.line, message: (e as Error).message });
    }
  }
  return { ok: errors.length === 0, program, config, errors, labels, addrToLine };
}

function encodeLine(l: SourceLine, value: (text: string | undefined) => number): number {
  const mnemonic = l.mnemonic!;
  const meta = instructionInfo(mnemonic);
  if (!meta) throw new AsmError(`Instruction inconnue : ${mnemonic}`);
  const ops = l.operands;
  const expect = (min: number, max = min): void => {
    if (ops.length < min || ops.length > max) {
      throw new AsmError(`${mnemonic} attend ${min === max ? min : `${min} ou ${max}`} opérande(s), ${ops.length} donné(s).`);
    }
  };
  const inRange = (v: number, min: number, max: number, what: string): number => {
    if (v < min || v > max) throw new AsmError(`${what} hors limites : ${v}`);
    return v;
  };
  const register = (text: string | undefined): number => inRange(value(text), 0, 0xff, 'Adresse de registre');
  const m = mnemonic as Mnemonic;
  switch (meta.form) {
    case 'none':
      expect(0);
      return encode(m);
    case 'f':
      expect(1);
      return encode(m, register(ops[0]));
    case 'fd':
      expect(1, 2);
      return encode(m, register(ops[0]), ops.length === 2 ? inRange(value(ops[1]), 0, 1, 'Destination') : 1);
    case 'fb':
      expect(2);
      return encode(m, register(ops[0]), inRange(value(ops[1]), 0, 7, 'Numéro de bit'));
    case 'k8':
      expect(1);
      return encode(m, inRange(value(ops[0]), -128, 255, 'Littéral'));
    case 'k11':
      expect(1);
      return encode(m, inRange(value(ops[0]), 0, 0x1fff, 'Adresse de saut'));
    case 'tris':
      expect(1);
      return encode(m, inRange(register(ops[0]) & 0x7f, 5, 7, 'Registre TRIS'));
  }
}
