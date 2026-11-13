import { describe, expect, it } from 'vitest';
import { compile } from '../../src/compile';
import { onEmulator } from '../e2e/support';
import { readVar, runToHalt } from '../support/harness';

// MikroC's built_in.h defines `#define Lo(param) ((char *)&param)[0]` (and Hi/Higher/Highest likewise,
// research/07_tech_research.md §1.4): they designate a byte of the variable and are assignable, e.g.
// `Hi(counter) = 0x12;`. The compiler implements them as value-only built-in calls and rejects the assignment
// with E_NOT_LVALUE.

const SRC = `#include "built_in.h"
unsigned int w;
void main() {
    Hi(w) = 0x12;
    Lo(w) = 0x34;
}`;

describe('Lo()/Hi() comme destinations d’affectation (built_in.h)', () => {
  it('compile sans erreur', () => {
    const r = compile(SRC);
    expect(r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code)).toEqual([]);
  });

  it('écrit les octets haut et bas de la variable', () => {
    const { r, core } = onEmulator(SRC);
    runToHalt(core);
    expect(readVar(core, r, 'w', 2)).toBe(0x1234);
  });
});
