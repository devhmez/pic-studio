import { addInPlace, negateInPlace, shiftLeftOnce, subInPlace, type ByteSrc } from './arith';
import { emitDelayCycles } from './delay';
import { Emitter, type LabelFactory } from './emitter';
import { at, C, type FileRef, R, sfr, slotRef, Z } from './ir';
import { addSlot, type CodeUnit, newFrame } from './units';

export type ExecContext = 'main' | 'isr';

export type HelperKind =
  | { kind: 'mul'; size: number }
  | { kind: 'div'; size: number; signed: boolean }
  | { kind: 'vdelay' }
  | { kind: 'delaycyc' }
  | { kind: 'button' }
  | { kind: 'eeread' }
  | { kind: 'eewrite' }
  | { kind: 'tbljump' };

export interface HelperRef {
  label: string;
  /** Parameter locations in call order. */
  params: FileRef[];
  /** Product / quotient (mul, div). */
  result?: FileRef;
  /** Remainder (div). */
  remainder?: FileRef;
}

const STATUS = sfr(R.STATUS);
const files = (f: FileRef, n: number): ByteSrc[] => Array.from({ length: n }, (_, i) => ({ f: at(f, i) }));

/**
 * Runtime library generated on demand. Helpers are not reentrant (static frames), so a separate copy is
 * generated for code running in the interrupt routine.
 */
export class Runtime {
  private readonly made = new Map<string, { unit: CodeUnit; ref: HelperRef }>();

  constructor(
    private readonly labels: LabelFactory,
    private readonly clockHz: number,
  ) {}

  get units(): CodeUnit[] {
    return [...this.made.values()].map((m) => m.unit);
  }

  get(h: HelperKind, ctx: ExecContext): HelperRef {
    const suffix = ctx === 'isr' ? '_isr' : '';
    const base =
      h.kind === 'mul' ? `__mul${h.size * 8}` :
      h.kind === 'div' ? `__div${h.signed ? 's' : 'u'}${h.size * 8}` :
      h.kind === 'tbljump' ? '__tbl_jump' : `__${h.kind}`;
    // The table jump has no RAM, so one copy serves both contexts.
    const name = h.kind === 'tbljump' ? base : base + suffix;
    const existing = this.made.get(name);
    if (existing) return existing.ref;
    const made = this.build(h, name, ctx);
    this.made.set(name, made);
    return made.ref;
  }

  private build(h: HelperKind, name: string, ctx: ExecContext): { unit: CodeUnit; ref: HelperRef } {
    const frame = newFrame(name);
    const em = new Emitter(this.labels, name.replace(/^_+/, ''));
    const unit: CodeUnit = { name, kind: 'helper', code: em.code, frame, callees: new Set(), jumps: new Set() };
    em.label(name);
    let ref: HelperRef;
    switch (h.kind) {
      case 'mul':
        ref = this.mul(em, unit, h.size);
        break;
      case 'div':
        ref = this.div(em, unit, h.size, h.signed);
        break;
      case 'vdelay':
        ref = this.vdelay(em, unit);
        break;
      case 'delaycyc':
        ref = this.delayCyc(em, unit);
        break;
      case 'button':
        ref = this.button(em, unit, ctx);
        break;
      case 'eeread':
        ref = this.eeread(em, unit);
        break;
      case 'eewrite':
        ref = this.eewrite(em, unit);
        break;
      case 'tbljump':
        // W = low byte of the entry, PCLATH = high byte: jump there; the RETLW entry returns to our caller.
        em.movwf(sfr(R.PCL));
        ref = { label: name, params: [] };
        break;
    }
    ref.label = name;
    return { unit, ref };
  }

  /** Shift-and-add multiply, result truncated to `n` bytes. */
  private mul(em: Emitter, unit: CodeUnit, n: number): HelperRef {
    const a = slotRef(addSlot(unit.frame, `${unit.name}.a`, n));
    const b = slotRef(addSlot(unit.frame, `${unit.name}.b`, n));
    const r = slotRef(addSlot(unit.frame, `${unit.name}.r`, n));
    const cnt = slotRef(addSlot(unit.frame, `${unit.name}.cnt`, 1));
    const scratch = slotRef(addSlot(unit.frame, `${unit.name}.t`, 1));
    for (let i = 0; i < n; i++) em.clrf(at(r, i));
    em.movlw(8 * n);
    em.movwf(cnt);
    const loop = em.newLabel();
    const skip = em.newLabel();
    em.label(loop);
    em.bit('BTFSS', b, 0);
    em.goto(skip);
    addInPlace(em, r, files(a, n), n, scratch);
    em.label(skip);
    shiftLeftOnce(em, a, n);
    em.bit('BCF', STATUS, C);
    for (let i = n - 1; i >= 0; i--) em.file('RRF', at(b, i), 1);
    em.file('DECFSZ', cnt, 1);
    em.goto(loop);
    if (n === 1) em.movf(r, 0);
    em.none('RETURN');
    return { label: unit.name, params: [a, b], result: r };
  }

