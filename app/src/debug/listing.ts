// Listing / program-memory model: maps the compiler's ListingLine[] to display rows (with the reset and interrupt
// vectors called out), program-memory regions for the map, and C-line <-> address helpers shared with the editor.
import type { ListingLine } from '@pic/compiler';
import { hex, hexH } from './format';

export const PROGRAM_WORDS = 1024;
export const RESET_VECTOR = 0x0000;
export const INTERRUPT_VECTOR = 0x0004;
export const LAST_ADDRESS = PROGRAM_WORDS - 1;

export type ListingRowKind = 'code' | 'label' | 'section' | 'gap';

export interface ListingRow {
  key: string;
  kind: ListingRowKind;
  addr: number | null;
  /** 'hex 3' address: '004'. Empty for non-code rows. */
  addrText: string;
  /** 'hex 4' opcode: '1683'. */
  opcodeText: string;
  label: string | null;
  mnemonic: string;
  operands: string;
  /** C source text (first instruction of each C line). */
  comment: string | null;
  srcLine: number | null;
  /** Text of section/gap rows. */
  note: string | null;
}

function splitText(text: string): { mnemonic: string; operands: string } {
  const t = text.trim();
  const sp = t.indexOf(' ');
  return sp < 0 ? { mnemonic: t, operands: '' } : { mnemonic: t.slice(0, sp), operands: t.slice(sp + 1).trim() };
}

/** Section title shown above the vector rows. */
export function vectorNote(addr: number, label: string | undefined): string | null {
  if (addr === RESET_VECTOR) return `${hexH(RESET_VECTOR)} · Vecteur de reset`;
  if (addr === INTERRUPT_VECTOR) {
    return label === '_interrupt'
      ? `${hexH(INTERRUPT_VECTOR)} · Vecteur d'interruption — routine interrupt()`
      : `${hexH(INTERRUPT_VECTOR)} · Vecteur d'interruption (pas d'interruption : le programme continue ici)`;
  }
  return null;
}

/**
 * Display rows of a listing: one row per instruction, label-only rows, a section row above 0000h and 0004h, and a
 * gap row for unused words between two instructions (0001h–0003h after the reset GOTO).
 */
export function buildListingRows(listing: readonly ListingLine[]): ListingRow[] {
  const rows: ListingRow[] = [];
  let prevAddr: number | null = null;
  let n = 0;
  const empty = { addrText: '', opcodeText: '', mnemonic: '', operands: '', comment: null, srcLine: null, label: null };
  // Label-only lines name the next instruction's address: they are shown after any gap / vector rows.
  let pendingLabels: ListingRow[] = [];
  for (const line of listing) {
    if (line.addr === undefined) {
      if (line.label) pendingLabels.push({ ...empty, key: `l${n++}`, kind: 'label', addr: null, label: line.label, note: null });
      continue;
    }
    const addr = line.addr;
    if (prevAddr !== null && addr > prevAddr + 1) {
      rows.push({ ...empty, key: `g${prevAddr + 1}`, kind: 'gap', addr: null, note: gapNote(prevAddr + 1, addr - 1) });
    }
    const note = vectorNote(addr, line.label);
    if (note) rows.push({ ...empty, key: `s${addr}`, kind: 'section', addr: null, note });
    rows.push(...pendingLabels);
    pendingLabels = [];
    const { mnemonic, operands } = splitText(line.text);
    rows.push({
      key: `a${addr}`,
      kind: 'code',
      addr,
      addrText: hex(addr, 3),
      opcodeText: line.word === undefined ? '' : hex(line.word & 0x3fff, 4),
      label: line.label ?? null,
      mnemonic,
      operands,
      comment: line.comment ?? null,
      srcLine: line.srcLine ?? null,
      note: null,
    });
    prevAddr = addr;
  }
  rows.push(...pendingLabels);
  return rows;
}

function gapNote(from: number, to: number): string {
  const count = to - from + 1;
  const range = from === to ? hexH(from) : `${hexH(from)}–${hexH(to)}`;
  return `${range} · ${count} mot${count > 1 ? 's' : ''} inutilisé${count > 1 ? 's' : ''}`;
}

/**
 * Keyboard cursor over instruction rows: from instruction row `from` move `delta` instructions (negative = up),
 * clamped to the first / last one. Without a valid start, lands on the first (delta ≥ 0) or last instruction.
 * Returns -1 when the listing has no instruction.
 */
export function moveCodeCursor(rows: readonly ListingRow[], from: number, delta: number): number {
  const code: number[] = [];
  rows.forEach((r, i) => { if (r.kind === 'code') code.push(i); });
  if (code.length === 0) return -1;
  const k = code.indexOf(from);
  if (k < 0) return delta < 0 ? code[code.length - 1] : code[0];
  return code[Math.min(code.length - 1, Math.max(0, k + delta))];
}

/** Row index of each instruction address. */
export function rowIndexByAddr(rows: readonly ListingRow[]): Map<number, number> {
  const m = new Map<number, number>();
  rows.forEach((r, i) => { if (r.kind === 'code' && r.addr !== null) m.set(r.addr, i); });
  return m;
}

