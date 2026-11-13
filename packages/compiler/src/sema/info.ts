import type {
  BinaryOperator, BitAccess, CallExpression, CType, Expression, FunctionDeclaration, Identifier, IntType,
  SbitDeclaration, VariableDeclaration,
} from '../ast';
import type { FuncSymbol, SbitSymbol, Symbol, VarSymbol } from './symbols';
import { fitsPattern, fitsStrict, I16, typeOfConstant, U8, unify, widenFor, wrap } from './types';

export interface ExprInfo {
  type: CType;
  /** Compile-time constant value, already wrapped to `type`. */
  value?: number;
  /** Result of a comparison, a logical operator or a bit (always 0 or 1). */
  isBool?: boolean;
  /** Constant data address from `&REG` (Button's port argument). */
  address?: number;
}

export interface Semantics {
  exprs: Map<Expression, ExprInfo>;
  symbols: Map<Identifier, Symbol>;
  /** Bit position selected by each `X.bit` expression. */
  bits: Map<BitAccess, number>;
  calls: Map<CallExpression, FuncSymbol>;
  decls: Map<VariableDeclaration, VarSymbol>;
  sbits: Map<SbitDeclaration, SbitSymbol>;
  fnOf: Map<FunctionDeclaration, FuncSymbol>;
  /** Defined user functions, in source order. */
  functions: FuncSymbol[];
  /** Globals and static locals (RAM or ROM), in declaration order. */
  globals: VarSymbol[];
  main: FuncSymbol | null;
  isr: FuncSymbol | null;
}

/** Operators whose constant operands may be used as bit patterns (`x & ~0x01`, `x + (-1)`). */
export const ARITH_PATTERN_OPS: ReadonlySet<BinaryOperator> = new Set<BinaryOperator>(['+', '-', '*', '&', '|', '^']);

export function intOfInfo(i: ExprInfo): IntType {
  return i.type.kind === 'int' ? i.type : U8;
}

/**
 * Operand type of a binary operation, MikroC style (no promotion to int): the wider operand wins, and a constant
 * adapts to the other operand when it fits (as a value for comparisons, as a bit pattern for + - * & | ^).
 */
export function operandType(a: ExprInfo, b: ExprInfo, patternFit: boolean): IntType {
  const ta = intOfInfo(a);
  const tb = intOfInfo(b);
  const fits = patternFit ? fitsPattern : fitsStrict;
  if (a.value !== undefined && b.value !== undefined) return widenFor(typeOfConstant(a.value), b.value);
  if (a.value !== undefined && b.value === undefined) return fits(a.value, tb) ? tb : widenFor(tb, a.value);
  if (b.value !== undefined && a.value === undefined) return fits(b.value, ta) ? ta : widenFor(ta, b.value);
  return unify(ta, tb);
}

/** Operators whose constant operands may be used as bit patterns. */
export function isPatternOp(op: BinaryOperator): boolean {
  return ARITH_PATTERN_OPS.has(op);
}

/**
 * Value of a `case` constant once converted to the promoted type of the switch expression (C11 6.8.4.2p5; char
 * operands promote to int, 16 bits in MikroC), or undefined when no value of the switch type `t` can equal it
 * (`case 300:` on an unsigned char). This matches `if (x == 300)`, which never holds either.
 */
export function caseValue(k: number, t: IntType): number | undefined {
  const v = wrap(k, t.size < 2 ? I16 : t);
  return fitsStrict(v, t) ? v : undefined;
}