  /** Restoring division: a ← a / b, rem ← a % b. Signed variant works on magnitudes and fixes the signs. */
  private div(em: Emitter, unit: CodeUnit, n: number, signed: boolean): HelperRef {
    const a = slotRef(addSlot(unit.frame, `${unit.name}.a`, n));
    const b = slotRef(addSlot(unit.frame, `${unit.name}.b`, n));
    const rem = slotRef(addSlot(unit.frame, `${unit.name}.rem`, n));
    const t = slotRef(addSlot(unit.frame, `${unit.name}.t`, n));
    const cnt = slotRef(addSlot(unit.frame, `${unit.name}.cnt`, 1));
    const ovf = slotRef(addSlot(unit.frame, `${unit.name}.ovf`, 1));
    const scratch = slotRef(addSlot(unit.frame, `${unit.name}.s`, 1));
    const sgn = signed ? slotRef(addSlot(unit.frame, `${unit.name}.sgn`, 1)) : null;

    if (sgn) {
      // bit 0: quotient negative, bit 1: remainder negative (sign of the dividend, as in C).
      em.clrf(sgn);
      const pa = em.newLabel();
      em.bit('BTFSS', at(a, n - 1), 7);
      em.goto(pa);
      negateInPlace(em, a, n);
      em.movlw(3);
      em.file('XORWF', sgn, 1);
      em.label(pa);
      const pb = em.newLabel();
      em.bit('BTFSS', at(b, n - 1), 7);
      em.goto(pb);
      negateInPlace(em, b, n);
      em.movlw(1);
      em.file('XORWF', sgn, 1);
      em.label(pb);
    }

    for (let i = 0; i < n; i++) em.clrf(at(rem, i));
    em.movlw(8 * n);
    em.movwf(cnt);
    const loop = em.newLabel();
    const next = em.newLabel();
    em.label(loop);
    // (rem:a) <<= 1
    shiftLeftOnce(em, a, n);
    for (let i = 0; i < n; i++) em.file('RLF', at(rem, i), 1);
    // A bit shifted out of rem means rem ≥ 2^(8n) > b: the subtraction must happen.
    em.clrf(ovf);
    em.file('RLF', ovf, 1);
    em.copy(t, rem, n);
    subInPlace(em, t, files(b, n), n, scratch);
    em.bit('BTFSC', ovf, 0);
    em.bit('BSF', STATUS, C);
    em.bit('BTFSS', STATUS, C);
    em.goto(next);
    em.copy(rem, t, n);
    em.bit('BSF', a, 0);
    em.label(next);
    em.file('DECFSZ', cnt, 1);
    em.goto(loop);

    if (sgn) {
      const fq = em.newLabel();
      em.bit('BTFSS', sgn, 0);
      em.goto(fq);
      negateInPlace(em, a, n);
      em.label(fq);
      const fr = em.newLabel();
      em.bit('BTFSS', sgn, 1);
      em.goto(fr);
      negateInPlace(em, rem, n);
      em.label(fr);
    }
    em.none('RETURN');
    return { label: unit.name, params: [a, b], result: a, remainder: rem };
  }

  /** Vdelay_ms(n): n × (1 ms busy wait); the loop overhead is 10 cycles per millisecond. */
  private vdelay(em: Emitter, unit: CodeUnit): HelperRef {
    const n = slotRef(addSlot(unit.frame, `${unit.name}.n`, 2));
    const counters = [0, 1, 2, 3].map((i) => slotRef(addSlot(unit.frame, `${unit.name}.c${i}`, 1)));
    const loop = em.newLabel();
    em.label(loop);
    em.movf(n, 0);
    em.file('IORWF', at(n, 1), 0);
    em.bit('BTFSC', STATUS, Z);
    em.none('RETURN');
    const perMs = Math.round(this.clockHz / 4000);
    emitDelayCycles(em, Math.max(0, perMs - 10), counters);
    em.movlw(1);
    em.file('SUBWF', n, 1);
    em.bit('BTFSS', STATUS, C);
    em.file('DECF', at(n, 1), 1);
    em.goto(loop);
    return { label: unit.name, params: [n] };
  }

  /**
   * Delay_Cyc(n) with a run-time n, passed in W: exactly 10·n cycles from the 1-cycle instruction that loads W
   * through the RETURN (n = 1..255; 0 counts as 256). Load W + CALL + MOVWF + GOTO = 6 cycles, each pass of the loop
   * 10 cycles (7 of padding + DECFSZ + GOTO), and the last DECFSZ (skip, 2) + RETURN (2) replace one pass.
   */
  private delayCyc(em: Emitter, unit: CodeUnit): HelperRef {
    const cnt = slotRef(addSlot(unit.frame, `${unit.name}.n`, 1));
    const loop = em.newLabel();
    const test = em.newLabel();
    em.movwf(cnt);
    em.goto(test);
    em.label(loop);
    for (let i = 0; i < 3; i++) em.goto({ rel: 1 });
    em.none('NOP');
    em.label(test);
    em.file('DECFSZ', cnt, 1);
    em.goto(loop);
    em.none('RETURN');
    return { label: unit.name, params: [] };
  }

