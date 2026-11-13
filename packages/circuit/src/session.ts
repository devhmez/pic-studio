// Simulation driver: a PIC16F84A running a program inside a schematic, advanced in slices of simulated time.
// This is the loop the UI runs in a Web Worker (about 10 ms of simulated time per slice):
//   - the core runs; after every instruction that changed a port latch, a TRIS or the pull-ups, the circuit
//     re-solves (so inputs the program reads next already reflect its own outputs);
//   - before each re-solve, the LED duty-cycle accumulators are credited with the time spent in the old state;
//   - interactions (LOGICSTATE, BUTTON, TORCH_LDR) re-solve at once and reach the program in the next slice.
import { Pic16F84A, type Pic16F84AStepResult } from '@pic/emulator';
import type { Level } from '@pic/emulator/api';
import type { ComponentVisual, Interaction, Schematic } from './api';
import { createCircuitSimulator, type CircuitSimulatorEx, type SimulatorOptions } from './simulator';

export interface SimSessionOptions extends SimulatorOptions {
  /** PIC16F84A component the program runs on. Default: the first PIC16F84A of the schematic. */
  mcuComponentId?: string;
  /** Configuration word (0x2007) produced by the compiler. Default 0x3FFB (WDT off), like the prof's ISIS files. */
  config?: number;
  /** Initial data EEPROM (64 bytes). Default: erased (0xFF), Proteus MODDATA=64,255. */
  eeprom?: Uint8Array;
}

/** Outcome of runFor(). */
export interface SliceResult {
  /** Instruction cycles executed by this call (sleep cycles included). */
  cycles: number;
  /** Simulated seconds that elapsed during this call. */
  seconds: number;
  /** Program address of the breakpoint that ended the slice early, or null when the whole slice ran. */
  breakpoint: number | null;
}

/** Plain, structured-cloneable state for the UI (postMessage from the worker). */
export interface SessionSnapshot {
  /** Simulated seconds since the session started or was last reset. */
  time: number;
  /** Instruction cycles since the session started or was last reset (not cleared by a WDT reset of the core). */
  cycles: number;
  cpu: { pc: number; w: number; status: number; sleeping: boolean; halted: boolean };
  /** What to draw for every component that has a live state (LED, 7-segment, traffic lights, sources...). */
  visuals: Record<string, ComponentVisual>;
  /** Level of every net, for the red / blue / grey pin squares. */
  nets: Record<string, Level>;
}

export class SimSession {
  /** The core, for the register / memory views. Run it only through the session (it owns onIoChange). */
  readonly mcu: Pic16F84A;
  readonly circuit: CircuitSimulatorEx;
  readonly clockHz: number;
  readonly mcuComponentId: string;

  private readonly componentIds: string[];
  private readonly cyclesPerSecond: number;
  private readonly breakpoints = new Set<number>();
  /** Cycles executed since start/reset, settled at the end of every runFor()/step(). */
  private totalCycles = 0;
  /** Point up to which the LED accumulators have been credited. */
  private visualCycles = 0;
  /** Running estimate of totalCycles inside a slice (the core only reports its own counter). */
  private liveCycles = 0;
  private lastRawCycles = 0;
  /** Cycles owed to the simulation: fractions of a cycle and the overshoot of 2-cycle instructions carry over. */
  private debt = 0;
  /**
   * True when the next runFor() starts from a point the user stopped at (start, reset, step, a breakpoint):
   * the instruction at PC runs even if it carries a breakpoint. False after a slice that simply ran out of
   * time, so a breakpoint the slice ended on is still reported.
   */
  private resumeAtPc = true;

  /**
   * @param program 14-bit program words (CompileResult.program).
   * @param clockHz PIC oscillator frequency; defaults to the schematic's (ISIS CLOCK property).
   */
  constructor(schematic: Schematic, program: Uint16Array, clockHz: number = schematic.clockHz, options: SimSessionOptions = {}) {
    const { mcuComponentId, config, eeprom, ...circuitOptions } = options;
    const mcuPart = mcuComponentId ?? schematic.components.find((c) => c.kind === 'PIC16F84A')?.id;
    if (mcuPart === undefined) throw new Error('Le schéma ne contient aucun PIC16F84A.');
    this.mcuComponentId = mcuPart;
    this.clockHz = clockHz;
    this.cyclesPerSecond = clockHz / 4;
    this.mcu = new Pic16F84A({ clockHz });
    this.mcu.load(program, eeprom, config);
    // Built after load(): its first solve() hands the power-on input levels to the reset core.
    this.circuit = createCircuitSimulator(schematic, this.mcu, mcuPart, circuitOptions);
    this.componentIds = schematic.components.map((c) => c.id);
    this.mcu.onIoChange = () => this.ioChanged();
  }

