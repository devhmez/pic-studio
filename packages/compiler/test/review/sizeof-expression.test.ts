import { describe, expect, it } from 'vitest';
import { compile } from '../../src/compile';
import { onEmulator } from '../e2e/support';
import { readVar, runToHalt } from '../support/harness';

// The spec asks for "all integer C operators". `sizeof` applied to an expression (a variable or an array) is a plain
// C operator that MikroC accepts and that student code uses for table loops (`i < sizeof(SEG)`). Only `sizeof(type)`
// is implemented; `sizeof(SEG)` is rejected with E_UNSUPPORTED.

const SRC = `const unsigned char SEG[10] = {0x3F,0x06,0x5B,0x4F,0x66,0x6D,0x7D,0x07,0x7F,0x6F};
unsigned char n_seg, n_int, n_elems;
int w;
unsigned char t[4];
void main() {
    n_seg = sizeof(SEG);
    n_int = sizeof(w);
    n_elems = sizeof(t) / sizeof(t[0]);
}`;

describe('sizeof appliqué à une expression', () => {
  it('compile sans erreur', () => {
    const r = compile(SRC);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('donne la taille en octets de la variable ou du tableau', () => {
    const { r, core } = onEmulator(SRC);
    runToHalt(core);
    expect(readVar(core, r, 'n_seg')).toBe(10);
    expect(readVar(core, r, 'n_int')).toBe(2);
    expect(readVar(core, r, 'n_elems')).toBe(4);
  });
});
