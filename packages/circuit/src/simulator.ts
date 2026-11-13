// Digital net solver with strengths + a small resistive solve, driving the MCU pins (ISIS replacement engine).
//
// Per solve():
//  1. Nets shorted by closed BUTTONs merge into one node.
//  2. Drivers per node, by strength (Proteus VSM states):
//     - power: POWER (1) / GROUND (0) terminals, ideal 5 V / 0 V rails. They beat every other driver, so a pin
//       shorted to a rail is pulled to it and the rail never moves; only a POWER-GROUND short is 'X'.
//     - strong: MCU outputs (getDrive), LOGICSTATEs. Agreeing → that level, disagreeing → 'X'.
//  3. Nodes with no driver get a voltage from the resistor network (RES, TORCH_LDR, MCU weak pull-ups to VDD);
//     the voltage becomes 0/1 through input thresholds with hysteresis. No resistive path → 'Z'.
//  4. LEDs, 7-segment displays and traffic lights never change a net level. An LED is lit when it carries a
//     forward current in a piecewise-linear DC solve of the same network (LEDA model: VF 2.2 V, RS, ROFF), so
//     LEDs in series behave as in Proteus.
//  5. Every MCU GPIO gets the level of its net through setInput().
import type { Level, PinName } from '@pic/emulator/api';
import type {
  CircuitSimulator, ComponentInstance, ComponentVisual, Interaction, McuPins, Schematic,
} from './api';
import { buildNetlist, pinKey, type BuiltNetlist } from './netlist';
import { BRIGHTNESS_WINDOW_S, DutyCycle, LED_MIN_ON_TIME_S } from './sim/brightness';
import { LED_MODEL, diodeCurrents, minLitCurrent, type Diode, type DiodeModel } from './sim/diodes';
import {
  DEFAULT_VDD, TTL_THRESHOLDS, classifyVoltage, schmittThresholds, type Bit, type Thresholds,
} from './sim/levels';
import { solveResistive, type Conductance } from './sim/resistive';
import { clampLdrLevel, extractTopology, type Led, type Topology } from './sim/topology';
import { PIC_GPIO_PINS } from './symbols';

export { BRIGHTNESS_WINDOW_S, DutyCycle, LED_MIN_ON_TIME_S } from './sim/brightness';
export { LED_MODEL, diodeCurrents, minLitCurrent, type Diode, type DiodeModel } from './sim/diodes';
export {
  DEFAULT_VDD, PROTEUS_PIC_THRESHOLDS, TTL_THRESHOLDS, classifyVoltage, schmittThresholds, type Thresholds,
} from './sim/levels';
export { solveResistive, type Conductance } from './sim/resistive';

export interface SimulatorOptions {
  /** Supply voltage (5 V). */
  vdd?: number;
  /** Thresholds of TTL inputs (RA0-RA3, RB0-RB7) and of the displays. Default: datasheet TTL 0.8 / 2.0 V. */
  ttl?: Thresholds;
  /** Thresholds of the RA4/T0CKI Schmitt-trigger input. Default: datasheet 0.2·VDD / 0.8·VDD. */
  schmitt?: Thresholds;
  /** PORTB weak pull-up as a resistor to VDD (Proteus RWHI = 20 kΩ). */
  weakPullupOhms?: number;
  /** LED duty-cycle averaging window in seconds (20 ms). */
  brightnessWindow?: number;
  /** Minimum on time before a switched-on LED is drawn lit (LED library TLITMIN = 0.1 ms). */
  ledMinOnTime?: number;
  /** Electrical model of every LED (VF 2.2 V, RS 3 Ω, ROFF 100 kΩ, IMAX 10 mA). */
  ledModel?: DiodeModel;
}

export interface CircuitSimulatorEx extends CircuitSimulator {
  readonly netlist: BuiltNetlist;
  /** Node voltage when it is defined (strong 0/VDD or resistive solve), else null (floating, contention). */
  netVoltage(netId: string): number | null;
  /** Back to the initial interactive states (props) with LED averages cleared, then solve(). */
  reset(): void;
  /** French messages about parts the simulator had to ignore (unreadable resistor value...). */
  readonly warnings: readonly string[];
}

interface McuPinSlot { pin: PinName; net: number; thresholds: Thresholds; prev: Bit | undefined }

const NONE = -1;
const STRONG_X = 2;

