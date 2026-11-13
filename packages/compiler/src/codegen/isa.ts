// PIC14 (mid-range) instruction encodings, datasheet DS35007 Table 7-2.

export type FileOp =
  | 'ADDWF' | 'ANDWF' | 'CLRF' | 'COMF' | 'DECF' | 'DECFSZ' | 'INCF' | 'INCFSZ' | 'IORWF' | 'MOVF' | 'MOVWF'
  | 'RLF' | 'RRF' | 'SUBWF' | 'SWAPF' | 'XORWF';
export type BitOp = 'BCF' | 'BSF' | 'BTFSC' | 'BTFSS';
export type LitOp = 'ADDLW' | 'ANDLW' | 'IORLW' | 'MOVLW' | 'RETLW' | 'SUBLW' | 'XORLW';
export type JumpOp = 'CALL' | 'GOTO';
export type NoArgOp = 'CLRW' | 'NOP' | 'RETFIE' | 'RETURN' | 'SLEEP' | 'CLRWDT';

const FILE_OPCODES: Record<FileOp, number> = {
  ADDWF: 0x0700, ANDWF: 0x0500, CLRF: 0x0180, COMF: 0x0900, DECF: 0x0300, DECFSZ: 0x0b00, INCF: 0x0a00,
  INCFSZ: 0x0f00, IORWF: 0x0400, MOVF: 0x0800, MOVWF: 0x0080, RLF: 0x0d00, RRF: 0x0c00, SUBWF: 0x0200,
  SWAPF: 0x0e00, XORWF: 0x0600,
};
const BIT_OPCODES: Record<BitOp, number> = { BCF: 0x1000, BSF: 0x1400, BTFSC: 0x1800, BTFSS: 0x1c00 };
const LIT_OPCODES: Record<LitOp, number> = {
  ADDLW: 0x3e00, ANDLW: 0x3900, IORLW: 0x3800, MOVLW: 0x3000, RETLW: 0x3400, SUBLW: 0x3c00, XORLW: 0x3a00,
};
const JUMP_OPCODES: Record<JumpOp, number> = { CALL: 0x2000, GOTO: 0x2800 };
const NOARG_OPCODES: Record<NoArgOp, number> = {
  CLRW: 0x0103, NOP: 0x0000, RETFIE: 0x0009, RETURN: 0x0008, SLEEP: 0x0063, CLRWDT: 0x0064,
};

/** File-register ops without a destination bit. */
export const NO_DEST: ReadonlySet<FileOp> = new Set(['CLRF', 'MOVWF']);
/** Instructions that conditionally skip the next one. */
export const SKIP_OPS: ReadonlySet<string> = new Set(['BTFSC', 'BTFSS', 'DECFSZ', 'INCFSZ']);

export function encodeFile(op: FileOp, f: number, d: 0 | 1): number {
  const base = FILE_OPCODES[op];
  return NO_DEST.has(op) ? base | (f & 0x7f) : base | (d << 7) | (f & 0x7f);
}

export function encodeBit(op: BitOp, f: number, b: number): number {
  return BIT_OPCODES[op] | ((b & 7) << 7) | (f & 0x7f);
}

export function encodeLit(op: LitOp, k: number): number {
  return LIT_OPCODES[op] | (k & 0xff);
}

export function encodeJump(op: JumpOp, addr: number): number {
  return JUMP_OPCODES[op] | (addr & 0x7ff);
}

export function encodeNoArg(op: NoArgOp): number {
  return NOARG_OPCODES[op];
}

/** Instruction cycles (skips taking 2 cycles when they skip are not accounted here). */
export function baseCycles(op: string): number {
  return op === 'GOTO' || op === 'CALL' || op === 'RETURN' || op === 'RETLW' || op === 'RETFIE' ? 2 : 1;
}
