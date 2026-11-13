// The simulation worker's logic (protocol.ts), independent of the worker global so it runs in unit tests:
// one SimSession, real-time pacing, snapshots, breakpoints, single steps and live interactions.
import { SimSession, type Schematic } from '@pic/circuit';
import type { DebugSnapshot } from '../state/types';
import type { FromWorker, ToWorker } from './protocol';
import {
  ChunkSizer, DEBUG_INTERVAL_MS, IDLE_TICK_MS, Pacer, RatioMeter, SLICE_BUDGET_MS, SNAPSHOT_INTERVAL_MS,
  STEP_LINE_BUDGET_MS, Throttle, lineStops,
} from './pacing';
import { carriedInteractions, cloneCoreState, electricalSignature } from './transplant';

export interface EngineHost {
  post(message: FromWorker): void;
  /** Wall clock in milliseconds (performance.now()). */
  now(): number;
  /** Call `fn` after `delayMs`; 0 means "as soon as pending messages are handled". */
  schedule(fn: () => void, delayMs: number): void;
}

interface Loaded {
  program: Uint16Array;
  clockHz: number;
  config: number;
  eeprom?: Uint8Array;
  schematic: Schematic;
  /** Lazily computed electrical signature of `schematic`. */
  signature?: string;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class SimEngine {
  private session: SimSession | null = null;
  private loaded: Loaded | null = null;
  private breakpoints: number[] = [];
  private running = false;
  private speed = 1;
  private tickPending = false;
  /** Time / cycles of the sessions replaced by updateSchematic since the last load or reset. */
  private timeOffset = 0;
  private cycleOffset = 0;
  private interruptEntry = false;
  private ratio = 0;
  private readonly pacer = new Pacer();
  private readonly meter = new RatioMeter();
  private readonly chunk = new ChunkSizer();
  private readonly snapshots = new Throttle(SNAPSHOT_INTERVAL_MS);
  private readonly debugs = new Throttle(DEBUG_INTERVAL_MS);

  constructor(private readonly host: EngineHost) {}

  /** True while real-time pacing is on (for tests). */
  get isRunning(): boolean {
    return this.running;
  }

  /** Simulated seconds since load/reset (for tests). */
  get time(): number {
    return this.session ? this.timeOffset + this.session.time : 0;
  }

  get currentSession(): SimSession | null {
    return this.session;
  }

  handle(msg: ToWorker): void {
    try {
      switch (msg.type) {
        case 'load': return this.load(msg.schematic, msg.program, msg.clockHz, msg.config, msg.eeprom);
        case 'run': return this.run(msg.speed);
        case 'pause': return this.pause();
        case 'setSpeed': return this.setSpeed(msg.speed);
        case 'stepInstruction': return this.stepInstruction();
        case 'stepLine': return this.stepLine(msg.addrToLine);
        case 'reset': return this.reset();
        case 'interact': return this.interact(msg.componentId, msg.action);
        case 'setBreakpoints': return this.setBreakpoints(msg.addrs);
        case 'updateSchematic': return this.updateSchematic(msg.schematic);
      }
    } catch (e) {
      this.fail(e);
    }
  }

  // ---------------------------------------------------------------- commands

  private load(schematic: Schematic, program: Uint16Array, clockHz: number, config: number, eeprom?: Uint8Array): void {
    this.running = false;
    this.session = null;
    this.loaded = null;
    const session = new SimSession(schematic, program, clockHz, { config, eeprom });
    session.setBreakpoints(this.breakpoints);
    this.session = session;
    this.loaded = { program, clockHz, config, eeprom, schematic };
    this.timeOffset = 0;
    this.cycleOffset = 0;
    this.interruptEntry = false;
    this.meter.reset();
    this.ratio = 0;
    this.postSnapshot(true);
  }

  private run(speed: number): void {
    const s = this.requireSession();
    if (this.running) {
      this.setSpeed(speed);
      return;
    }
    this.speed = speed;
    this.running = true;
    this.interruptEntry = false;
    const now = this.host.now();
    this.pacer.start(now, s.time, speed);
    this.meter.reset();
    this.meter.sample(now, s.time);
    this.postSnapshot(false);
    this.scheduleTick(0);
  }

  private pause(): void {
    if (!this.session) return;
    const wasRunning = this.running;
    this.running = false;
    if (wasRunning) this.postSnapshot(true);
  }

  private setSpeed(speed: number): void {
    if (!(speed > 0)) return;
    this.speed = speed;
    if (this.running && this.session) {
      const now = this.host.now();
      this.pacer.setSpeed(now, this.session.time, speed);
      this.meter.reset();
      this.meter.sample(now, this.session.time);
      this.scheduleTick(0);
    }
  }

  private stepInstruction(): void {
    const s = this.requireSession();
    this.running = false;
    const r = s.step();
    this.interruptEntry = r.interruptEntry;
    this.postSnapshot(true);
  }

  private stepLine(addrToLine: [number, number][]): void {
    const s = this.requireSession();
    this.running = false;
    this.interruptEntry = false;
    const { stops } = lineStops(addrToLine, s.mcu.pc);
    if (stops.length === 0) {
      this.stepInstruction();
      return;
    }
    s.setBreakpoints(stops);
    try {
      const deadline = this.host.now() + STEP_LINE_BUDGET_MS;
      // runFor() always executes the instruction at PC first, then stops before the first address of another line.
      for (;;) {
        const r = s.runFor(this.chunk.current);
        if (r.breakpoint !== null) break;
        if (this.host.now() >= deadline) break; // the line waits on an input: stop where it is
      }
    } finally {
      s.setBreakpoints(this.breakpoints);
    }
    this.postSnapshot(true);
  }

  private reset(): void {
    const s = this.requireSession();
    s.reset();
    this.timeOffset = 0;
    this.cycleOffset = 0;
    this.interruptEntry = false;
    const now = this.host.now();
    this.meter.reset();
    if (this.running) {
      this.pacer.start(now, 0, this.speed);
      this.meter.sample(now, 0);
    }
    this.postSnapshot(true);
  }

  private interact(componentId: string, action: Parameters<SimSession['interact']>[1]): void {
    const s = this.session;
    if (!s) return;
    try {
      s.interact(componentId, action);
    } catch {
      return; // a component that no longer exists in the simulated circuit: nothing to do
    }
    this.postSnapshot(!this.running);
  }

  private setBreakpoints(addrs: number[]): void {
    this.breakpoints = [...addrs];
    this.session?.setBreakpoints(this.breakpoints);
  }

  private updateSchematic(schematic: Schematic): void {
    const prev = this.session;
    const loaded = this.loaded;
    if (!prev || !loaded) return;
    loaded.signature ??= electricalSignature(loaded.schematic);
    const signature = electricalSignature(schematic);
    if (signature === loaded.signature) {
      // Same circuit, drawn differently (moved parts, new labels): the running session stays valid as is.
      loaded.schematic = schematic;
      return;
    }
    const next = new SimSession(schematic, loaded.program, loaded.clockHz, { config: loaded.config, eeprom: loaded.eeprom });
    cloneCoreState(prev.mcu, next.mcu);
    for (const { id, action } of carriedInteractions(loaded.schematic, prev, schematic, next)) next.interact(id, action);
    next.circuit.solve();
    next.setBreakpoints(this.breakpoints);
    this.timeOffset += prev.time;
    this.cycleOffset += prev.cycles;
    this.session = next;
    loaded.schematic = schematic;
    loaded.signature = signature;
    if (this.running) {
      const now = this.host.now();
      this.pacer.start(now, next.time, this.speed);
      this.meter.reset();
      this.meter.sample(now, this.time);
    }
    this.postSnapshot(true);
  }

  // ---------------------------------------------------------------- run loop

  private scheduleTick(delayMs: number): void {
    if (this.tickPending) return;
    this.tickPending = true;
    this.host.schedule(this.tick, delayMs);
  }

  private readonly tick = (): void => {
    this.tickPending = false;
    const s = this.session;
    if (!this.running || !s) return;
    try {
      const start = this.host.now();
      const deadline = start + SLICE_BUDGET_MS;
      let now = start;
      let owed = this.pacer.owed(start, s.time);
      while (owed > 0) {
        const r = s.runFor(this.chunk.next(owed));
        const after = this.host.now();
        this.chunk.record(r.seconds, after - now);
        now = after;
        owed -= r.seconds;
        if (r.breakpoint !== null) {
          this.running = false;
          this.ratio = 0;
          this.host.post({ type: 'breakpoint', pc: r.breakpoint });
          this.postSnapshot(true);
          return;
        }
        if (r.cycles === 0 || now >= deadline) break;
      }
      this.ratio = this.meter.sample(now, this.time);
      if (this.snapshots.due(now)) this.postSnapshot(this.debugs.due(now));
      // Still behind (maximum speed, or the budget ran out): continue right after pending messages.
      const behind = now >= deadline || !Number.isFinite(this.speed);
      this.scheduleTick(behind ? 0 : IDLE_TICK_MS);
    } catch (e) {
      this.fail(e);
    }
  };

  // ---------------------------------------------------------------- snapshots

  private debugSnapshot(): DebugSnapshot {
    const s = this.session!;
    const core = s.mcu.snapshot();
    return {
      pc: core.pc,
      w: core.w,
      status: core.status,
      file: Array.from(core.file),
      stack: core.stack.slice(),
      eeprom: Array.from(core.eeprom),
      cycles: this.cycleOffset + s.cycles,
      time: this.timeOffset + s.time,
      sleeping: core.sleeping,
      halted: core.halted,
      interruptEntry: this.interruptEntry,
    };
  }

  private postSnapshot(withDebug: boolean): void {
    const s = this.session;
    if (!s) return;
    const now = this.host.now();
    const snapshot = s.snapshot();
    snapshot.time += this.timeOffset;
    snapshot.cycles += this.cycleOffset;
    this.snapshots.mark(now);
    if (withDebug) this.debugs.mark(now);
    this.host.post({
      type: 'snapshot',
      snapshot,
      debug: withDebug ? this.debugSnapshot() : null,
      running: this.running,
      realtimeRatio: this.running ? this.ratio : 0,
    });
  }

  private requireSession(): SimSession {
    if (!this.session) throw new Error('Aucun programme chargé dans le simulateur.');
    return this.session;
  }

  private fail(e: unknown): void {
    this.running = false;
    this.host.post({ type: 'error', message: `Erreur du simulateur : ${message(e)}` });
  }
}
