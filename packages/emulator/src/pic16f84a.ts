// Cycle-accurate PIC16F84A core (DS35007). Semantics follow the datasheet; where it is silent,
// the choice made is documented where it is implemented.
import type { CoreSnapshot, Drive, Level, PicCore, PinName, ResetKind, StepResult } from './api';
import { PIN_NAMES } from './api';
import { DataEeprom, EEPROM_ERASED, EEPROM_WRITE_TIME_S } from './eeprom';
import { Op, PACK_D, decodePacked } from './isa';
import { PIN_INDEX, PORTA_MASK, PortState } from './ports';
import {
  CONFIG_WDTE, DEFAULT_CONFIG, EECON1_EEIF, EECON1_RD, EECON1_WR, EEPROM_BYTES, GPR_FIRST, GPR_LAST,
  INTCON_EEIE, INTCON_GIE, INTCON_INTF, INTCON_RBIF, INTCON_T0IF, INTERRUPT_VECTOR,
  OPTION_INTEDG, OPTION_PSA, OPTION_RBPU, OPTION_T0CS, OPTION_T0SE, PROGRAM_WORDS, RESET_VECTOR, SFR,
  STATUS_C, STATUS_DC, STATUS_PD, STATUS_RP0, STATUS_TO, STATUS_Z,
} from './sfr';
import { Timer0 } from './timer0';

export const DEFAULT_CLOCK_HZ = 1_000_000;
/** Proteus PIC16 model property WDT_PERIOD=18m (datasheet: 18 ms nominal, no prescaler). */
export const WDT_PERIOD_S = 0.018;

// Operation numbers as module-local constants: with `case Op.ADDWF:` (a property load per case)
// V8 cannot build a jump table for the dispatch switch and run() is ~3.5x slower.
const {
  NOP: OP_NOP, MOVWF: OP_MOVWF, CLRW: OP_CLRW, CLRF: OP_CLRF, SUBWF: OP_SUBWF, DECF: OP_DECF,
  IORWF: OP_IORWF, ANDWF: OP_ANDWF, XORWF: OP_XORWF, ADDWF: OP_ADDWF, MOVF: OP_MOVF, COMF: OP_COMF,
  INCF: OP_INCF, DECFSZ: OP_DECFSZ, RRF: OP_RRF, RLF: OP_RLF, SWAPF: OP_SWAPF, INCFSZ: OP_INCFSZ,
  BCF: OP_BCF, BSF: OP_BSF, BTFSC: OP_BTFSC, BTFSS: OP_BTFSS, CALL: OP_CALL, GOTO: OP_GOTO,
  MOVLW: OP_MOVLW, RETLW: OP_RETLW, IORLW: OP_IORLW, ANDLW: OP_ANDLW, XORLW: OP_XORLW,
  SUBLW: OP_SUBLW, ADDLW: OP_ADDLW, RETURN: OP_RETURN, RETFIE: OP_RETFIE, SLEEP: OP_SLEEP,
  CLRWDT: OP_CLRWDT, OPTION: OP_OPTION, TRIS: OP_TRIS, INVALID: OP_INVALID,
} = Op;
const PC_MASK = 0x1fff;
const FETCH_MASK = PROGRAM_WORDS - 1;
/** Erased flash word (decodes as ADDLW 0xFF). */
const BLANK_WORD = 0x3fff;
const STACK_LEVELS = 8;
const FLAGS_CDZ = STATUS_C | STATUS_DC | STATUS_Z;
/** STATUS bits a program can never write. */
const STATUS_TO_PD = STATUS_TO | STATUS_PD;

/**
 * Interrupt latency model (DS35007 §6.9 and its INT pin timing figure: flags are "sampled every
 * Q1", latency "the same for one or two cycle instructions"). Flags are sampled at Q1 of every
 * instruction cycle, including the second cycle of a 2-cycle instruction. When GIE and an enabled
 * flag are both set at a Q1, the instruction executing in that cycle completes (both cycles when it
 * is sampled in its first one), then dummy cycles push the PC, clear GIE and load 0004h, so that the
 * first ISR instruction starts exactly INTERRUPT_LATENCY Tcy after the sampling point:
 *   - 1-cycle instruction + 2 dummy cycles;
 *   - 2-cycle instruction sampled in its first cycle + 1 dummy cycle;
 *   - 2-cycle instruction sampled in its second cycle + 2 dummy cycles (the PC pushed is then the
 *     jump target; e.g. RETFIE, which sets GIE in its first cycle, re-enters a still-pending
 *     interrupt without running a main-line instruction).
 * Measured from an asynchronous edge (RB0/INT, RB port change) this is the datasheet's 3–4 Tcy.
 * The dummy cycles form their own step() (StepResult.cycles 1 or 2, as api.ts specifies).
 */
const INTERRUPT_LATENCY = 3;
/** Opcode reported for the interrupt-entry dummy cycles: the core executes a forced NOP. */
const FORCED_NOP = 0x0000;

