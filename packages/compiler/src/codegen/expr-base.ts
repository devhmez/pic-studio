import type {
  AssignmentExpression, BinaryExpression, BinaryOperator, BitAccess, CallExpression, ConditionalExpression,
  Expression, IndexExpression, IntType, UnaryExpression, UpdateExpression,
} from '../ast';
import { type ExprInfo, intOfInfo } from '../sema/info';
import type { BitTarget, VarSymbol } from '../sema/symbols';
import { pattern, U8 } from '../sema/types';
import { addInPlace, shiftLeftOnce, shiftRightOnce, subInPlace, negateInPlace, type ByteSrc } from './arith';
import type { Emitter } from './emitter';
import { at, C, type FileRef, R, sfr, slotRef, Z } from './ir';
import type { FileOp, LitOp } from './isa';
import type { ExecContext } from './runtime';
import type { ProgramServices } from './services';
import { addSlot, type CodeUnit } from './units';
import { byteSrc, byteSrcs, type TempPool, type Val, ValueOps } from './values';

export const STATUS = sfr(R.STATUS);
export const COMPARE = new Set<BinaryOperator>(['==', '!=', '<', '>', '<=', '>=']);
export const OPWF: Partial<Record<BinaryOperator, FileOp>> = { '+': 'ADDWF', '-': 'SUBWF', '&': 'ANDWF', '|': 'IORWF', '^': 'XORWF' };
export const OPLW: Partial<Record<BinaryOperator, LitOp>> = { '+': 'ADDLW', '-': 'SUBLW', '&': 'ANDLW', '|': 'IORLW', '^': 'XORLW' };

export type ImmOrMem = Val & { k: 'imm' | 'mem' };

/**
 * Expression code generation, layer 1: values, memory access and arithmetic. Results are in W for 8-bit values
 * and in temporaries otherwise. Conditions, assignments and calls are added by the subclasses
 * (expr-cond.ts → expr-assign.ts → expr.ts).
 */
export abstract class ExprBase {
  readonly ops: ValueOps;
  protected scratchRef: FileRef | undefined;

  constructor(
    readonly svc: ProgramServices,
    readonly em: Emitter,
    readonly temps: TempPool,
    readonly unit: CodeUnit,
    readonly ctx: ExecContext,
  ) {
    this.ops = new ValueOps(em, temps);
  }

  /** A byte reserved for flag-neutral bank-1 bit tests and constant materialisation. */
  readonly scratch = (): FileRef => (this.scratchRef ??= slotRef(addSlot(this.unit.frame, `${this.unit.name}.scr`, 1)));

  info(e: Expression): ExprInfo {
    const i = this.svc.sem.exprs.get(e);
    if (!i) throw new Error(`expression sans information sémantique : ${e.text}`);
    return i;
  }

  intType(e: Expression): IntType {
    return intOfInfo(this.info(e));
  }

  // ===========================================================================================================
  // Values

  value(e: Expression): Val {
    const inf = this.info(e);
    if (inf.value !== undefined) return { k: 'imm', v: inf.value, t: intOfInfo(inf) };
    switch (e.kind) {
      case 'Identifier':
        return this.identifierValue(e);
      case 'BitAccess':
        return { k: 'bit', ...this.bitLoc(e) };
      case 'IndexExpression':
        return this.indexValue(e);
      case 'CallExpression':
        return this.call(e);
      case 'UnaryExpression':
        return this.unary(e);
      case 'UpdateExpression':
        return this.update(e, true)!;
      case 'BinaryExpression':
        if (COMPARE.has(e.operator)) return this.boolValue(e);
        return this.binary(e);
      case 'LogicalExpression':
        return this.boolValue(e);
      case 'AssignmentExpression':
        return this.assign(e, true)!;
      case 'ConditionalExpression':
        return this.conditional(e);
      case 'CastExpression': {
        const ct = e.typeSpec.type;
        if (ct.kind === 'bit') return this.boolValue(e.argument);
        if (ct.kind !== 'int') {
          this.discard(e.argument);
          return { k: 'imm', v: 0, t: U8 };
        }
        return this.valueAs(e.argument, ct);
      }
      case 'SequenceExpression':
        e.expressions.slice(0, -1).forEach((x) => this.discard(x));
        return this.value(e.expressions[e.expressions.length - 1]);
      default:
        return { k: 'imm', v: 0, t: U8 };
    }
  }

