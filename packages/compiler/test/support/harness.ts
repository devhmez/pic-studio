import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { CompileOptions } from '../../src/api';
import { compile, type CompileResultEx } from '../../src/compile';
import { MiniSim, type Pin } from './minisim';

export function fixture(name: string): Uint8Array {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
}

/** Compile and fail the test with the diagnostics when compilation does not succeed. */
export function compileOk(src: string | Uint8Array, opts: CompileOptions = {}): CompileResultEx {
  const r = compile(src, opts);
  if (!r.ok) {
    throw new Error(`compilation échouée :\n${r.diagnostics.map((d) => `${d.line}:${d.col} ${d.code} ${d.message}`).join('\n')}`);
  }
  return r;
}

export function codes(r: CompileResultEx): string[] {
  return r.diagnostics.map((d) => d.code);
}

/** Minimal core surface shared by MiniSim and @pic/emulator's Pic16F84A. */
export interface TestCore {
  step(): { cycles: number };
  readonly pc: number;
  readonly cycles: number;
  readonly halted: boolean;
  setInput(pin: Pin, level: 0 | 1): void;
  getDrive(pin: Pin): 0 | 1 | 'Z';
  peek(addr: number): number;
  poke(addr: number, value: number): void;
}

export function runCycles(core: TestCore, n: number): void {
  const end = core.cycles + n;
  while (core.cycles < end && !core.halted) core.step();
}

/** Run for `n` cycles even through `GOTO $`-style idle loops (interrupts keep running). */
export function runFor(core: TestCore, n: number): void {
  const end = core.cycles + n;
  while (core.cycles < end) core.step();
}

export function runToHalt(core: TestCore, maxCycles = 5_000_000): void {
  const end = core.cycles + maxCycles;
  while (!core.halted && core.cycles < end) core.step();
  expect(core.halted, 'le programme doit se terminer sur GOTO $').toBe(true);
}

/** Run until PC reaches `addr` (after at least one step). Returns the cycles spent. */
export function runToAddr(core: TestCore, addr: number, maxCycles = 50_000_000): number {
  const start = core.cycles;
  const end = start + maxCycles;
  do core.step();
  while (core.pc !== addr && core.cycles < end);
  expect(core.pc, `PC doit atteindre 0x${addr.toString(16)}`).toBe(addr);
  return core.cycles - start;
}

/** Fraction of instruction cycles during which the pin drives 1 (what an LED's brightness shows). */
export function duty(core: TestCore, pin: Pin, cycles: number): number {
  let on = 0;
  let total = 0;
  const end = core.cycles + cycles;
  while (core.cycles < end) {
    const level = core.getDrive(pin) === 1;
    const before = core.cycles;
    core.step();
    // Time from the core's counter: a sleeping step reports 0 cycles in StepResult but still takes one Tcy.
    const c = Math.max(0, core.cycles - before);
    total += c;
    if (level) on += c;
  }
  return total > 0 ? on / total : 0;
}

export function symbolAddr(r: CompileResultEx, name: string): number {
  const s = r.symbols.find((x) => x.name === name);
  if (!s) throw new Error(`symbole introuvable : ${name}`);
  return s.addr;
}

/** Read a little-endian value of `size` bytes from RAM. */
export function readVar(core: TestCore, r: CompileResultEx, name: string, size = 1, signed = false): number {
  const a = symbolAddr(r, name);
  let v = 0;
  for (let i = 0; i < size; i++) v += core.peek(a + i) * 2 ** (8 * i);
  if (signed && v >= 2 ** (8 * size - 1)) v -= 2 ** (8 * size);
  return v;
}

/** Write a little-endian value of `size` bytes into RAM. */
export function writeVar(core: TestCore, r: CompileResultEx, name: string, value: number, size = 1): void {
  if (!r.symbols.some((x) => x.name === name)) return; // unused variables get no RAM
  const a = symbolAddr(r, name);
  const big = BigInt.asUintN(size * 8, BigInt(Math.trunc(value)));
  for (let i = 0; i < size; i++) core.poke(a + i, Number((big >> BigInt(8 * i)) & 0xffn));
}

/** Compile, load into the reference simulator and return both. */
export function onMiniSim(src: string | Uint8Array, opts: CompileOptions = {}): { r: CompileResultEx; sim: MiniSim } {
  const r = compileOk(src, opts);
  const sim = new MiniSim({ clockHz: opts.clockHz });
  sim.load(r.program!);
  return { r, sim };
}

/** Address of the first instruction generated for a source line containing `needle`. */
export function addrOfLine(r: CompileResultEx, needle: string): number {
  const lines = r.source.split(/\r\n|\r|\n/);
  const idx = lines.findIndex((l) => l.includes(needle));
  if (idx < 0) throw new Error(`ligne introuvable : ${needle}`);
  const addr = r.lineToAddr.get(idx + 1);
  if (addr === undefined) throw new Error(`pas de code pour la ligne ${idx + 1} : ${needle}`);
  return addr;
}