export interface Pic16F84AOptions {
  /** Oscillator frequency in Hz (Proteus CLOCK property). Default 1 MHz. */
  clockHz?: number;
}

/** StepResult with the core-specific details of the step. */
export interface Pic16F84AStepResult extends StepResult {
  /**
   * True when this step was the dummy cycles of an interrupt entry: no instruction executed,
   * `pc` is the return address pushed on the stack and `opcode` the forced NOP (0x0000).
   */
  interruptEntry: boolean;
}

function cyclesFor(seconds: number, clockHz: number): number {
  return Math.max(1, Math.round((seconds * clockHz) / 4));
}

export class Pic16F84A implements PicCore {
  readonly clockHz: number;
  readonly tcy: number;
  readonly pinNames: readonly PinName[] = PIN_NAMES;
  /**
   * Called by run() after every instruction that changed a port latch, a TRIS register or the
   * PORTB pull-ups, so the circuit can re-solve in the middle of a slice. step() reports the same
   * information in StepResult.ioChanged instead.
   */
  onIoChange: (() => void) | null = null;

  private readonly programMemory = new Uint16Array(PROGRAM_WORDS).fill(BLANK_WORD);
  /** Pre-decoded program (see isa.decodePacked). */
  private readonly decoded = new Int32Array(PROGRAM_WORDS);
  /** General-purpose RAM indexed by the 7-bit register address (0x0C–0x4F used, mirrored in bank 1). */
  private readonly ram = new Uint8Array(0x80);
  private readonly stack = new Uint16Array(STACK_LEVELS);
  private readonly timer = new Timer0();
  private readonly ee = new DataEeprom();
  private readonly io = new PortState();
  private readonly eeWriteCycles: number;
  private readonly wdtPeriodCycles: number;

  private cfg = DEFAULT_CONFIG;
  private pcReg = 0;
  private wReg = 0;
  private status = STATUS_TO_PD;
  private fsr = 0;
  private pclath = 0;
  private intcon = 0;
  private option = 0xff;
  /** Next free stack slot; the stack is circular, so a 9th push overwrites the oldest entry. */
  private sp = 0;
  private stackDepth = 0;
  private stackOverflowed = false;
  private stackUnderflowed = false;
  private totalCycles = 0;
  private isSleeping = false;
  private sleepAddr = 0;
  private isHalted = false;
  /** Set by a write to PCL during the current instruction (2-cycle instruction). */
  private pclWritten = false;
  /** Dummy cycles of a committed interrupt entry, run by the next step (0: none pending). */
  private pendingEntry = 0;
  private ioDirty = false;
  private wdtEnabled = false;
  private wdtDeadline = Infinity;
  /** Earliest absolute cycle at which a timed event (EEPROM write end, WDT time-out) is due. */
  private nextEventAt = Infinity;

  constructor(opts: Pic16F84AOptions = {}) {
    this.clockHz = opts.clockHz ?? DEFAULT_CLOCK_HZ;
    if (!(this.clockHz > 0)) throw new RangeError(`Fréquence d'horloge invalide : ${this.clockHz}`);
    this.tcy = 4 / this.clockHz;
    this.eeWriteCycles = cyclesFor(EEPROM_WRITE_TIME_S, this.clockHz);
    this.wdtPeriodCycles = cyclesFor(WDT_PERIOD_S, this.clockHz);
    this.decoded.fill(decodePacked(BLANK_WORD));
    this.reset('por');
  }

  // ---------------------------------------------------------------- public state

  get pc(): number {
    return this.pcReg;
  }

  get w(): number {
    return this.wReg;
  }

  /** Total instruction cycles since the last reset (sleep cycles included). */
  get cycles(): number {
    return this.totalCycles;
  }

  get sleeping(): boolean {
    return this.isSleeping;
  }

  /** True while the core sits on a `GOTO $` (how MikroC ends main). */
  get halted(): boolean {
    return this.isHalted;
  }

  /**
   * True when an interrupt was sampled during the last instruction: the next step() runs the
   * dummy cycles that push the PC and vector to 0004h.
   */
  get interruptEntryPending(): boolean {
    return this.pendingEntry !== 0;
  }

  /** Configuration word in use (0x2007). */
  get config(): number {
    return this.cfg;
  }

  /** True once a 9th nested CALL/interrupt overwrote the oldest return address (cleared on reset). */
  get stackOverflow(): boolean {
    return this.stackOverflowed;
  }

  /** True once RETURN/RETLW/RETFIE ran with an empty stack (cleared on reset). */
  get stackUnderflow(): boolean {
    return this.stackUnderflowed;
  }

  /** Simulated time of the 10 ms EEPROM write and the 18 ms WDT period, in instruction cycles. */
  get timing(): { eepromWriteCycles: number; wdtPeriodCycles: number } {
    return { eepromWriteCycles: this.eeWriteCycles, wdtPeriodCycles: this.wdtPeriodCycles };
  }

  // ---------------------------------------------------------------- loading and reset