  valueAs(e: Expression, t: IntType): Val {
    return this.ops.convert(this.value(e), t);
  }

  /** Evaluate an 8-bit view of `e` into W. */
  toW(e: Expression, t: IntType): void {
    this.ops.loadW(this.valueAs(e, t.size === 1 ? t : { kind: 'int', size: 1, signed: t.signed }));
  }

  /** Evaluate for side effects only (expression statements). The value is still computed: no dead-code removal. */
  discard(e: Expression): void {
    switch (e.kind) {
      case 'AssignmentExpression':
        this.assign(e, false);
        return;
      case 'UpdateExpression':
        this.update(e, false);
        return;
      case 'CallExpression':
        this.call(e);
        return;
      case 'SequenceExpression':
        e.expressions.forEach((x) => this.discard(x));
        return;
      default: {
        const v = this.value(e);
        if (v.k === 'mem' || v.k === 'bit') this.ops.loadW(v);
      }
    }
  }

  protected identifierValue(e: Expression & { kind: 'Identifier' }): Val {
    const sym = this.svc.sem.symbols.get(e);
    switch (sym?.kind) {
      case 'var':
        if (sym.type.kind === 'bit') return { k: 'bit', ...this.svc.bitRef(sym) };
        if (sym.type.kind === 'int') return { k: 'mem', f: this.svc.varRef(sym), t: sym.type };
        return { k: 'imm', v: 0, t: U8 };
      case 'sfr':
        return { k: 'mem', f: sfr(sym.def.addr), t: U8 };
      case 'sbit':
        return { k: 'bit', ...this.bitTargetLoc(sym.target) };
      default:
        return { k: 'imm', v: 0, t: U8 };
    }
  }

  bitTargetLoc(t: BitTarget): { f: FileRef; b: number } {
    if (t.kind === 'sfr') return { f: sfr(t.def.addr), b: t.bit };
    return { f: at(this.svc.varRef(t.sym), t.bit >> 3), b: t.bit & 7 };
  }

  bitLoc(e: BitAccess): { f: FileRef; b: number } {
    const bit = this.svc.sem.bits.get(e) ?? 0;
    const sym = e.object.kind === 'Identifier' ? this.svc.sem.symbols.get(e.object) : undefined;
    if (sym?.kind === 'sfr') return { f: sfr(sym.def.addr), b: bit };
    if (sym?.kind === 'var') return { f: at(this.svc.varRef(sym), bit >> 3), b: bit & 7 };
    return { f: sfr(R.STATUS), b: 0 };
  }

  protected arraySymbol(e: IndexExpression): VarSymbol {
    const sym = this.svc.sem.symbols.get(e.object as Expression & { kind: 'Identifier' });
    if (sym?.kind !== 'var' || sym.type.kind !== 'array') throw new Error('tableau attendu');
    return sym;
  }

  protected indexValue(e: IndexExpression): Val {
    const sym = this.arraySymbol(e);
    const arr = sym.type as { kind: 'array'; elem: IntType; length: number };
    const elem = arr.elem;
    const idx = this.info(e.index);
    if (sym.romData) return this.tableRead(sym, elem, e.index);
    if (idx.value !== undefined) return { k: 'mem', f: at(this.svc.varRef(sym), idx.value * elem.size), t: elem };
    this.indirectAddress(sym, elem, e.index);
    this.em.movwf(sfr(R.FSR));
    if (elem.size === 1) {
      this.em.movf(sfr(R.INDF), 0);
      return { k: 'w', t: elem };
    }
    const dst = this.temps.alloc(elem.size);
    for (let i = 0; i < elem.size; i++) {
      if (i > 0) this.em.file('INCF', sfr(R.FSR), 1);
      this.em.movf(sfr(R.INDF), 0);
      this.em.movwf(at(dst, i));
    }
    return { k: 'mem', f: dst, t: elem };
  }

  /** W ← address of sym[index] (8-bit data address for FSR). */
  protected indirectAddress(sym: VarSymbol, elem: IntType, index: Expression): void {
    const base = this.svc.varRef(sym);
    this.toW(index, U8);
    if (elem.size > 1) {
      const t = this.temps.alloc(1);
      this.em.movwf(t);
      for (let s = elem.size; s > 1; s >>= 1) {
        this.em.bit('BCF', STATUS, C);
        this.em.file('RLF', t, 1);
      }
      this.em.movf(t, 0);
    }
    this.em.lit('ADDLW', { kind: 'addr', ref: base });
  }

