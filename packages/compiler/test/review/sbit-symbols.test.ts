import { describe, expect, it } from 'vitest';
import { compileOk } from '../support/harness';

// api.ts, SymbolInfo.addr: "RAM address (GPR 0x0C–0x4F) or SFR address for absolute/sbit." `sbit` declarations are
// part of the symbol table contract (the debugger's watch view needs them), but they never reach
// CompileResult.symbols.

describe('CompileResult.symbols et les déclarations sbit', () => {
  const r = compileOk(`sbit LED at PORTB.B0;
sbit LED_Direction at TRISB.B0;
void main() {
    LED_Direction = 0;
    LED = 1;
}`);

  it("contient l'sbit LED à l'adresse de PORTB (0x06)", () => {
    const led = r.symbols.find((s) => s.name === 'LED');
    expect(led, 'symbole LED absent de CompileResult.symbols').toBeDefined();
    expect(led!.addr).toBe(0x06);
    expect(led!.scope).toBe('global');
  });

  it("contient l'sbit LED_Direction à l'adresse de TRISB (0x86)", () => {
    const dir = r.symbols.find((s) => s.name === 'LED_Direction');
    expect(dir, 'symbole LED_Direction absent de CompileResult.symbols').toBeDefined();
    expect(dir!.addr).toBe(0x86);
  });
});
