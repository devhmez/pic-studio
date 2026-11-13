import { describe, expect, it } from 'vitest';
import { compile } from '../../src/compile';

// MikroC: `void Delay_Cyc(char Cycles_div_by_10);` is a LIBRARY routine taking a run-time char (3..255), unlike the
// built-ins `Delay_ms/Delay_us(const unsigned long)` (research/07_tech_research.md §1.4 lists it without `const`).
// The compiler declares it with a constant-only argument, so `Delay_Cyc(n)` with a variable is rejected with
// E_DELAY_NOT_CONST.

describe('Delay_Cyc avec une variable', () => {
  it('compile sans erreur', () => {
    const r = compile(`unsigned char n;
void main() {
    n = 10;
    Delay_Cyc(n);
}`);
    expect(r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code)).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