  load(program: Uint16Array, eeprom?: Uint8Array, config: number = DEFAULT_CONFIG): void {
    this.programMemory.fill(BLANK_WORD);
    const n = Math.min(program.length, PROGRAM_WORDS);
    for (let i = 0; i < n; i++) this.programMemory[i] = program[i] & 0x3fff;
    for (let i = 0; i < PROGRAM_WORDS; i++) this.decoded[i] = decodePacked(this.programMemory[i]);
    this.ee.data.fill(EEPROM_ERASED);
    if (eeprom) this.ee.data.set(eeprom.subarray(0, EEPROM_BYTES));
    this.cfg = config & 0x3fff;
    this.wdtEnabled = (this.cfg & CONFIG_WDTE) !== 0;
    this.reset('por');
  }

  /** Reset values per DS35007 Tables 6-3 and 6-4. RAM is zeroed on power-on (Proteus default). */
  reset(kind: ResetKind = 'por'): void {
    const powerOn = kind === 'por';
    if (powerOn) {
      this.ram.fill(0);
      this.stack.fill(0);
      this.wReg = 0;
      this.fsr = 0;
      this.timer.value = 0;
      this.status = STATUS_TO_PD; // 0001 1xxx
    } else if (kind === 'mclr') {
      // 000u uuuu in normal operation, 0001 0uuu when the reset ends a SLEEP.
      this.status = this.isSleeping ? (this.status & 0x07) | STATUS_TO : this.status & 0x1f;
    } else {
      this.status = (this.status & 0x07) | STATUS_PD; // WDT reset: 0000 1uuu
    }
    this.pcReg = RESET_VECTOR;
    this.pclath = 0;
    this.intcon = powerOn ? 0 : this.intcon & INTCON_RBIF;
    this.option = 0xff;
    this.timer.reset();
    this.ee.resetControl(powerOn);
    this.io.reset(powerOn);
    this.sp = 0;
    this.stackDepth = 0;
    this.stackOverflowed = false;
    this.stackUnderflowed = false;
    this.isSleeping = false;
    this.isHalted = false;
    this.pclWritten = false;
    this.pendingEntry = 0;
    this.totalCycles = 0;
    this.wdtDeadline = this.wdtPeriodCycles;
    this.scheduleEvents();
    this.ioDirty = true;
  }

  // ---------------------------------------------------------------- execution

  /**
   * Execute one instruction, the dummy cycles of an interrupt entry, or one Tcy of sleep.
   * `cycles` is 1 or 2, and 0 while sleeping: the oscillator is stopped, so no instruction cycle
   * is consumed, but one Tcy of simulated time still passes for the WDT and the EEPROM write timer
   * (it is counted in `cycles`/snapshot().cycles and by run()). A `GOTO $` reports its real 2 cycles:
   * Timer0 and interrupts keep running in that loop.
   */
  step(): Pic16F84AStepResult {
    this.ioDirty = false;
    const interruptEntry = this.pendingEntry !== 0;
    const asleep = !interruptEntry && this.isSleeping;
    const pc = asleep ? this.sleepAddr : this.pcReg;
    const opcode = interruptEntry ? FORCED_NOP : this.programMemory[pc & FETCH_MASK];
    const cycles = this.exec();
    return { cycles: asleep ? 0 : cycles, pc, opcode, ioChanged: this.ioDirty, interruptEntry };
  }

  run(cycles: number, breakpoints?: ReadonlySet<number>): number {
    const stops = breakpoints !== undefined && breakpoints.size > 0 ? breakpointMap(breakpoints) : null;
    const listener = this.onIoChange;
    let done = 0;
    while (done < cycles) {
      // A breakpoint stops before the instruction executes, except on the first one (resume).
      // Interrupt-entry dummy cycles and sleep do not execute the instruction at PC.
      if (stops !== null && done > 0 && this.pendingEntry === 0 && !this.isSleeping
        && stops[this.pcReg & FETCH_MASK] === 1) break;
      if (listener === null) {
        done += this.exec();
      } else {
        this.ioDirty = false;
        done += this.exec();
        if (this.ioDirty) listener();
      }
    }
    return done;
  }

