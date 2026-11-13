/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compile } from '@pic/compiler';
import { bitOptionsFor, collectUserSymbols, completionDataFrom } from './completionData';

const fixture = (name: string) =>
  readFileSync(new URL(`../../../packages/compiler/test/fixtures/${name}`, import.meta.url));

describe('user symbols for autocomplete', () => {
  it('collects the #defines and locals of status.c', () => {
    const r = compile(fixture('status.c'), {});
    const names = collectUserSymbols(r.ast, r.symbols).map((u) => `${u.kind}:${u.name}`);
    expect(names).toEqual(expect.arrayContaining(['macro:LED_SUP', 'macro:LED_EGAL', 'macro:LED_INF', 'macro:LED_ON', 'variable:x', 'variable:y', 'variable:z']));
    const ledOn = collectUserSymbols(r.ast).find((u) => u.name === 'LED_ON')!;
    expect(ledOn.detail).toBe('#define(pin) (pin = 1)');
    const x = collectUserSymbols(r.ast).find((u) => u.name === 'x')!;
    expect(x.detail).toBe('unsigned char · main');
  });

  it('collects globals, sbits, functions and parameters, without duplicates', () => {
    const src = `
sbit LED at PORTB.B0;
unsigned char compteur absolute 0x20;
void attendre(unsigned char n) { while (n) { n--; } }
void main() {
  for (;;) { unsigned char k; k = compteur; attendre(k); LED = 1; }
}`;
    const r = compile(src, {});
    const users = collectUserSymbols(r.ast, r.symbols);
    const byName = new Map(users.map((u) => [u.name, u]));
    expect(byName.get('LED')?.kind).toBe('sbit');
    expect(byName.get('compteur')?.detail).toBe('unsigned char · globale');
    expect(byName.get('attendre')?.kind).toBe('function');
    expect(byName.get('n')?.detail).toContain('paramètre de attendre');
    expect(byName.get('k')?.kind).toBe('variable');
    expect(byName.has('main')).toBe(false);
    expect(users.filter((u) => u.name.toLowerCase() === 'compteur')).toHaveLength(1);
  });

  it('returns empty data before the first build', () => {
    expect(completionDataFrom(null).user).toEqual([]);
  });
});

describe('bit options after a dot', () => {
  it('offers the port pins and F0–F7 on PORTB', () => {
    const labels = bitOptionsFor('PORTB').map((b) => b.label);
    expect(labels.slice(0, 8)).toEqual(['RB0', 'RB1', 'RB2', 'RB3', 'RB4', 'RB5', 'RB6', 'RB7']);
    expect(labels).toContain('F7');
  });

  it('offers port pin names on TRIS registers, as the prof writes TRISA.RA0', () => {
    const opts = bitOptionsFor('trisa');
    expect(opts.map((b) => b.label)).toEqual(['RA0', 'RA1', 'RA2', 'RA3', 'RA4', 'F0', 'F1', 'F2', 'F3', 'F4']);
    expect(opts[0].detail).toBe('bit 0 de TRISA (TRISA0)');
  });

  it('offers the flags on STATUS and generic bits elsewhere', () => {
    expect(bitOptionsFor('STATUS').map((b) => b.label).slice(0, 3)).toEqual(['C', 'DC', 'Z']);
    const generic = bitOptionsFor('compteur').map((b) => b.label);
    expect(generic).toEqual(['F0', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'B0', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7']);
  });
});
