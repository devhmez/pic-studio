import { assemble, Pic16F84A, SFR } from '../src/index';

export interface BuildOptions {
  clockHz?: number;
  config?: number;
  eeprom?: Uint8Array;
}

/** Assemble `source` and load it into a fresh core (power-on reset); also returns the labels. */
export function buildWithLabels(
  source: string, opts: BuildOptions = {},
): { core: Pic16F84A; label: (name: string) => number } {
  const result = assemble(source);
  if (!result.ok) {
    throw new Error(result.errors.map((e) => `ligne ${e.line}: ${e.message}`).join('\n'));
  }
  const core = new Pic16F84A({ clockHz: opts.clockHz });
  core.load(result.program, opts.eeprom, opts.config ?? result.config);
  const label = (name: string): number => {
    const addr = result.labels.get(name.toUpperCase());
    if (addr === undefined) throw new Error(`étiquette inconnue : ${name}`);
    return addr;
  };
  return { core, label };
}

/** Assemble `source` and load it into a fresh core (power-on reset). */
export function build(source: string, opts: BuildOptions = {}): Pic16F84A {
  return buildWithLabels(source, opts).core;
}

/** Execute `n` steps, returning the total cycles. */
export function steps(core: Pic16F84A, n: number): number {
  let cycles = 0;
  for (let i = 0; i < n; i++) cycles += core.step().cycles;
  return cycles;
}

/** Step until PC equals `addr` (checked before each step). Returns the cycles spent. */
export function stepUntilPc(core: Pic16F84A, addr: number, maxSteps = 100_000): number {
  let cycles = 0;
  for (let i = 0; i < maxSteps; i++) {
    if (core.pc === addr) return cycles;
    cycles += core.step().cycles;
  }
  throw new Error(`PC n'a jamais atteint ${addr.toString(16)} (PC = ${core.pc.toString(16)})`);
}

/** Step until the core is halted on `GOTO $`. */
export function runToHalt(core: Pic16F84A, maxSteps = 100_000): void {
  for (let i = 0; i < maxSteps; i++) {
    core.step();
    if (core.halted) return;
  }
  throw new Error('le programme ne s’arrête pas sur GOTO $');
}

export const STATUS = SFR.STATUS;
export const C = 0x01;
export const DC = 0x02;
export const Z = 0x04;
export const PD = 0x08;
export const TO = 0x10;
export const RP0 = 0x20;

/** Flags C, DC, Z of the STATUS register. */
export function flags(core: Pic16F84A): { C: number; DC: number; Z: number } {
  const s = core.peek(SFR.STATUS);
  return { C: s & 1, DC: (s >> 1) & 1, Z: (s >> 2) & 1 };
}
