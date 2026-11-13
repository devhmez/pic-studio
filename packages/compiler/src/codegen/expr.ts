import type { CallExpression, IntType } from '../ast';
import { BYTE_SELECTORS, type FuncSymbol } from '../sema/symbols';
import { pattern, U16, U8 } from '../sema/types';
import { cyclesForMicroseconds, emitDelayCycles } from './delay';
import { AssignGen } from './expr-assign';
import { at, type FileRef } from './ir';
import type { Val } from './values';

/** Expression code generation, top layer: user function calls and MikroC built-in routines. */
export class ExprGen extends AssignGen {
  // ===========================================================================================================
  // Calls

  call(e: CallExpression): Val {
    const fn = this.svc.sem.calls.get(e);
    if (!fn) return { k: 'imm', v: 0, t: U8 };
    if (fn.builtin) return this.builtin(e, fn);
    const vals = e.args.map((a, i) => {
      const pt = fn.params[i]?.type;
      const t: IntType = pt?.kind === 'int' ? pt : U8;
      return { v: this.ops.stable(this.valueAs(a, t)), t };
    });
    vals.forEach(({ v, t }, i) => this.ops.storeMem(this.svc.varRef(fn.params[i]), v, t));
    const label = this.svc.functionLabel(fn);
    this.unit.callees.add(label);
    this.em.call(label);
    const rt = fn.returnType;
    if (rt.kind !== 'int') return { k: 'imm', v: 0, t: U8 };
    if (rt.size === 1) return { k: 'w', t: rt };
    const dst = this.temps.alloc(rt.size);
    this.em.copy(dst, this.svc.returnRef(fn), rt.size);
    return { k: 'mem', f: dst, t: rt };
  }

  /** Four scratch bytes for delay loop counters. */
  protected delayCounters(): FileRef[] {
    const base = this.temps.alloc(4);
    return [0, 1, 2, 3].map((i) => at(base, i));
  }

  protected builtin(e: CallExpression, fn: FuncSymbol): Val {
    const em = this.em;
    const arg = (i: number) => e.args[i];
    const constArg = (i: number) => this.info(arg(i)).value ?? 0;
    const viaXc8 = e.callee.name.startsWith('__');
    const clock = viaXc8 && this.svc.xtalFreq ? this.svc.xtalFreq : this.svc.clockHz;
    const helper = (kind: 'vdelay' | 'delaycyc' | 'button' | 'eeread' | 'eewrite') => {
      const h = this.svc.runtime.get({ kind }, this.ctx);
      this.unit.callees.add(h.label);
      return h;
    };
    switch (fn.builtin) {
      case 'delay_ms': {
        const m = this.temps.mark();
        emitDelayCycles(em, cyclesForMicroseconds(constArg(0) * 1000, clock), this.delayCounters());
        this.temps.release(m);
        return { k: 'imm', v: 0, t: U8 };
      }
      case 'delay_us': {
        const m = this.temps.mark();
        emitDelayCycles(em, cyclesForMicroseconds(constArg(0), clock), this.delayCounters());
        this.temps.release(m);
        return { k: 'imm', v: 0, t: U8 };
      }
      case 'delay_cyc': {
        if (this.info(arg(0)).value === undefined) {
          const h = helper('delaycyc');
          this.toW(arg(0), U8);
          em.call(h.label);
          return { k: 'imm', v: 0, t: U8 };
        }
        const m = this.temps.mark();
        // Same count as the run-time routine: the argument is a char, and 0 counts as 256.
        emitDelayCycles(em, 10 * (pattern(constArg(0), 1) || 256), this.delayCounters());
        this.temps.release(m);
        return { k: 'imm', v: 0, t: U8 };
      }
      case 'vdelay_ms': {
        const h = helper('vdelay');
        const v = this.ops.stable(this.valueAs(arg(0), U16));
        this.ops.storeMem(h.params[0], v, U16);
        em.call(h.label);
        return { k: 'imm', v: 0, t: U8 };
      }
      case 'button': {
        const h = helper('button');
        const vals = e.args.map((a) => this.ops.stable(this.valueAs(a, U8)));
        vals.forEach((v, i) => this.ops.storeMem(h.params[i], v, U8));
        em.call(h.label);
        return { k: 'w', t: U8 };
      }
      case 'eeprom_read': {
        const h = helper('eeread');
        this.ops.storeMem(h.params[0], this.valueAs(arg(0), U8), U8);
        em.call(h.label);
        return { k: 'w', t: U8 };
      }
      case 'eeprom_write': {
        const h = helper('eewrite');
        const a = this.ops.stable(this.valueAs(arg(0), U8));
        const d = this.ops.stable(this.valueAs(arg(1), U8));
        this.ops.storeMem(h.params[0], a, U8);
        this.ops.storeMem(h.params[1], d, U8);
        em.call(h.label);
        return { k: 'imm', v: 0, t: U8 };
      }
      case 'swap': {
        const v = this.ops.stable(this.valueAs(arg(0), U8));
        if (v.k === 'imm') return { k: 'imm', v: ((v.v & 0x0f) << 4) | ((v.v >> 4) & 0x0f), t: U8 };
        em.file('SWAPF', (v as Val & { k: 'mem' }).f, 0);
        return { k: 'w', t: U8 };
      }
      case 'lo':
      case 'hi':
      case 'higher':
      case 'highest': {
        const k = BYTE_SELECTORS[fn.builtin]!;
        const at0 = this.info(arg(0)).type;
        const size = at0.kind === 'int' ? at0.size : 1;
        const v = this.ops.stable(this.value(arg(0)));
        if (k >= size || v.k !== 'mem') return { k: 'imm', v: 0, t: U8 };
        return { k: 'mem', f: at(v.f, k), t: U8 };
      }
      default:
        e.args.forEach((a) => this.discard(a));
        return { k: 'imm', v: 0, t: U8 };
    }
  }
}
