import type { BitOp, FileOp, JumpOp, LitOp, NoArgOp } from './isa';

/** A group of RAM slots belonging to one function, helper or to the globals. */
export interface Frame {
  name: string;
  slots: Slot[];
}

/** A RAM object (variable, temporary area, helper parameter). */
export interface Slot {
  /** Name shown in the listing. */
  name: string;
  size: number;
  frame: Frame;
  /** Fixed address (`absolute`). */
  fixed?: number;
  /** Address assigned by the RAM allocator. */
  addr?: number;
  /** Scope reported in CompileResult.symbols ('global' or function name); undefined for internal slots. */
  scope?: string;
  /** C type text reported in CompileResult.symbols. */
  typeText?: string;
  /** Names of the `bit` variables packed into this byte (index = bit number). */
  bitNames?: string[];
}

export type FileRef =
  | { kind: 'sfr'; addr: number }
  | { kind: 'slot'; slot: Slot; offset: number };

export type Lit =
  | number
  | { kind: 'label'; label: string; part: 'lo' | 'hi' }
  | { kind: 'addr'; ref: FileRef };

/** Jump target: a label, or a relative address (`$`, `$+1`). */
export type Target = string | { rel: number };

interface InstrBase {
  /** C source line (1-based). */
  line?: number;
}

export type Instr =
  | (InstrBase & { t: 'file'; op: FileOp; f: FileRef; d: 0 | 1 })
  | (InstrBase & { t: 'bit'; op: BitOp; f: FileRef; b: number })
  | (InstrBase & { t: 'lit'; op: LitOp; k: Lit })
  | (InstrBase & { t: 'jump'; op: JumpOp; target: Target })
  | (InstrBase & { t: 'none'; op: NoArgOp })
  | { t: 'label'; name: string };

export function sfr(addr: number): FileRef {
  return { kind: 'sfr', addr };
}

export function slotRef(slot: Slot, offset = 0): FileRef {
  return { kind: 'slot', slot, offset };
}

/** Byte `i` of a multi-byte object. */
export function at(f: FileRef, i: number): FileRef {
  return f.kind === 'slot' ? { kind: 'slot', slot: f.slot, offset: f.offset + i } : { kind: 'sfr', addr: f.addr + i };
}

export function sameRef(a: FileRef, b: FileRef): boolean {
  if (a.kind === 'sfr' && b.kind === 'sfr') return a.addr === b.addr;
  if (a.kind === 'slot' && b.kind === 'slot') return a.slot === b.slot && a.offset === b.offset;
  return false;
}

/** Well-known SFR addresses used by generated code. */
export const R = {
  INDF: 0x00,
  TMR0: 0x01,
  PCL: 0x02,
  STATUS: 0x03,
  FSR: 0x04,
  PORTA: 0x05,
  PORTB: 0x06,
  EEDATA: 0x08,
  EEADR: 0x09,
  PCLATH: 0x0a,
  INTCON: 0x0b,
  OPTION_REG: 0x81,
  TRISA: 0x85,
  TRISB: 0x86,
  EECON1: 0x88,
  EECON2: 0x89,
} as const;

/** STATUS bits. */
export const C = 0;
export const DC = 1;
export const Z = 2;
export const RP0 = 5;
