// Helpers over the compiler's typed AST (@pic/compiler): statements at a source line with the conditions that lead
// to them, what a statement writes (register, register bit, variable), and a small evaluator for conditions.
// Node texts are the ORIGINAL source (before macro expansion) and `macro` names the #define that produced a node,
// so `LED_ON(LED_EGAL);` is seen as `PORTB.F1 = 1` written through the alias LED_EGAL.
import {
  BIT_NAMES, findSfr, resolveBitSelector,
  type BitName, type Expression, type FunctionDeclaration, type IfStatement, type Statement, type TranslationUnit,
} from '@pic/compiler';
import { ADDR } from './cpu';

/** HI-TECH / XC8 bare bit names (`RB0`, `TRISA0`, `CARRY`, `ZERO`), valid only with `#include <htc.h>`. */
function hitechBit(upper: string): BitName | undefined {
  if (upper === 'CARRY') return { bit: 0, reg: 'STATUS' };
  if (upper === 'ZERO') return { bit: 2, reg: 'STATUS' };
  if (upper === 'C' || upper === 'Z') return undefined;
  return BIT_NAMES.get(upper);
}

// ---------------------------------------------------------------------------------------------------------------
// Walking

export interface PathCond {
  /** Condition as written. */
  test: Expression;
  /** Value the condition must have for the statement to run. */
  value: boolean;
  kind: 'if' | 'while' | 'for' | 'do';
  /** The if / loop statement that owns the condition. */
  owner: Statement;
}

export interface StmtVisit {
  stmt: Statement;
  fn: FunctionDeclaration;
  /** Conditions from the outermost to the innermost (else-if chains give « A faux, B vrai »). */
  path: PathCond[];
  /** Statement list holding `stmt` (null for a statement used directly as a branch body). */
  list: Statement[] | null;
  index: number;
  /** Innermost enclosing loop. */
  loop: Statement | null;
  /** Outermost if of the else-if chain `stmt` belongs to as an `else if` (null otherwise). */
  chainHead: IfStatement | null;
  /** True for the top-level infinite loop body of main (`while(1)`), recursively. */
  inMainLoop: boolean;
}

/** Literal `1` / non-zero constant test: `while(1)`. */
export function isAlwaysTrue(e: Expression | null): boolean {
  if (!e) return true;
  return (e.kind === 'NumberLiteral' || e.kind === 'CharLiteral') && e.value !== 0;
}

/** Visit every statement of every function body, depth first, in source order. */
export function walkUnit(unit: TranslationUnit, visit: (v: StmtVisit) => void): void {
  for (const top of unit.body) {
    if (top.kind !== 'FunctionDeclaration' || !top.body) continue;
    const fn = top;
    const body = top.body;
    const rec = (stmt: Statement, path: PathCond[], list: Statement[] | null, index: number, loop: Statement | null, chainHead: IfStatement | null, inMainLoop: boolean) => {
      visit({ stmt, fn, path, list, index, loop, chainHead, inMainLoop });
      switch (stmt.kind) {
        case 'Block':
          stmt.body.forEach((s, i) => rec(s, path, stmt.body, i, loop, null, inMainLoop));
          break;
        case 'IfStatement': {
          const head = chainHead ?? stmt;
          rec(stmt.consequent, [...path, { test: stmt.test, value: true, kind: 'if', owner: stmt }], null, 0, loop, null, inMainLoop);
          if (stmt.alternate) {
            const alt = stmt.alternate;
            const altPath = [...path, { test: stmt.test, value: false, kind: 'if' as const, owner: stmt }];
            rec(alt, altPath, null, 0, loop, alt.kind === 'IfStatement' ? head : null, inMainLoop);
          }
          break;
        }
        case 'WhileStatement': {
          const infinite = isAlwaysTrue(stmt.test);
          const p = infinite ? path : [...path, { test: stmt.test, value: true, kind: 'while' as const, owner: stmt }];
          rec(stmt.body, p, null, 0, stmt, null, inMainLoop || (infinite && fn.name.toLowerCase() === 'main'));
          break;
        }
        case 'DoWhileStatement':
          rec(stmt.body, path, null, 0, stmt, null, inMainLoop);
          break;
        case 'ForStatement': {
          const p = stmt.test ? [...path, { test: stmt.test, value: true, kind: 'for' as const, owner: stmt }] : path;
          rec(stmt.body, p, null, 0, stmt, null, inMainLoop);
          break;
        }
        case 'SwitchStatement':
          for (const c of stmt.cases) c.consequent.forEach((s, i) => rec(s, path, c.consequent, i, loop, null, inMainLoop));
          break;
        default:
          break;
      }
    };
    rec(body, [], null, 0, null, null, false);
  }
}

