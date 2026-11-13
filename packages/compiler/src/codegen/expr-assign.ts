import type { AssignmentExpression, BinaryOperator, Expression, IntType, UpdateExpression } from '../ast';
import { bankOfAddress } from '../device';
import { operandType } from '../sema/info';
import { BYTE_SELECTORS } from '../sema/symbols';
import { pattern, U8 } from '../sema/types';
import { addInPlace, decrementInPlace, incrementInPlace, loadByteW, subInPlace } from './arith';
import { CondGen } from './expr-cond';
import { OPWF } from './expr-base';
import { at, type FileRef, R, sameRef, sfr } from './ir';
import { byteSrc, byteSrcs, type LVal, type Val } from './values';

/** Expression code generation, layer 3: assignable locations, assignments, ++/--, bit copies. */
export abstract class AssignGen extends CondGen {
  // ===========================================================================================================
  // Assignment

  lvalue(e: Expression): LVal {
    switch (e.kind) {
      case 'Identifier': {
        const v = this.identifierValue(e);
        if (v.k === 'bit') return { k: 'bit', f: v.f, b: v.b };
        if (v.k === 'mem') return { k: 'mem', f: v.f, t: v.t };
        break;
      }
      case 'BitAccess':
        return { k: 'bit', ...this.bitLoc(e) };
      case 'IndexExpression': {
        const sym = this.arraySymbol(e);
        const elem = (sym.type as { elem: IntType }).elem;
        const idx = this.info(e.index).value;
        if (idx !== undefined) return { k: 'mem', f: at(this.svc.varRef(sym), idx * elem.size), t: elem };
        this.indirectAddress(sym, elem, e.index);
        const addr = this.temps.alloc(1);
        this.em.movwf(addr);
        return { k: 'ind', addr, t: elem };
      }
      case 'CallExpression': {
        // `Hi(x) = v` (built_in.h): byte k of the inner location.
        const fn = this.svc.sem.calls.get(e);
        const k = fn?.builtin ? BYTE_SELECTORS[fn.builtin] : undefined;
        if (k === undefined) break;
        const inner = this.lvalue(e.args[0]);
        if (inner.k === 'mem') return { k: 'mem', f: at(inner.f, k), t: U8 };
        if (inner.k === 'ind') {
          if (k > 0) {
            this.em.movlw(k);
            this.em.file('ADDWF', inner.addr, 1);
          }
          return { k: 'ind', addr: inner.addr, t: U8 };
        }
        break;
      }
      default:
        break;
    }
    throw new Error(`lvalue inattendue : ${e.text}`);
  }

  readLVal(lv: LVal): Val {
    if (lv.k === 'bit') return { k: 'bit', f: lv.f, b: lv.b };
    if (lv.k === 'mem') return { k: 'mem', f: lv.f, t: lv.t };
    this.em.movf(lv.addr, 0);
    this.em.movwf(sfr(R.FSR));
    if (lv.t.size === 1) {
      this.em.movf(sfr(R.INDF), 0);
      return { k: 'w', t: lv.t };
    }
    const dst = this.temps.alloc(lv.t.size);
    for (let i = 0; i < lv.t.size; i++) {
      if (i > 0) this.em.file('INCF', sfr(R.FSR), 1);
      this.em.movf(sfr(R.INDF), 0);
      this.em.movwf(at(dst, i));
    }
    return { k: 'mem', f: dst, t: lv.t };
  }

  storeLVal(lv: LVal, v: Val): void {
    if (lv.k === 'bit') {
      this.storeBitVal(lv, v);
      return;
    }
    if (lv.k === 'mem') {
      this.ops.storeMem(lv.f, v, lv.t);
      return;
    }
    const sv = this.ops.stable(this.ops.convert(v, lv.t));
    this.em.movf(lv.addr, 0);
    this.em.movwf(sfr(R.FSR));
    for (let i = 0; i < lv.t.size; i++) {
      if (i > 0) this.em.file('INCF', sfr(R.FSR), 1);
      const b = byteSrc(sv, i);
      if ('imm' in b && b.imm === 0) this.em.clrf(sfr(R.INDF));
      else {
        loadByteW(this.em, b);
        this.em.movwf(sfr(R.INDF));
      }
    }
  }

  assign(e: AssignmentExpression, wantValue: boolean): Val | undefined {
    const lv = this.lvalue(e.left);
    if (e.operator === '=') {
      if (lv.k === 'bit') this.storeBit(lv, e.right);
      else this.storeLVal(lv, this.valueAs(e.right, lv.t));
    } else if (lv.k !== 'bit') {
      this.compoundAssign(lv, e.operator.slice(0, -1) as BinaryOperator, e.left, e.right);
    }
    return wantValue ? this.readLVal(lv) : undefined;
  }

