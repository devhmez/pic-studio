import type { IntType } from '../ast';
import { byteOf, pattern } from '../sema/types';
import type { ByteSrc } from './arith';
import type { Emitter } from './emitter';
import { at, type FileRef, type Slot, slotRef } from './ir';

/** Where an evaluated expression lives. */
export type Val =
  | { k: 'imm'; v: number; t: IntType }
  | { k: 'mem'; f: FileRef; t: IntType }
  | { k: 'w'; t: IntType }
  | { k: 'bit'; f: FileRef; b: number };

/** Assignable locations. */
export type LVal =
  | { k: 'mem'; f: FileRef; t: IntType }
  | { k: 'bit'; f: FileRef; b: number }
  /** Element reached through FSR/INDF; `addr` holds the 8-bit address (computed before the value). */
  | { k: 'ind'; addr: FileRef; t: IntType };

/** Per-function scratch area: one slot that grows to the maximum simultaneous need. */
export class TempPool {
  private top = 0;

  constructor(readonly slot: Slot) {
    slot.size = 0;
  }

  alloc(size: number): FileRef {
    const ref = slotRef(this.slot, this.top);
    this.top += size;
    if (this.top > this.slot.size) this.slot.size = this.top;
    return ref;
  }

  mark(): number {
    return this.top;
  }

  release(mark: number): void {
    this.top = mark;
  }
}

/** Byte `i` of a value (imm or mem only). */
export function byteSrc(v: Val, i: number): ByteSrc {
  if (v.k === 'imm') return { imm: byteOf(pattern(v.v, v.t.size), i) };
  if (v.k === 'mem') return { f: at(v.f, i) };
  throw new Error(`byteSrc on ${v.k}`);
}

export function byteSrcs(v: Val, n: number): ByteSrc[] {
  return Array.from({ length: n }, (_, i) => byteSrc(v, i));
}

/** Value helpers bound to one emitter and temp pool. */
export class ValueOps {
  constructor(
    readonly em: Emitter,
    readonly temps: TempPool,
  ) {}

  /** Load an 8-bit value (or the low byte of a wider one) into W. Bits load as 0/1 without touching flags. */
  loadW(v: Val): void {
    switch (v.k) {
      case 'imm':
        this.em.movlw(pattern(v.v, 1));
        break;
      case 'mem':
        this.em.movf(v.f, 0);
        break;
      case 'w':
        break;
      case 'bit':
        this.em.movlw(0);
        this.em.prepare(v.f);
        this.em.bit('BTFSC', v.f, v.b);
        this.em.movlw(1);
        break;
    }
  }

  /** Make sure the value is addressable (imm or mem): spills W / bits into a temp. */
  stable(v: Val): Val {
    if (v.k === 'imm' || v.k === 'mem') return v;
    if (v.k === 'w') {
      const t = this.temps.alloc(1);
      this.em.movwf(t);
      return { k: 'mem', f: t, t: v.t };
    }
    this.loadW(v);
    const t = this.temps.alloc(1);
    this.em.movwf(t);
    return { k: 'mem', f: t, t: { kind: 'int', size: 1, signed: false } };
  }

  /** Convert to another integer type (truncation is free on little-endian memory; widening copies to a temp). */
  convert(v: Val, t: IntType): Val {
    switch (v.k) {
      case 'imm':
        return { k: 'imm', v: v.v, t };
      case 'w':
        if (t.size === 1) return { k: 'w', t };
        return this.extend({ k: 'mem', f: this.spillW(), t: v.t }, t);
      case 'bit':
        if (t.size === 1) {
          this.loadW(v);
          return { k: 'w', t };
        }
        return this.extend(this.stable(v) as Val & { k: 'mem' }, t);
      case 'mem':
        if (t.size <= v.t.size) return { k: 'mem', f: v.f, t };
        return this.extend(v, t);
    }
  }

  private spillW(): FileRef {
    const tmp = this.temps.alloc(1);
    this.em.movwf(tmp);
    return tmp;
  }

  /** Copy a narrower memory value into a temp of type `t`, zero- or sign-extending. */
  private extend(v: Val & { k: 'mem' }, t: IntType): Val {
    const dst = this.temps.alloc(t.size);
    this.em.copy(dst, v.f, v.t.size);
    this.fillHigh(dst, v.t, t.size);
    return { k: 'mem', f: dst, t };
  }

  /** Bytes from `from.size` up to `size` of `dst`: 0, or 0xFF when `from` is signed and negative. */
  fillHigh(dst: FileRef, from: IntType, size: number): void {
    if (size <= from.size) return;
    if (!from.signed) {
      for (let i = from.size; i < size; i++) this.em.clrf(at(dst, i));
      return;
    }
    this.em.movlw(0);
    this.em.bit('BTFSC', at(dst, from.size - 1), 7);
    this.em.movlw(0xff);
    for (let i = from.size; i < size; i++) this.em.movwf(at(dst, i));
  }

  /** Copy any value into a fresh temp of type `t` (for in-place arithmetic). */
  toTemp(v: Val, t: IntType): FileRef {
    const dst = this.temps.alloc(t.size);
    this.storeMem(dst, v, t);
    return dst;
  }

  /** Store a value into memory of type `t` (all bytes). */
  storeMem(dst: FileRef, v: Val, t: IntType): void {
    const em = this.em;
    if (t.size === 1) {
      if (v.k === 'imm' && pattern(v.v, 1) === 0) {
        em.clrf(dst);
        return;
      }
      this.loadW(v);
      em.movwf(dst);
      return;
    }
    if (v.k === 'w' || v.k === 'bit') {
      this.loadW(v);
      em.movwf(dst);
      const from: IntType = v.k === 'w' ? v.t : { kind: 'int', size: 1, signed: false };
      this.fillHigh(dst, from, t.size);
      return;
    }
    if (v.k === 'mem' && v.t.size < t.size) {
      em.copy(dst, v.f, v.t.size);
      this.fillHigh(dst, v.t, t.size);
      return;
    }
    for (let i = 0; i < t.size; i++) {
      const b = byteSrc(v, i);
      if ('imm' in b) {
        if (b.imm === 0) em.clrf(at(dst, i));
        else {
          em.movlw(b.imm);
          em.movwf(at(dst, i));
        }
      } else {
        em.movf(b.f, 0);
        em.movwf(at(dst, i));
      }
    }
  }
}
