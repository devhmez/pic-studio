import { Pic16F84A } from '@pic/emulator';
import type { CompileOptions } from '../../src/api';
import type { CompileResultEx } from '../../src/compile';
import { decodeSource } from '../../src/source';
import { compileOk, duty, fixture, runFor } from '../support/harness';

/** Compile and load into the real emulator (power-on reset). */
export function onEmulator(src: string | Uint8Array, opts: CompileOptions = {}): { r: CompileResultEx; core: Pic16F84A } {
  const r = compileOk(src, opts);
  const core = new Pic16F84A({ clockHz: opts.clockHz ?? 1_000_000 });
  core.load(r.program!, undefined, r.config);
  return { r, core };
}

export function fixtureText(name: string): string {
  return decodeSource(fixture(name));
}

/**
 * LED state as Proteus shows it. status.c switches its LEDs off and on again on every loop pass (a few µs off),
 * which Proteus displays as lit: an LED counts as lit when its pin drives 1 for a visible share of the time.
 */
export const LIT_DUTY = 0.1;

/** Lit LEDs among status.c's three outputs after the program has settled. */
export function statusLeds(core: Pic16F84A): { sup: boolean; egal: boolean; inf: boolean } {
  runFor(core, 2000);
  const d = (pin: 'RB0' | 'RB1' | 'RB2') => duty(core, pin, 3000);
  return { sup: d('RB0') > LIT_DUTY, egal: d('RB1') > LIT_DUTY, inf: d('RB2') > LIT_DUTY };
}
