// Test helper (imported by *.test.ts only): run a template in the real circuit + PIC simulation.
import { SimSession, type ComponentVisual, type Interaction } from '@pic/circuit';
import type { ReplaySnapshot } from './replay';
import type { LoadedTemplate } from './testTemplates';

export interface LiveState {
  cpu: ReplaySnapshot & { eeprom: number[] };
  visuals: Record<string, ComponentVisual>;
  line: number | null;
}

export function startSession(t: LoadedTemplate): SimSession {
  return new SimSession(t.schematic, t.build.program!, t.clockHz, { config: t.build.config });
}

export function capture(s: SimSession, t: LoadedTemplate, interruptEntry = false): LiveState {
  const c = s.mcu.snapshot();
  return {
    cpu: { pc: c.pc, w: c.w, status: c.status, file: Array.from(c.file), stack: c.stack.slice(), cycles: s.cycles, eeprom: Array.from(c.eeprom), interruptEntry },
    visuals: s.snapshot().visuals,
    line: t.build.addrToLine.get(c.pc) ?? null,
  };
}

/** Step instructions until the PC is on the first instruction of `line` (after at least `minSteps` steps). */
export function stepToLine(s: SimSession, t: LoadedTemplate, line: number, minSteps = 0, maxSteps = 2_000_000): void {
  for (let i = 0; i < maxSteps; i++) {
    if (i >= minSteps && t.build.addrToLine.get(s.mcu.pc) === line && t.build.lineToAddr.get(line) === s.mcu.pc) return;
    s.step();
  }
  throw new Error(`ligne ${line} jamais atteinte`);
}

export function interact(s: SimSession, id: string, action: Interaction): void {
  s.interact(id, action);
}
