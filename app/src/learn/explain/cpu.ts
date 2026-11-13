// Register-file vocabulary shared by the instruction, change and line explanations: bank-mapped addresses, SFR and
// bit names, variable names from the compiler's symbol table, and the pin behind a port bit.
import type { SymbolInfo } from '@pic/compiler';
import { PIN_NUMBER, sfrAt, type PinName } from '@pic/emulator';
import { bitOf, hex2 } from './text';

/** The part of a debugger snapshot the explanations read (structurally compatible with DebugSnapshot). */
export interface CpuState {
  pc: number;
  w: number;
  status: number;
  /** 256 bank-mapped file registers (index = address 0x00–0xFF). */
  file: ArrayLike<number>;
  /** Hardware stack, bottom..top. */
  stack: readonly number[];
  cycles?: number;
}

export const ADDR = {
  INDF: 0x00, TMR0: 0x01, PCL: 0x02, STATUS: 0x03, FSR: 0x04, PORTA: 0x05, PORTB: 0x06,
  EEDATA: 0x08, EEADR: 0x09, PCLATH: 0x0a, INTCON: 0x0b,
  OPTION_REG: 0x81, TRISA: 0x85, TRISB: 0x86, EECON1: 0x88, EECON2: 0x89,
} as const;

export const STATUS_RP0_BIT = 5;
export const GPR_FIRST = 0x0c;
export const GPR_LAST = 0x4f;

/** Names of general-purpose registers (C variables and compiler temporaries). */
export interface Naming {
  /** Name of the GPR at a 7-bit address (0x0C–0x4F), e.g. 'x' or 'var1+1'. */
  variable(addr: number): string | undefined;
}

export const NO_NAMING: Naming = { variable: () => undefined };

/** Naming from the compiler's symbol table: one name per byte ('compte', 'n+1' for the high byte of an int). */
export function namingFromSymbols(symbols: readonly SymbolInfo[] | undefined): Naming {
  const byAddr = new Map<number, string>();
  for (const s of symbols ?? []) {
    if (/\(bit \d\)/.test(s.type)) continue; // sbit aliases point at an SFR or share a byte
    const size = Math.max(1, s.size);
    for (let i = 0; i < size; i++) {
      const a = (s.addr + i) & 0x7f;
      if (a < GPR_FIRST || a > GPR_LAST || byAddr.has(a)) continue;
      byAddr.set(a, i === 0 ? s.name : `${s.name}+${i}`);
    }
  }
  return { variable: (addr) => byAddr.get(addr & 0x7f) };
}

/** Variable value lookup by C name (case-insensitive, as MikroC identifiers are). */
export function variableAddresses(symbols: readonly SymbolInfo[] | undefined): Map<string, SymbolInfo> {
  const out = new Map<string, SymbolInfo>();
  for (const s of symbols ?? []) {
    const key = s.name.toLowerCase();
    if (!out.has(key)) out.set(key, s);
  }
  return out;
}

/** Bank-mapped address of a 7-bit register operand under the current STATUS.RP0. */
export function fullAddress(f: number, status: number): number {
  const low = f & 0x7f;
  if (low >= GPR_FIRST) return low; // GPRs are mirrored: same byte in both banks
  return low | (bitOf(status, STATUS_RP0_BIT) << 7);
}

/** True for a general-purpose RAM address (either bank). */
export function isGpr(addr: number): boolean {
  const low = addr & 0x7f;
  return low >= GPR_FIRST && low <= GPR_LAST;
}

/** Name of a bank-mapped register: 'PORTB', 'TRISB', a variable, or its hex address. */
export function registerName(addr: number, naming: Naming = NO_NAMING): string {
  const a = addr & 0xff;
  if (isGpr(a)) return naming.variable(a & 0x7f) ?? hex2(a & 0x7f);
  const sfr = sfrAt(a);
  if (sfr) return sfr.name;
  return hex2(a);
}

/** Datasheet bit name of a register bit ('Z', 'RP0', 'GIE', 'RB1', 'TRISB1'), or null. */
export function bitName(addr: number, bit: number): string | null {
  if (isGpr(addr)) return null;
  return sfrAt(addr & 0xff)?.bits[bit] ?? null;
}

/** Value of a bank-mapped register in a snapshot (GPR mirrors read through bank 0). */
export function readRegister(state: Pick<CpuState, 'file'>, addr: number): number {
  const a = isGpr(addr) ? addr & 0x7f : addr & 0xff;
  return (state.file[a] ?? 0) & 0xff;
}

export type PortName = 'PORTA' | 'PORTB';

/** GPIO behind a port bit: ('PORTB', 1) → 'RB1'; PORTA bits 5–7 do not exist. */
export function pinOfPortBit(port: PortName, bit: number): PinName | null {
  if (port === 'PORTA') return bit <= 4 ? (`RA${bit}` as PinName) : null;
  return bit <= 7 ? (`RB${bit}` as PinName) : null;
}

/** Port register and bit of a GPIO: 'RB1' → { port: 'PORTB', tris: TRISB address, bit: 1 }. */
export function portOfPin(pin: PinName): { port: PortName; portAddr: number; trisAddr: number; bit: number } {
  const bit = Number(pin.slice(2));
  return pin.startsWith('RA')
    ? { port: 'PORTA', portAddr: ADDR.PORTA, trisAddr: ADDR.TRISA, bit }
    : { port: 'PORTB', portAddr: ADDR.PORTB, trisAddr: ADDR.TRISB, bit };
}

/** « RB1 (broche 7) ». */
export function pinWithNumber(pin: PinName): string {
  return `${pin} (broche ${PIN_NUMBER[pin]})`;
}

/** Port register that a TRIS register configures: TRISB → PORTB. */
export function portOfTris(addr: number): PortName | null {
  if (addr === ADDR.TRISA) return 'PORTA';
  if (addr === ADDR.TRISB) return 'PORTB';
  return null;
}

/** Interrupt sources whose flag and enable bits are both set (INTCON, plus EEIF of EECON1). */
export function pendingInterrupts(intcon: number, eecon1 = 0): ('INT' | 'RB' | 'T0' | 'EE')[] {
  const out: ('INT' | 'RB' | 'T0' | 'EE')[] = [];
  if (bitOf(intcon, 4) && bitOf(intcon, 1)) out.push('INT');
  if (bitOf(intcon, 3) && bitOf(intcon, 0)) out.push('RB');
  if (bitOf(intcon, 5) && bitOf(intcon, 2)) out.push('T0');
  if (bitOf(intcon, 6) && bitOf(eecon1, 4)) out.push('EE');
  return out;
}

export const INTERRUPT_SOURCE_TEXT: Readonly<Record<'INT' | 'RB' | 'T0' | 'EE', string>> = {
  INT: 'un front sur RB0/INT (drapeau INTF = 1, autorisé par INTE = 1)',
  RB: 'un changement d’état sur RB4 à RB7 (drapeau RBIF = 1, autorisé par RBIE = 1)',
  T0: 'le débordement de TMR0, de 255 à 0 (drapeau T0IF = 1, autorisé par T0IE = 1)',
  EE: 'la fin d’une écriture en EEPROM (drapeau EEIF = 1, autorisé par EEIE = 1)',
};