  /** Button(&port, pin, time, active_state): 255 when the pin is in the active state before and after `time` ms. */
  private button(em: Emitter, unit: CodeUnit, ctx: ExecContext): HelperRef {
    const f = unit.frame;
    const port = slotRef(addSlot(f, `${unit.name}.port`, 1));
    const pin = slotRef(addSlot(f, `${unit.name}.pin`, 1));
    const time = slotRef(addSlot(f, `${unit.name}.time`, 1));
    const active = slotRef(addSlot(f, `${unit.name}.active`, 1));
    const mask = slotRef(addSlot(f, `${unit.name}.mask`, 1));
    const cnt = slotRef(addSlot(f, `${unit.name}.cnt`, 1));
    const vd = this.get({ kind: 'vdelay' }, ctx);
    unit.callees.add(vd.label);

    // active ← (active != 0)
    em.movf(active, 0);
    em.bit('BTFSS', STATUS, Z);
    em.movlw(1);
    em.movwf(active);
    // mask ← 1 << (pin & 7)
    em.movlw(1);
    em.movwf(mask);
    em.movf(pin, 0);
    em.lit('ANDLW', 7);
    em.movwf(cnt);
    const ml = em.newLabel();
    const md = em.newLabel();
    em.label(ml);
    em.movf(cnt, 1);
    em.bit('BTFSC', STATUS, Z);
    em.goto(md);
    em.bit('BCF', STATUS, C);
    em.file('RLF', mask, 1);
    em.file('DECF', cnt, 1);
    em.goto(ml);
    em.label(md);
    const testActive = () => {
      em.movf(port, 0);
      em.movwf(sfr(R.FSR));
      em.movf(sfr(R.INDF), 0);
      em.file('ANDWF', mask, 0);
      em.bit('BTFSS', STATUS, Z);
      em.movlw(1);
      em.file('XORWF', active, 0);
      em.bit('BTFSS', STATUS, Z);
      em.retlw(0);
    };
    testActive();
    em.movf(time, 0);
    em.movwf(vd.params[0]);
    em.clrf(at(vd.params[0], 1));
    em.call(vd.label);
    testActive();
    em.retlw(255);
    return { label: unit.name, params: [port, pin, time, active] };
  }

  /** Wait for any EEPROM write in progress (WR = 1), in bank 1. Leaves bank 1 selected. */
  private waitEepromIdle(em: Emitter): void {
    const wait = em.newLabel();
    em.label(wait);
    em.setBank1();
    em.bit('BTFSC', sfr(R.EECON1), 1);
    em.goto(wait);
  }

  private eeread(em: Emitter, unit: CodeUnit): HelperRef {
    const addr = slotRef(addSlot(unit.frame, `${unit.name}.addr`, 1));
    em.raw = true;
    this.waitEepromIdle(em);
    em.setBank0();
    em.movf(addr, 0);
    em.movwf(sfr(R.EEADR));
    em.setBank1();
    em.bit('BSF', sfr(R.EECON1), 0); // RD
    em.setBank0();
    em.movf(sfr(R.EEDATA), 0);
    em.none('RETURN');
    em.raw = false;
    return { label: unit.name, params: [addr] };
  }

  /** EEPROM write with the required 0x55/0xAA unlock sequence; GIE is cleared during the sequence and restored. */
  private eewrite(em: Emitter, unit: CodeUnit): HelperRef {
    const addr = slotRef(addSlot(unit.frame, `${unit.name}.addr`, 1));
    const data = slotRef(addSlot(unit.frame, `${unit.name}.data`, 1));
    const gie = slotRef(addSlot(unit.frame, `${unit.name}.gie`, 1));
    em.raw = true;
    this.waitEepromIdle(em);
    em.setBank0();
    em.movf(addr, 0);
    em.movwf(sfr(R.EEADR));
    em.movf(data, 0);
    em.movwf(sfr(R.EEDATA));
    em.movf(sfr(R.INTCON), 0);
    em.movwf(gie);
    em.bit('BCF', sfr(R.INTCON), 7);
    em.setBank1();
    em.bit('BSF', sfr(R.EECON1), 2); // WREN
    em.movlw(0x55);
    em.movwf(sfr(R.EECON2));
    em.movlw(0xaa);
    em.movwf(sfr(R.EECON2));
    em.bit('BSF', sfr(R.EECON1), 1); // WR
    em.bit('BCF', sfr(R.EECON1), 2); // WREN off (the write already started)
    em.setBank0();
    em.bit('BTFSC', gie, 7);
    em.bit('BSF', sfr(R.INTCON), 7);
    em.none('RETURN');
    em.raw = false;
    return { label: unit.name, params: [addr, data] };
  }
}