  /** Read sym[index] from a RETLW table: PCLATH:W = table + index, then CALL a `MOVWF PCL` stub. */
  protected tableRead(sym: VarSymbol, elem: IntType, index: Expression): Val {
    const jump = this.svc.runtime.get({ kind: 'tbljump' }, this.ctx);
    this.unit.callees.add(jump.label);
    const idx = this.ops.stable(this.valueAs(index, U8));
    const dst = elem.size > 1 ? this.temps.alloc(elem.size) : null;
    const tmp = this.temps.alloc(1);
    for (let b = 0; b < elem.size; b++) {
      const label = this.svc.romTable(sym, b);
      this.ops.loadW(idx);
      this.em.lit('ADDLW', { kind: 'label', label, part: 'lo' });
      this.em.movwf(tmp);
      this.em.movlw({ kind: 'label', label, part: 'hi' });
      this.em.bit('BTFSC', STATUS, C);
      this.em.lit('ADDLW', 1);
      this.em.movwf(sfr(R.PCLATH));
      this.em.movf(tmp, 0);
      this.em.call(jump.label);
      if (dst) this.em.movwf(at(dst, b));
    }
    return dst ? { k: 'mem', f: dst, t: elem } : { k: 'w', t: elem };
  }

  protected unary(e: UnaryExpression): Val {
    const t = this.intType(e);
    switch (e.operator) {
      case '+':
        return this.valueAs(e.argument, t);
      case '!':
        return this.boolValue(e);
      case '&': {
        const arg = e.argument as Expression & { kind: 'Identifier' };
        const sym = this.svc.sem.symbols.get(arg);
        if (sym?.kind === 'sfr') return { k: 'imm', v: sym.def.addr & 0xff, t: U8 };
        if (sym?.kind === 'var') {
          this.em.movlw({ kind: 'addr', ref: this.svc.varRef(sym) });
          return { k: 'w', t: U8 };
        }
        return { k: 'imm', v: 0, t: U8 };
      }
      case '-':
      case '~': {
        if (t.size === 1) {
          this.toW(e.argument, t);
          if (e.operator === '-') this.em.lit('SUBLW', 0);
          else this.em.lit('XORLW', 0xff);
          return { k: 'w', t };
        }
        const dst = this.ops.toTemp(this.valueAs(e.argument, t), t);
        if (e.operator === '-') negateInPlace(this.em, dst, t.size);
        else for (let i = 0; i < t.size; i++) this.em.file('COMF', at(dst, i), 1);
        return { k: 'mem', f: dst, t };
      }
      default:
        this.discard(e.argument);
        return { k: 'imm', v: 0, t: U8 };
    }
  }


  // ===========================================================================================================
  // Arithmetic

  protected binary(e: BinaryExpression): Val {
    const t = this.intType(e);
    const op = e.operator;
    if (t.size === 1 && OPWF[op]) {
      this.bin8(op, e.left, e.right, t);
      return { k: 'w', t };
    }
    if (op === '<<' || op === '>>') {
      const a = this.valueAs(e.left, t);
      const cnt = this.info(e.right).value;
      return this.shift(op, a, cnt !== undefined ? cnt : this.ops.stable(this.valueAs(e.right, U8)), t);
    }
    const a = this.ops.stable(this.valueAs(e.left, t));
    const b = this.ops.stable(this.valueAs(e.right, t));
    return this.arithVals(op, a, b, t);
  }

  /** Operand usable directly by an instruction (constant or file register), without emitting code. */
  protected simple(e: Expression, t: IntType): ImmOrMem | null {
    const inf = this.info(e);
    if (inf.value !== undefined) return { k: 'imm', v: inf.value, t };
    if (e.kind === 'Identifier') {
      const v = this.identifierValue(e);
      if (v.k === 'mem') return { k: 'mem', f: v.f, t };
    }
    if (e.kind === 'IndexExpression' && this.info(e.index).value !== undefined) {
      const sym = this.arraySymbol(e);
      if (!sym.romData) {
        const v = this.indexValue(e);
        if (v.k === 'mem') return { k: 'mem', f: v.f, t };
      }
    }
    return null;
  }

