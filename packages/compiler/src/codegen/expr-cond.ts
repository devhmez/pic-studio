import type { BinaryExpression, ConditionalExpression, Expression, IntType } from '../ast';
import { type ExprInfo, operandType } from '../sema/info';
import { pattern, U8 } from '../sema/types';
import { compareBorrow, loadByteW, type ByteSrc } from './arith';
import { COMPARE, ExprBase, type ImmOrMem, STATUS } from './expr-base';
import { at, C, type FileRef, Z } from './ir';
import { byteSrc, byteSrcs, type Val } from './values';

/** Expression code generation, layer 2: conditions as jumps (bit tests, comparisons, && || !) and 0/1 values. */
export abstract class CondGen extends ExprBase {
  /** 0/1 value of a condition, built with branches (MOVLW leaves the flags alone). */
  boolValue(e: Expression): Val {
    const inf = this.info(e);
    if (inf.value !== undefined) return { k: 'imm', v: inf.value ? 1 : 0, t: U8 };
    // Plain bits load without branches.
    const loc = this.bitLocation(e);
    if (loc) return { k: 'bit', ...loc };
    if (e.kind === 'UnaryExpression' && e.operator === '!') {
      const inner = this.bitLocation(e.argument);
      if (inner) {
        this.em.movlw(1);
        this.em.prepare(inner.f);
        this.em.bit('BTFSC', inner.f, inner.b);
        this.em.movlw(0);
        return { k: 'w', t: U8 };
      }
    }
    const lf = this.em.newLabel();
    const le = this.em.newLabel();
    this.branch(e, false, lf);
    this.em.movlw(1);
    this.em.goto(le);
    this.em.label(lf);
    this.em.movlw(0);
    this.em.label(le);
    return { k: 'w', t: U8 };
  }

  /** Location of a bit-valued expression (BitAccess, sbit, bit variable), or null. */
  bitLocation(e: Expression): { f: FileRef; b: number } | null {
    if (e.kind === 'BitAccess') return this.bitLoc(e);
    if (e.kind === 'Identifier') {
      const v = this.identifierValue(e);
      if (v.k === 'bit') return { f: v.f, b: v.b };
    }
    return null;
  }

  protected conditional(e: ConditionalExpression): Val {
    const t = this.intType(e);
    const lElse = this.em.newLabel();
    const lEnd = this.em.newLabel();
    this.branch(e.test, false, lElse);
    if (t.size === 1) {
      this.toW(e.consequent, t);
      this.em.goto(lEnd);
      this.em.label(lElse);
      this.toW(e.alternate, t);
      this.em.label(lEnd);
      return { k: 'w', t };
    }
    const dst = this.temps.alloc(t.size);
    this.ops.storeMem(dst, this.valueAs(e.consequent, t), t);
    this.em.goto(lEnd);
    this.em.label(lElse);
    this.ops.storeMem(dst, this.valueAs(e.alternate, t), t);
    this.em.label(lEnd);
    return { k: 'mem', f: dst, t };
  }

  // ===========================================================================================================
  // Conditions

  /** Jump to `label` when the truth of `e` equals `sense`; fall through otherwise. */
  branch(e: Expression, sense: boolean, label: string): void {
    const inf = this.info(e);
    if (inf.value !== undefined) {
      if (Boolean(inf.value) === sense) this.em.goto(label);
      return;
    }
    switch (e.kind) {
      case 'LogicalExpression':
        if ((e.operator === '&&') === !sense) {
          this.branch(e.left, sense, label);
          this.branch(e.right, sense, label);
        } else {
          const skip = this.em.newLabel();
          this.branch(e.left, !sense, skip);
          this.branch(e.right, sense, label);
          this.em.label(skip);
        }
        return;
      case 'UnaryExpression':
        if (e.operator === '!') {
          this.branch(e.argument, !sense, label);
          return;
        }
        break;
      case 'BinaryExpression':
        if (COMPARE.has(e.operator)) {
          this.compareBranch(e, sense, label);
          return;
        }
        break;
      case 'CastExpression':
        if (e.typeSpec.type.kind === 'bit' || e.typeSpec.type.kind === 'int') {
          // A cast to a narrower type changes the truth value; only widening/same-size casts are transparent.
          const it = this.info(e.argument).type;
          const ct = e.typeSpec.type;
          if (ct.kind === 'bit' || (it.kind === 'int' && ct.kind === 'int' && ct.size >= it.size)) {
            this.branch(e.argument, sense, label);
            return;
          }
        }
        break;
      default:
        break;
    }
    const loc = this.bitLocation(e);
    if (loc) {
      this.bitBranch(loc, sense, label);
      return;
    }
    this.truthBranch(this.value(e), sense, label);
  }

  protected bitBranch(loc: { f: FileRef; b: number }, sense: boolean, label: string): void {
    this.em.testBitGoto(sense ? 'BTFSC' : 'BTFSS', loc.f, loc.b, label, this.scratch);
  }

  protected truthBranch(v: Val, sense: boolean, label: string): void {
    const em = this.em;
    if (v.k === 'imm') {
      if (Boolean(pattern(v.v, v.t.size)) === sense) em.goto(label);
      return;
    }
    if (v.k === 'bit') {
      this.bitBranch(v, sense, label);
      return;
    }
    if (v.k === 'w') em.lit('IORLW', 0);
    else {
      em.movf(v.f, 0);
      for (let i = 1; i < v.t.size; i++) em.file('IORWF', at(v.f, i), 0);
    }
    em.testBitGoto(sense ? 'BTFSS' : 'BTFSC', STATUS, Z, label, this.scratch);
  }