/** Level of a node from the drivers of its strongest class: 0, 1, STRONG_X (both) or NONE. */
function resolveDrivers(drives0: number, drives1: number): number {
  if (drives0 && drives1) return STRONG_X;
  return drives1 ? 1 : drives0 ? 0 : NONE;
}

class CircuitSim implements CircuitSimulatorEx {
  readonly netlist: BuiltNetlist;
  readonly warnings: readonly string[];

  private readonly vdd: number;
  private readonly ttl: Thresholds;
  private readonly pullupG: number;
  private readonly ledModel: DiodeModel;
  private readonly netIds: string[];
  private readonly netIndex = new Map<string, number>();
  private readonly components = new Map<string, ComponentInstance>();

  // Static structure.
  private readonly mcuPins: McuPinSlot[] = [];
  private readonly topo: Topology;

  // Solve state.
  private readonly nodeOf: Int32Array;
  private nodeCount = 0;
  private nodesDirty = true;
  private dirty = true;
  private readonly levels: Level[];
  private readonly volts: Float64Array;
  private readonly prevNet: (Bit | undefined)[];
  private readonly lastDrive: Int8Array;
  private readonly lastPullup: Uint8Array;
  private readonly pinLevels: Level[];
  // Scratch buffers reused by every solve (node count never exceeds the net count).
  private readonly rail0: Uint8Array;
  private readonly rail1: Uint8Array;
  private readonly has0: Uint8Array;
  private readonly has1: Uint8Array;
  private readonly strong: Int8Array;
  private readonly vLo: Float64Array;
  private readonly vHi: Float64Array;
  private readonly localIndex: Int32Array;

  constructor(schematic: Schematic, private readonly mcu: McuPins, mcuComponentId: string, opts: SimulatorOptions) {
    this.vdd = opts.vdd ?? DEFAULT_VDD;
    this.ttl = opts.ttl ?? TTL_THRESHOLDS;
    this.pullupG = 1 / (opts.weakPullupOhms ?? 20_000);
    this.ledModel = opts.ledModel ?? LED_MODEL;
    this.netlist = buildNetlist(schematic);
    this.netIds = this.netlist.nets.map((n) => n.id);
    this.netIds.forEach((id, i) => this.netIndex.set(id, i));
    const n = this.netIds.length;
    this.nodeOf = new Int32Array(n);
    this.levels = new Array<Level>(n).fill('Z');
    this.volts = new Float64Array(n).fill(NaN);
    this.prevNet = new Array<Bit | undefined>(n).fill(undefined);
    this.rail0 = new Uint8Array(n);
    this.rail1 = new Uint8Array(n);
    this.has0 = new Uint8Array(n);
    this.has1 = new Uint8Array(n);
    this.strong = new Int8Array(n);
    this.vLo = new Float64Array(n);
    this.vHi = new Float64Array(n);
    this.localIndex = new Int32Array(n + 1);
    for (const c of schematic.components) this.components.set(c.id, c);

    const mcuPart = this.components.get(mcuComponentId);
    if (!mcuPart || mcuPart.kind !== 'PIC16F84A') {
      throw new Error(`Microcontrôleur « ${mcuComponentId} » introuvable dans le schéma.`);
    }
    const schmitt = opts.schmitt ?? schmittThresholds(this.vdd);
    for (const [symbolPin, pin] of Object.entries(PIC_GPIO_PINS)) {
      const net = this.netOfPin(mcuComponentId, symbolPin);
      if (net === NONE || !mcu.pinNames.includes(pin)) continue;
      this.mcuPins.push({ pin, net, thresholds: pin === 'RA4' ? schmitt : this.ttl, prev: undefined });
    }
    this.lastDrive = new Int8Array(this.mcuPins.length).fill(-2);
    this.lastPullup = new Uint8Array(this.mcuPins.length);
    this.pinLevels = new Array<Level>(this.mcuPins.length).fill('Z');

    const window = opts.brightnessWindow ?? BRIGHTNESS_WINDOW_S;
    const minOnTime = opts.ledMinOnTime ?? LED_MIN_ON_TIME_S;
    this.topo = extractTopology(
      schematic, n, (id, pin) => this.netOfPin(id, pin), (net) => this.netlist.nets[net]?.pins.length ?? 0,
      () => new DutyCycle(window, minOnTime),
    );
    this.warnings = this.topo.warnings;
    this.solve();
  }