  /** Execute one instruction (or interrupt entry, or one cycle of sleep) and return the Tcy elapsed. */
  private exec(): number {
    if (this.pendingEntry !== 0) return this.enterInterrupt();
    if (this.isSleeping) return this.sleepCycle();
    const sampled = (this.intcon & INTCON_GIE) !== 0 && this.interruptRequested();
    const pc = this.pcReg;
    const dw = this.decoded[pc & FETCH_MASK];
    this.pcReg = (pc + 1) & PC_MASK;
    this.isHalted = false;
    let cycles = 1;

    switch (dw & 0x3f) {
      case OP_NOP:
      case OP_INVALID:
        break;
      case OP_MOVWF:
        this.writeF((dw >>> 8) & 0x7f, this.wReg, false);
        break;
      case OP_CLRW:
        this.wReg = 0;
        this.status |= STATUS_Z;
        break;
      case OP_CLRF:
        this.writeF((dw >>> 8) & 0x7f, 0, true);
        this.status |= STATUS_Z;
        break;
      case OP_SUBWF: {
        // Subtraction adds the two's complement of W: C and DC are NOT borrow.
        const a = this.readF((dw >>> 8) & 0x7f);
        const w = this.wReg;
        const r = (a - w) & 0xff;
        const flags = (a >= w ? STATUS_C : 0) | ((a & 0xf) >= (w & 0xf) ? STATUS_DC : 0) | (r === 0 ? STATUS_Z : 0);
        this.store(dw, r, true);
        this.status = (this.status & ~FLAGS_CDZ) | flags;
        break;
      }
      case OP_DECF: {
        const r = (this.readF((dw >>> 8) & 0x7f) - 1) & 0xff;
        this.store(dw, r, true);
        this.setZ(r);
        break;
      }
      case OP_IORWF: {
        const r = this.readF((dw >>> 8) & 0x7f) | this.wReg;
        this.store(dw, r, true);
        this.setZ(r);
        break;
      }
      case OP_ANDWF: {
        const r = this.readF((dw >>> 8) & 0x7f) & this.wReg;
        this.store(dw, r, true);
        this.setZ(r);
        break;
      }
      case OP_XORWF: {
        const r = this.readF((dw >>> 8) & 0x7f) ^ this.wReg;
        this.store(dw, r, true);
        this.setZ(r);
        break;
      }
      case OP_ADDWF: {
        const a = this.readF((dw >>> 8) & 0x7f);
        const w = this.wReg;
        const sum = a + w;
        const r = sum & 0xff;
        const flags = (sum > 0xff ? STATUS_C : 0) | ((a & 0xf) + (w & 0xf) > 0xf ? STATUS_DC : 0) | (r === 0 ? STATUS_Z : 0);
        this.store(dw, r, true);
        this.status = (this.status & ~FLAGS_CDZ) | flags;
        break;
      }
      case OP_MOVF: {
        const r = this.readF((dw >>> 8) & 0x7f);
        this.store(dw, r, true);
        this.setZ(r);
        break;
      }
      case OP_COMF: {
        const r = ~this.readF((dw >>> 8) & 0x7f) & 0xff;
        this.store(dw, r, true);
        this.setZ(r);
        break;
      }
      case OP_INCF: {
        const r = (this.readF((dw >>> 8) & 0x7f) + 1) & 0xff;
        this.store(dw, r, true);
        this.setZ(r);
        break;
      }
      case OP_DECFSZ: {
        const r = (this.readF((dw >>> 8) & 0x7f) - 1) & 0xff;
        this.store(dw, r, false);
        if (r === 0) cycles = this.skip();
        break;
      }
      case OP_RRF: {
        const a = this.readF((dw >>> 8) & 0x7f);
        this.store(dw, (a >>> 1) | ((this.status & STATUS_C) << 7), true);
        this.status = (this.status & ~STATUS_C) | (a & 1);
        break;
      }
      case OP_RLF: {
        const a = this.readF((dw >>> 8) & 0x7f);
        this.store(dw, ((a << 1) | (this.status & STATUS_C)) & 0xff, true);
        this.status = (this.status & ~STATUS_C) | (a >>> 7);
        break;
      }
      case OP_SWAPF: {
        const a = this.readF((dw >>> 8) & 0x7f);
        this.store(dw, ((a << 4) | (a >>> 4)) & 0xff, false);
        break;
      }
      case OP_INCFSZ: {
        const r = (this.readF((dw >>> 8) & 0x7f) + 1) & 0xff;
        this.store(dw, r, false);
        if (r === 0) cycles = this.skip();
        break;
      }
      case OP_BCF: {
        // Read-modify-write: on a port this reads the pin levels and rewrites the whole latch.
        const f = (dw >>> 8) & 0x7f;
        this.writeF(f, this.readF(f) & ~(1 << ((dw >>> 16) & 7)), false);
        break;
      }
      case OP_BSF: {
        const f = (dw >>> 8) & 0x7f;
        this.writeF(f, this.readF(f) | (1 << ((dw >>> 16) & 7)), false);
        break;
      }
      case OP_BTFSC:
        if ((this.readF((dw >>> 8) & 0x7f) & (1 << ((dw >>> 16) & 7))) === 0) cycles = this.skip();
        break;
      case OP_BTFSS:
        if ((this.readF((dw >>> 8) & 0x7f) & (1 << ((dw >>> 16) & 7))) !== 0) cycles = this.skip();
        break;
      case OP_CALL:
        this.push(this.pcReg);
        this.pcReg = ((this.pclath & 0x18) << 8) | ((dw >>> 8) & 0x7ff);
        cycles = 2;
        break;
      case OP_GOTO: {
        const target = ((this.pclath & 0x18) << 8) | ((dw >>> 8) & 0x7ff);
        if (target === pc) this.isHalted = true;
        this.pcReg = target;
        cycles = 2;
        break;
      }
      case OP_MOVLW:
        this.wReg = (dw >>> 8) & 0xff;
        break;
      case OP_RETLW:
        this.wReg = (dw >>> 8) & 0xff;
        this.pcReg = this.pop();
        cycles = 2;
        break;
      case OP_IORLW:
        this.wReg |= (dw >>> 8) & 0xff;
        this.setZ(this.wReg);
        break;
      case OP_ANDLW:
        this.wReg &= (dw >>> 8) & 0xff;
        this.setZ(this.wReg);
        break;
      case OP_XORLW:
        this.wReg ^= (dw >>> 8) & 0xff;
        this.setZ(this.wReg);
        break;
      case OP_SUBLW: {
        const k = (dw >>> 8) & 0xff;
        const w = this.wReg;
        const r = (k - w) & 0xff;
        this.wReg = r;
        this.status = (this.status & ~FLAGS_CDZ)
          | (k >= w ? STATUS_C : 0) | ((k & 0xf) >= (w & 0xf) ? STATUS_DC : 0) | (r === 0 ? STATUS_Z : 0);
        break;
      }
      case OP_ADDLW: {
        const k = (dw >>> 8) & 0xff;
        const w = this.wReg;
        const sum = k + w;
        const r = sum & 0xff;
        this.wReg = r;
        this.status = (this.status & ~FLAGS_CDZ)
          | (sum > 0xff ? STATUS_C : 0) | ((k & 0xf) + (w & 0xf) > 0xf ? STATUS_DC : 0) | (r === 0 ? STATUS_Z : 0);
        break;
      }
      case OP_RETURN:
        this.pcReg = this.pop();
        cycles = 2;
        break;
      case OP_RETFIE:
        this.pcReg = this.pop();
        this.intcon |= INTCON_GIE;
        cycles = 2;
        break;
      case OP_SLEEP:
        this.enterSleep(pc);
        break;
      case OP_CLRWDT:
        this.status |= STATUS_TO_PD;
        this.clearWatchdog();
        break;
      case OP_OPTION:
        this.writeOption(this.wReg);
        break;
      case OP_TRIS: {
        const port = (dw >>> 8) & 0x07;
        if (port === 5) this.writeTrisA(this.wReg);
        else if (port === 6) this.writeTrisB(this.wReg);
        break;
      }
    }

    if (this.pclWritten) {
      // Any write to PCL flushes the prefetched instruction: 2 cycles.
      this.pclWritten = false;
      cycles = 2;
    }
    if (cycles === 2 && !sampled && (this.intcon & INTCON_GIE) !== 0) {
      // Not sampled at the first Q1, but flags are sampled again at the Q1 of the second cycle:
      // catch a flag raised during the first cycle (Timer0 overflow, EEPROM write end) or the GIE
      // set by RETFIE in its first cycle.
      this.elapse(1);
      if (this.totalCycles === 0) return cycles; // a WDT reset during the first cycle ended the instruction
      const sampledLate = (this.intcon & INTCON_GIE) !== 0 && this.interruptRequested();
      this.elapse(1);
      if (sampledLate) this.pendingEntry = INTERRUPT_LATENCY - 1;
      return cycles;
    }
    this.elapse(cycles);
    // Clearing GIE (or the flag) in the sampled instruction itself cancels the entry.
    if (sampled && (this.intcon & INTCON_GIE) !== 0 && this.interruptRequested()) {
      this.pendingEntry = INTERRUPT_LATENCY - cycles;
    }
    return cycles;
  }

