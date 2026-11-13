/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compile, type ListingLine } from '@pic/compiler';
import {
  breakpointLines, breakpointTogglesForLine, buildListingRows, describeLabel, execLineFor, moveCodeCursor, programRegions,
  rowIndexByAddr, usedWords,
} from './listing';

const fixture = (name: string) =>
  readFileSync(new URL(`../../../packages/compiler/test/fixtures/${name}`, import.meta.url));

const status = compile(fixture('status.c'), { clockHz: 1_000_000 });

const ISR_SOURCE = `
unsigned char cpt;
void interrupt() {
  if (INTCON.INTF) { cpt++; INTCON.INTF = 0; }
}
void main() {
  unsigned char i;
  TRISB = 0x01;
  INTCON = 0x90;
  while (1) {
    i = EEPROM_Read(2);
    PORTB = i;
  }
}`;
const isr = compile(ISR_SOURCE, { clockHz: 1_000_000 });

describe('listing rows', () => {
  it('compiles the fixtures used below', () => {
    expect(status.ok).toBe(true);
    expect(isr.ok).toBe(true);
  });

  it('maps every instruction to a code row with hex-3 address and hex-4 opcode', () => {
    const rows = buildListingRows(status.listing);
    const code = rows.filter((r) => r.kind === 'code');
    expect(code.length).toBe(status.listing.filter((l) => l.addr !== undefined).length);
    const first = code[0];
    expect(first.addrText).toBe('000');
    expect(first.mnemonic).toBe('GOTO');
    expect(first.operands).toBe('_main');
    const bsf = code.find((r) => r.addr === 4)!;
    expect(bsf.opcodeText).toBe('1683'); // BSF STATUS, RP0
    expect([bsf.mnemonic, bsf.operands]).toEqual(['BSF', 'STATUS, RP0']);
    expect(bsf.label).toBe('_main');
    expect(bsf.srcLine).toBe(9);
    expect(bsf.comment).toContain('TRISB = 0x00;');
  });

  it('labels the reset and interrupt vectors and the unused words in between', () => {
    const rows = buildListingRows(status.listing);
    const kinds = rows.slice(0, 5).map((r) => r.kind);
    expect(kinds).toEqual(['section', 'code', 'gap', 'section', 'code']);
    expect(rows[0].note).toBe('0000h · Vecteur de reset');
    expect(rows[2].note).toBe('0001h–0003h · 3 mots inutilisés');
    expect(rows[3].note).toMatch(/^0004h · Vecteur d'interruption \(pas d'interruption/);
    const isrRows = buildListingRows(isr.listing);
    expect(isrRows.find((r) => r.kind === 'section' && r.note?.startsWith('0004h'))!.note).toMatch(/routine interrupt\(\)/);
  });

  it('keeps label-only lines and indexes rows by address', () => {
    const listing: ListingLine[] = [
      { addr: 0, word: 0x2804, text: 'GOTO _main' },
      { label: 'L_main_0', text: '' },
      { addr: 4, word: 0, text: 'NOP', label: '_main', srcLine: 2 },
      { label: 'L_main_1', text: '' },
      { addr: 5, word: 0x2805, text: 'GOTO $', srcLine: 3 },
      { label: 'L_end', text: '' },
    ];
    const rows = buildListingRows(listing);
    // L_main_0 belongs to 0004h: shown after the gap and the vector title, right before the instruction.
    expect(rows.map((r) => r.label ?? r.kind)).toEqual(['section', 'code', 'gap', 'section', 'L_main_0', '_main', 'L_main_1', 'code', 'L_end']);
    expect(rows.map((r) => r.kind)).toEqual(['section', 'code', 'gap', 'section', 'label', 'code', 'label', 'code', 'label']);
    const idx = rowIndexByAddr(rows);
    expect(idx.get(0)).toBe(1);
    expect(idx.get(4)).toBe(5);
    expect(idx.get(5)).toBe(7);
    expect(idx.has(1)).toBe(false);
  });
});

