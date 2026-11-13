// PIC16F84A instruction set (DS35007, Table 7-2): decoding, encoding and per-instruction metadata.

/** Internal operation numbers. OPTION and TRIS are the legacy mid-range opcodes (not in the 35). */
export const Op = {
  NOP: 0, MOVWF: 1, CLRW: 2, CLRF: 3,
  SUBWF: 4, DECF: 5, IORWF: 6, ANDWF: 7, XORWF: 8, ADDWF: 9, MOVF: 10, COMF: 11,
  INCF: 12, DECFSZ: 13, RRF: 14, RLF: 15, SWAPF: 16, INCFSZ: 17,
  BCF: 18, BSF: 19, BTFSC: 20, BTFSS: 21,
  CALL: 22, GOTO: 23,
  MOVLW: 24, RETLW: 25, IORLW: 26, ANDLW: 27, XORLW: 28, SUBLW: 29, ADDLW: 30,
  RETURN: 31, RETFIE: 32, SLEEP: 33, CLRWDT: 34,
  OPTION: 35, TRIS: 36,
  /** Unassigned opcode: executes as a NOP. */
  INVALID: 37,
} as const;

export type OpName = keyof typeof Op;
export type Mnemonic = Exclude<OpName, 'INVALID'>;

/**
 * Operand layout:
 * - `fd`: 00 oooo dfff ffff · `f`: register only · `fb`: 01 oobb bfff ffff
 * - `k8`: 8-bit literal · `k11`: 11-bit address (CALL/GOTO) · `tris`: register 5..7 · `none`.
 */
export type OperandForm = 'none' | 'f' | 'fd' | 'fb' | 'k8' | 'k11' | 'tris';

export interface InstructionInfo {
  mnemonic: Mnemonic;
  op: number;
  /** Canonical encoding with all operand fields at 0. */
  base: number;
  form: OperandForm;
  /** Instruction cycles when it does not skip (a taken skip costs 2). */
  cycles: 1 | 2;
  /** Conditional skip instruction. */
  skip: boolean;
  /** STATUS bits affected, datasheet notation. */
  status: readonly ('C' | 'DC' | 'Z' | 'TO' | 'PD')[];
  /** Not one of the 35 PIC16F84A instructions (obsolete mid-range opcodes, kept for old code). */
  legacy: boolean;
  /** French description for the UI. */
  description: string;
}

function info(
  mnemonic: Mnemonic, base: number, form: OperandForm, cycles: 1 | 2,
  status: InstructionInfo['status'], description: string, extra: { skip?: boolean; legacy?: boolean } = {},
): InstructionInfo {
  return {
    mnemonic, op: Op[mnemonic], base, form, cycles, status, description,
    skip: extra.skip ?? false, legacy: extra.legacy ?? false,
  };
}

const CZD = ['C', 'DC', 'Z'] as const;
const Z = ['Z'] as const;

