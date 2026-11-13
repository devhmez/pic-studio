// Register-view model: STATUS bit chips, SFR rows, C variables (from the compiler's symbol table) and EEPROM cells.
// Pure functions over a DebugSnapshot so the React views stay thin and the logic is unit-tested.
import type { SymbolInfo } from '@pic/compiler';
import { sfrByName, type SfrName } from '@pic/emulator';
import { bin, bitOf, hex, hex0x } from './format';

// ---------------------------------------------------------------------------------------------------------------
// STATUS

export interface StatusChipDef {
  bit: number;
  /** Label as the course writes it (active-low bits with a leading slash). */
  label: string;
  /** French explanation shown on hover. */
  help: string;
}

/** STATUS bits, MSB first (IRP … C), with the course's explanations. */
export const STATUS_CHIP_DEFS: readonly StatusChipDef[] = [
  { bit: 7, label: 'IRP', help: "IRP : sélection de banque pour l'adressage indirect (banques 2–3). Inutilisé sur le PIC16F84A, reste à 0." },
  { bit: 6, label: 'RP1', help: 'RP1 : bit haut de sélection de banque. Inutilisé sur le PIC16F84A (2 banques seulement), reste à 0.' },
  { bit: 5, label: 'RP0', help: 'RP0 : sélection de banque — 0 = banque 0 (PORTA, PORTB, TMR0…), 1 = banque 1 (TRISA, TRISB, OPTION_REG…).' },
  { bit: 4, label: '/TO', help: "/TO : time-out (actif à 0) — passe à 0 quand le chien de garde (WDT) déborde. Vaut 1 après la mise sous tension, CLRWDT ou SLEEP. Lecture seule." },
  { bit: 3, label: '/PD', help: '/PD : power-down (actif à 0) — passe à 0 après l’instruction SLEEP. Vaut 1 après la mise sous tension ou CLRWDT. Lecture seule.' },
  { bit: 2, label: 'Z', help: 'Z : zéro — vaut 1 quand le résultat de la dernière opération est nul. Après z = x − y : Z = 1 signifie x = y.' },
  { bit: 1, label: 'DC', help: 'DC : retenue décimale — retenue du bit 3 vers le bit 4 (entre les deux demi-octets), utile en BCD.' },
  { bit: 0, label: 'C', help: "C : retenue — après une addition, C = 1 s'il y a dépassement (résultat > 255). Après une soustraction, C = 1 signifie pas d'emprunt : x ≥ y." },
];

export interface StatusChip extends StatusChipDef {
  value: 0 | 1;
  /** Changed since the baseline snapshot. */
  changed: boolean;
}

/** The 8 STATUS chips for a value, MSB first; `changedMask` marks bits that differ from the previous step. */
export function statusChips(status: number, changedMask = 0): StatusChip[] {
  return STATUS_CHIP_DEFS.map((d) => ({ ...d, value: bitOf(status, d.bit), changed: ((changedMask >> d.bit) & 1) === 1 }));
}

/** Data-memory bank selected by STATUS.RP0 (the PIC16F84A has banks 0 and 1 only). */
export function selectedBank(status: number): 0 | 1 {
  return bitOf(status, 5);
}

// ---------------------------------------------------------------------------------------------------------------
// SFR table

/** Registers listed in the SFR table, in teaching order (ports with their TRIS, then interrupts/timer, then the rest). */
export const SFR_VIEW_ORDER: readonly SfrName[] = [
  'PORTA', 'TRISA', 'PORTB', 'TRISB', 'INTCON', 'OPTION_REG', 'TMR0', 'FSR', 'PCLATH', 'EEDATA', 'EEADR', 'EECON1',
];

export interface BitCell {
  bit: number;
  value: 0 | 1;
  /** Datasheet bit name, or null for unnamed bits. */
  name: string | null;
  /** False for bits that do not exist in silicon (PORTA<7:5>…): drawn as '-'. */
  implemented: boolean;
  /** Hover text, e.g. 'RB3 = 1' or 'TRISB3 = 1 (entrée)'. */
  title: string;
}

export interface SfrRow {
  name: SfrName;
  addr: number;
  addrText: string;
  value: number;
  hexText: string;
  bits: BitCell[];
  description: string;
  changed: boolean;
}

function bitTitle(reg: string, name: string | null, bit: number, value: 0 | 1, implemented: boolean): string {
  if (!implemented) return `${reg} bit ${bit} : non implémenté (lu 0)`;
  const label = name ?? `${reg}.F${bit}`;
  if (reg === 'TRISA' || reg === 'TRISB') return `${label} = ${value} (${value ? 'entrée' : 'sortie'})`;
  if (name === 'RBPU') return `/RBPU = ${value} (${value ? 'pull-up PORTB désactivés' : 'pull-up PORTB activés'})`;
  if (name === 'INTEDG') return `INTEDG = ${value} (${value ? 'front montant' : 'front descendant'} sur RB0/INT)`;
  return `${label} = ${value}`;
}

