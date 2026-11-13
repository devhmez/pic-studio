// PIC16F84A register file as seen by the compiler (datasheet DS35007, Table 2-1 and the per-register maps).
// Names follow @pic/emulator's sfr.ts (PD, TO, RBPU), with the MikroC/XC8 spellings (NOT_PD, TMR0IF…) as aliases.

export type Bank = 0 | 1 | 'both';

export interface SfrDef {
  name: string;
  /** Canonical address (bank-1-only registers use their 0x80+ address). */
  addr: number;
  bank: Bank;
  /** Datasheet bit names, index = bit number (null = unimplemented). */
  bits: readonly (string | null)[];
  /** Number of implemented bits from bit 0 (PORTA/TRISA: 5). */
  width: number;
}

const sfr = (name: string, addr: number, bank: Bank, bits: (string | null)[] = [], width = 8): SfrDef => ({
  name, addr, bank, bits, width,
});

export const SFRS: readonly SfrDef[] = [
  sfr('INDF', 0x00, 'both'),
  sfr('TMR0', 0x01, 0),
  sfr('PCL', 0x02, 'both'),
  sfr('STATUS', 0x03, 'both', ['C', 'DC', 'Z', 'PD', 'TO', 'RP0', 'RP1', 'IRP']),
  sfr('FSR', 0x04, 'both'),
  sfr('PORTA', 0x05, 0, ['RA0', 'RA1', 'RA2', 'RA3', 'RA4', null, null, null], 5),
  sfr('PORTB', 0x06, 0, ['RB0', 'RB1', 'RB2', 'RB3', 'RB4', 'RB5', 'RB6', 'RB7']),
  sfr('EEDATA', 0x08, 0),
  sfr('EEADR', 0x09, 0),
  sfr('PCLATH', 0x0a, 'both'),
  sfr('INTCON', 0x0b, 'both', ['RBIF', 'INTF', 'T0IF', 'RBIE', 'INTE', 'T0IE', 'EEIE', 'GIE']),
  sfr('OPTION_REG', 0x81, 1, ['PS0', 'PS1', 'PS2', 'PSA', 'T0SE', 'T0CS', 'INTEDG', 'RBPU']),
  sfr('TRISA', 0x85, 1, ['TRISA0', 'TRISA1', 'TRISA2', 'TRISA3', 'TRISA4', null, null, null], 5),
  sfr('TRISB', 0x86, 1, ['TRISB0', 'TRISB1', 'TRISB2', 'TRISB3', 'TRISB4', 'TRISB5', 'TRISB6', 'TRISB7']),
  sfr('EECON1', 0x88, 1, ['RD', 'WR', 'WREN', 'WRERR', 'EEIF', null, null, null], 5),
  sfr('EECON2', 0x89, 1),
];

/** Alternative register names accepted by MikroC / HI-TECH. */
const SFR_ALIASES: Record<string, string> = { OPTION: 'OPTION_REG', EEDAT: 'EEDATA' };

const SFR_BY_NAME = new Map<string, SfrDef>();
for (const s of SFRS) SFR_BY_NAME.set(s.name.toLowerCase(), s);
for (const [alias, target] of Object.entries(SFR_ALIASES)) SFR_BY_NAME.set(alias.toLowerCase(), SFR_BY_NAME.get(target.toLowerCase())!);

/** Case-insensitive SFR lookup (also accepts XC8 `PORTBbits`-style names). */
export function findSfr(name: string): SfrDef | undefined {
  const lower = name.toLowerCase();
  return SFR_BY_NAME.get(lower) ?? (lower.endsWith('bits') ? SFR_BY_NAME.get(lower.slice(0, -4)) : undefined);
}

export function sfrAt(addr: number): SfrDef | undefined {
  return SFRS.find((s) => s.addr === addr || (s.bank === 'both' && s.addr === (addr & 0x7f)));
}

export interface BitName {
  /** Bit position 0..7. */
  bit: number;
  /** Register the name belongs to in the datasheet. */
  reg: string;
}

/** Every predefined bit name (and aliases) with its position and owning register. Keys are upper-case. */
export const BIT_NAMES: ReadonlyMap<string, BitName> = (() => {
  const m = new Map<string, BitName>();
  for (const s of SFRS) s.bits.forEach((b, i) => { if (b) m.set(b, { bit: i, reg: s.name }); });
  const alias = (name: string, of: string) => m.set(name, m.get(of)!);
  alias('NOT_PD', 'PD');
  alias('NOT_TO', 'TO');
  alias('NOT_RBPU', 'RBPU');
  alias('TMR0IF', 'T0IF');
  alias('TMR0IE', 'T0IE');
  alias('T0CKI', 'RA4');
  alias('INT', 'RB0');
  return m;
})();

/** HI-TECH / XC8 bare bit variables (`CARRY`, `ZERO`, `RB0`, `TRISA0`…), only with `#include <htc.h>`. */
export const HITECH_BIT_VARS: ReadonlyMap<string, BitName> = (() => {
  const m = new Map<string, BitName>();
  for (const [name, b] of BIT_NAMES) {
    if (name === 'C' || name === 'Z' || name === 'DC') continue; // too collision-prone; HI-TECH uses CARRY/ZERO/DC
    m.set(name, b);
  }
  m.set('CARRY', { bit: 0, reg: 'STATUS' });
  m.set('DC', { bit: 1, reg: 'STATUS' });
  m.set('ZERO', { bit: 2, reg: 'STATUS' });
  return m;
})();

/** Resolve a bit selector written after a register: F0–F31, B0–B31 or a predefined bit name. */
export function resolveBitSelector(sel: string): number | undefined {
  const m = /^[FB]([0-9]{1,2})$/i.exec(sel);
  if (m) return Number(m[1]);
  return BIT_NAMES.get(sel.toUpperCase())?.bit;
}

/** Bank-agnostic GPR range on the PIC16F84A (0x8C–0xCF mirror 0x0C–0x4F). */
export const GPR_START = 0x0c;
export const GPR_END = 0x4f;
export const PROGRAM_WORDS = 1024;
export const STACK_LEVELS = 8;
export const DEFAULT_CONFIG = 0x3ffb;
export const CONFIG_ADDR = 0x2007;

/** Bank a file register address needs (GPRs and mirrored SFRs need none). */
export function bankOfAddress(addr: number): Bank {
  const low = addr & 0x7f;
  if (low >= GPR_START && low <= GPR_END) return 'both';
  const s = sfrAt(addr);
  if (s) return s.bank;
  return addr >= 0x80 ? 1 : 0;
}

/** Normalise a data address: GPR mirrors map to bank 0. */
export function canonicalAddress(addr: number): number {
  const low = addr & 0x7f;
  if (low >= GPR_START && low <= GPR_END) return low;
  const s = sfrAt(addr);
  return s ? s.addr : addr;
}

/** True when the address is neither a SFR nor a GPR on this device (reads as 0). */
export function isUnimplemented(addr: number): boolean {
  const low = addr & 0x7f;
  if (low >= GPR_START && low <= GPR_END) return false;
  return !sfrAt(addr);
}