  private skip(): number {
    this.pcReg = (this.pcReg + 1) & PC_MASK;
    return 2;
  }

  private store(dw: number, value: number, aluFlags: boolean): void {
    if (dw & PACK_D) this.writeF((dw >>> 8) & 0x7f, value, aluFlags);
    else this.wReg = value;
  }

  private setZ(result: number): void {
    this.status = result === 0 ? this.status | STATUS_Z : this.status & ~STATUS_Z;
  }

  private push(addr: number): void {
    if (this.stackDepth === STACK_LEVELS) this.stackOverflowed = true;
    else this.stackDepth++;
    this.stack[this.sp] = addr;
    this.sp = (this.sp + 1) & (STACK_LEVELS - 1);
  }

  private pop(): number {
    if (this.stackDepth === 0) this.stackUnderflowed = true;
    else this.stackDepth--;
    this.sp = (this.sp - 1) & (STACK_LEVELS - 1);
    return this.stack[this.sp];
  }

  /** Let instruction cycles elapse: Timer0, then the timed events (EEPROM write, WDT). */
  private elapse(cycles: number): void {
    if (this.timer.tick(cycles, this.option)) this.intcon |= INTCON_T0IF;
    this.totalCycles += cycles;
    if (this.totalCycles >= this.nextEventAt) this.runTimedEvents();
  }

  // ---------------------------------------------------------------- interrupts, sleep, watchdog

