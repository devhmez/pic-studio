// Rebuild what happened between two paused debugger snapshots. A single-instruction step is decoded directly; a
// longer step (a C line, a pause) is replayed on a private PIC16F84A core seeded from the first snapshot, and the
// replay is trusted only if it lands exactly on the second snapshot (same cycle count, PC, W, STATUS, RAM, ports).
import { decode, Pic16F84A, type PinName } from '@pic/emulator';
import { ADDR, GPR_FIRST, GPR_LAST, type CpuState } from './cpu';

/** One executed instruction (or interrupt entry) with the full state before and after it. */
export interface TraceStep {
  addr: number;
  word: number;
  interruptEntry: boolean;
  before: CpuState;
  after: CpuState;
}

export interface StepTrace {
  /** Instruction cycles between the two snapshots. */
  cycles: number;
  /** Instructions executed (interrupt entries count as one). */
  count: number;
  /** First executed steps (at most `keepFirst`). */
  first: TraceStep[];
  /** Last executed steps (at most `keepLast`, never overlapping `first`). */
  last: TraceStep[];
  /** Number of steps between `first` and `last` that are not kept. */
  omitted: number;
  /** Every executed address with its execution count (loops show up as large counts). */
  hits: Map<number, number>;
}

export interface ReplayOptions {
  clockHz: number;
  config?: number;
  /** Longest stretch worth replaying (default 400 000 cycles, i.e. a few Delay_ms(1000) at 1 MHz). */
  maxCycles?: number;
  keepFirst?: number;
  keepLast?: number;
}

/** Snapshot fields the replay needs (structurally compatible with DebugSnapshot). */
export interface ReplaySnapshot extends CpuState {
  cycles: number;
  eeprom?: readonly number[];
  sleeping?: boolean;
  interruptEntry?: boolean;
}

const RETURNS = new Set(['RETURN', 'RETLW', 'RETFIE']);
/** Registers restored before the replay (INDF, PCL and EECON2 are not real storage). */
const SEED_SFRS = [ADDR.TMR0, ADDR.FSR, ADDR.EEDATA, ADDR.EEADR, ADDR.PCLATH, ADDR.OPTION_REG, ADDR.TRISA, ADDR.TRISB, ADDR.PORTA, ADDR.PORTB, ADDR.EECON1];
/** Registers compared at the end (TMR0 is left out: its prescaler is not in the snapshot). */
const CHECK_SFRS = [ADDR.FSR, ADDR.PORTA, ADDR.PORTB, ADDR.TRISA, ADDR.TRISB, ADDR.INTCON, ADDR.OPTION_REG, ADDR.PCLATH, ADDR.EEDATA, ADDR.EEADR];

const PINS: readonly [PinName, number, number][] = [
  ['RA0', ADDR.PORTA, 0], ['RA1', ADDR.PORTA, 1], ['RA2', ADDR.PORTA, 2], ['RA3', ADDR.PORTA, 3], ['RA4', ADDR.PORTA, 4],
  ['RB0', ADDR.PORTB, 0], ['RB1', ADDR.PORTB, 1], ['RB2', ADDR.PORTB, 2], ['RB3', ADDR.PORTB, 3],
  ['RB4', ADDR.PORTB, 4], ['RB5', ADDR.PORTB, 5], ['RB6', ADDR.PORTB, 6], ['RB7', ADDR.PORTB, 7],
];

function seed(program: Uint16Array, prev: ReplaySnapshot, opts: ReplayOptions): Pic16F84A {
  const core = new Pic16F84A({ clockHz: opts.clockHz });
  core.load(program, prev.eeprom ? Uint8Array.from(prev.eeprom) : undefined, opts.config);
  // Pin levels first (they may raise INTF/RBIF), then the registers, so INTCON ends as in the snapshot.
  for (const [pin, port, bit] of PINS) core.setInput(pin, ((prev.file[port] ?? 0) >> bit) & 1 ? 1 : 0);
  for (const a of SEED_SFRS) core.poke(a, prev.file[a] ?? 0);
  for (let a = GPR_FIRST; a <= GPR_LAST; a++) core.poke(a, prev.file[a] ?? 0);
  core.poke(ADDR.INTCON, prev.file[ADDR.INTCON] ?? 0);
  core.poke(ADDR.STATUS, prev.status);
  core.setW(prev.w);
  core.setPc(prev.pc);
  return core;
}

function stateOf(core: Pic16F84A, stackBase: readonly number[]): CpuState {
  const s = core.snapshot();
  return { pc: s.pc, w: s.w, status: s.status, file: Array.from(s.file), stack: [...stackBase, ...s.stack], cycles: s.cycles };
}

