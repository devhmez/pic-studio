import { describe, expect, it } from 'vitest';
import { onEmulator } from '../e2e/support';
import { readVar, runToHalt } from '../support/harness';

// Each `const` array is its own object (C scoping): two tables with the same name declared in different scopes must
// compile to two RETLW tables. The code generator keys tables by the bare variable name (`_tbl_<name>`), so the second
// declaration silently reuses the first one's data.

describe('tables constantes (RETLW) de même nom dans des portées différentes', () => {
  it('deux fonctions avec chacune une table locale T lisent leurs propres valeurs', () => {
    const { r, core } = onEmulator(`unsigned char a, b, i;
unsigned char f() { const unsigned char T[3] = {10, 20, 30}; return T[i]; }
unsigned char g() { const unsigned char T[3] = {40, 50, 60}; return T[i]; }
void main() {
    i = 1;
    a = f();
    b = g();
}`);
    runToHalt(core);
    expect(readVar(core, r, 'a')).toBe(20);
    expect(readVar(core, r, 'b')).toBe(50); // currently 20: g() reads f()'s table
  });

  it('une table locale qui masque une table globale du même nom', () => {
    const { r, core } = onEmulator(`const unsigned char SEG[3] = {1, 2, 3};
unsigned char a, b, i;
unsigned char f() { const unsigned char SEG[3] = {7, 8, 9}; return SEG[i]; }
void main() {
    i = 2;
    a = SEG[i];
    b = f();
}`);
    runToHalt(core);
    expect(readVar(core, r, 'a')).toBe(3); // currently 9: main reads the local table of f()
    expect(readVar(core, r, 'b')).toBe(9);
  });
});
