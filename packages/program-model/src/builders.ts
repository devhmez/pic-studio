// Small factories to write programs in TypeScript (templates, the assistant's blocks, tests).
// Statements are created with an empty id; call ensureIds() on the finished program to number them.
import type {
  ArithOp, AssignStmt, CallStmt, ClearFlagStmt, CodeStyle, CommentStmt, CompareOp, Cond, DecrStmt, DelayStmt,
  DisplayStmt, ElseBranch, Expr, FlagName, ForStmt, FunctionDef, IfBranch, IfStmt, IncrStmt, Level, LValue,
  Program, Radix, RawStmt, RepeatStmt, SetAllStmt, SetStmt, Stmt, StmtBase, ToggleStmt, WaitStmt, WhileStmt,
} from './types';
import { PROGRAM_VERSION } from './types';

/** Optional statement decorations: trailing comment, comment above, organigramme text. */
export type Extra = Partial<Pick<StmtBase, 'comment' | 'lead' | 'text'>>;

// ---------------------------------------------------------------------------------------------------------------
// Expressions

export const num = (value: number, radix?: Radix): Expr => (radix ? { kind: 'num', value, radix } : { kind: 'num', value });
export const hex = (value: number): Expr => num(value, 16);
export const bin = (value: number): Expr => num(value, 2);
export const v = (name: string): Extract<Expr, { kind: 'var' }> => ({ kind: 'var', name });
export const sig = (id: string): Extract<Expr, { kind: 'signal' }> => ({ kind: 'signal', id });
export const bus = (id: string): Extract<Expr, { kind: 'bus' }> => ({ kind: 'bus', id });
export const reg = (name: string, bit?: string): Extract<Expr, { kind: 'reg' }> =>
  (bit ? { kind: 'reg', name, bit } : { kind: 'reg', name });
export const op = (operator: ArithOp, left: Expr, right: Expr): Expr => ({ kind: 'bin', op: operator, left, right });
export const sub = (left: Expr, right: Expr): Expr => op('-', left, right);
export const add = (left: Expr, right: Expr): Expr => op('+', left, right);
export const rawExpr = (text: string): Expr => ({ kind: 'raw', text });

// ---------------------------------------------------------------------------------------------------------------
// Conditions

export const pin = (signal: string, value: Level = 1): Cond => ({ kind: 'pin', signal, value });
export const flag = (name: FlagName, value: Level = 1): Cond => ({ kind: 'flag', flag: name, value });
export const cmp = (left: Expr, operator: CompareOp, right: Expr): Cond => ({ kind: 'compare', left, op: operator, right });
export const and = (...items: Cond[]): Cond => ({ kind: 'and', items });
export const or = (...items: Cond[]): Cond => ({ kind: 'or', items });
export const not = (cond: Cond): Cond => ({ kind: 'not', cond });
export const rawCond = (text: string): Cond => ({ kind: 'raw', text });

// ---------------------------------------------------------------------------------------------------------------
// Statements

export const set = (signal: string, value: Level, extra?: Extra): SetStmt => ({ id: '', kind: 'set', signal, value, ...extra });
/** Pin to 1 (LED_ON). */
export const on = (signal: string, extra?: Extra): SetStmt => set(signal, 1, extra);
/** Pin to 0 (LED_OFF). */
export const off = (signal: string, extra?: Extra): SetStmt => set(signal, 0, extra);
export const setAll = (signals: string[], value: Level, extra?: Extra): SetAllStmt => ({ id: '', kind: 'setAll', signals, value, ...extra });
export const toggle = (signal: string, extra?: Extra): ToggleStmt => ({ id: '', kind: 'toggle', signal, ...extra });
export const display = (busId: string, value: number | Expr, extra?: Extra): DisplayStmt =>
  ({ id: '', kind: 'display', bus: busId, value: typeof value === 'number' ? hex(value) : value, ...extra });
export const assign = (target: LValue, value: number | Expr, extra?: Extra): AssignStmt =>
  ({ id: '', kind: 'assign', target, value: typeof value === 'number' ? num(value) : value, ...extra });
export const incr = (variable: string, extra?: Extra): IncrStmt => ({ id: '', kind: 'incr', variable, ...extra });
export const decr = (variable: string, extra?: Extra): DecrStmt => ({ id: '', kind: 'decr', variable, ...extra });
export const delay = (ms: number, extra?: Extra): DelayStmt => ({ id: '', kind: 'delay', ms, ...extra });
export const waitFor = (cond: Cond, extra?: Extra): WaitStmt => ({ id: '', kind: 'waitFor', cond, ...extra });
export const call = (name: string, extra?: Extra): CallStmt => ({ id: '', kind: 'call', name, ...extra });
export const clearFlag = (f: ClearFlagStmt['flag'], extra?: Extra): ClearFlagStmt => ({ id: '', kind: 'clearFlag', flag: f, ...extra });
export const comment = (text: string, extra?: Extra): CommentStmt => ({ id: '', kind: 'comment', text, ...extra });
export const raw = (code: string, extra?: Extra): RawStmt => ({ id: '', kind: 'raw', code, ...extra });

export type BranchExtra = Partial<Pick<IfBranch, 'comment' | 'note' | 'text'>>;