function matches(core: Pic16F84A, cur: ReplaySnapshot): boolean {
  if (core.pc !== cur.pc || core.w !== (cur.w & 0xff)) return false;
  if (core.peek(ADDR.STATUS) !== (cur.status & 0xff)) return false;
  for (const a of CHECK_SFRS) if (core.peek(a) !== ((cur.file[a] ?? 0) & 0xff)) return false;
  for (let a = GPR_FIRST; a <= GPR_LAST; a++) if (core.peek(a) !== ((cur.file[a] ?? 0) & 0xff)) return false;
  return true;
}

/**
 * Replay the instructions between `prev` and `cur` (consecutive snapshots of the same program). Returns null when
 * the stretch is too long or when the replay cannot reproduce `cur` exactly (an input changed meanwhile, a timer
 * was involved…): the caller then only lists what changed.
 */
export function replayBetween(program: Uint16Array, prev: ReplaySnapshot, cur: ReplaySnapshot, opts: ReplayOptions): StepTrace | null {
  const cycles = cur.cycles - prev.cycles;
  const maxCycles = opts.maxCycles ?? 400_000;
  if (!(cycles > 0) || cycles > maxCycles) return null;
  const keepFirst = opts.keepFirst ?? 40;
  const keepLast = opts.keepLast ?? 6;

  // Pass 1: count the steps and check the end state, without copying snapshots.
  const run = (record: ((i: number) => boolean) | null, onStep?: (step: TraceStep) => void): { count: number; ok: boolean; hits: Map<number, number> } => {
    const core = seed(program, prev, opts);
    // Return addresses already on the real stack: the private core starts with an empty one.
    const outer = [...prev.stack];
    let depth = 0; // entries pushed by the replay itself
    const hits = new Map<number, number>();
    let count = 0;
    while (core.cycles < cycles) {
      const pc = core.pc;
      const word = core.readProgram(pc) & 0x3fff;
      const pending = core.interruptEntryPending;
      const mnemonic = pending ? undefined : decode(word).mnemonic;
      const keep = record?.(count) ?? false;
      const before = keep ? stateOf(core, outer) : null;
      const r = core.step();
      if (r.interruptEntry || mnemonic === 'CALL') depth++;
      else if (mnemonic && RETURNS.has(mnemonic)) {
        if (depth > 0) depth--;
        else {
          // Returning into code that called before the replay started: the real return address is on `outer`.
          const back = outer.pop();
          if (back === undefined) return { count, ok: false, hits };
          core.setPc(back);
        }
      }
      hits.set(r.pc, (hits.get(r.pc) ?? 0) + 1);
      if (keep && before && onStep) onStep({ addr: r.pc, word: r.opcode & 0x3fff, interruptEntry: r.interruptEntry, before, after: stateOf(core, outer) });
      count++;
      if (count > maxCycles) return { count, ok: false, hits };
    }
    return { count, ok: core.cycles === cycles && matches(core, cur), hits };
  };

  const pass1 = run(null);
  if (!pass1.ok) return null;
  const n = pass1.count;
  const firstN = Math.min(keepFirst, n);
  const lastStart = Math.max(firstN, n - keepLast);
  const first: TraceStep[] = [];
  const last: TraceStep[] = [];
  run((i) => i < firstN || i >= lastStart, (step) => (first.length < firstN ? first : last).push(step));
  return { cycles, count: n, first, last, omitted: lastStart - firstN, hits: pass1.hits };
}

/**
 * Addresses that can follow the instruction at `pc` when it is the only one executed: the next word, the one after
 * (skips), the GOTO/CALL target, or the top of the stack (returns).
 */
export function possibleNextPcs(program: Uint16Array, pc: number, stack: readonly number[]): number[] {
  const word = program[pc & 0x3ff] & 0x3fff;
  const ins = decode(word);
  const next = (pc + 1) & 0x1fff;
  switch (ins.mnemonic) {
    case 'GOTO': case 'CALL': return [ins.k];
    case 'RETURN': case 'RETLW': case 'RETFIE': return stack.length ? [stack[stack.length - 1]] : [];
    case 'BTFSC': case 'BTFSS': case 'DECFSZ': case 'INCFSZ': return [next, (pc + 2) & 0x1fff];
    case 'SLEEP': return [pc, next];
    default: return [next];
  }
}

/** True when `cur` is exactly one instruction after `prev` (the cycle count and the PC agree). */
export function isSingleInstruction(program: Uint16Array, prev: ReplaySnapshot, cur: ReplaySnapshot): boolean {
  const dc = cur.cycles - prev.cycles;
  if (dc < 1 || dc > 2 || cur.interruptEntry) return false;
  const word = program[prev.pc & 0x3ff] & 0x3fff;
  const m = decode(word).mnemonic;
  // A write to PCL also jumps: accept any target for those (MOVWF PCL, ADDWF PCL, F…).
  const writesPcl = (m === 'MOVWF' || m === 'ADDWF' || m === 'CLRF') && (decode(word).f === 0x02);
  return writesPcl || possibleNextPcs(program, prev.pc, prev.stack).includes(cur.pc);
}
