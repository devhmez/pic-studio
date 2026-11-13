// Public contract of the circuit model + simulator (ISIS replacement).
import type { McuPins } from '@pic/emulator/api';

/** Grid unit = 0.1 inch (one ISIS grid step). Y axis points DOWN in this model (screen coordinates). */
export interface Point { x: number; y: number }

export type ComponentKind =
  | 'PIC16F84A'
  | 'LED'            // props.color: 'RED' | 'GREEN' | 'BLUE' | 'YELLOW'  (ISIS LED-RED ...)
  | 'LOGICSTATE'     // props.state: 0 | 1 (latched)
  | 'BUTTON'         // momentary push button, 2 pins
  | 'RES'            // value e.g. '220', '10k'
  | '7SEG-BCD'       // props.color: 'RED' | 'BLUE' | 'GREEN'; pins E3 E2 E1 E0 (MSB left), shows 0-9 A b C d E F
  | '7SEG-CC'        // direct common-cathode 7-segment (a..g, dp, K)
  | 'TRAFFIC_LIGHTS' // pins R, A(mber), G active high (ISIS TRAFFIC LIGHTS)
  | 'TORCH_LDR'      // props.level 0..9 → R(0)=1M .. R(9)=500 (ISIS TORCH_LDR / ORP-12)
  | 'CAP'
  | 'CRYSTAL'
  | 'POWER'          // +5V terminal
  | 'GROUND';

export interface PinDef {
  /** Pin name as in ISIS (e.g. 'RA0', 'RB0/INT', 'A', 'K', '1', '2', 'E3'). */
  name: string;
  /** Pin number shown on the symbol, if any. */
  number?: number;
  /** Pin tip position relative to component origin, before rotation/mirror, in grid units. */
  tip: Point;
}

export interface ComponentInstance {
  id: string;
  kind: ComponentKind;
  /** Reference shown on the schematic: U1, D1, R1, or custom (X_SUPERIEUR, EGALITE...). */
  ref: string;
  /** Value text: '220', '10k', 'PIC16F84A', 'LED-RED'... */
  value?: string;
  /** Origin position in grid units. */
  at: Point;
  rotation: 0 | 90 | 180 | 270;
  mirror?: boolean;
  props: Record<string, string | number>;
}

export interface Wire {
  id: string;
  /** Polyline in grid units; endpoints must land on a pin tip, another wire's vertex/segment (junction) or a terminal. */
  points: Point[];
}

export interface Schematic {
  components: ComponentInstance[];
  wires: Wire[];
  /** PIC clock in Hz (ISIS CLOCK property of U1). */
  clockHz: number;
}

export interface PinRef { componentId: string; pin: string }

export interface Net {
  id: string;
  pins: PinRef[];
  /** True if the net touches POWER or GROUND. */
  rail?: 'VDD' | 'GND';
}

export interface Netlist {
  nets: Net[];
  /** componentId:pin → net id */
  pinToNet: Map<string, string>;
  /** Wire endpoints that touch nothing (shown as warnings in the editor). */
  dangling: Point[];
}

/** Live visual state of a component during simulation (what the UI draws). */
export type ComponentVisual =
  | { kind: 'LED'; brightness: number /* 0..1, duty-cycle averaged */ ; lit: boolean }
  | { kind: '7SEG-BCD'; value: number | null /* 0..15, null = inputs undefined */ }
  | { kind: '7SEG-CC'; segments: number /* bit0=a .. bit6=g, bit7=dp */ }
  | { kind: 'TRAFFIC_LIGHTS'; red: boolean; amber: boolean; green: boolean }
  | { kind: 'LOGICSTATE'; state: 0 | 1 }
  | { kind: 'BUTTON'; pressed: boolean }
  | { kind: 'TORCH_LDR'; level: number }
  | { kind: 'NONE' };

export type Interaction =
  | { type: 'toggle' }                 // LOGICSTATE
  | { type: 'press' } | { type: 'release' } // BUTTON
  | { type: 'setLevel'; level: number }; // TORCH_LDR 0..9

export interface CircuitSimulator {
  readonly netlist: Netlist;
  /** Resolve all nets from current drivers and push levels into the MCU via setInput. Call after every MCU step that changed IO, and after interactions. */
  solve(): void;
  /** Advance visual accumulators (LED duty cycle) by dt seconds of simulated time. */
  advance(dtSeconds: number): void;
  interact(componentId: string, action: Interaction): void;
  visual(componentId: string): ComponentVisual;
  /** Resolved logic level of every net ('Z' floating, 'X' contention), for red/blue/grey pin squares. */
  netLevel(netId: string): 0 | 1 | 'Z' | 'X';
}

export type { McuPins };