  /** An interrupt flag is set together with its enable bit (GIE not considered). */
  private interruptRequested(): boolean {
    const i = this.intcon;
    // T0IE/INTE/RBIE (bits 5..3) line up with T0IF/INTF/RBIF (bits 2..0) after a shift by 3.
    return (i & (i >>> 3) & 0x07) !== 0 || ((i & INTCON_EEIE) !== 0 && (this.ee.eecon1 & EECON1_EEIF) !== 0);
  }

  /** Dummy cycles of a committed interrupt: push PC, clear GIE, vector to 0004h. */
  private enterInterrupt(): number {
    const dummyCycles = this.pendingEntry;
    this.pendingEntry = 0;
    this.push(this.pcReg);
    this.intcon &= ~INTCON_GIE;
    this.pcReg = INTERRUPT_VECTOR;
    this.isHalted = false;
    this.elapse(dummyCycles);
    return dummyCycles;
  }

  private enterSleep(addr: number): void {
    // With an interrupt already pending (flag and enable set), SLEEP completes as a NOP:
    // WDT not cleared, TO/PD unchanged (PICmicro Mid-Range Reference Manual, Sleep mode).
    if (this.interruptRequested()) return;
    this.status = (this.status & ~STATUS_PD) | STATUS_TO;
    this.clearWatchdog();
    this.sleepAddr = addr;
    this.isSleeping = true;
  }

  /**
   * One instruction-cycle of simulated time while asleep. The oscillator is stopped, so Timer0
   * does not count (and cannot wake the core); the WDT RC oscillator and the EEPROM write timer
   * keep running. Any enabled interrupt flag wakes the core regardless of GIE; with GIE = 1 the
   * instruction after SLEEP executes before the jump to 0004h (Proteus DBG_WAKEUP_DELAY=0).
   */
  private sleepCycle(): number {
    this.totalCycles += 1;
    if (this.totalCycles >= this.nextEventAt) this.runTimedEvents();
    if (this.isSleeping && this.interruptRequested()) this.isSleeping = false;
    return 1;
  }

  private clearWatchdog(): void {
    this.wdtDeadline = this.totalCycles + this.wdtPeriodCycles;
    if (this.option & OPTION_PSA) this.timer.prescaler = 0;
    this.scheduleEvents();
  }

  private scheduleEvents(): void {
    const wdt = this.wdtEnabled ? this.wdtDeadline : Infinity;
    this.nextEventAt = this.ee.writeDoneAt < wdt ? this.ee.writeDoneAt : wdt;
  }

  private runTimedEvents(): void {
    const now = this.totalCycles;
    if (this.ee.writeDoneAt <= now) this.ee.completeWrite();
    if (this.wdtEnabled && this.wdtDeadline <= now) {
      this.wdtDeadline += this.wdtPeriodCycles;
      if (this.timer.watchdogPulse(this.option)) this.watchdogTimeout();
    }
    this.scheduleEvents();
  }

  private watchdogTimeout(): void {
    if (this.isSleeping) {
      // WDT wake-up: execution continues after SLEEP with STATUS = uuu0 0uuu.
      this.isSleeping = false;
      this.status &= ~STATUS_TO_PD;
    } else {
      this.reset('wdt');
    }
  }

  // ---------------------------------------------------------------- file registers

  private readF(f: number): number {
    if (f >= GPR_FIRST) return f <= GPR_LAST ? this.ram[f] : 0;
    if (f === 0) return this.readIndirect();
    return this.readSfr(f | ((this.status & STATUS_RP0) << 2));
  }

  private writeF(f: number, value: number, aluFlags: boolean): void {
    if (f >= GPR_FIRST) {
      if (f <= GPR_LAST) this.ram[f] = value;
      return;
    }
    if (f === 0) this.writeIndirect(value, aluFlags);
    else this.writeSfr(f | ((this.status & STATUS_RP0) << 2), value, aluFlags);
  }

  /** INDF: FSR holds the full 8-bit bank-mapped address (IRP unused); INDF through FSR = 0 reads 0. */
  private readIndirect(): number {
    const a = this.fsr;
    const f = a & 0x7f;
    if (f >= GPR_FIRST) return f <= GPR_LAST ? this.ram[f] : 0;
    return f === 0 ? 0 : this.readSfr(a);
  }

  /** Writing INDF through FSR = 0 is a no-operation. */
  private writeIndirect(value: number, aluFlags: boolean): void {
    const a = this.fsr;
    const f = a & 0x7f;
    if (f >= GPR_FIRST) {
      if (f <= GPR_LAST) this.ram[f] = value;
    } else if (f !== 0) {
      this.writeSfr(a, value, aluFlags);
    }
  }

  private readSfr(addr: number): number {
    const value = this.peekSfr(addr);
    // Any read of PORTB (including the read half of BSF/BCF) ends the RB-change mismatch.
    if (addr === SFR.PORTB) this.io.rbLatch = value;
    return value;
  }