export const INSTRUCTIONS: readonly InstructionInfo[] = [
  info('ADDWF', 0x0700, 'fd', 1, CZD, 'Additionne W et f'),
  info('ANDWF', 0x0500, 'fd', 1, Z, 'ET logique de W et f'),
  info('CLRF', 0x0180, 'f', 1, Z, 'Met f à zéro'),
  info('CLRW', 0x0103, 'none', 1, Z, 'Met W à zéro'),
  info('COMF', 0x0900, 'fd', 1, Z, 'Complément de f'),
  info('DECF', 0x0300, 'fd', 1, Z, 'Décrémente f'),
  info('DECFSZ', 0x0b00, 'fd', 1, [], 'Décrémente f, saute si résultat nul', { skip: true }),
  info('INCF', 0x0a00, 'fd', 1, Z, 'Incrémente f'),
  info('INCFSZ', 0x0f00, 'fd', 1, [], 'Incrémente f, saute si résultat nul', { skip: true }),
  info('IORWF', 0x0400, 'fd', 1, Z, 'OU inclusif de W et f'),
  info('MOVF', 0x0800, 'fd', 1, Z, 'Copie f'),
  info('MOVWF', 0x0080, 'f', 1, [], 'Copie W dans f'),
  info('NOP', 0x0000, 'none', 1, [], 'Aucune opération'),
  info('RLF', 0x0d00, 'fd', 1, ['C'], 'Rotation à gauche de f à travers C'),
  info('RRF', 0x0c00, 'fd', 1, ['C'], 'Rotation à droite de f à travers C'),
  info('SUBWF', 0x0200, 'fd', 1, CZD, 'Soustrait W de f (C = pas de retenue négative)'),
  info('SWAPF', 0x0e00, 'fd', 1, [], 'Échange les quartets de f'),
  info('XORWF', 0x0600, 'fd', 1, Z, 'OU exclusif de W et f'),
  info('BCF', 0x1000, 'fb', 1, [], 'Met le bit b de f à 0'),
  info('BSF', 0x1400, 'fb', 1, [], 'Met le bit b de f à 1'),
  info('BTFSC', 0x1800, 'fb', 1, [], 'Teste le bit b de f, saute s\'il vaut 0', { skip: true }),
  info('BTFSS', 0x1c00, 'fb', 1, [], 'Teste le bit b de f, saute s\'il vaut 1', { skip: true }),
  info('ADDLW', 0x3e00, 'k8', 1, CZD, 'Additionne le littéral k et W'),
  info('ANDLW', 0x3900, 'k8', 1, Z, 'ET logique du littéral k et W'),
  info('CALL', 0x2000, 'k11', 2, [], 'Appel de sous-programme (empile PC+1)'),
  info('CLRWDT', 0x0064, 'none', 1, ['TO', 'PD'], 'Remet à zéro le chien de garde'),
  info('GOTO', 0x2800, 'k11', 2, [], 'Saut inconditionnel'),
  info('IORLW', 0x3800, 'k8', 1, Z, 'OU inclusif du littéral k et W'),
  info('MOVLW', 0x3000, 'k8', 1, [], 'Charge le littéral k dans W'),
  info('RETFIE', 0x0009, 'none', 2, [], 'Retour d\'interruption (GIE = 1)'),
  info('RETLW', 0x3400, 'k8', 2, [], 'Retour avec le littéral k dans W'),
  info('RETURN', 0x0008, 'none', 2, [], 'Retour de sous-programme'),
  info('SLEEP', 0x0063, 'none', 1, ['TO', 'PD'], 'Mise en veille'),
  info('SUBLW', 0x3c00, 'k8', 1, CZD, 'Soustrait W du littéral k (C = pas de retenue négative)'),
  info('XORLW', 0x3a00, 'k8', 1, Z, 'OU exclusif du littéral k et W'),
  info('OPTION', 0x0062, 'none', 1, [], 'Copie W dans OPTION_REG (instruction obsolète)', { legacy: true }),
  info('TRIS', 0x0060, 'tris', 1, [], 'Copie W dans TRISA/TRISB (instruction obsolète)', { legacy: true }),
];

const BY_MNEMONIC: ReadonlyMap<string, InstructionInfo> = new Map(INSTRUCTIONS.map((i) => [i.mnemonic, i]));
const BY_OP: readonly (InstructionInfo | undefined)[] = (() => {
  const out: (InstructionInfo | undefined)[] = [];
  for (const i of INSTRUCTIONS) out[i.op] = i;
  return out;
})();

export function instructionInfo(mnemonic: string): InstructionInfo | undefined {
  return BY_MNEMONIC.get(mnemonic.toUpperCase());
}

export function instructionInfoByOp(op: number): InstructionInfo | undefined {
  return BY_OP[op];
}

/** Byte-oriented operations indexed by opcode bits 11:8 (values 2..15). */
const BYTE_OPS: readonly number[] = [
  Op.INVALID, Op.INVALID, Op.SUBWF, Op.DECF, Op.IORWF, Op.ANDWF, Op.XORWF, Op.ADDWF,
  Op.MOVF, Op.COMF, Op.INCF, Op.DECFSZ, Op.RRF, Op.RLF, Op.SWAPF, Op.INCFSZ,
];
const BIT_OPS: readonly number[] = [Op.BCF, Op.BSF, Op.BTFSC, Op.BTFSS];
/** Literal operations indexed by opcode bits 11:8 (the 'x' bits of MOVLW/RETLW/SUBLW/ADDLW are don't-care). */
const LITERAL_OPS: readonly number[] = [
  Op.MOVLW, Op.MOVLW, Op.MOVLW, Op.MOVLW, Op.RETLW, Op.RETLW, Op.RETLW, Op.RETLW,
  Op.IORLW, Op.ANDLW, Op.XORLW, Op.INVALID, Op.SUBLW, Op.SUBLW, Op.ADDLW, Op.ADDLW,
];

