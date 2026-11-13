import type { CType, IntType } from '../ast';

export const U8: IntType = { kind: 'int', size: 1, signed: false };
export const I8: IntType = { kind: 'int', size: 1, signed: true };
export const U16: IntType = { kind: 'int', size: 2, signed: false };
export const I16: IntType = { kind: 'int', size: 2, signed: true };
export const U32: IntType = { kind: 'int', size: 4, signed: false };
export const I32: IntType = { kind: 'int', size: 4, signed: true };

/** Candidate types from smallest to largest, used to type constants and to widen mixed expressions. */
const LADDER: readonly IntType[] = [U8, I8, U16, I16, U32, I32];

export function intType(size: 1 | 2 | 4, signed: boolean): IntType {
  return { kind: 'int', size, signed };
}

export function minOf(t: IntType): number {
  return t.signed ? -(2 ** (t.size * 8 - 1)) : 0;
}

export function maxOf(t: IntType): number {
  return t.signed ? 2 ** (t.size * 8 - 1) - 1 : 2 ** (t.size * 8) - 1;
}

/** Value lies in the type's range. */
export function fitsStrict(v: number, t: IntType): boolean {
  return v >= minOf(t) && v <= maxOf(t);
}

/** Value can be stored in the type's width as a bit pattern (e.g. -1 or 255 in 8 bits). */
export function fitsPattern(v: number, t: IntType): boolean {
  return v >= -(2 ** (t.size * 8 - 1)) && v <= 2 ** (t.size * 8) - 1;
}

/** Wrap a value to the type (two's complement), returning the value as that type interprets it. */
export function wrap(v: number, t: IntType): number {
  const bits = BigInt(t.size * 8);
  const n = BigInt.asUintN(Number(bits), BigInt(Math.trunc(v)));
  return Number(t.signed ? BigInt.asIntN(Number(bits), n) : n);
}

/** Unsigned bit pattern of a value in `size` bytes. */
export function pattern(v: number, size: number): number {
  return Number(BigInt.asUintN(size * 8, BigInt(Math.trunc(v))));
}

/** Byte `i` (little-endian) of a value. */
export function byteOf(v: number, i: number): number {
  return Number((BigInt.asUintN(32, BigInt(Math.trunc(v))) >> BigInt(8 * i)) & 0xffn);
}

/** Smallest type holding the constant (unsigned preferred for non-negative values). */
export function typeOfConstant(v: number): IntType {
  return LADDER.find((t) => fitsStrict(v, t)) ?? (v < 0 ? I32 : U32);
}

/** Smallest type containing both the range of `t` and the value `v`. */
export function widenFor(t: IntType, v: number): IntType {
  const lo = Math.min(minOf(t), v);
  const hi = Math.max(maxOf(t), v);
  return LADDER.find((c) => minOf(c) <= lo && maxOf(c) >= hi) ?? I32;
}

/** MikroC-style usual conversion without integer promotion: the wider operand wins; equal widths are signed only if both are. */
export function unify(a: IntType, b: IntType): IntType {
  if (a.size !== b.size) return a.size > b.size ? a : b;
  return intType(a.size, a.signed && b.signed);
}

export function sameType(a: CType, b: CType): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function typeToString(t: CType): string {
  switch (t.kind) {
    case 'void':
      return 'void';
    case 'bit':
      return 'bit';
    case 'pointer':
      return `${typeToString(t.to)} *`;
    case 'array':
      return `${typeToString(t.elem)}[${t.length}]`;
    case 'int': {
      const base = t.size === 1 ? 'char' : t.size === 2 ? 'int' : 'long';
      if (t.size === 1) return t.signed ? 'signed char' : 'unsigned char';
      return `${t.signed ? '' : 'unsigned '}${base}`;
    }
  }
}

export function sizeOf(t: CType): number {
  switch (t.kind) {
    case 'int':
      return t.size;
    case 'bit':
      return 1;
    case 'array':
      return t.elem.size * t.length;
    case 'pointer':
      return 1;
    case 'void':
      return 0;
  }
}