  /** Register read without side effects. `addr` is bank-mapped and not INDF or a GPR. */
  private peekSfr(addr: number): number {
    switch (addr) {
      case SFR.TMR0: return this.timer.value;
      case SFR.OPTION_REG: return this.option;
      case SFR.PCL: case 0x82: return this.pcReg & 0xff;
      case SFR.STATUS: case 0x83: return this.status;
      case SFR.FSR: case 0x84: return this.fsr;
      case SFR.PORTA: return this.io.readA();
      case SFR.TRISA: return this.io.trisA;
      case SFR.PORTB: return this.io.readB();
      case SFR.TRISB: return this.io.trisB;
      case SFR.EEDATA: return this.ee.eedata;
      case SFR.EECON1: return this.ee.eecon1;
      case SFR.EEADR: return this.ee.eeadr;
      case SFR.PCLATH: case 0x8a: return this.pclath;
      case SFR.INTCON: case 0x8b: return this.intcon;
      default: return 0; // 07h/87h, EECON2 and the unimplemented bank-1 holes
    }
  }

  /**
   * Program write to an SFR. `aluFlags` is true when the instruction itself sets Z/DC/C: then a
   * write to STATUS cannot change those three bits (the flag result wins, e.g. CLRF STATUS gives
   * 000u u1uu). TO and PD are never writable.
   */
  private writeSfr(addr: number, value: number, aluFlags: boolean): void {
    switch (addr) {
      case SFR.TMR0: this.timer.write(value, this.option); return;
      case SFR.OPTION_REG: this.writeOption(value); return;
      case SFR.PCL: case 0x82:
        this.pcReg = ((this.pclath & 0x1f) << 8) | value;
        this.pclWritten = true;
        return;
      case SFR.STATUS: case 0x83:
        this.status = aluFlags
          ? (value & 0xe0) | (this.status & 0x1f)
          : (value & ~STATUS_TO_PD & 0xff) | (this.status & STATUS_TO_PD);
        return;
      case SFR.FSR: case 0x84: this.fsr = value; return;
      case SFR.PORTA: this.writePortA(value); return;
      case SFR.TRISA: this.writeTrisA(value); return;
      case SFR.PORTB: this.writePortB(value); return;
      case SFR.TRISB: this.writeTrisB(value); return;
      case SFR.EEDATA: this.ee.eedata = value; return;
      case SFR.EECON1:
        this.ee.writeEecon1(value, this.totalCycles, this.eeWriteCycles);
        this.scheduleEvents();
        return;
      case SFR.EEADR: this.ee.eeadr = value; return;
      case SFR.EECON2: this.ee.writeEecon2(value); return;
      case SFR.PCLATH: case 0x8a: this.pclath = value & 0x1f; return;
      case SFR.INTCON: case 0x8b:
        this.intcon = value;
        // RBIF is set by the mismatch level: clearing it without reading PORTB has no effect.
        this.updateRbif();
        return;
      default: return;
    }
  }

  // ---------------------------------------------------------------- ports

  private writePortA(value: number): void {
    const v = value & PORTA_MASK;
    if (v !== this.io.latchA) {
      this.io.latchA = v;
      this.ioDirty = true;
    }
  }

  private writePortB(value: number): void {
    if (value !== this.io.latchB) {
      this.io.latchB = value;
      this.ioDirty = true;
    }
    // Any write of PORTB also ends the mismatch condition.
    this.io.rbLatch = this.io.readB();
  }

  private writeTrisA(value: number): void {
    const v = value & PORTA_MASK;
    if (v !== this.io.trisA) {
      this.io.trisA = v;
      this.ioDirty = true;
    }
  }

  private writeTrisB(value: number): void {
    if (value === this.io.trisB) return;
    const before = this.io.levelB;
    this.io.trisB = value;
    this.io.applyPullups();
    this.ioDirty = true;
    this.portBLevelsChanged(before);
    this.updateRbif();
  }

  private writeOption(value: number): void {
    const old = this.option;
    this.option = value;
    if ((old ^ value) & OPTION_RBPU) {
      const before = this.io.levelB;
      this.io.pullupsEnabled = (value & OPTION_RBPU) === 0;
      this.io.applyPullups();
      this.ioDirty = true;
      this.portBLevelsChanged(before);
    }
  }

  /** RB0/INT edge detection (input only, polarity from INTEDG) and RB7:RB4 change detection. */
  private portBLevelsChanged(before: number): void {
    const changed = before ^ this.io.levelB;
    if (changed === 0) return;
    if (changed & 0x01 && this.io.trisB & 0x01) {
      const rising = (this.io.levelB & 0x01) !== 0;
      if (rising === ((this.option & OPTION_INTEDG) !== 0)) this.intcon |= INTCON_INTF;
    }
    if (changed & 0xf0) this.updateRbif();
  }

  private updateRbif(): void {
    if (this.io.rbMismatch()) this.intcon |= INTCON_RBIF;
  }