// ---------------------------------------------------------------------------------------------------------------
// Program memory map

export type RegionKind = 'reset' | 'interrupt' | 'main' | 'function' | 'library' | 'table' | 'free';

export interface ProgramRegion {
  from: number;
  to: number;
  kind: RegionKind;
  /** French description, e.g. 'main()', 'Routine EEPROM_Read (bibliothèque)'. */
  name: string;
  label: string | null;
}

const LIBRARY_NAMES: Record<string, string> = {
  __eeread: 'EEPROM_Read',
  __eewrite: 'EEPROM_Write',
  __mul8: 'multiplication 8 bits',
  __mul16: 'multiplication 16 bits',
  __div8: 'division 8 bits',
  __div16: 'division 16 bits',
  __tbl_jump: 'saut dans une table',
};

/** Human description of a routine label produced by the compiler. */
export function describeLabel(label: string): { kind: RegionKind; name: string } {
  if (label === '_main') return { kind: 'main', name: 'main()' };
  if (label === '_interrupt') return { kind: 'interrupt', name: 'interrupt() — routine d’interruption' };
  if (label.startsWith('_tbl_')) return { kind: 'table', name: `Table constante ${label.slice(5)} (RETLW)` };
  if (label.startsWith('__')) {
    const known = LIBRARY_NAMES[label];
    return { kind: 'library', name: known ? `Routine ${known} (bibliothèque)` : `Routine interne ${label.slice(2)}` };
  }
  if (label.startsWith('_')) return { kind: 'function', name: `${label.slice(1)}()` };
  return { kind: 'function', name: label };
}

/** True for labels that start a routine (compiler-internal jump labels look like L_main_3). */
function isRoutineLabel(label: string | undefined): label is string {
  return !!label && !/^L_/.test(label);
}

/**
 * Contiguous program-memory regions, in address order: the reset vector, each routine (main, interrupt, functions,
 * library routines, constant tables) and the free words up to 03FFh.
 */
export function programRegions(listing: readonly ListingLine[]): ProgramRegion[] {
  const code = listing.filter((l): l is ListingLine & { addr: number } => l.addr !== undefined).sort((a, b) => a.addr - b.addr);
  const regions: ProgramRegion[] = [];
  let cur: ProgramRegion | null = null;
  let last = -1;
  const pushFree = (from: number, to: number) => {
    if (to >= from) regions.push({ from, to, kind: 'free', name: 'Libre', label: null });
  };
  for (const l of code) {
    const a = l.addr;
    const startsRoutine = a === RESET_VECTOR || isRoutineLabel(l.label) || a > last + 1;
    if (!cur || startsRoutine) {
      if (cur) regions.push(cur);
      pushFree(last + 1, a - 1);
      if (a === RESET_VECTOR) cur = { from: a, to: a, kind: 'reset', name: 'Vecteur de reset (saut vers main)', label: l.label ?? null };
      else if (isRoutineLabel(l.label)) cur = { from: a, to: a, ...describeLabel(l.label), label: l.label };
      else cur = { from: a, to: a, kind: 'function', name: 'Code', label: null };
    }
    cur.to = a;
    last = a;
  }
  if (cur) regions.push(cur);
  pushFree(last + 1, LAST_ADDRESS);
  return regions;
}

/** Number of program words holding an instruction. */
export function usedWords(listing: readonly ListingLine[]): number {
  const seen = new Set<number>();
  for (const l of listing) if (l.addr !== undefined) seen.add(l.addr);
  return seen.size;
}

// ---------------------------------------------------------------------------------------------------------------
// C line <-> address

/**
 * C source line the core is executing: the line of the PC, or — inside a library routine that has no C line
 * (Delay loop helpers, EEPROM_Read, multiplication) — the line of the CALL found through the stack.
 */
export function execLineFor(
  pc: number,
  stack: readonly number[],
  addrToLine: ReadonlyMap<number, number>,
): number | null {
  const direct = addrToLine.get(pc);
  if (direct !== undefined) return direct;
  for (let i = stack.length - 1; i >= 0; i--) {
    const caller = addrToLine.get((stack[i] - 1) & 0x1fff);
    if (caller !== undefined) return caller;
  }
  return null;
}

/** C lines that hold at least one breakpoint. */
export function breakpointLines(breakpoints: readonly number[], addrToLine: ReadonlyMap<number, number>): Set<number> {
  const lines = new Set<number>();
  for (const a of breakpoints) {
    const l = addrToLine.get(a);
    if (l !== undefined) lines.add(l);
  }
  return lines;
}

/**
 * Addresses to pass to toggleBreakpoint() when the user clicks C line `line`: every breakpoint already on that line
 * (to clear it), or the line's first address (to set one). Empty when the line generates no code.
 */
export function breakpointTogglesForLine(
  line: number,
  lineToAddr: ReadonlyMap<number, number>,
  addrToLine: ReadonlyMap<number, number>,
  breakpoints: readonly number[],
): number[] {
  const onLine = breakpoints.filter((a) => addrToLine.get(a) === line);
  if (onLine.length > 0) return onLine;
  const first = lineToAddr.get(line);
  return first === undefined ? [] : [first];
}
