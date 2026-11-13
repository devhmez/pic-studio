// MPASM-style disassembler: SFR names, named flag bits and W/F destinations
// (e.g. 'SUBWF 0x0D, W', 'BTFSC STATUS, Z', 'BSF STATUS, RP0', 'MOVWF TRISB').
import { Op, decode, type DecodedInstruction } from './isa';
import { GPR_FIRST, GPR_LAST, NAMED_BIT_REGISTERS, SFR, STATUS_BITS, sfrAt } from './sfr';

export interface DisasmOptions {
  /** Bank used to name register operands (STATUS.RP0). Default 0. */
  bank?: 0 | 1;
  /** Name for a general-purpose register (7-bit address 0x0C–0x4F), e.g. a C variable. */
  registerName?: (addr: number) => string | undefined;
  /** Label for a CALL/GOTO target. */
  label?: (addr: number) => string | undefined;
}

export function hex2(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
}

export function hex3(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(3, '0')}`;
}

export function hex4(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(4, '0')}`;
}

function registerOperand(f: number, opts: DisasmOptions): string {
  const full = f | ((opts.bank ?? 0) << 7);
  const sfr = sfrAt(full);
  if (sfr) return sfr.name;
  if (f >= GPR_FIRST && f <= GPR_LAST) return opts.registerName?.(f) ?? hex2(f);
  return hex2(f);
}

function bitOperand(f: number, b: number, opts: DisasmOptions): string {
  const sfr = sfrAt(f | ((opts.bank ?? 0) << 7));
  if (sfr && NAMED_BIT_REGISTERS.has(sfr.name)) return sfr.bits[b] ?? String(b);
  return String(b);
}

/** Disassemble one already-decoded instruction. */
export function formatInstruction(ins: DecodedInstruction, word: number, opts: DisasmOptions = {}): string {
  const m = ins.mnemonic;
  if (m === undefined) return `DW ${hex4(word & 0x3fff)}`;
  switch (ins.form) {
    case 'none': return m;
    case 'f': return `${m} ${registerOperand(ins.f, opts)}`;
    case 'fd': return `${m} ${registerOperand(ins.f, opts)}, ${ins.d ? 'F' : 'W'}`;
    case 'fb': return `${m} ${registerOperand(ins.f, opts)}, ${bitOperand(ins.f, ins.b, opts)}`;
    case 'k8': return `${m} ${hex2(ins.k)}`;
    case 'k11': return `${m} ${opts.label?.(ins.k) ?? hex3(ins.k)}`;
    case 'tris': return `${m} ${registerOperand(ins.f, { ...opts, bank: 0 })}`;
  }
}

/** Disassemble one 14-bit word. */
export function disassemble(word: number, opts: DisasmOptions = {}): string {
  return formatInstruction(decode(word), word, opts);
}

export interface DisasmLine {
  addr: number;
  word: number;
  text: string;
}

/**
 * Disassemble a program range, tracking the bank across `BSF/BCF STATUS, RP0` so that bank-1
 * registers get their names (TRISB rather than PORTB). The tracking is linear; it restarts in
 * bank 0 at the reset and interrupt vectors.
 */
export function disassembleProgram(
  program: Uint16Array, start = 0, end = program.length, opts: Omit<DisasmOptions, 'bank'> = {},
): DisasmLine[] {
  const lines: DisasmLine[] = [];
  let bank: 0 | 1 = 0;
  for (let addr = start; addr < end; addr++) {
    if (addr === 0x0000 || addr === 0x0004) bank = 0;
    const word = program[addr] & 0x3fff;
    const ins = decode(word);
    lines.push({ addr, word, text: formatInstruction(ins, word, { ...opts, bank }) });
    if ((ins.op === Op.BSF || ins.op === Op.BCF) && ins.f === SFR.STATUS && ins.b === STATUS_BITS.RP0) {
      bank = ins.op === Op.BSF ? 1 : 0;
    }
  }
  return lines;
}