  /**
   * 8-bit `L op R` into W. The last instruction is always the operation itself, so C/DC/Z are the ones the
   * datasheet gives for it: `z = x - y` is exactly MOVF y,W / SUBWF x,W (then MOVWF z).
   */
  bin8(op: BinaryOperator, L: Expression, R: Expression, t: IntType): void {
    const em = this.em;
    const l = this.simple(L, t);
    const r = this.simple(R, t);
    if (l && r) {
      this.bin8Vals(op, l, r);
      return;
    }
    if (r) {
      this.toW(L, t);
      if (op === '-') {
        const tmp = this.temps.alloc(1);
        em.movwf(tmp);
        this.bin8Vals('-', { k: 'mem', f: tmp, t }, r);
        return;
      }
      if (r.k === 'imm') em.lit(OPLW[op]!, pattern(r.v, 1));
      else em.file(OPWF[op]!, r.f, 0);
      return;
    }
    if (l) {
      this.toW(R, t);
      if (l.k === 'imm') em.lit(OPLW[op]!, pattern(l.v, 1)); // SUBLW k: W = k − W
      else em.file(OPWF[op]!, l.f, 0); // SUBWF l,W: W = l − W
      return;
    }
    this.toW(L, t);
    const tmp = this.temps.alloc(1);
    em.movwf(tmp);
    this.toW(R, t);
    em.file(OPWF[op]!, tmp, 0);
  }

  bin8Vals(op: BinaryOperator, l: ImmOrMem, r: ImmOrMem): void {
    const em = this.em;
    if (l.k === 'imm' && r.k === 'imm') {
      // Both constant (only reached from compound paths): still execute the operation for its flags.
      em.movlw(pattern(r.v, 1));
      em.lit(OPLW[op]!, pattern(l.v, 1));
      return;
    }
    if (r.k === 'imm') {
      em.movlw(pattern(r.v, 1));
      em.file(OPWF[op]!, (l as Val & { k: 'mem' }).f, 0);
      return;
    }
    if (l.k === 'imm') {
      if (op === '-') {
        em.movf(r.f, 0);
        em.lit('SUBLW', pattern(l.v, 1));
      } else {
        em.movlw(pattern(l.v, 1));
        em.file(OPWF[op]!, r.f, 0);
      }
      return;
    }
    em.movf(r.f, 0);
    em.file(OPWF[op]!, l.f, 0);
  }

  /** Binary operation on already-evaluated operands (multi-byte, helpers, compound assignments). */
  arithVals(op: BinaryOperator, a: Val, b: Val, t: IntType): Val {
    const em = this.em;
    const n = t.size;
    if (op === '<<' || op === '>>') return this.shift(op, a, b.k === 'imm' ? b.v : this.ops.stable(b), t);
    if (op === '*' || op === '/' || op === '%') return this.helperOp(op, a, b, t);
    a = this.ops.stable(this.ops.convert(a, t));
    b = this.ops.stable(this.ops.convert(b, t));
    if (n === 1) {
      this.bin8Vals(op, a as ImmOrMem, b as ImmOrMem);
      return { k: 'w', t };
    }
    if (op === '+' || op === '-') {
      const dst = this.ops.toTemp(a, t);
      if (op === '+') addInPlace(em, dst, byteSrcs(b, n), n, this.scratch());
      else subInPlace(em, dst, byteSrcs(b, n), n, this.scratch());
      return { k: 'mem', f: dst, t };
    }
    const dst = this.temps.alloc(n);
    for (let i = 0; i < n; i++) {
      this.byteOp(op, byteSrc(a, i), byteSrc(b, i));
      em.movwf(at(dst, i));
    }
    return { k: 'mem', f: dst, t };
  }

  /** W ← a op b for one byte (op in & | ^). */
  protected byteOp(op: BinaryOperator, a: ByteSrc, b: ByteSrc): void {
    const em = this.em;
    if ('imm' in a && 'imm' in b) {
      const r = op === '&' ? a.imm & b.imm : op === '|' ? a.imm | b.imm : a.imm ^ b.imm;
      em.movlw(r);
    } else if ('imm' in b) {
      em.movlw(b.imm);
      em.file(OPWF[op]!, (a as { f: FileRef }).f, 0);
    } else if ('imm' in a) {
      em.movlw(a.imm);
      em.file(OPWF[op]!, b.f, 0);
    } else {
      em.movf(b.f, 0);
      em.file(OPWF[op]!, a.f, 0);
    }
  }

