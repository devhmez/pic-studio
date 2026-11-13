// Traversal helpers over statements, conditions and expressions.
import type { CompareOp, Cond, Expr, FunctionDef, Program, Stmt } from './types';

/** Where a statement list lives. */
export type BlockOwner = 'init' | 'loop' | { functionId: string };

export interface StmtVisit {
  stmt: Stmt;
  /** Enclosing block: init, main loop or a function. */
  owner: BlockOwner;
  /** Nesting depth inside the owner (0 = top level of init / loop / function body). */
  depth: number;
  /** Ids of the enclosing statements and branches, outermost first. */
  path: string[];
}

/** Statement lists directly nested in a statement (branches, loop bodies). */
export function childBlocks(stmt: Stmt): Stmt[][] {
  switch (stmt.kind) {
    case 'if': return [...stmt.branches.map((b) => b.body), ...(stmt.otherwise ? [stmt.otherwise.body] : [])];
    case 'while':
    case 'repeat':
    case 'for':
      return [stmt.body];
    default:
      return [];
  }
}

/** Depth-first, in source order, through every statement of `list`. Return false from `fn` to skip children. */
export function walkStmts(list: readonly Stmt[], fn: (stmt: Stmt, depth: number, path: string[]) => boolean | void, depth = 0, path: string[] = []): void {
  for (const s of list) {
    if (fn(s, depth, path) === false) continue;
    if (s.kind === 'if') {
      for (const b of s.branches) walkStmts(b.body, fn, depth + 1, [...path, s.id, b.id]);
      if (s.otherwise) walkStmts(s.otherwise.body, fn, depth + 1, [...path, s.id, s.otherwise.id]);
    } else {
      for (const block of childBlocks(s)) walkStmts(block, fn, depth + 1, [...path, s.id]);
    }
  }
}

/** Every statement of the program: init, loop, then each function, depth-first in source order. */
export function forEachStmt(program: Program, fn: (visit: StmtVisit) => void): void {
  const run = (list: readonly Stmt[], owner: BlockOwner) =>
    walkStmts(list, (stmt, depth, path) => { fn({ stmt, owner, depth, path }); });
  run(program.init, 'init');
  if (program.loop) run(program.loop, 'loop');
  for (const f of program.functions) run(f.body, { functionId: f.id });
}

export function allStmts(program: Program): Stmt[] {
  const out: Stmt[] = [];
  forEachStmt(program, (v) => out.push(v.stmt));
  return out;
}

export function findStmt(program: Program, id: string): StmtVisit | undefined {
  let found: StmtVisit | undefined;
  forEachStmt(program, (v) => { if (!found && v.stmt.id === id) found = v; });
  return found;
}

export function findFunction(program: Program, name: string): FunctionDef | undefined {
  return program.functions.find((f) => f.name.toLowerCase() === name.toLowerCase());
}

export function interruptRoutine(program: Program): FunctionDef | undefined {
  return program.functions.find((f) => f.kind === 'interrupt');
}

/** Visit every sub-expression (pre-order). */
export function walkExpr(e: Expr, fn: (e: Expr) => void): void {
  fn(e);
  if (e.kind === 'bin') { walkExpr(e.left, fn); walkExpr(e.right, fn); }
  else if (e.kind === 'unary') walkExpr(e.arg, fn);
}

/** Visit every condition node and every expression inside it. */
export function walkCond(c: Cond, onCond: (c: Cond) => void, onExpr: (e: Expr) => void = () => {}): void {
  onCond(c);
  switch (c.kind) {
    case 'and':
    case 'or':
      c.items.forEach((x) => walkCond(x, onCond, onExpr));
      break;
    case 'not':
      walkCond(c.cond, onCond, onExpr);
      break;
    case 'compare':
      walkExpr(c.left, onExpr);
      walkExpr(c.right, onExpr);
      break;
    default:
      break;
  }
}

/** Conditions written directly on a statement (not in nested statements). */
export function stmtConds(s: Stmt): Cond[] {
  switch (s.kind) {
    case 'if': return s.branches.map((b) => b.cond);
    case 'while':
    case 'waitFor':
    case 'for':
      return [s.cond];
    default:
      return [];
  }
}

/** Expressions written directly on a statement (assignment sides, displayed values…). */
export function stmtExprs(s: Stmt): Expr[] {
  switch (s.kind) {
    case 'display': return [s.value];
    case 'assign': return [s.target, s.value];
    case 'for': return [...stmtExprs(s.init), ...stmtExprs(s.update)];
    default: return [];
  }
}

const NEGATED_OP: Readonly<Record<CompareOp, CompareOp>> = {
  '==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>',
};

/**
 * Logical negation, kept readable: `L0 == 1` ↔ `L0 == 0`, `a < b` ↔ `a >= b`, De Morgan on and/or.
 * An involution: negateCond(negateCond(c)) deep-equals c.
 */
export function negateCond(c: Cond): Cond {
  switch (c.kind) {
    case 'pin': return { ...c, value: c.value === 1 ? 0 : 1 };
    case 'flag': return { ...c, value: c.value === 1 ? 0 : 1 };
    case 'compare': return { ...c, op: NEGATED_OP[c.op] };
    case 'and': return { kind: 'or', items: c.items.map(negateCond) };
    case 'or': return { kind: 'and', items: c.items.map(negateCond) };
    case 'not': return c.cond;
    case 'raw': return { kind: 'not', cond: c };
  }
}

/** Names of the variables an expression or condition reads. */
export function exprVariables(e: Expr, out = new Set<string>()): Set<string> {
  walkExpr(e, (x) => { if (x.kind === 'var') out.add(x.name); });
  return out;
}

/** Variables written or read by a statement itself (not its children). */
export function stmtVariables(s: Stmt): Set<string> {
  const out = new Set<string>();
  for (const e of stmtExprs(s)) exprVariables(e, out);
  for (const c of stmtConds(s)) walkCond(c, () => {}, (e) => exprVariables(e, out));
  if (s.kind === 'incr' || s.kind === 'decr') out.add(s.variable);
  if (s.kind === 'repeat') out.add(s.counter);
  if (s.kind === 'for' && (s.update.kind === 'incr' || s.update.kind === 'decr')) out.add(s.update.variable);
  return out;
}
