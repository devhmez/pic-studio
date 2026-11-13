import type {
  CType, FunctionDeclaration, IntType, Parameter, SbitDeclaration, VariableDeclaration,
} from '../ast';
import type { SfrDef } from '../device';

export type BuiltinId =
  | 'delay_ms' | 'delay_us' | 'delay_cyc' | 'vdelay_ms' | 'button' | 'eeprom_read' | 'eeprom_write'
  | 'clock_khz' | 'clock_mhz' | 'swap' | 'lo' | 'hi' | 'higher' | 'highest';

export interface VarSymbol {
  kind: 'var';
  name: string;
  type: CType;
  isConst: boolean;
  isVolatile: boolean;
  storage: 'global' | 'local' | 'param' | 'static';
  /** Owning function for locals and params. */
  fn: FuncSymbol | null;
  decl: VariableDeclaration | Parameter;
  /** Fixed address (`absolute`). */
  absolute?: number;
  /** Compile-time value of a `const` scalar (no storage is allocated). */
  constValue?: number;
  /** Contents of a `const` array, placed in program memory as a RETLW table. */
  romData?: number[];
  /** Initial value(s) of a global/static variable, written by the startup code. */
  initData?: number[];
  reads: number;
  writes: number;
}

export interface SfrSymbol {
  kind: 'sfr';
  name: string;
  def: SfrDef;
}

/** A single bit of a register or variable. */
export type BitTarget =
  | { kind: 'sfr'; def: SfrDef; bit: number }
  | { kind: 'var'; sym: VarSymbol; bit: number };

/** `sbit` declarations, MikroC `RB0_bit` aliases and HI-TECH bare bits (`RB0`, `CARRY`). */
export interface SbitSymbol {
  kind: 'sbit';
  name: string;
  target: BitTarget;
  decl: SbitDeclaration | null;
  /** Function declaring a local `sbit`. */
  fn?: FuncSymbol;
}

/** MikroC predefined bit-position constant (`RA0` = 0, `GIE` = 7) when used outside a bit selector. */
export interface BitNameSymbol {
  kind: 'bitname';
  name: string;
  bit: number;
}

export interface FuncSymbol {
  kind: 'func';
  name: string;
  returnType: CType;
  params: VarSymbol[];
  decl: FunctionDeclaration | null;
  defined: boolean;
  isInterrupt: boolean;
  builtin?: BuiltinId;
  locals: VarSymbol[];
  /** User functions called from this function. */
  callees: Set<FuncSymbol>;
}

export type Symbol = VarSymbol | SfrSymbol | SbitSymbol | BitNameSymbol | FuncSymbol;

export interface BuiltinSignature {
  id: BuiltinId;
  name: string;
  params: IntType[];
  returnType: CType;
  /** Indexes of arguments that must be compile-time constants. */
  constArgs: number[];
}

const U8: IntType = { kind: 'int', size: 1, signed: false };
const U16: IntType = { kind: 'int', size: 2, signed: false };
const U32: IntType = { kind: 'int', size: 4, signed: false };
const VOID: CType = { kind: 'void' };

/** MikroC PRO built-in routines (keys are lower-case; identifiers are case-insensitive). */
export const BUILTINS: ReadonlyMap<string, BuiltinSignature> = new Map<string, BuiltinSignature>([
  ['delay_ms', { id: 'delay_ms', name: 'Delay_ms', params: [U32], returnType: VOID, constArgs: [0] }],
  ['delay_us', { id: 'delay_us', name: 'Delay_us', params: [U32], returnType: VOID, constArgs: [0] }],
  ['__delay_ms', { id: 'delay_ms', name: '__delay_ms', params: [U32], returnType: VOID, constArgs: [0] }],
  ['__delay_us', { id: 'delay_us', name: '__delay_us', params: [U32], returnType: VOID, constArgs: [0] }],
  // A library routine taking a run-time char (MikroC: `void Delay_Cyc(char Cycles_div_by_10);`, 3..255).
  ['delay_cyc', { id: 'delay_cyc', name: 'Delay_Cyc', params: [U8], returnType: VOID, constArgs: [] }],
  ['vdelay_ms', { id: 'vdelay_ms', name: 'Vdelay_ms', params: [U16], returnType: VOID, constArgs: [] }],
  ['button', { id: 'button', name: 'Button', params: [U8, U8, U8, U8], returnType: U8, constArgs: [] }],
  ['eeprom_read', { id: 'eeprom_read', name: 'EEPROM_Read', params: [U8], returnType: U8, constArgs: [] }],
  ['eeprom_write', { id: 'eeprom_write', name: 'EEPROM_Write', params: [U8, U8], returnType: VOID, constArgs: [] }],
  ['clock_khz', { id: 'clock_khz', name: 'Clock_kHz', params: [], returnType: U16, constArgs: [] }],
  ['clock_mhz', { id: 'clock_mhz', name: 'Clock_MHz', params: [], returnType: U8, constArgs: [] }],
  ['swap', { id: 'swap', name: 'swap', params: [U8], returnType: U8, constArgs: [] }],
  ['lo', { id: 'lo', name: 'Lo', params: [U32], returnType: U8, constArgs: [] }],
  ['hi', { id: 'hi', name: 'Hi', params: [U32], returnType: U8, constArgs: [] }],
  ['higher', { id: 'higher', name: 'Higher', params: [U32], returnType: U8, constArgs: [] }],
  ['highest', { id: 'highest', name: 'Highest', params: [U32], returnType: U8, constArgs: [] }],
]);

/**
 * Byte selected by MikroC's built_in.h macros, e.g. `#define Hi(param) ((char *)&param)[1]`: they read a byte of a
 * variable and can also be assigned (`Hi(counter) = 0x12;`).
 */
export const BYTE_SELECTORS: Partial<Record<BuiltinId, number>> = { lo: 0, hi: 1, higher: 2, highest: 3 };

/** Case-insensitive symbol scope chain. */
export class Scope {
  private readonly map = new Map<string, Symbol>();

  constructor(readonly parent: Scope | null) {}

  lookup(name: string): Symbol | undefined {
    const key = name.toLowerCase();
    for (let s: Scope | null = this; s; s = s.parent) {
      const v = s.map.get(key);
      if (v) return v;
    }
    return undefined;
  }

  lookupLocal(name: string): Symbol | undefined {
    return this.map.get(name.toLowerCase());
  }

  define(name: string, sym: Symbol): void {
    this.map.set(name.toLowerCase(), sym);
  }
}
