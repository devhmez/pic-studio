/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSchematicJson, SimSession, type Schematic } from '@pic/circuit';
import { compile, decodeSource } from '@pic/compiler';
import { SimEngine, type EngineHost } from './engine';
import type { FromWorker } from './protocol';
import { cloneCoreState, electricalSignature } from './transplant';

const REPO = new URL('../../../', import.meta.url);
const template = (name: string): Schematic =>
  parseSchematicJson(readFileSync(new URL(`templates/${name}.schematic.json`, REPO), 'utf8'));
const fixture = (name: string): string =>
  decodeSource(readFileSync(new URL(`packages/compiler/test/fixtures/${name}`, REPO)));

function build(source: string, clockHz: number) {
  const r = compile(source, { clockHz });
  if (!r.ok || !r.program) throw new Error(r.diagnostics.map((d) => `${d.line}: ${d.message}`).join('\n'));
  return r;
}

/** Deterministic host: a manual clock and a task queue pumped by advance(). */
class FakeHost implements EngineHost {
  clock = 0;
  messages: FromWorker[] = [];
  private queue: { at: number; fn: () => void; seq: number }[] = [];
  private seq = 0;

  post(message: FromWorker): void {
    this.messages.push(message);
  }

  now(): number {
    return this.clock;
  }

  schedule(fn: () => void, delayMs: number): void {
    this.queue.push({ at: this.clock + Math.max(0, delayMs), fn, seq: this.seq++ });
  }

  advance(ms: number): void {
    const end = this.clock + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.queue[0];
      if (!next || next.at > end) break;
      this.queue.shift();
      this.clock = Math.max(this.clock, next.at);
      next.fn();
    }
    this.clock = end;
  }

  snapshots() {
    return this.messages.filter((m): m is Extract<FromWorker, { type: 'snapshot' }> => m.type === 'snapshot');
  }

  last() {
    const s = this.snapshots();
    return s[s.length - 1];
  }
}

function start(templateName: string, source: string) {
  const schematic = template(templateName);
  const compiled = build(source, schematic.clockHz);
  const host = new FakeHost();
  const engine = new SimEngine(host);
  engine.handle({ type: 'load', schematic, program: compiled.program!, clockHz: schematic.clockHz, config: compiled.config });
  return { host, engine, schematic, compiled };
}