  /** Simulated seconds since start/reset. */
  get time(): number {
    return this.totalCycles / this.cyclesPerSecond;
  }

  /** Instruction cycles since start/reset. */
  get cycles(): number {
    return this.totalCycles;
  }

  /** Program addresses where runFor() stops before executing the instruction. */
  setBreakpoints(addresses: Iterable<number>): void {
    this.breakpoints.clear();
    for (const a of addresses) this.breakpoints.add(a);
  }

  /** Advance the simulation by `seconds` of simulated time (stops early on a breakpoint). */
  runFor(seconds: number): SliceResult {
    if (!(seconds >= 0)) throw new RangeError(`Durée de simulation invalide : ${seconds}`);
    this.debt += seconds * this.cyclesPerSecond;
    const wanted = Math.floor(this.debt);
    if (wanted <= 0) return { cycles: 0, seconds: 0, breakpoint: null };

    const stops = this.breakpoints.size > 0 ? this.breakpoints : undefined;
    if (stops && !this.resumeAtPc && this.atBreakpoint()) {
      this.debt = 0;
      this.resumeAtPc = true;
      return { cycles: 0, seconds: 0, breakpoint: this.mcu.pc };
    }
    this.beginSlice();
    const executed = this.mcu.run(wanted, stops);
    this.endSlice(executed);
    // run() only returns short of its target when a breakpoint stopped it.
    const hit = executed < wanted;
    this.resumeAtPc = hit;
    this.debt = hit ? 0 : this.debt - executed;
    return { cycles: executed, seconds: executed / this.cyclesPerSecond, breakpoint: hit ? this.mcu.pc : null };
  }

  /** Execute one instruction (or interrupt entry, or one cycle of sleep), with the circuit kept in step. */
  step(): Pic16F84AStepResult {
    this.beginSlice();
    const result = this.mcu.step();
    if (result.ioChanged) this.ioChanged();
    else this.liveCycles += this.coreCyclesSinceLastLook();
    this.endSlice(this.liveCycles - this.totalCycles);
    this.resumeAtPc = true;
    return result;
  }

  /** Click on a LOGICSTATE, press/release a BUTTON, set the TORCH_LDR light level. */
  interact(componentId: string, action: Interaction): void {
    this.circuit.interact(componentId, action);
  }

  /** Power-on reset of the core and back to the schematic's initial interactive states (ISIS stop + play). */
  reset(): void {
    this.mcu.reset('por');
    this.circuit.reset();
    this.totalCycles = 0;
    this.visualCycles = 0;
    this.debt = 0;
    this.resumeAtPc = true;
  }

  snapshot(): SessionSnapshot {
    const visuals: Record<string, ComponentVisual> = {};
    for (const id of this.componentIds) {
      const v = this.circuit.visual(id);
      if (v.kind !== 'NONE') visuals[id] = v;
    }
    const nets: Record<string, Level> = {};
    for (const net of this.circuit.netlist.nets) nets[net.id] = this.circuit.netLevel(net.id);
    const m = this.mcu;
    return {
      time: this.time,
      cycles: this.totalCycles,
      cpu: { pc: m.pc, w: m.w, status: m.peek(0x03), sleeping: m.sleeping, halted: m.halted },
      visuals,
      nets,
    };
  }

  private atBreakpoint(): boolean {
    const m = this.mcu;
    return !m.sleeping && !m.interruptEntryPending && this.breakpoints.has(m.pc);
  }

  private beginSlice(): void {
    this.liveCycles = this.totalCycles;
    this.lastRawCycles = this.mcu.cycles;
  }

  private endSlice(executed: number): void {
    this.totalCycles += executed;
    this.creditVisuals(this.totalCycles);
  }

  /** Core cycles since the last look; the core's counter restarts from 0 after a reset (WDT, MCLR). */
  private coreCyclesSinceLastLook(): number {
    const raw = this.mcu.cycles;
    const delta = raw >= this.lastRawCycles ? raw - this.lastRawCycles : raw;
    this.lastRawCycles = raw;
    return delta;
  }

  /** The instruction that just ran changed the pins: account the old LED states, then re-solve the nets. */
  private ioChanged(): void {
    this.liveCycles += this.coreCyclesSinceLastLook();
    this.creditVisuals(this.liveCycles);
    this.circuit.solve();
  }

  private creditVisuals(upTo: number): void {
    const dc = upTo - this.visualCycles;
    if (dc <= 0) return;
    this.circuit.advance(dc / this.cyclesPerSecond);
    this.visualCycles = upTo;
  }
}
