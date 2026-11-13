import { describe, expect, it } from 'vitest';
import { onEmulator } from '../e2e/support';
import { readVar, runToHalt } from '../support/harness';

// switch compares the controlling expression with each case value after the integer promotions (C11 6.8.4.2p5),
// and the compiler's own `if (u == 300)` correctly widens to 16 bits and never matches an unsigned char. caseTest()
// instead truncates the case constant to the discriminant's width, so `case 300:` matches u = 44 (300 & 0xFF) and
// `case 200:` matches a signed char holding -56 (0xC8). The same test written with `if` gives the other answer, and
// no diagnostic is emitted.

describe('switch : valeur de case hors de la plage du type contrôlé', () => {
  const { r, core } = onEmulator(`unsigned char u, r_sw_u, r_if_u, r_sw_s, r_if_s;
signed char s;
void main() {
    u = 44;
    switch (u) { case 300: r_sw_u = 1; break; default: r_sw_u = 2; }
    if (u == 300) r_if_u = 1; else r_if_u = 2;
    s = -56;
    switch (s) { case 200: r_sw_s = 1; break; default: r_sw_s = 2; }
    if (s == 200) r_if_s = 1; else r_if_s = 2;
}`);
  runToHalt(core);

  it('case 300 ne correspond pas à u = 44 (unsigned char), comme if (u == 300)', () => {
    expect(readVar(core, r, 'r_if_u'), 'référence if (u == 300)').toBe(2);
    expect(readVar(core, r, 'r_sw_u')).toBe(2);
  });

  it('case 200 ne correspond pas à s = -56 (signed char), comme if (s == 200)', () => {
    expect(readVar(core, r, 'r_if_s'), 'référence if (s == 200)').toBe(2);
    expect(readVar(core, r, 'r_sw_s')).toBe(2);
  });
});