  /** Active edge on RA4/T0CKI in counter mode (T0SE = 0: rising, 1: falling). */
  private t0ckiEdge(rising: boolean): void {
    if (this.isSleeping || (this.option & OPTION_T0CS) === 0) return;
    if (rising === ((this.option & OPTION_T0SE) !== 0)) return;
    if (this.timer.externalEdge(this.option)) this.intcon |= INTCON_T0IF;
  }

  getDrive(pin: PinName): Drive {
    return this.io.drive(PIN_INDEX[pin]);
  }

  hasWeakPullup(pin: PinName): boolean {
    return this.io.hasPullup(PIN_INDEX[pin]);
  }

  setInput(pin: PinName, level: Level): void {
    const index = PIN_INDEX[pin];
    if (index < 8) {
      const before = this.io.levelA;
      this.io.setLevel(index, level);
      if (index === 4 && ((before ^ this.io.levelA) & 0x10) !== 0) this.t0ckiEdge((this.io.levelA & 0x10) !== 0);
      return;
    }
    const before = this.io.levelB;
    this.io.setLevel(index, level);
    this.portBLevelsChanged(before);
  }

  // ---------------------------------------------------------------- debugger access

  snapshot(): CoreSnapshot {
    const file = new Uint8Array(256);
    for (let a = 0; a < 256; a++) file[a] = this.peek(a);
    const stack: number[] = [];
    for (let i = this.stackDepth; i > 0; i--) stack.push(this.stack[(this.sp - i) & (STACK_LEVELS - 1)]);
    return {
      pc: this.pcReg,
      w: this.wReg,
      status: this.status,
      file,
      stack,
      cycles: this.totalCycles,
      sleeping: this.isSleeping,
      halted: this.isHalted,
      eeprom: this.ee.data.slice(),
      tmr0Prescaler: this.timer.prescaler,
    };
  }

  peek(addr: number): number {
    const a = addr & 0xff;
    const f = a & 0x7f;
    if (f >= GPR_FIRST) return f <= GPR_LAST ? this.ram[f] : 0;
    if (f === 0) {
      const target = this.fsr;
      return (target & 0x7f) === 0 ? 0 : this.peek(target);
    }
    return this.peekSfr(a);
  }

  /** Debugger write: sets the register as-is (STATUS TO/PD included), without timer, EEPROM or interrupt side effects. */
  poke(addr: number, value: number): void {
    const a = addr & 0xff;
    const f = a & 0x7f;
    const v = value & 0xff;
    if (f >= GPR_FIRST) {
      if (f <= GPR_LAST) this.ram[f] = v;
      return;
    }
    if (f === 0) {
      if ((this.fsr & 0x7f) !== 0) this.poke(this.fsr, v);
      return;
    }
    switch (a) {
      case SFR.TMR0: this.timer.value = v; return;
      case SFR.OPTION_REG:
        this.option = v;
        this.io.pullupsEnabled = (v & OPTION_RBPU) === 0;
        this.io.applyPullups();
        this.ioDirty = true;
        return;
      case SFR.PCL: case 0x82: this.pcReg = (this.pcReg & 0x1f00) | v; return;
      case SFR.STATUS: case 0x83: this.status = v; return;
      case SFR.FSR: case 0x84: this.fsr = v; return;
      case SFR.PORTA: this.io.latchA = v & PORTA_MASK; this.ioDirty = true; return;
      case SFR.TRISA: this.io.trisA = v & PORTA_MASK; this.ioDirty = true; return;
      case SFR.PORTB: this.io.latchB = v; this.ioDirty = true; return;
      case SFR.TRISB: this.io.trisB = v; this.io.applyPullups(); this.ioDirty = true; return;
      case SFR.EEDATA: this.ee.eedata = v; return;
      case SFR.EECON1: this.ee.eecon1 = (v & ~(EECON1_WR | EECON1_RD) & 0x1f) | (this.ee.eecon1 & EECON1_WR); return;
      case SFR.EEADR: this.ee.eeadr = v; return;
      case SFR.PCLATH: case 0x8a: this.pclath = v & 0x1f; return;
      case SFR.INTCON: case 0x8b: this.intcon = v; return;
      default: return;
    }
  }

  /** Debugger jump. An interrupt entry already committed still happens and pushes the new PC. */
  setPc(addr: number): void {
    this.pcReg = addr & PC_MASK;
    this.isSleeping = false;
    this.isHalted = false;
  }

  setW(value: number): void {
    this.wReg = value & 0xff;
  }

  /** Program word at `addr` (0x000–0x3FF). */
  readProgram(addr: number): number {
    return this.programMemory[addr & FETCH_MASK];
  }

  peekEeprom(addr: number): number {
    return this.ee.data[addr & (EEPROM_BYTES - 1)];
  }

  pokeEeprom(addr: number, value: number): void {
    this.ee.data[addr & (EEPROM_BYTES - 1)] = value & 0xff;
  }
}

function breakpointMap(breakpoints: ReadonlySet<number>): Uint8Array {
  const map = new Uint8Array(PROGRAM_WORDS);
  for (const addr of breakpoints) map[addr & FETCH_MASK] = 1;
  return map;
}
