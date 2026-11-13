import type { Emitter } from './emitter';
import { at, C, type FileRef, R, sfr, Z } from './ir';

/** One byte of an operand: a constant or a file register. */
export type ByteSrc = { imm: number } | { f: FileRef };

const STATUS = sfr(R.STATUS);

export function loadByteW(em: Emitter, b: ByteSrc): void {
  if ('imm' in b) em.movlw(b.imm & 0xff);
  else em.movf(b.f, 0);
}

/**
 * dst += src over `n` bytes, with a correct carry chain. `scratch` is a free byte used when a constant byte of
 * 0xFF must be materialised. Leaves C = carry out of the top byte.
 */
export function addInPlace(em: Emitter, dst: FileRef, src: ByteSrc[], n: number, scratch: FileRef): void {
  loadByteW(em, src[0]);
  em.file('ADDWF', dst, 1);
  for (let i = 1; i < n; i++) {
    const s = src[i];
    if ('imm' in s && s.imm < 0xff) {
      // W = k (+1 when carry): k+1 still fits in 8 bits, so ADDWF produces the right carry.
      em.movlw(s.imm);
      em.bit('BTFSC', STATUS, C);
      em.movlw(s.imm + 1);
    } else {
      // Classic idiom: when the incremented byte wraps to 0, skip the add (the destination byte is unchanged and
      // C stays 1, which is exactly the carry out of adding 0x100).
      const f = materialize(em, s, scratch);
      em.movf(f, 0);
      em.bit('BTFSC', STATUS, C);
      em.file('INCFSZ', f, 0);
    }
    em.file('ADDWF', at(dst, i), 1);
  }
}

/** dst -= src over `n` bytes. Leaves C = 1 when no borrow (dst ≥ src unsigned). */
export function subInPlace(em: Emitter, dst: FileRef, src: ByteSrc[], n: number, scratch: FileRef): void {
  loadByteW(em, src[0]);
  em.file('SUBWF', dst, 1);
  for (let i = 1; i < n; i++) {
    const s = src[i];
    if ('imm' in s && s.imm < 0xff) {
      em.movlw(s.imm);
      em.bit('BTFSS', STATUS, C);
      em.movlw(s.imm + 1);
    } else {
      const f = materialize(em, s, scratch);
      em.movf(f, 0);
      em.bit('BTFSS', STATUS, C);
      em.file('INCFSZ', f, 0);
    }
    em.file('SUBWF', at(dst, i), 1);
  }
}

/**
 * Compute a − b over `n` bytes without storing the result; afterwards C = 1 iff a ≥ b (unsigned).
 * `a` bytes that are constants are handled with SUBLW.
 */
export function compareBorrow(em: Emitter, a: ByteSrc[], b: ByteSrc[], n: number, scratch: FileRef): void {
  for (let i = 0; i < n; i++) {
    const bi = b[i];
    if (i === 0) {
      loadByteW(em, bi);
    } else if ('imm' in bi && bi.imm < 0xff) {
      em.movlw(bi.imm);
      em.bit('BTFSS', STATUS, C);
      em.movlw(bi.imm + 1);
    } else {
      const f = materialize(em, bi, scratch);
      em.movf(f, 0);
      em.bit('BTFSS', STATUS, C);
      em.file('INCFSZ', f, 0);
    }
    const ai = a[i];
    if ('imm' in ai) em.lit('SUBLW', ai.imm);
    else em.file('SUBWF', ai.f, 0);
  }
}

function materialize(em: Emitter, s: ByteSrc, scratch: FileRef): FileRef {
  if ('f' in s) return s.f;
  em.movlw(s.imm);
  em.movwf(scratch);
  return scratch;
}

/** x = −x over `n` bytes (two's complement): COMF every byte then increment with carry. */
export function negateInPlace(em: Emitter, x: FileRef, n: number): void {
  for (let i = 0; i < n; i++) em.file('COMF', at(x, i), 1);
  em.file('INCF', x, 1);
  for (let i = 1; i < n; i++) {
    em.bit('BTFSC', STATUS, Z);
    em.file('INCF', at(x, i), 1);
  }
}

/** x <<= 1 over `n` bytes (C ends with the bit shifted out). */
export function shiftLeftOnce(em: Emitter, x: FileRef, n: number): void {
  em.bit('BCF', STATUS, C);
  for (let i = 0; i < n; i++) em.file('RLF', at(x, i), 1);
}

/** x >>= 1 over `n` bytes; arithmetic shift keeps the sign bit. */
export function shiftRightOnce(em: Emitter, x: FileRef, n: number, arithmetic: boolean): void {
  if (arithmetic) em.file('RLF', at(x, n - 1), 0); // C = sign bit, W discarded
  else em.bit('BCF', STATUS, C);
  for (let i = n - 1; i >= 0; i--) em.file('RRF', at(x, i), 1);
}

/** Increment x by one over `n` bytes. */
export function incrementInPlace(em: Emitter, x: FileRef, n: number): void {
  em.file('INCF', x, 1);
  for (let i = 1; i < n; i++) {
    em.bit('BTFSC', STATUS, Z);
    em.file('INCF', at(x, i), 1);
  }
}

/** Decrement x by one over `n` bytes. */
export function decrementInPlace(em: Emitter, x: FileRef, n: number): void {
  if (n === 1) {
    em.file('DECF', x, 1);
    return;
  }
  // Borrow propagates while the lower bytes were 0 before decrementing (i.e. are 0xFF after).
  em.movlw(1);
  em.file('SUBWF', x, 1);
  for (let i = 1; i < n; i++) {
    em.movlw(0);
    em.bit('BTFSS', STATUS, C);
    em.movlw(1);
    em.file('SUBWF', at(x, i), 1);
  }
}