  protected helperOp(op: '*' | '/' | '%', a: Val, b: Val, t: IntType): Val {
    const n = t.size;
    const h = this.svc.runtime.get(op === '*' ? { kind: 'mul', size: n } : { kind: 'div', size: n, signed: t.signed }, this.ctx);
    this.unit.callees.add(h.label);
    // Evaluate both operands before filling the helper frame (an operand may itself call the helper).
    const sa = this.ops.stable(this.ops.convert(a, t));
    const sb = this.ops.stable(this.ops.convert(b, t));
    this.ops.storeMem(h.params[0], sa, t);
    this.ops.storeMem(h.params[1], sb, t);
    this.em.call(h.label);
    const res = op === '%' ? h.remainder! : h.result!;
    if (n === 1) {
      this.em.movf(res, 0);
      return { k: 'w', t };
    }
    const dst = this.temps.alloc(n);
    this.em.copy(dst, res, n);
    return { k: 'mem', f: dst, t };
  }

  /** Shift by a constant (byte moves then single-bit shifts) or by a variable count (loop). */
  protected shift(op: '<<' | '>>', a: Val, count: number | Val, t: IntType): Val {
    const em = this.em;
    const n = t.size;
    const dst = this.ops.toTemp(a, t);
    const arithmetic = op === '>>' && t.signed;
    if (typeof count === 'number') {
      const s = Math.max(0, count);
      if (s >= 8 * n) {
        if (arithmetic) {
          em.movlw(0);
          em.bit('BTFSC', at(dst, n - 1), 7);
          em.movlw(0xff);
          for (let i = 0; i < n; i++) em.movwf(at(dst, i));
        } else {
          for (let i = 0; i < n; i++) em.clrf(at(dst, i));
        }
        return { k: 'mem', f: dst, t };
      }
      const q = s >> 3;
      if (q > 0) this.moveBytes(dst, n, q, op, arithmetic);
      for (let i = 0; i < (s & 7); i++) {
        if (op === '<<') shiftLeftOnce(em, dst, n);
        else shiftRightOnce(em, dst, n, arithmetic);
      }
      return { k: 'mem', f: dst, t };
    }
    const cnt = this.temps.alloc(1);
    this.ops.loadW(count);
    em.movwf(cnt);
    const loop = em.newLabel();
    const done = em.newLabel();
    em.label(loop);
    em.movf(cnt, 1);
    em.testBitGoto('BTFSC', STATUS, Z, done, this.scratch);
    if (op === '<<') shiftLeftOnce(em, dst, n);
    else shiftRightOnce(em, dst, n, arithmetic);
    em.file('DECF', cnt, 1);
    em.goto(loop);
    em.label(done);
    return { k: 'mem', f: dst, t };
  }

  protected moveBytes(dst: FileRef, n: number, q: number, op: '<<' | '>>', arithmetic: boolean): void {
    const em = this.em;
    if (op === '<<') {
      for (let i = n - 1; i >= 0; i--) {
        if (i - q >= 0) {
          em.movf(at(dst, i - q), 0);
          em.movwf(at(dst, i));
        } else em.clrf(at(dst, i));
      }
      return;
    }
    for (let i = 0; i < n; i++) {
      if (i + q < n) {
        em.movf(at(dst, i + q), 0);
        em.movwf(at(dst, i));
      }
    }
    if (arithmetic) {
      em.movlw(0);
      em.bit('BTFSC', at(dst, n - q - 1), 7);
      em.movlw(0xff);
      for (let i = n - q; i < n; i++) em.movwf(at(dst, i));
    } else {
      for (let i = n - q; i < n; i++) em.clrf(at(dst, i));
    }
  }

  // Implemented by the upper layers.
  abstract boolValue(e: Expression): Val;
  abstract branch(e: Expression, sense: boolean, label: string): void;
  protected abstract conditional(e: ConditionalExpression): Val;
  abstract assign(e: AssignmentExpression, wantValue: boolean): Val | undefined;
  abstract update(e: UpdateExpression, wantValue: boolean): Val | undefined;
  abstract call(e: CallExpression): Val;
}