  protected compoundAssign(lv: LVal & { k: 'mem' | 'ind' }, op: BinaryOperator, lhs: Expression, rhs: Expression): void {
    const em = this.em;
    const t = lv.t;
    const n = t.size;
    if (lv.k === 'mem' && OPWF[op]) {
      // In place: x += y → MOVF y,W / ADDWF x,F
      const r = this.valueAs(rhs, t);
      if (n === 1) {
        this.ops.loadW(r);
        em.file(OPWF[op]!, lv.f, 1);
        return;
      }
      const sr = this.ops.stable(r);
      if (op === '+') addInPlace(em, lv.f, byteSrcs(sr, n), n, this.scratch());
      else if (op === '-') subInPlace(em, lv.f, byteSrcs(sr, n), n, this.scratch());
      else {
        for (let i = 0; i < n; i++) {
          loadByteW(em, byteSrc(sr, i));
          em.file(OPWF[op]!, at(lv.f, i), 1);
        }
      }
      return;
    }
    const cur = this.ops.stable(this.readLVal(lv));
    const cnt = this.info(rhs).value;
    let r: Val;
    if ((op === '<<' || op === '>>') && cnt !== undefined) r = this.shift(op, cur, cnt, t);
    else if (op === '<<' || op === '>>') r = this.arithVals(op, cur, this.ops.stable(this.valueAs(rhs, U8)), t);
    else {
      // `x op= e` is `x = x op e`: / and % use the operand type of the binary operator, so a wider divisor (an
      // int, or 300) is not truncated to x's type; the result is then narrowed to x. The low bytes of * do not
      // depend on the upper bytes of the operands, so it can stay in x's type.
      const opType = op === '/' || op === '%' ? operandType(this.info(lhs), this.info(rhs), false) : t;
      r = this.arithVals(op, this.ops.convert(cur, opType), this.ops.stable(this.valueAs(rhs, opType)), opType);
    }
    this.storeLVal(lv, r);
  }

  /** bit = expression (constant → BSF/BCF; bit → conditional copy; integer → its least significant bit). */
  protected storeBit(lv: { f: FileRef; b: number }, rhs: Expression): void {
    const c = this.info(rhs).value;
    if (c !== undefined) {
      this.em.bit(c & 1 ? 'BSF' : 'BCF', lv.f, lv.b);
      return;
    }
    const loc = this.bitLocation(rhs);
    if (loc) {
      this.copyBit(loc, lv);
      return;
    }
    this.storeBitVal(lv, this.value(rhs));
  }

  protected storeBitVal(lv: { f: FileRef; b: number }, v: Val): void {
    if (v.k === 'imm') {
      this.em.bit(pattern(v.v, 1) & 1 ? 'BSF' : 'BCF', lv.f, lv.b);
      return;
    }
    if (v.k === 'bit') {
      this.copyBit(v, lv);
      return;
    }
    const tmp = this.temps.alloc(1);
    this.ops.loadW(v);
    this.em.movwf(tmp);
    this.copyBit({ f: tmp, b: 0 }, lv);
  }

  /** dst ← src for single bits, without glitches on the destination when src = 1. */
  protected copyBit(src: { f: FileRef; b: number }, dst: { f: FileRef; b: number }): void {
    const em = this.em;
    const bankOf = (f: FileRef) => (f.kind === 'sfr' ? bankOfAddress(f.addr) : 'both');
    const sb = bankOf(src.f);
    const db = bankOf(dst.f);
    const dstIsStatus = dst.f.kind === 'sfr' && (dst.f.addr & 0x7f) === R.STATUS;
    // Same bit: the first BSF/BCF would change the bit being tested.
    const sameBit = sameRef(src.f, dst.f) && src.b === dst.b;
    if ((sb !== 'both' && db !== 'both' && sb !== db) || dstIsStatus || sameBit) {
      const tmp = this.temps.alloc(1);
      em.movlw(0);
      em.prepare(src.f);
      em.bit('BTFSC', src.f, src.b);
      em.movlw(1);
      em.movwf(tmp);
      src = { f: tmp, b: 0 };
    }
    em.prepare(src.f);
    em.prepare(dst.f);
    em.bit('BTFSC', src.f, src.b);
    em.bit('BSF', dst.f, dst.b);
    em.bit('BTFSS', src.f, src.b);
    em.bit('BCF', dst.f, dst.b);
  }

  update(e: UpdateExpression, wantValue: boolean): Val | undefined {
    const em = this.em;
    const lv = this.lvalue(e.argument);
    if (lv.k === 'bit') return undefined;
    const t = lv.t;
    if (lv.k === 'mem') {
      let old: Val | undefined;
      if (wantValue && !e.prefix) {
        if (t.size === 1) {
          em.movf(lv.f, 0); // W keeps the old value: INCF/DECF x,F do not touch W
          old = { k: 'w', t };
        } else {
          old = { k: 'mem', f: this.ops.toTemp({ k: 'mem', f: lv.f, t }, t), t };
        }
      }
      if (e.operator === '++') incrementInPlace(em, lv.f, t.size);
      else decrementInPlace(em, lv.f, t.size);
      if (!wantValue) return undefined;
      return old ?? { k: 'mem', f: lv.f, t };
    }
    const cur = this.ops.stable(this.readLVal(lv));
    const before = wantValue && !e.prefix ? this.ops.toTemp(cur, t) : null;
    const tmp = this.ops.toTemp(cur, t);
    if (e.operator === '++') incrementInPlace(em, tmp, t.size);
    else decrementInPlace(em, tmp, t.size);
    this.storeLVal(lv, { k: 'mem', f: tmp, t });
    if (!wantValue) return undefined;
    return { k: 'mem', f: before ?? tmp, t };
  }
}
