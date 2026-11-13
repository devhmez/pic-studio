import { describe, expect, it } from 'vitest';
import type { SymbolInfo } from '@pic/compiler';
import { bitCells, selectedBank, sfrRows, stackSlots, statusChips, variableRows } from './registers';

function fileWith(values: Record<number, number>): number[] {
  const f = new Array<number>(256).fill(0);
  for (const [a, v] of Object.entries(values)) f[Number(a)] = v;
  return f;
}

describe('STATUS bit chips', () => {
  it('lists IRP … C, MSB first, with the course labels', () => {
    expect(statusChips(0).map((c) => c.label)).toEqual(['IRP', 'RP1', 'RP0', '/TO', '/PD', 'Z', 'DC', 'C']);
  });

  it('derives values: 200 + 100 → STATUS 0x19 (TO, PD, C set)', () => {
    const chips = statusChips(0x19);
    const on = chips.filter((c) => c.value === 1).map((c) => c.label);
    expect(on).toEqual(['/TO', '/PD', 'C']);
  });

  it('derives values: 250 + 6 → STATUS 0x1F (Z, DC and C set)', () => {
    const on = statusChips(0x1f).filter((c) => c.value).map((c) => c.label);
    expect(on).toEqual(['/TO', '/PD', 'Z', 'DC', 'C']);
  });

  it('marks changed bits from an XOR mask', () => {
    const chips = statusChips(0x1c, 0x05);
    expect(chips.filter((c) => c.changed).map((c) => c.label)).toEqual(['Z', 'C']);
  });

  it('explains C as "no borrow" after a subtraction', () => {
    const c = statusChips(0).find((x) => x.label === 'C')!;
    expect(c.help).toMatch(/pas d'emprunt/);
    const z = statusChips(0).find((x) => x.label === 'Z')!;
    expect(z.help).toMatch(/x = y/);
  });

  it('reads the selected bank from RP0', () => {
    expect(selectedBank(0x18)).toBe(0);
    expect(selectedBank(0x38)).toBe(1);
  });
});

describe('SFR rows', () => {
  it('reads bank-1 registers at their 0x80+ address and keeps the teaching order', () => {
    const rows = sfrRows(fileWith({ 0x86: 0x01, 0x06: 0x05, 0x81: 0xff, 0x85: 0x1f }));
    expect(rows.map((r) => r.name)).toEqual([
      'PORTA', 'TRISA', 'PORTB', 'TRISB', 'INTCON', 'OPTION_REG', 'TMR0', 'FSR', 'PCLATH', 'EEDATA', 'EEADR', 'EECON1',
    ]);
    const trisb = rows.find((r) => r.name === 'TRISB')!;
    expect(trisb.addrText).toBe('0x86');
    expect(trisb.hexText).toBe('0x01');
    expect(rows.find((r) => r.name === 'OPTION_REG')!.value).toBe(0xff);
  });

  it('names bits on hover, with TRIS direction and unimplemented PORTA bits', () => {
    const rows = sfrRows(fileWith({ 0x86: 0x01, 0x05: 0x1f }));
    const trisb = rows.find((r) => r.name === 'TRISB')!;
    const rb0 = trisb.bits.find((b) => b.bit === 0)!;
    expect(rb0.title).toBe('TRISB0 = 1 (entrée)');
    expect(trisb.bits.find((b) => b.bit === 1)!.title).toBe('TRISB1 = 0 (sortie)');
    const porta = rows.find((r) => r.name === 'PORTA')!;
    expect(porta.bits.map((b) => (b.implemented ? String(b.value) : '-')).join('')).toBe('---11111');
  });

  it('flags changed registers', () => {
    const rows = sfrRows(fileWith({}), new Set([0x06]));
    expect(rows.filter((r) => r.changed).map((r) => r.name)).toEqual(['PORTB']);
  });

  it('bitCells gives one cell per bit, MSB first', () => {
    const cells = bitCells('STATUS', 0x04, ['C', 'DC', 'Z', 'PD', 'TO', 'RP0', 'RP1', 'IRP'], 0xff);
    expect(cells.map((c) => c.bit)).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    expect(cells.find((c) => c.name === 'Z')!.value).toBe(1);
    expect(cells.find((c) => c.name === 'Z')!.title).toBe('Z = 1');
  });
});

describe('variable rows', () => {
  const symbols: SymbolInfo[] = [
    { name: 'z', scope: 'main', addr: 0x0e, size: 1, type: 'unsigned char' },
    { name: 'x', scope: 'main', addr: 0x0c, size: 1, type: 'unsigned char' },
    { name: 'total', scope: 'global', addr: 0x10, size: 2, type: 'int' },
    { name: 's', scope: 'global', addr: 0x12, size: 1, type: 'signed char' },
    { name: 'LED', scope: 'global', addr: 0x06, size: 1, type: 'sbit (bit 1)' },
    { name: 'buf', scope: 'global', addr: 0x13, size: 3, type: 'unsigned char[3]' },
  ];
  const file = fileWith({ 0x0c: 6, 0x0e: 0, 0x10: 0xfe, 0x11: 0xff, 0x12: 0x80, 0x06: 0x02, 0x13: 1, 0x14: 2, 0x15: 0xaa });

  it('sorts by address and formats hex / decimal / binary', () => {
    const rows = variableRows(symbols, file);
    expect(rows.map((r) => r.name)).toEqual(['LED', 'x', 'z', 'total', 's', 'buf']);
    const x = rows.find((r) => r.name === 'x')!;
    expect([x.addrText, x.hexText, x.decText, x.binText]).toEqual(['0x0C', '0x06', '6', '00000110']);
  });

  it('reads multi-byte values little-endian and signed types as signed', () => {
    const rows = variableRows(symbols, file);
    const total = rows.find((r) => r.name === 'total')!;
    expect(total.hexText).toBe('0xFFFE');
    expect(total.decText).toBe('-2');
    expect(total.binText).toBe('11111111 11111110');
    expect(rows.find((r) => r.name === 's')!.decText).toBe('-128');
  });

  it('shows an sbit as its single bit and arrays as bytes', () => {
    const rows = variableRows(symbols, file);
    const led = rows.find((r) => r.name === 'LED')!;
    expect(led.addrText).toBe('0x06.1');
    expect(led.decText).toBe('1');
    expect(rows.find((r) => r.name === 'buf')!.hexText).toBe('01 02 AA');
  });

  it('flags variables whose bytes changed, and shows dashes without a snapshot', () => {
    const rows = variableRows(symbols, file, new Set([0x11]));
    expect(rows.filter((r) => r.changed).map((r) => r.name)).toEqual(['total']);
    const none = variableRows(symbols, null);
    expect(none.every((r) => r.hexText === '—' && !r.changed)).toBe(true);
  });
});

describe('stack slots', () => {
  it('shows 8 levels top first, marking the top of stack', () => {
    const slots = stackSlots([0x1b, 0x4c]);
    expect(slots).toHaveLength(8);
    expect(slots[0]).toEqual({ level: 8, addr: null, isTop: false });
    expect(slots[6]).toEqual({ level: 2, addr: 0x4c, isTop: true });
    expect(slots[7]).toEqual({ level: 1, addr: 0x1b, isTop: false });
    expect(stackSlots([]).every((s) => s.addr === null && !s.isTop)).toBe(true);
  });
});
