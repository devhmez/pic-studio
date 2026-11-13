import { bankOfAddress } from '../device';
import { InternalError } from '../diagnostics';
import { at, type FileRef, type Instr, type Lit, R, RP0, sfr, type Target } from './ir';
import { type BitOp, type FileOp, type LitOp, type NoArgOp, SKIP_OPS } from './isa';

export type BankState = 0 | 1 | null;

/** Shared label counter for one compilation. */
export class LabelFactory {
  private n = 0;

  next(prefix: string): string {
    return `${prefix}${this.n++}`;
  }
}

/** True when the operand is only reachable with RP0 = 1 (TRISA/TRISB/OPTION_REG/EECON1/EECON2). */
export function needsBank1(f: FileRef): boolean {
  return f.kind === 'sfr' && bankOfAddress(f.addr) === 1;
}

/**
 * Instruction sink with automatic RP0 bank selection.
 *
 * Invariant (except in raw mode): the bank is 0 at every label, jump, call and return, so merge points never need
 * bank tracking. Bank switches use BSF/BCF STATUS,RP0, which leave C/DC/Z untouched. No bank switch may sit
 * between a skip instruction and the instruction it skips; callers select the bank before the skip.
 */
export class Emitter {
  readonly code: Instr[] = [];
  bank: BankState;
  /** C source line attached to the next instructions. */
  line: number | undefined;
  /** Raw mode: no automatic bank normalisation (hand-written runtime sequences). */
  raw = false;
  private lastWasSkip = false;

  constructor(
    readonly labels: LabelFactory,
    readonly labelPrefix: string,
    initialBank: BankState = 0,
  ) {
    this.bank = initialBank;
  }

  newLabel(): string {
    return this.labels.next(`L_${this.labelPrefix}_`);
  }

  private push(i: Instr): void {
    if (i.t !== 'label') i.line = this.line;
    this.code.push(i);
    this.lastWasSkip = i.t !== 'label' && SKIP_OPS.has(i.op);
  }

  private switchTo(bank: 0 | 1): void {
    if (this.lastWasSkip) throw new InternalError('bank switch right after a skip instruction');
    this.push({ t: 'bit', op: bank === 1 ? 'BSF' : 'BCF', f: sfr(R.STATUS), b: RP0 });
    this.bank = bank;
  }

  /** Select the bank an operand needs (no-op for GPRs and mirrored SFRs). */
  prepare(f: FileRef): void {
    if (f.kind !== 'sfr') return;
    const need = bankOfAddress(f.addr);
    if (need === 'both' || this.bank === need) return;
    this.switchTo(need);
  }

  /** Force bank 0 (labels, jumps, calls and returns). */
  bank0(): void {
    if (this.bank !== 0) this.switchTo(0);
  }

  setBank1(): void {
    this.switchTo(1);
  }

  setBank0(): void {
    this.switchTo(0);
  }

  // -----------------------------------------------------------------------------------------------------------
  // Instructions

  file(op: FileOp, f: FileRef, d: 0 | 1 = 1): void {
    this.prepare(f);
    const conditional = this.lastWasSkip;
    this.push({ t: 'file', op, f, d });
    if (f.kind === 'sfr' && (f.addr & 0x7f) === R.STATUS && (op === 'MOVWF' || op === 'CLRF' || (d === 1 && op !== 'MOVF'))) {
      // Writing STATUS may change RP0 (CLRF STATUS selects bank 0).
      this.bankAfter(op === 'CLRF' ? 0 : null, conditional);
    }
  }

  movf(f: FileRef, d: 0 | 1 = 0): void { this.file('MOVF', f, d); }
  movwf(f: FileRef): void { this.file('MOVWF', f); }
  clrf(f: FileRef): void { this.file('CLRF', f); }

  bit(op: BitOp, f: FileRef, b: number): void {
    this.prepare(f);
    const conditional = this.lastWasSkip;
    this.push({ t: 'bit', op, f, b });
    if (f.kind === 'sfr' && (f.addr & 0x7f) === R.STATUS && b === RP0 && (op === 'BSF' || op === 'BCF')) {
      this.bankAfter(op === 'BSF' ? 1 : 0, conditional);
    }
  }

  /**
   * Record the bank after an instruction that writes RP0. When that instruction sits under a skip it may not run
   * (e.g. `BTFSC tmp,0 / BSF STATUS,RP0 / BTFSS tmp,0 / BCF STATUS,RP0` copies a run-time bit into RP0), so the
   * bank is only known if both paths agree.
   */
  private bankAfter(bank: BankState, conditional: boolean): void {
    this.bank = !conditional || this.bank === bank ? bank : null;
  }

  lit(op: LitOp, k: Lit): void {
    this.push({ t: 'lit', op, k: typeof k === 'number' ? k & 0xff : k });
  }

  movlw(k: Lit): void { this.lit('MOVLW', k); }

  label(name: string): void {
    if (!this.raw) this.bank0();
    this.code.push({ t: 'label', name });
    this.lastWasSkip = false;
    if (!this.raw) this.bank = 0;
  }

  goto(target: Target): void {
    if (!this.raw) this.bank0();
    this.push({ t: 'jump', op: 'GOTO', target });
  }

  call(target: string): void {
    if (!this.raw) this.bank0();
    this.push({ t: 'jump', op: 'CALL', target });
    if (!this.raw) this.bank = 0;
  }

  none(op: NoArgOp): void {
    if (!this.raw && (op === 'RETURN' || op === 'RETFIE')) this.bank0();
    this.push({ t: 'none', op });
  }

  retlw(k: number): void {
    if (!this.raw) this.bank0();
    this.push({ t: 'lit', op: 'RETLW', k: k & 0xff });
  }

  /** `BTFSx f,b` + `GOTO target`, jumping in bank 0. Bank-1 operands are read with SWAPF (flag-neutral). */
  testBitGoto(op: 'BTFSC' | 'BTFSS', f: FileRef, b: number, target: Target, scratch: () => FileRef): void {
    if (needsBank1(f)) {
      const tmp = scratch();
      this.file('SWAPF', f, 0);
      this.movwf(tmp);
      this.bank0();
      this.bit(op, tmp, (b + 4) & 7);
    } else {
      this.bank0();
      this.bit(op, f, b);
    }
    this.goto(target);
  }

  /** `DECFSZ f,F` + `GOTO target`. */
  decfszGoto(f: FileRef, target: Target): void {
    this.bank0();
    this.file('DECFSZ', f, 1);
    this.goto(target);
  }

  /** Copy `size` bytes from one object to another through W. */
  copy(dst: FileRef, src: FileRef, size: number): void {
    for (let i = 0; i < size; i++) {
      this.movf(at(src, i), 0);
      this.movwf(at(dst, i));
    }
  }
}