  protected isBoolish(i: ExprInfo): boolean {
    return i.type.kind === 'bit' || Boolean(i.isBool);
  }

  protected compareBranch(e: BinaryExpression, sense: boolean, label: string): void {
    const op = e.operator;
    const li = this.info(e.left);
    const ri = this.info(e.right);
    // `PORTB.RB0 == 1`, `STATUS.F2 == 1`, `bit != 0`… compile to a single bit test.
    if ((op === '==' || op === '!=') && this.isBoolish(li) && ri.value !== undefined) {
      this.boolConstBranch(e.left, op, ri.value, sense, label);
      return;
    }
    if ((op === '==' || op === '!=') && this.isBoolish(ri) && li.value !== undefined) {
      this.boolConstBranch(e.right, op, li.value, sense, label);
      return;
    }
    const t = operandType(li, ri, false);
    if (op === '==' || op === '!=') {
      this.equalityBranch(e.left, e.right, t, (op === '==') === sense, label);
      return;
    }
    let x = e.left;
    let y = e.right;
    let neg = false;
    if (op === '>') [x, y] = [y, x];
    else if (op === '<=') {
      [x, y] = [y, x];
      neg = true;
    } else if (op === '>=') neg = true;
    // After computeBorrow, C = 1 iff x ≥ y; x < y iff C = 0.
    this.computeBorrow(x, y, t);
    const jumpOnC = sense === neg;
    this.em.testBitGoto(jumpOnC ? 'BTFSC' : 'BTFSS', STATUS, C, label, this.scratch);
  }

  protected boolConstBranch(x: Expression, op: '==' | '!=', c: number, sense: boolean, label: string): void {
    if (c !== 0 && c !== 1) {
      // A 0/1 value never equals another constant.
      const alwaysTrue = op === '!=';
      this.discard(x);
      if (alwaysTrue === sense) this.em.goto(label);
      return;
    }
    const whenTrue = (op === '==') === (c === 1);
    this.branch(x, whenTrue ? sense : !sense, label);
  }

  /** Jump when (L == R) === jumpIfEqual. */
  protected equalityBranch(L: Expression, R: Expression, t: IntType, jumpIfEqual: boolean, label: string): void {
    const em = this.em;
    const zTest = jumpIfEqual ? 'BTFSC' : 'BTFSS';
    if (t.size === 1) {
      const lz = this.info(L).value === 0;
      const rz = this.info(R).value === 0;
      if (lz || rz) {
        this.setZFor(rz ? L : R, t);
      } else {
        this.bin8('^', L, R, t);
      }
      em.testBitGoto(zTest, STATUS, Z, label, this.scratch);
      return;
    }
    const a = this.ops.stable(this.valueAs(L, t));
    const b = this.ops.stable(this.valueAs(R, t));
    const ne = jumpIfEqual ? em.newLabel() : label;
    for (let i = 0; i < t.size; i++) {
      const ai = byteSrc(a, i);
      const bi = byteSrc(b, i);
      if ('imm' in ai && 'imm' in bi) {
        if (ai.imm !== bi.imm) em.goto(ne);
        continue;
      }
      this.byteOp('^', ai, bi);
      em.testBitGoto('BTFSS', STATUS, Z, ne, this.scratch);
    }
    if (jumpIfEqual) {
      em.goto(label);
      em.label(ne);
    }
  }

  /** Z ← (e == 0) for an 8-bit value. */
  protected setZFor(e: Expression, t: IntType): void {
    const s = this.simple(e, t);
    if (s && s.k === 'mem') {
      this.em.movf(s.f, 0);
      return;
    }
    this.toW(e, t);
    this.em.lit('IORLW', 0);
  }

  /** C ← (x ≥ y) for the operand type `t` (signed compares flip the sign bits). */
  protected computeBorrow(x: Expression, y: Expression, t: IntType): void {
    const em = this.em;
    if (t.size === 1 && !t.signed) {
      this.bin8('-', x, y, t);
      return;
    }
    const a = this.ops.stable(this.valueAs(x, t));
    const b = this.ops.stable(this.valueAs(y, t));
    const n = t.size;
    const as = byteSrcs(a, n);
    const bs = byteSrcs(b, n);
    if (t.signed) {
      as[n - 1] = this.flipSign(as[n - 1]);
      bs[n - 1] = this.flipSign(bs[n - 1]);
    }
    if (n === 1) {
      const l: ImmOrMem = 'imm' in as[0] ? { k: 'imm', v: as[0].imm, t: U8 } : { k: 'mem', f: as[0].f, t: U8 };
      const r: ImmOrMem = 'imm' in bs[0] ? { k: 'imm', v: bs[0].imm, t: U8 } : { k: 'mem', f: bs[0].f, t: U8 };
      this.bin8Vals('-', l, r);
      return;
    }
    compareBorrow(em, as, bs, n, this.scratch());
  }

  protected flipSign(b: ByteSrc): ByteSrc {
    if ('imm' in b) return { imm: b.imm ^ 0x80 };
    const t = this.temps.alloc(1);
    loadByteW(this.em, b);
    this.em.lit('XORLW', 0x80);
    this.em.movwf(t);
    return { f: t };
  }
}
