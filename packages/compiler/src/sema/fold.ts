import type { BinaryOperator, IntType } from '../ast';
import { wrap } from './types';

/** Exact integer evaluation of a binary operator on constants (C semantics: division truncates toward zero). */
export function foldBinary(op: BinaryOperator, a: number, b: number): number | 'divzero' {
  const A = BigInt(Math.trunc(a));
  const B = BigInt(Math.trunc(b));
  switch (op) {
    case '+': return Number(A + B);
    case '-': return Number(A - B);
    case '*': return Number(BigInt.asIntN(64, A * B));
    case '/': return B === 0n ? 'divzero' : Number(A / B);
    case '%': return B === 0n ? 'divzero' : Number(A % B);
    case '<<': return B >= 64n ? 0 : Number(BigInt.asIntN(64, A << B));
    case '>>': return B >= 64n ? (A < 0n ? -1 : 0) : Number(A >> B);
    case '&': return Number(A & B);
    case '|': return Number(A | B);
    case '^': return Number(A ^ B);
    case '==': return A === B ? 1 : 0;
    case '!=': return A !== B ? 1 : 0;
    case '<': return A < B ? 1 : 0;
    case '>': return A > B ? 1 : 0;
    case '<=': return A <= B ? 1 : 0;
    case '>=': return A >= B ? 1 : 0;
  }
}

/** Evaluate an operator the way the generated code will, i.e. in the given operand type. */
export function foldBinaryTyped(op: BinaryOperator, a: number, b: number, t: IntType): number | 'divzero' {
  const r = foldBinary(op, wrap(a, t), wrap(b, t));
  if (r === 'divzero') return r;
  const isCompare = op === '==' || op === '!=' || op === '<' || op === '>' || op === '<=' || op === '>=';
  return isCompare ? r : wrap(r, t);
}