/** Operation number of a 14-bit word. */
export function decodeOp(word: number): number {
  const w = word & 0x3fff;
  switch (w >> 12) {
    case 0: {
      const nibble = (w >> 8) & 0xf;
      if (nibble === 1) return w & 0x80 ? Op.CLRF : Op.CLRW;
      if (nibble !== 0) return BYTE_OPS[nibble];
      if (w & 0x80) return Op.MOVWF;
      switch (w & 0x7f) {
        case 0x00: case 0x20: case 0x40: case 0x60: return Op.NOP;
        case 0x08: return Op.RETURN;
        case 0x09: return Op.RETFIE;
        case 0x62: return Op.OPTION;
        case 0x63: return Op.SLEEP;
        case 0x64: return Op.CLRWDT;
        case 0x65: case 0x66: case 0x67: return Op.TRIS;
        default: return Op.INVALID;
      }
    }
    case 1: return BIT_OPS[(w >> 10) & 3];
    case 2: return w & 0x800 ? Op.GOTO : Op.CALL;
    default: return LITERAL_OPS[(w >> 8) & 0xf];
  }
}

/**
 * Packed form used by the core's pre-decoded program:
 * bits 0–5 op; register forms: f in bits 8–14, d in bit 15, b in bits 16–18;
 * literal forms: k in bits 8–18.
 */
export const PACK_D = 0x8000;

export function decodePacked(word: number): number {
  const w = word & 0x3fff;
  const op = decodeOp(w);
  switch (w >> 12) {
    case 0: return op | ((w & 0x7f) << 8) | ((w & 0x80) << 8);
    case 1: return op | ((w & 0x7f) << 8) | (((w >> 7) & 7) << 16);
    case 2: return op | ((w & 0x7ff) << 8);
    default: return op | ((w & 0xff) << 8);
  }
}

export interface DecodedInstruction {
  op: number;
  /** Mnemonic, or undefined for an unassigned opcode. */
  mnemonic: Mnemonic | undefined;
  form: OperandForm;
  /** Register address (7 bits) for register forms. */
  f: number;
  /** Destination: 0 = W, 1 = f. */
  d: 0 | 1;
  /** Bit number for bit-oriented forms. */
  b: number;
  /** Literal (8 bits) or address (11 bits). */
  k: number;
}

export function decode(word: number): DecodedInstruction {
  const packed = decodePacked(word);
  const op = packed & 0x3f;
  const meta = BY_OP[op];
  const form = meta?.form ?? 'none';
  const f = (packed >>> 8) & 0x7f;
  // Fields an operand form does not use are reported as 0.
  return {
    op,
    mnemonic: meta?.mnemonic,
    form,
    f: form === 'f' || form === 'fd' || form === 'fb' ? f : form === 'tris' ? f & 0x07 : 0,
    d: form === 'fd' && packed & PACK_D ? 1 : 0,
    b: form === 'fb' ? (packed >>> 16) & 7 : 0,
    k: form === 'k11' ? (packed >>> 8) & 0x7ff : form === 'k8' ? (packed >>> 8) & 0xff : 0,
  };
}

/**
 * Encode one instruction. Operands follow the assembler order:
 * `fd` → (f, d), `f` → (f), `fb` → (f, b), `k8`/`k11` → (k), `tris` → (f).
 * Register addresses keep only their 7 low bits (bank bit comes from RP0 at run time).
 */
export function encode(mnemonic: Mnemonic, a = 0, b = 0): number {
  const meta = BY_MNEMONIC.get(mnemonic);
  if (!meta) throw new Error(`Mnémonique inconnu : ${mnemonic}`);
  switch (meta.form) {
    case 'none': return meta.base;
    case 'f': return meta.base | (a & 0x7f);
    case 'fd': return meta.base | (a & 0x7f) | ((b & 1) << 7);
    case 'fb': return meta.base | (a & 0x7f) | ((b & 7) << 7);
    case 'k8': return meta.base | (a & 0xff);
    case 'k11': return meta.base | (a & 0x7ff);
    case 'tris': return meta.base | (a & 0x7f);
  }
}