describe('listing keyboard cursor', () => {
  const rows = buildListingRows(status.listing);
  const code = rows.flatMap((r, i) => (r.kind === 'code' ? [i] : []));

  it('moves over instruction rows only, skipping vector and gap rows', () => {
    expect(moveCodeCursor(rows, -1, 1)).toBe(code[0]);
    expect(moveCodeCursor(rows, -1, -1)).toBe(code[code.length - 1]);
    expect(moveCodeCursor(rows, code[0], 1)).toBe(code[1]); // 000 → 004, across the gap and the 0004h title
    expect(rows[code[1]].addr).toBe(4);
    expect(moveCodeCursor(rows, code[1], -1)).toBe(code[0]);
  });

  it('clamps at both ends and supports page jumps', () => {
    expect(moveCodeCursor(rows, code[0], -5)).toBe(code[0]);
    expect(moveCodeCursor(rows, code[2], 1000)).toBe(code[code.length - 1]);
    expect(moveCodeCursor(rows, code[0], 10)).toBe(code[10]);
    expect(moveCodeCursor([], -1, 1)).toBe(-1);
  });
});

describe('program memory regions', () => {
  it('splits memory into vector, routines and free space up to 03FFh', () => {
    const regions = programRegions(isr.listing);
    expect(regions[0]).toMatchObject({ from: 0, to: 0, kind: 'reset' });
    expect(regions[1]).toMatchObject({ from: 1, to: 3, kind: 'free' });
    expect(regions[2]).toMatchObject({ from: 4, kind: 'interrupt' });
    expect(regions.some((r) => r.kind === 'main')).toBe(true);
    expect(regions.some((r) => r.kind === 'library' && r.name.includes('EEPROM_Read'))).toBe(true);
    const last = regions[regions.length - 1];
    expect(last).toMatchObject({ kind: 'free', to: 0x3ff });
    // Regions tile the whole memory without overlap.
    for (let i = 1; i < regions.length; i++) expect(regions[i].from).toBe(regions[i - 1].to + 1);
  });

  it('counts used words like the compiler', () => {
    expect(usedWords(status.listing)).toBe(status.usage.rom);
    expect(usedWords([{ addr: 0, text: 'GOTO _main' }, { label: 'x', text: '' }, { addr: 4, text: 'NOP' }])).toBe(2);
  });

  it('describes compiler labels in French', () => {
    expect(describeLabel('_main')).toEqual({ kind: 'main', name: 'main()' });
    expect(describeLabel('_compte').name).toBe('compte()');
    expect(describeLabel('__mul16').name).toBe('Routine multiplication 16 bits (bibliothèque)');
    expect(describeLabel('_tbl_seg').kind).toBe('table');
  });
});

describe('C line <-> address helpers', () => {
  it('finds the executing C line from the PC', () => {
    // status.c: 0x12 = MOVF y,W of `z = x - y;` (line 17)
    expect(execLineFor(0x12, [], status.addrToLine)).toBe(17);
  });

  it('falls back to the calling line inside a library routine', () => {
    const eeread = isr.listing.find((l) => l.label === '__eeread')!.addr!;
    const call = isr.listing.find((l) => l.text === 'CALL __eeread')!;
    expect(execLineFor(eeread + 2, [call.addr! + 1], isr.addrToLine)).toBe(call.srcLine);
    expect(execLineFor(0x3ff, [], isr.addrToLine)).toBeNull();
  });

  it('collects breakpoint lines', () => {
    expect([...breakpointLines([0x12, 0x13, 0x15], status.addrToLine)].sort()).toEqual([17, 18]);
  });

  it('toggles a line: sets its first address, or clears every breakpoint on it', () => {
    const { lineToAddr, addrToLine } = status;
    expect(breakpointTogglesForLine(17, lineToAddr, addrToLine, [])).toEqual([0x12]);
    expect(breakpointTogglesForLine(17, lineToAddr, addrToLine, [0x13, 0x14, 0x15])).toEqual([0x13, 0x14]);
    expect(breakpointTogglesForLine(7, lineToAddr, addrToLine, [])).toEqual([]); // declaration line: no code
  });
});