describe('SimEngine', () => {
  it('posts a paused snapshot with registers right after load', () => {
    const { host } = start('tp-status', fixture('status_corrige.c'));
    const s = host.last();
    expect(s.running).toBe(false);
    expect(s.debug).not.toBeNull();
    expect(s.debug!.pc).toBe(0);
    expect(s.debug!.file).toHaveLength(256);
    expect(s.snapshot.time).toBe(0);
  });

  it('runs in real time at ×1 and posts about 30 snapshots per second', () => {
    const { host, engine } = start('tp-status', fixture('status_corrige.c'));
    engine.handle({ type: 'run', speed: 1 });
    host.messages = [];
    host.advance(1000);
    expect(engine.time).toBeGreaterThan(0.95);
    expect(engine.time).toBeLessThanOrEqual(1.001);
    const n = host.snapshots().length;
    expect(n).toBeGreaterThanOrEqual(25);
    expect(n).toBeLessThanOrEqual(35);
    // Registers ride along about 10 times per second.
    const withDebug = host.snapshots().filter((m) => m.debug !== null).length;
    expect(withDebug).toBeGreaterThanOrEqual(8);
    expect(withDebug).toBeLessThanOrEqual(12);
    expect(host.last().realtimeRatio).toBeGreaterThan(0.9);
  });

  it('honours the speed multiplier', () => {
    const { host, engine } = start('tp-status', fixture('status_corrige.c'));
    engine.handle({ type: 'run', speed: 0.25 });
    host.advance(400);
    expect(engine.time).toBeCloseTo(0.1, 2);
    engine.handle({ type: 'setSpeed', speed: 2 });
    host.advance(100);
    expect(engine.time).toBeCloseTo(0.3, 2);
  });

  it('pauses and reports the registers at once', () => {
    const { host, engine } = start('tp-status', fixture('status_corrige.c'));
    engine.handle({ type: 'run', speed: 1 });
    host.advance(50);
    host.messages = [];
    engine.handle({ type: 'pause' });
    expect(engine.isRunning).toBe(false);
    expect(host.last()).toMatchObject({ running: false });
    expect(host.last().debug).not.toBeNull();
    const t = engine.time;
    host.advance(200);
    expect(engine.time).toBe(t);
  });

  it('stops on a breakpoint and tells the UI', () => {
    const { host, engine, compiled } = start('tp-status', fixture('status_corrige.c'));
    const addr = compiled.lineToAddr.get(17)!; // z = x - y; inside the main loop
    engine.handle({ type: 'setBreakpoints', addrs: [addr] });
    engine.handle({ type: 'run', speed: 1 });
    host.advance(500);
    const bp = host.messages.find((m) => m.type === 'breakpoint');
    expect(bp).toEqual({ type: 'breakpoint', pc: addr });
    expect(engine.isRunning).toBe(false);
    expect(host.last().debug!.pc).toBe(addr);
  });

  it('steps one instruction, then one C line', () => {
    const { host, engine, compiled } = start('tp-status', fixture('status_corrige.c'));
    engine.handle({ type: 'stepInstruction' });
    expect(host.last().debug!.cycles).toBeGreaterThan(0);
    const pairs = [...compiled.addrToLine.entries()];
    engine.handle({ type: 'stepLine', addrToLine: pairs });
    const first = host.last().debug!.pc;
    const line1 = compiled.addrToLine.get(first);
    expect(line1).toBeDefined();
    engine.handle({ type: 'stepLine', addrToLine: pairs });
    const second = host.last().debug!.pc;
    expect(compiled.addrToLine.get(second)).toBeDefined();
    expect(compiled.addrToLine.get(second)).not.toBe(line1);
  });

  it('applies interactions at once with a fresh snapshot', () => {
    const { host, engine } = start('tp0-exemple2', fixture('EXEMPLE2.c'));
    engine.handle({ type: 'run', speed: 1 });
    host.advance(100);
    const before = host.last().snapshot.visuals.LS1;
    host.messages = [];
    engine.handle({ type: 'interact', componentId: 'LS1', action: { type: 'toggle' } });
    expect(host.messages).toHaveLength(1);
    const after = host.last().snapshot.visuals.LS1;
    expect(before).toMatchObject({ kind: 'LOGICSTATE' });
    expect(after).toMatchObject({ kind: 'LOGICSTATE' });
    expect((after as { state: number }).state).not.toBe((before as { state: number }).state);
    // The LED follows the new input after a few milliseconds.
    host.advance(100);
    const led = host.last().snapshot.visuals.D1 as { lit: boolean };
    expect(led.lit).toBe((after as { state: number }).state === 1);
  });

  it('resets to the power-on state', () => {
    const { host, engine } = start('tp-status', fixture('status_corrige.c'));
    engine.handle({ type: 'run', speed: 1 });
    host.advance(200);
    engine.handle({ type: 'reset' });
    expect(host.last().snapshot.time).toBe(0);
    expect(host.last().debug!.pc).toBe(0);
    expect(engine.isRunning).toBe(true);
  });

  it('keeps the session when the circuit is only redrawn, rebuilds it (state kept) when it changes', () => {
    const { host, engine, schematic } = start('tp-status', fixture('status_corrige.c'));
    engine.handle({ type: 'run', speed: 1 });
    host.advance(100);
    engine.handle({ type: 'pause' });
    const session = engine.currentSession;
    const moved: Schematic = {
      ...schematic,
      components: schematic.components.map((c) => (c.kind === 'GROUND' ? { ...c, ref: 'masse' } : c)),
    };
    engine.handle({ type: 'updateSchematic', schematic: moved });
    expect(engine.currentSession).toBe(session);

    const before = host.last().debug!;
    const extra: Schematic = {
      ...moved,
      components: [...moved.components, {
        id: 'D9', kind: 'LED', ref: 'D9', value: 'LED-YELLOW', at: { x: 40, y: 20 }, rotation: 0, props: { color: 'YELLOW' },
      }],
    };
    engine.handle({ type: 'updateSchematic', schematic: extra });
    expect(engine.currentSession).not.toBe(session);
    const after = host.last().debug!;
    expect(after.pc).toBe(before.pc);
    expect(after.w).toBe(before.w);
    expect(after.file).toEqual(before.file);
    expect(after.time).toBeCloseTo(before.time, 9);
    expect(host.last().snapshot.visuals.D9).toMatchObject({ kind: 'LED' });
  });

  it('reports a circuit without PIC as an error', () => {
    const host = new FakeHost();
    const engine = new SimEngine(host);
    const compiled = build('void main() {\n}\n', 1e6);
    engine.handle({ type: 'load', schematic: { clockHz: 1e6, components: [], wires: [] }, program: compiled.program!, clockHz: 1e6, config: compiled.config });
    expect(host.messages[0]).toMatchObject({ type: 'error' });
    engine.handle({ type: 'run', speed: 1 });
    expect(host.messages[1]).toMatchObject({ type: 'error' });
  });
});

describe('cloneCoreState', () => {
  // A program that sits inside a function call (stack) most of the time.
  const SOURCE = `unsigned char n;
void bump() {
  n = n + 1;
  PORTB = n;
  Delay_ms(1);
}
void main() {
  TRISB = 0;
  n = 0;
  while (1) {
    bump();
  }
}
`;

  it('makes a second core continue exactly like the first', () => {
    const schematic = template('tp-status');
    const compiled = build(SOURCE, schematic.clockHz);
    const a = new SimSession(schematic, compiled.program!, schematic.clockHz, { config: compiled.config });
    const b = new SimSession(schematic, compiled.program!, schematic.clockHz, { config: compiled.config });
    a.runFor(0.0123);
    expect(a.mcu.snapshot().stack.length).toBeGreaterThan(0);
    cloneCoreState(a.mcu, b.mcu);
    b.circuit.solve();
    expect(b.mcu.snapshot()).toEqual(a.mcu.snapshot());
    for (let i = 0; i < 5; i++) {
      a.runFor(0.003);
      b.runFor(0.003);
      expect(b.mcu.snapshot()).toEqual(a.mcu.snapshot());
    }
  });

  it('electrical signature ignores positions but sees new connections', () => {
    const s = template('tp-status');
    const moved = { ...s, components: s.components.map((c) => ({ ...c, ref: `${c.ref}x` })) };
    expect(electricalSignature(moved)).toBe(electricalSignature(s));
    const cut = { ...s, wires: s.wires.slice(1) };
    expect(electricalSignature(cut)).not.toBe(electricalSignature(s));
  });
});
