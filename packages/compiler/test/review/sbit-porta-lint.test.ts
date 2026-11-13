import { describe, expect, it } from 'vitest';
import { codes, compileOk } from '../support/harness';

// Spec: lint warning for PORTA.F5–F7 (PORTA only has RA0–RA4 on the PIC16F84A, datasheet Table 4-1). The direct form
// `PORTA.F6 = 1;` is reported, but the same pin written through MikroC's usual `sbit X at PORTA.Bn;` form is not:
// the linter never visits sbit targets.

describe('W_PORTA_BIT_UNIMPLEMENTED via une déclaration sbit', () => {
  it('sbit LED at PORTA.B6 est signalé comme PORTA.F6', () => {
    const r = compileOk(`sbit LED at PORTA.B6;
void main() {
    TRISA = 0x00;
    LED = 1;
}`);
    expect(codes(r)).toContain('W_PORTA_BIT_UNIMPLEMENTED');
  });
});