/** Every visit, in source order. */
export function allVisits(unit: TranslationUnit): StmtVisit[] {
  const out: StmtVisit[] = [];
  walkUnit(unit, (v) => out.push(v));
  return out;
}

/** Statements (not blocks) starting on `line`, outermost first. */
export function visitsAtLine(unit: TranslationUnit, line: number): StmtVisit[] {
  return allVisits(unit).filter((v) => v.stmt.kind !== 'Block' && v.stmt.span.line === line);
}

/** Function whose body spans `line`. */
export function functionAtLine(unit: TranslationUnit, line: number): FunctionDeclaration | undefined {
  for (const top of unit.body) {
    if (top.kind === 'FunctionDeclaration' && top.body && top.span.line <= line && line <= top.span.endLine) return top;
  }
  return undefined;
}

/** Statements whose span covers `line` (blocks and control statements included), innermost last. */
export function enclosingVisits(unit: TranslationUnit, line: number): StmtVisit[] {
  return allVisits(unit).filter((v) => v.stmt.span.line <= line && line <= v.stmt.span.endLine);
}

/** The statement right before `stmt` in its list (the else-if chain head counts for its `else if`s). */
export function previousStatement(unit: TranslationUnit, stmt: Statement): Statement | null {
  const visits = allVisits(unit);
  const v = visits.find((x) => x.stmt === stmt);
  if (!v) return null;
  const anchor = v.chainHead ?? stmt;
  const av = anchor === stmt ? v : visits.find((x) => x.stmt === anchor);
  if (!av || !av.list || av.index === 0) return null;
  return av.list[av.index - 1] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Register / variable targets

export type Target =
  /** A special-function register, whole or one bit. `alias` is the #define / sbit name used in the code. */
  | { kind: 'reg'; name: string; addr: number; bit?: number; alias?: string }
  /** A C variable, whole or one bit. */
  | { kind: 'var'; name: string; bit?: number; alias?: string };

function sbitTargets(unit: TranslationUnit): Map<string, Target> {
  const out = new Map<string, Target>();
  const visitTop = (s: Statement | TranslationUnit['body'][number]) => {
    if (s.kind === 'SbitDeclaration' && s.target) {
      const t = targetOf(s.target, unit, false);
      if (t) out.set(s.name.toLowerCase(), { ...t, alias: s.name });
    }
  };
  unit.body.forEach(visitTop);
  walkUnit(unit, (v) => visitTop(v.stmt));
  return out;
}

const sbitCache = new WeakMap<TranslationUnit, Map<string, Target>>();

function sbits(unit: TranslationUnit): Map<string, Target> {
  let m = sbitCache.get(unit);
  if (!m) {
    m = new Map();
    sbitCache.set(unit, m); // set first: sbitTargets → targetOf → sbits must not recurse forever
    for (const [k, v] of sbitTargets(unit)) m.set(k, v);
  }
  return m;
}

/** Name of the #define the node came from, when it is a plain alias (not the function-like macro of a statement). */
function aliasOf(e: Expression): string | undefined {
  return e.macro && /^[A-Za-z_]\w*$/.test(e.text.trim()) ? e.macro : undefined;
}

/** What an lvalue (or a read) designates: `PORTB.F1`, `LED_EGAL`, `TRISA.RA0`, `x`, `STATUS.Z`, `RB0_bit`… */
export function targetOf(e: Expression, unit?: TranslationUnit, useSbits = true): Target | null {
  if (e.kind === 'BitAccess') {
    const bit = resolveBitSelector(e.bit);
    if (bit === undefined) return null;
    const obj = e.object;
    if (obj.kind !== 'Identifier') return null;
    const sfr = findSfr(obj.name);
    const alias = aliasOf(e);
    if (sfr) return { kind: 'reg', name: sfr.name, addr: sfr.addr, bit, alias };
    return { kind: 'var', name: obj.name, bit, alias };
  }
  if (e.kind === 'Identifier') {
    const alias = aliasOf(e);
    const sfr = findSfr(e.name);
    if (sfr) return { kind: 'reg', name: sfr.name, addr: sfr.addr, alias };
    const lower = e.name.toLowerCase();
    if (unit && useSbits) {
      const sb = sbits(unit).get(lower);
      if (sb) return sb;
    }
    const upper = e.name.toUpperCase();
    // MikroC `RB0_bit`, HI-TECH bare `RB0` / `CARRY` / `ZERO`.
    const bitVar = upper.endsWith('_BIT') ? BIT_NAMES.get(upper.slice(0, -4)) : unit?.dialect === 'hitech' ? hitechBit(upper) : undefined;
    if (bitVar) {
      const sfr2 = findSfr(bitVar.reg)!;
      return { kind: 'reg', name: sfr2.name, addr: sfr2.addr, bit: bitVar.bit, alias: alias ?? e.name };
    }
    return { kind: 'var', name: e.name, alias };
  }
  return null;
}

/** Text the student wrote for a target: the alias when there is one (`LED_EGAL`), else `PORTB.F1` / `x`. */
export function targetText(t: Target): string {
  if (t.alias) return t.alias;
  return t.bit === undefined ? t.name : `${t.name}.F${t.bit}`;
}

/** Assignments written by an expression statement (also `a = 1, b = 2` and `x++`). */
export interface Write {
  target: Target;
  /** Operator: '=', '+=', '++'… */
  op: string;
  /** Right-hand side (null for ++ / --). */
  value: Expression | null;
  expr: Expression;
}

export function writesOf(e: Expression, unit?: TranslationUnit): Write[] {
  switch (e.kind) {
    case 'AssignmentExpression': {
      const t = targetOf(e.left, unit);
      return t ? [{ target: t, op: e.operator, value: e.right, expr: e }] : [];
    }
    case 'UpdateExpression': {
      const t = targetOf(e.argument, unit);
      return t ? [{ target: t, op: e.operator, value: null, expr: e }] : [];
    }
    case 'SequenceExpression':
      return e.expressions.flatMap((x) => writesOf(x, unit));
    default:
      return [];
  }
}

/** Writes performed by a statement itself (not by its children). */
export function statementWrites(s: Statement, unit?: TranslationUnit): Write[] {
  if (s.kind === 'ExpressionStatement') return writesOf(s.expression, unit);
  if (s.kind === 'DeclarationStatement') {
    const out: Write[] = [];
    for (const d of s.declarations) {
      if (d.init && d.init.kind !== 'InitializerList') {
        out.push({ target: { kind: 'var', name: d.name }, op: '=', value: d.init, expr: d.init });
      }
    }
    return out;
  }
  return [];
}

/** Calls made by an expression statement (`Delay_ms(500)`, `clignoter()`). */
export function callOf(s: Statement): Extract<Expression, { kind: 'CallExpression' }> | null {
  if (s.kind !== 'ExpressionStatement') return null;
  return s.expression.kind === 'CallExpression' ? s.expression : null;
}

/** Same register (bank mirrors are canonical in the compiler's table). */
export function sameReg(t: Target, addr: number): boolean {
  return t.kind === 'reg' && t.addr === addr;
}

// ---------------------------------------------------------------------------------------------------------------
// Evaluation

/** Values the evaluator may read. Every lookup may answer undefined (unknown). */
export interface EvalEnv {
  /** Whole special register (bank-mapped address). */
  reg(addr: number): number | undefined;
  /** One bit of a special register (lets partially known ports be tested). */
  bit?(addr: number, bit: number): 0 | 1 | undefined;
  variable(name: string): number | undefined;
}

/** STATUS flags known from the computation that sets them (z = x − y), overriding the register. */
export interface FlagValues { C?: 0 | 1; DC?: 0 | 1; Z?: 0 | 1 }

const STATUS_FLAG_BITS: Readonly<Record<number, keyof FlagValues>> = { 0: 'C', 1: 'DC', 2: 'Z' };

function readTarget(t: Target, env: EvalEnv, flags?: FlagValues): number | undefined {
  if (t.kind === 'reg') {
    if (t.bit !== undefined) {
      if (t.addr === ADDR.STATUS && flags) {
        const f = STATUS_FLAG_BITS[t.bit];
        if (f && flags[f] !== undefined) return flags[f];
      }
      const b = env.bit?.(t.addr, t.bit);
      if (b !== undefined) return b;
      const v = env.reg(t.addr);
      return v === undefined ? undefined : (v >> t.bit) & 1;
    }
    return env.reg(t.addr);
  }
  const v = env.variable(t.name);
  if (v === undefined) return undefined;
  return t.bit === undefined ? v : (v >> t.bit) & 1;
}

const u8 = (v: number) => v & 0xff;

/** Value of an expression with 8-bit unsigned arithmetic (the course's `unsigned char`), or undefined if unknown. */
export function evaluate(e: Expression, env: EvalEnv, unit?: TranslationUnit, flags?: FlagValues): number | undefined {
  const ev = (x: Expression) => evaluate(x, env, unit, flags);
  switch (e.kind) {
    case 'NumberLiteral': case 'CharLiteral': return e.value;
    case 'Identifier': case 'BitAccess': {
      const t = targetOf(e, unit);
      return t ? readTarget(t, env, flags) : undefined;
    }
    case 'UnaryExpression': {
      const a = ev(e.argument);
      if (a === undefined) return undefined;
      switch (e.operator) {
        case '!': return a === 0 ? 1 : 0;
        case '~': return u8(~a);
        case '-': return u8(-a);
        case '+': return a;
        default: return undefined;
      }
    }
    case 'BinaryExpression': {
      const a = ev(e.left);
      const b = ev(e.right);
      if (a === undefined || b === undefined) return undefined;
      switch (e.operator) {
        case '+': return u8(a + b);
        case '-': return u8(a - b);
        case '*': return u8(a * b);
        case '/': return b === 0 ? undefined : u8(Math.trunc(a / b));
        case '%': return b === 0 ? undefined : u8(a % b);
        case '<<': return u8(a << b);
        case '>>': return a >> b;
        case '&': return a & b;
        case '|': return a | b;
        case '^': return a ^ b;
        case '==': return a === b ? 1 : 0;
        case '!=': return a !== b ? 1 : 0;
        case '<': return a < b ? 1 : 0;
        case '>': return a > b ? 1 : 0;
        case '<=': return a <= b ? 1 : 0;
        case '>=': return a >= b ? 1 : 0;
      }
      return undefined;
    }
    case 'LogicalExpression': {
      const a = ev(e.left);
      if (e.operator === '&&') {
        if (a === 0) return 0;
        const b = ev(e.right);
        if (b === 0) return 0;
        return a === undefined || b === undefined ? undefined : 1;
      }
      if (a !== undefined && a !== 0) return 1;
      const b = ev(e.right);
      if (b !== undefined && b !== 0) return 1;
      return a === undefined || b === undefined ? undefined : 0;
    }
    case 'ConditionalExpression': {
      const t = ev(e.test);
      if (t === undefined) return undefined;
      return t ? ev(e.consequent) : ev(e.alternate);
    }
    case 'CastExpression': {
      const a = ev(e.argument);
      return a === undefined ? undefined : u8(a);
    }
    default:
      return undefined;
  }
}

/** Truth of a condition: true / false / undefined (unknown). */
export function truth(e: Expression, env: EvalEnv, unit?: TranslationUnit, flags?: FlagValues): boolean | undefined {
  const v = evaluate(e, env, unit, flags);
  return v === undefined ? undefined : v !== 0;
}

/** STATUS flags read by a condition (`STATUS.F2`, `STATUS.Z`, `ZERO`…). */
export function flagsRead(e: Expression, unit?: TranslationUnit): Set<keyof FlagValues> {
  const out = new Set<keyof FlagValues>();
  const rec = (x: Expression) => {
    if (x.kind === 'BitAccess' || x.kind === 'Identifier') {
      const t = targetOf(x, unit);
      if (t?.kind === 'reg' && t.addr === ADDR.STATUS && t.bit !== undefined && STATUS_FLAG_BITS[t.bit]) out.add(STATUS_FLAG_BITS[t.bit]);
      if (x.kind === 'BitAccess') rec(x.object);
      return;
    }
    switch (x.kind) {
      case 'UnaryExpression': rec(x.argument); break;
      case 'BinaryExpression': case 'LogicalExpression': rec(x.left); rec(x.right); break;
      case 'ConditionalExpression': rec(x.test); rec(x.consequent); rec(x.alternate); break;
      case 'CastExpression': rec(x.argument); break;
      default: break;
    }
  };
  rec(e);
  return out;
}

/** The arithmetic that sets the flags tested by an if: `z = x - y;` right before it. */
export interface FlagSource {
  stmt: Statement;
  op: '+' | '-';
  left: Expression;
  right: Expression;
  /** Values when known. */
  a?: number;
  b?: number;
  flags?: FlagValues;
}

/** Flags of an 8-bit `a op b` (SUBWF semantics: C and DC are NOT borrow). */
export function arithmeticFlags(op: '+' | '-', a: number, b: number): Required<FlagValues> {
  if (op === '+') {
    const s = a + b;
    return { C: s > 0xff ? 1 : 0, DC: (a & 0xf) + (b & 0xf) > 0xf ? 1 : 0, Z: (s & 0xff) === 0 ? 1 : 0 };
  }
  return { C: a >= b ? 1 : 0, DC: (a & 0xf) >= (b & 0xf) ? 1 : 0, Z: ((a - b) & 0xff) === 0 ? 1 : 0 };
}

/**
 * The statement whose subtraction / addition sets the STATUS flags an if (or else-if) tests, when it is the
 * statement right before the if chain (the course's pattern `z = x - y; if (STATUS.F2 == 1) …`).
 */
export function flagSourceFor(unit: TranslationUnit, ifStmt: Statement, env?: EvalEnv): FlagSource | null {
  const prev = previousStatement(unit, ifStmt);
  if (!prev || prev.kind !== 'ExpressionStatement') return null;
  const e = prev.expression;
  let op: '+' | '-' | null = null;
  let left: Expression | null = null;
  let right: Expression | null = null;
  if (e.kind === 'AssignmentExpression' && e.operator === '=' && e.right.kind === 'BinaryExpression' && (e.right.operator === '-' || e.right.operator === '+')) {
    op = e.right.operator;
    left = e.right.left;
    right = e.right.right;
  } else if (e.kind === 'AssignmentExpression' && (e.operator === '-=' || e.operator === '+=')) {
    op = e.operator === '-=' ? '-' : '+';
    left = e.left;
    right = e.right;
  }
  if (!op || !left || !right) return null;
  const src: FlagSource = { stmt: prev, op, left, right };
  // `x -= y` or `x = x - y` overwrites an operand: recomputing with the values now would use the result instead of
  // the operand (5 − 5 → x = 0, then « 0 − 5 »). The flags then come from STATUS itself (env), not from a guess.
  const assigned = e.kind === 'AssignmentExpression' ? exprText(e.left).toLowerCase() : null;
  const selfWrite = e.kind === 'AssignmentExpression' && (e.operator !== '=' || [left, right].some((x) => exprText(x).toLowerCase() === assigned));
  if (env && !selfWrite) {
    const a = evaluate(left, env, unit);
    const b = evaluate(right, env, unit);
    if (a !== undefined && b !== undefined) {
      src.a = a;
      src.b = b;
      src.flags = arithmeticFlags(op, a, b);
    }
  }
  return src;
}

/** Source text of an expression with the student's names (`STATUS.F2 == 1`, `L1 == 0 && L0 == 0`). */
export function exprText(e: Expression): string {
  return e.text.replace(/\s+/g, ' ').trim();
}

/** Text of a statement's first line (`if (STATUS.F2 == 1) { LED_ON(LED_EGAL); }` → as written on that line). */
export function lineText(source: string, line: number): string {
  return (source.split(/\r\n?|\n/)[line - 1] ?? '').trim();
}