/** Bit cells MSB first for one register value. */
export function bitCells(regName: string, value: number, names: readonly (string | null)[], implementedMask: number): BitCell[] {
  const cells: BitCell[] = [];
  for (let bit = 7; bit >= 0; bit--) {
    const implemented = ((implementedMask >> bit) & 1) === 1;
    const v = implemented ? bitOf(value, bit) : 0;
    const name = names[bit] ?? null;
    cells.push({ bit, value: v, name, implemented, title: bitTitle(regName, name, bit, v, implemented) });
  }
  return cells;
}

/** Rows of the SFR table from the bank-mapped file array. */
export function sfrRows(file: readonly number[], changed: ReadonlySet<number> = new Set()): SfrRow[] {
  return SFR_VIEW_ORDER.map((name) => {
    const info = sfrByName(name)!;
    const value = (file[info.addr] ?? 0) & 0xff;
    return {
      name,
      addr: info.addr,
      addrText: hex0x(info.addr),
      value,
      hexText: hex0x(value),
      bits: bitCells(name, value, info.bits, info.implemented),
      description: info.description,
      changed: changed.has(info.addr),
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// C variables

export interface VariableRow {
  key: string;
  name: string;
  /** 'global' or the function name. */
  scope: string;
  type: string;
  addrText: string;
  hexText: string;
  decText: string;
  binText: string;
  changed: boolean;
}

const SBIT_RE = /\(bit (\d)\)/;

function isSignedType(type: string): boolean {
  const t = type.trim();
  if (t.startsWith('unsigned')) return false;
  if (t.startsWith('signed')) return true;
  // MikroC: plain `char` is unsigned; `short`, `int`, `long` are signed.
  return /^(short|int|long)\b/.test(t);
}

/** Little-endian value of `size` bytes at `addr`. */
function readLE(file: readonly number[], addr: number, size: number): number {
  let v = 0;
  for (let i = size - 1; i >= 0; i--) v = v * 256 + ((file[addr + i] ?? 0) & 0xff);
  return v;
}

function toSigned(v: number, size: number): number {
  const bits = size * 8;
  const half = 2 ** (bits - 1);
  return v >= half ? v - 2 ** bits : v;
}

/**
 * One row per compiler symbol (sorted by address): sbits show their single bit, scalars their little-endian value
 * (signed when the C type is), arrays their bytes.
 */
export function variableRows(
  symbols: readonly SymbolInfo[],
  file: readonly number[] | null,
  changed: ReadonlySet<number> = new Set(),
): VariableRow[] {
  const sorted = [...symbols].sort((a, b) => a.addr - b.addr || a.name.localeCompare(b.name));
  return sorted.map((s) => {
    const key = `${s.scope}:${s.name}`;
    const sbit = SBIT_RE.exec(s.type);
    const touched = (() => {
      for (let i = 0; i < Math.max(1, s.size); i++) if (changed.has(s.addr + i)) return true;
      return false;
    })();
    const base = { key, name: s.name, scope: s.scope, type: s.type, changed: file !== null && touched };
    if (sbit) {
      const bit = Number(sbit[1]);
      const v = file ? bitOf(file[s.addr] ?? 0, bit) : null;
      return {
        ...base,
        addrText: `${hex0x(s.addr)}.${bit}`,
        hexText: v === null ? '—' : String(v),
        decText: v === null ? '—' : String(v),
        binText: v === null ? '—' : String(v),
      };
    }
    const isArray = s.type.includes('[');
    const size = Math.max(1, s.size);
    if (!file) return { ...base, addrText: hex0x(s.addr), hexText: '—', decText: '—', binText: '—' };
    if (isArray || size > 4) {
      const bytes: string[] = [];
      for (let i = 0; i < size; i++) bytes.push(hex(file[s.addr + i] ?? 0, 2));
      return { ...base, addrText: hex0x(s.addr), hexText: bytes.join(' '), decText: '', binText: '' };
    }
    const raw = readLE(file, s.addr, size);
    const dec = isSignedType(s.type) ? toSigned(raw, size) : raw;
    return {
      ...base,
      addrText: hex0x(s.addr),
      hexText: hex0x(raw, size * 2),
      decText: String(dec),
      binText: size === 1 ? bin(raw, 8) : bin(raw, size * 8).replace(/(.{8})(?!$)/g, '$1 '),
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Stack

export interface StackSlot {
  /** 1 = bottom … 8 = top of the 8-level hardware stack. */
  level: number;
  /** Return address, or null when the level is empty. */
  addr: number | null;
  isTop: boolean;
}

/** The 8 stack levels, top first (the order a student draws it). */
export function stackSlots(stack: readonly number[]): StackSlot[] {
  const slots: StackSlot[] = [];
  for (let level = 8; level >= 1; level--) {
    const addr = stack[level - 1];
    slots.push({ level, addr: addr === undefined ? null : addr, isTop: level === stack.length });
  }
  return slots;
}