  private netOfPin(componentId: string, pin: string): number {
    const id = this.netlist.pinToNet.get(pinKey(componentId, pin));
    return id === undefined ? NONE : this.netIndex.get(id)!;
  }

  private regroupNodes(): void {
    const n = this.netIds.length;
    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (i: number): number => {
      while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    };
    for (const b of this.topo.buttons.values()) {
      if (!b.pressed) continue;
      const ra = find(b.a);
      const rb = find(b.b);
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    }
    const nodeIndex = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      let node = nodeIndex.get(r);
      if (node === undefined) { node = nodeIndex.size; nodeIndex.set(r, node); }
      this.nodeOf[i] = node;
    }
    this.nodeCount = nodeIndex.size;
    this.nodesDirty = false;
  }

  /** True when the MCU drives and pull-ups are the same as at the previous solve (nothing to recompute). */
  private sampleMcu(): boolean {
    let same = true;
    this.mcuPins.forEach((slot, i) => {
      const d = this.mcu.getDrive(slot.pin);
      const code = d === 'Z' ? -1 : d;
      const pu = this.mcu.hasWeakPullup(slot.pin) ? 1 : 0;
      if (code !== this.lastDrive[i] || pu !== this.lastPullup[i]) same = false;
      this.lastDrive[i] = code;
      this.lastPullup[i] = pu;
    });
    return same;
  }

  solve(): void {
    const unchanged = this.sampleMcu();
    if (unchanged && !this.dirty) {
      this.pushInputs();
      return;
    }
    this.dirty = false;
    if (this.nodesDirty) this.regroupNodes();
    const nodes = this.nodeCount;
    const nets = this.netIds.length;

    // Driven nodes: the power-strength rails first, then the strong drivers.
    const { rail0, rail1, has0, has1, strong } = this;
    for (const flags of [rail0, rail1, has0, has1]) flags.fill(0, 0, nodes);
    for (let i = 0; i < nets; i++) {
      if (this.topo.railHas0[i]) rail0[this.nodeOf[i]] = 1;
      if (this.topo.railHas1[i]) rail1[this.nodeOf[i]] = 1;
    }
    for (const s of this.topo.logic.values()) (s.state ? has1 : has0)[this.nodeOf[s.net]] = 1;
    this.mcuPins.forEach((slot, i) => {
      const d = this.lastDrive[i];
      if (d === 0) has0[this.nodeOf[slot.net]] = 1;
      else if (d === 1) has1[this.nodeOf[slot.net]] = 1;
    });
    for (let k = 0; k < nodes; k++) {
      strong[k] = rail0[k] || rail1[k] ? resolveDrivers(rail0[k], rail1[k]) : resolveDrivers(has0[k], has1[k]);
    }
    const [vLo, vHi] = this.solveAnalog();

    for (let i = 0; i < nets; i++) {
      const k = this.nodeOf[i];
      const s = strong[k];
      if (s === 0 || s === 1) {
        this.levels[i] = s;
        this.prevNet[i] = s;
        this.volts[i] = s * this.vdd;
      } else if (s === STRONG_X) {
        this.levels[i] = 'X';
        this.volts[i] = NaN;
      } else if (Number.isNaN(vLo[k])) {
        this.levels[i] = 'Z';
        this.volts[i] = NaN;
      } else {
        const lo = classifyVoltage(vLo[k], this.ttl, this.prevNet[i]);
        const hi = classifyVoltage(vHi[k], this.ttl, this.prevNet[i]);
        if (lo === hi) {
          this.levels[i] = lo;
          this.prevNet[i] = lo;
          this.volts[i] = vLo[k];
        } else {
          this.levels[i] = 'X';
          this.volts[i] = NaN;
        }
      }
    }

    this.mcuPins.forEach((slot, i) => {
      const level = this.levels[slot.net];
      const v = this.volts[slot.net];
      // Analog node read through this pin's own input buffer (RA4 is a Schmitt trigger).
      if (strong[this.nodeOf[slot.net]] === NONE && !Number.isNaN(v) && slot.thresholds !== this.ttl) {
        slot.prev = classifyVoltage(v, slot.thresholds, slot.prev);
        this.pinLevels[i] = slot.prev;
      } else {
        if (level === 0 || level === 1) slot.prev = level;
        this.pinLevels[i] = level;
      }
    });

    this.updateLeds();
    this.pushInputs();
  }

  /** Calls `add` for every resistive coupling: RES, TORCH_LDR, and weak pull-ups to the VDD pseudo-node (nodeCount). */
  private forEachConductance(add: (nodeA: number, nodeB: number, g: number) => void): void {
    for (const r of this.topo.resistors) add(this.nodeOf[r.a], this.nodeOf[r.b], r.g);
    for (const l of this.topo.ldrs.values()) add(this.nodeOf[l.a], this.nodeOf[l.b], 1 / l.ohms[l.level]);
    this.mcuPins.forEach((slot, i) => {
      if (this.lastPullup[i]) add(this.nodeOf[slot.net], this.nodeCount, this.pullupG);
    });
  }

  /** Indexes the nodes taking part in a linear solve; `localIndex` maps node → position in `order`. */
  private localNodes(): { order: number[]; local: (node: number) => number } {
    const { localIndex } = this;
    localIndex.fill(-1);
    const order: number[] = [];
    const local = (node: number): number => {
      if (localIndex[node] < 0) { localIndex[node] = order.length; order.push(node); }
      return localIndex[node];
    };
    return { order, local };
  }

  /**
   * LED conduction: the resistor network plus one piecewise-linear diode per LED, the driven nodes held at 0 V /
   * VDD. An LED is lit from minLitCurrent() on. Contended ('X') nodes are left out, so an LED touching one stays dark.
   */
  private updateLeds(): void {
    const { strong } = this;
    const vddNode = this.nodeCount;
    const usable = (node: number) => node === vddNode || strong[node] !== STRONG_X;
    const { order, local } = this.localNodes();
    const resistors: Conductance[] = [];
    this.forEachConductance((a, b, g) => {
      if (a !== b && usable(a) && usable(b)) resistors.push({ a: local(a), b: local(b), g });
    });
    const diodes: Diode[] = [];
    const diodeLeds: Led[] = [];
    for (const led of this.topo.leds.values()) {
      led.lit = false;
      const a = this.nodeOf[led.anode];
      const k = this.nodeOf[led.cathode];
      if (a === undefined || k === undefined || a === k || !usable(a) || !usable(k)) continue;
      diodes.push({ anode: local(a), cathode: local(k) });
      diodeLeds.push(led);
    }
    if (diodes.length === 0) return;
    const fixed = Float64Array.from(order, (node) => {
      if (node === vddNode) return this.vdd;
      const s = strong[node];
      return s === NONE ? NaN : s * this.vdd;
    });
    const current = diodeCurrents(order.length, resistors, diodes, fixed, this.ledModel);
    const threshold = minLitCurrent(this.ledModel);
    diodeLeds.forEach((led, i) => { led.lit = current[i] >= threshold; });
  }

  /**
   * Voltages of the undriven nodes that have a resistive path (RES, TORCH_LDR, weak pull-ups) to a driven one;
   * NaN elsewhere. Only the nodes touched by a resistor enter the linear solve. A node depending on a contended
   * ('X') node is solved twice, with the 'X' nodes at 0 V and at VDD, so the caller can tell whether it is decided.
   */
  private solveAnalog(): [Float64Array, Float64Array] {
    const { strong, vLo, vHi } = this;
    const vddNode = this.nodeCount;
    vLo.fill(NaN);
    vHi.fill(NaN);
    const { order, local } = this.localNodes();
    const edges: Conductance[] = [];
    this.forEachConductance((a, b, g) => {
      if (a !== b) edges.push({ a: local(a), b: local(b), g });
    });
    if (edges.length === 0) return [vLo, vHi];
    const fixed = (xVolts: number) => Float64Array.from(order, (node) => {
      if (node === vddNode) return this.vdd;
      const s = strong[node];
      return s === NONE ? NaN : s === STRONG_X ? xVolts : s * this.vdd;
    });
    const lo = solveResistive(order.length, edges, fixed(0));
    const dependsOnX = order.some((node) => node !== vddNode && strong[node] === STRONG_X);
    const hi = dependsOnX ? solveResistive(order.length, edges, fixed(this.vdd)) : lo;
    order.forEach((node, i) => {
      if (node !== vddNode) { vLo[node] = lo[i]; vHi[node] = hi[i]; }
    });
    return [vLo, vHi];
  }

  private pushInputs(): void {
    this.mcuPins.forEach((slot, i) => this.mcu.setInput(slot.pin, this.pinLevels[i]));
  }

  advance(dtSeconds: number): void {
    for (const led of this.topo.leds.values()) led.duty.advance(dtSeconds, led.lit);
  }

  interact(componentId: string, action: Interaction): void {
    if (!this.components.has(componentId)) throw new Error(`Composant inconnu : « ${componentId} ».`);
    const logic = this.topo.logic.get(componentId);
    const button = this.topo.buttons.get(componentId);
    const ldr = this.topo.ldrs.get(componentId);
    if (logic && action.type === 'toggle') {
      logic.state = logic.state ? 0 : 1;
    } else if (button && (action.type === 'press' || action.type === 'release')) {
      const pressed = action.type === 'press';
      if (button.pressed === pressed) return;
      button.pressed = pressed;
      this.nodesDirty = true;
    } else if (ldr && action.type === 'setLevel') {
      ldr.level = clampLdrLevel(action.level);
    } else {
      return; // interaction not applicable to this part
    }
    this.dirty = true;
    this.solve();
  }

  reset(): void {
    for (const s of this.topo.logic.values()) s.state = s.initial;
    for (const b of this.topo.buttons.values()) b.pressed = false;
    for (const l of this.topo.ldrs.values()) l.level = l.initial;
    for (const led of this.topo.leds.values()) led.duty.reset();
    this.prevNet.fill(undefined);
    for (const slot of this.mcuPins) slot.prev = undefined;
    this.nodesDirty = true;
    this.dirty = true;
    this.solve();
  }

  visual(componentId: string): ComponentVisual {
    const c = this.components.get(componentId);
    if (!c) throw new Error(`Composant inconnu : « ${componentId} ».`);
    switch (c.kind) {
      case 'LED': {
        const led = this.topo.leds.get(componentId)!;
        return { kind: 'LED', lit: led.lit, brightness: led.duty.value(led.lit) };
      }
      case 'LOGICSTATE': return { kind: 'LOGICSTATE', state: this.topo.logic.get(componentId)!.state };
      case 'BUTTON': return { kind: 'BUTTON', pressed: this.topo.buttons.get(componentId)!.pressed };
      case 'TORCH_LDR': return { kind: 'TORCH_LDR', level: this.topo.ldrs.get(componentId)!.level };
      case '7SEG-BCD': {
        let value = 0;
        for (const net of this.topo.bcd.get(componentId)!) {
          const l = this.levels[net];
          if (l !== 0 && l !== 1) return { kind: '7SEG-BCD', value: null };
          value = (value << 1) | l;
        }
        return { kind: '7SEG-BCD', value };
      }
      case '7SEG-CC': {
        const d = this.topo.cc.get(componentId)!;
        const k = this.levels[d.k];
        // An unconnected common pin counts as grounded (the prof's capture wires only a..g).
        const common = k === 0 || (k === 'Z' && d.kAlone);
        let segments = 0;
        if (common) d.segments.forEach((net, i) => { if (this.levels[net] === 1) segments |= 1 << i; });
        return { kind: '7SEG-CC', segments };
      }
      case 'TRAFFIC_LIGHTS': {
        const [r, a, g] = this.topo.traffic.get(componentId)!;
        return { kind: 'TRAFFIC_LIGHTS', red: this.levels[r] === 1, amber: this.levels[a] === 1, green: this.levels[g] === 1 };
      }
      default: return { kind: 'NONE' };
    }
  }

  netLevel(netId: string): Level {
    const i = this.netIndex.get(netId);
    if (i === undefined) throw new Error(`Net inconnu : « ${netId} ».`);
    return this.levels[i];
  }

  netVoltage(netId: string): number | null {
    const i = this.netIndex.get(netId);
    if (i === undefined) throw new Error(`Net inconnu : « ${netId} ».`);
    return Number.isNaN(this.volts[i]) ? null : this.volts[i];
  }
}

/**
 * Build the live simulator of a schematic around an MCU. `mcuComponentId` is the PIC16F84A whose GPIO pins are
 * bound to `mcu`. The constructor runs a first solve(), so the MCU sees its inputs before the first instruction.
 */
export function createCircuitSimulator(
  schematic: Schematic,
  mcu: McuPins,
  mcuComponentId: string,
  options: SimulatorOptions = {},
): CircuitSimulatorEx {
  return new CircuitSim(schematic, mcu, mcuComponentId, options);
}
