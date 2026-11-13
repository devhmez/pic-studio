// packages/emulator/src/api.ts (fixed contract), StepResult.cycles:
//   "Instruction cycles consumed (1 or 2; 0 when sleeping/halted)."
// The implementation returns 1 for every step taken while asleep, and 3 for a step whose
// instruction is followed by interrupt entry (dummy cycles folded into the same StepResult).
// Neither value is allowed by the contract, and the deviation is not reported anywhere.
import { describe, expect, it } from 'vitest';
import { build, buildWithLabels, stepUntilPc } from '../helpers';

describe('StepResult.cycles follows the api.ts contract', () => {
  it('reports 0 cycles for a step taken while the core is sleeping', () => {
    const core = build(`
      SLEEP
      NOP
      GOTO $
    `);
    core.step(); // SLEEP itself (1 cycle)
    expect(core.sleeping).toBe(true);
    const r = core.step();
    expect(core.sleeping).toBe(true);
    expect(r.cycles).toBe(0);
  });

  it('never reports more than 2 cycles for one step (interrupt entry included)', () => {
    const { core, label } = buildWithLabels(`
      GOTO main
      ORG 4
      BCF INTCON, INTF
      RETFIE
main: MOVLW 0x90        ; GIE | INTE
      MOVWF INTCON
spin: NOP
      GOTO spin
    `);
    stepUntilPc(core, label('spin')); // GIE and INTE already set
    core.setInput('RB0', 1); // INTEDG = 1 after reset: rising edge sets INTF
    const seen = new Set<number>();
    for (let i = 0; i < 10; i++) seen.add(core.step().cycles);
    for (const c of seen) expect([1, 2]).toContain(c);
  });
});