export const branch = (cond: Cond, body: Stmt[], extra: BranchExtra = {}): IfBranch => ({ id: '', cond, body, ...extra });
export const otherwise = (body: Stmt[], extra: Partial<Pick<ElseBranch, 'comment' | 'note'>> = {}): ElseBranch =>
  ({ id: '', body, ...extra });

/** if / else if … / else. */
export const ifChain = (branches: IfBranch[], elseBranch: ElseBranch | null = null, extra?: Extra): IfStmt =>
  ({ id: '', kind: 'if', branches, otherwise: elseBranch, ...extra });
/** A single `if (cond) { body }` with an optional else body. */
export const when = (cond: Cond, body: Stmt[], elseBody?: Stmt[], extra?: Extra & BranchExtra): IfStmt => {
  const { comment, note, text, lead } = extra ?? {};
  const b = branch(cond, body, { ...(comment ? { comment } : {}), ...(note ? { note } : {}), ...(text ? { text } : {}) });
  return ifChain([b], elseBody ? otherwise(elseBody) : null, lead ? { lead } : undefined);
};
export const whileLoop = (cond: Cond, body: Stmt[], extra?: Extra): WhileStmt => ({ id: '', kind: 'while', cond, body, ...extra });
export const repeat = (times: number, counter: string, body: Stmt[], extra?: Extra): RepeatStmt =>
  ({ id: '', kind: 'repeat', times, counter, body, ...extra });
export const forLoop = (init: AssignStmt, cond: Cond, update: ForStmt['update'], body: Stmt[], extra?: Extra): ForStmt =>
  ({ id: '', kind: 'for', init, cond, update, body, ...extra });

export const fn = (name: string, body: Stmt[], kind: FunctionDef['kind'] = 'function', lead?: string): FunctionDef =>
  ({ id: '', name, kind, body, ...(lead ? { lead } : {}) });
export const interrupt = (body: Stmt[], lead?: string): FunctionDef => fn('interrupt', body, 'interrupt', lead);

// ---------------------------------------------------------------------------------------------------------------
// Programs

/** The generator defaults (research §3.5): demux.c layout and section comments, LED_ON/LED_OFF macros. */
export function defaultStyle(): CodeStyle {
  return {
    bitNotation: 'pin',
    tris: { A: 'auto', B: 'auto' },
    macros: true,
    sections: 'demux',
    compactAssign: false,
    echoRegister: false,
    oneLineBranches: false,
    packLines: false,
  };
}

export function emptyProgram(title = 'Nouveau programme', clockHz = 1_000_000): Program {
  return {
    version: PROGRAM_VERSION,
    title,
    clockHz,
    style: defaultStyle(),
    signals: [],
    buses: [],
    constants: [],
    variables: [],
    init: [],
    loop: [],
    functions: [],
  };
}

const ID_RE = /^([a-z]+)(\d+)$/;

/**
 * Give every statement ('s<n>'), branch ('b<n>') and function ('f<n>') without an id a fresh one, in source order.
 * Existing ids are kept (and duplicates renumbered), so ids stay stable when a program is edited and re-saved.
 * Mutates and returns the program.
 */
export function ensureIds(program: Program): Program {
  const used = new Set<string>();
  const next: Record<string, number> = { s: 1, b: 1, f: 1 };
  const note = (id: string) => {
    used.add(id);
    const m = ID_RE.exec(id);
    if (m && m[1] in next) next[m[1]] = Math.max(next[m[1]], Number(m[2]) + 1);
  };
  const fresh = (prefix: 's' | 'b' | 'f') => {
    let id = `${prefix}${next[prefix]++}`;
    while (used.has(id)) id = `${prefix}${next[prefix]++}`;
    used.add(id);
    return id;
  };
  // First pass: collect existing ids (first occurrence wins).
  const seen = new Set<string>();
  const keep = (o: { id: string }) => {
    if (o.id && !seen.has(o.id)) { seen.add(o.id); note(o.id); } else o.id = '';
  };
  const collect = (list: Stmt[]) => {
    for (const s of list) {
      keep(s);
      if (s.kind === 'if') {
        for (const b of s.branches) { keep(b); collect(b.body); }
        if (s.otherwise) { keep(s.otherwise); collect(s.otherwise.body); }
      } else if (s.kind === 'while' || s.kind === 'repeat' || s.kind === 'for') {
        if (s.kind === 'for') { keep(s.init); keep(s.update); }
        collect(s.body);
      }
    }
  };
  // Second pass: number the blanks in source order.
  const fill = (list: Stmt[]) => {
    for (const s of list) {
      if (!s.id) s.id = fresh('s');
      if (s.kind === 'if') {
        for (const b of s.branches) { if (!b.id) b.id = fresh('b'); fill(b.body); }
        if (s.otherwise) { if (!s.otherwise.id) s.otherwise.id = fresh('b'); fill(s.otherwise.body); }
      } else if (s.kind === 'while' || s.kind === 'repeat' || s.kind === 'for') {
        if (s.kind === 'for') {
          if (!s.init.id) s.init.id = fresh('s');
          if (!s.update.id) s.update.id = fresh('s');
        }
        fill(s.body);
      }
    }
  };
  for (const f of program.functions) keep(f);
  collect(program.init);
  if (program.loop) collect(program.loop);
  for (const f of program.functions) collect(f.body);
  for (const f of program.functions) if (!f.id) f.id = fresh('f');
  fill(program.init);
  if (program.loop) fill(program.loop);
  for (const f of program.functions) fill(f.body);
  return program;
}
