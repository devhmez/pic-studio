import { describe, expect, it } from 'vitest';
import { onEmulator } from '../e2e/support';
import { readVar, runToHalt } from '../support/harness';

// `x op= e` must behave like `x = x op e` (C11 6.5.16.2p3; the compiler's own MikroC typing makes `x / w` an int
// division when w is int, and `b = b / w` is indeed right). compoundAssign() converts the right operand to the
// LEFT operand's type before calling the division helper, so a wider divisor is truncated to 8 bits:
//   a /= w   with w = 256 → divides by 0 (result 255) instead of 0
//   c /= 300 → divides by 44 (result 4) instead of 0
//   d %= 300 → 200 % 44 = 24 instead of 200
// No diagnostic is emitted.

describe('/= et %= avec un opérande droit plus large que la variable', () => {
  const { r, core } = onEmulator(`unsigned char a, b, c, d;
int w;
void main() {
    w = 256;
    a = 200; a /= w;
    b = 200; b = b / w;
    c = 200; c /= 300;
    d = 200; d %= 300;
}`);
  runToHalt(core);

  it('a /= w (w = 256) donne 0, comme b = b / w', () => {
    expect(readVar(core, r, 'b'), 'référence b = b / w').toBe(0);
    expect(readVar(core, r, 'a')).toBe(0);
  });

  it('c /= 300 donne 0', () => {
    expect(readVar(core, r, 'c')).toBe(0);
  });

  it('d %= 300 donne 200', () => {
    expect(readVar(core, r, 'd')).toBe(200);
  });
});
