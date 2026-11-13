// Static electrical structure of a schematic, extracted once per simulator: what drives, couples or loads each net.
import type { ComponentInstance, Schematic } from '../api';
import { LDR_LEVEL_OHMS, SEGMENTS } from '../symbols';
import { parseResistance } from '../units';
import type { DutyCycle } from './brightness';
import type { Bit } from './levels';
import type { Conductance } from './resistive';

export interface LogicSource { net: number; initial: Bit; state: Bit }
export interface ButtonSwitch { a: number; b: number; pressed: boolean }
export interface Ldr { a: number; b: number; ohms: number[]; initial: number; level: number }
export interface Led { anode: number; cathode: number; lit: boolean; duty: DutyCycle }
export interface SevenSegCc { segments: number[]; k: number; kAlone: boolean }

export interface Topology {
  /** Per net: a GROUND / POWER terminal sits on it. */
  railHas0: Uint8Array;
  railHas1: Uint8Array;
  logic: Map<string, LogicSource>;
  buttons: Map<string, ButtonSwitch>;
  resistors: Conductance[];
  ldrs: Map<string, Ldr>;
  leds: Map<string, Led>;
  /** 7SEG-BCD input nets, E3 (MSB) first. */
  bcd: Map<string, number[]>;
  cc: Map<string, SevenSegCc>;
  /** TRAFFIC LIGHTS nets: red, amber, green. */
  traffic: Map<string, [number, number, number]>;
  /** French messages about parts that had to be ignored. */
  warnings: string[];
}

export function clampLdrLevel(level: number): number {
  return Math.max(0, Math.min(LDR_LEVEL_OHMS.length - 1, Math.round(level)));
}

/**
 * @param netOf net index of a component pin
 * @param pinCount number of pins on a net (to tell an unconnected 7-seg common pin)
 * @param newDuty brightness accumulator of one LED
 */
export function extractTopology(
  schematic: Schematic,
  netCount: number,
  netOf: (componentId: string, pin: string) => number,
  pinCount: (net: number) => number,
  newDuty: () => DutyCycle,
): Topology {
  const t: Topology = {
    railHas0: new Uint8Array(netCount), railHas1: new Uint8Array(netCount),
    logic: new Map(), buttons: new Map(), resistors: [], ldrs: new Map(), leds: new Map(),
    bcd: new Map(), cc: new Map(), traffic: new Map(), warnings: [],
  };
  for (const c of schematic.components) addComponent(t, c, (pin) => netOf(c.id, pin), pinCount, newDuty);
  return t;
}

function addComponent(
  t: Topology, c: ComponentInstance, net: (pin: string) => number, pinCount: (net: number) => number,
  newDuty: () => DutyCycle,
): void {
  switch (c.kind) {
    case 'POWER': t.railHas1[net('VDD')] = 1; break;
    case 'GROUND': t.railHas0[net('GND')] = 1; break;
    case 'LOGICSTATE': {
      const initial: Bit = Number(c.props.state) === 1 ? 1 : 0;
      t.logic.set(c.id, { net: net('Q0'), initial, state: initial });
      break;
    }
    case 'BUTTON': t.buttons.set(c.id, { a: net('1'), b: net('2'), pressed: false }); break;
    case 'RES': {
      const ohms = parseResistance(c.value ?? '10k');
      if (ohms === null) t.warnings.push(`Valeur de résistance illisible : ${c.ref || c.id} = « ${c.value} » (ignorée).`);
      else t.resistors.push({ a: net('1'), b: net('2'), g: 1 / ohms });
      break;
    }
    case 'TORCH_LDR': {
      const ohms = LDR_LEVEL_OHMS.map((def, i) => parseResistance(c.props[`R(${i})`]) ?? def);
      const initial = clampLdrLevel(Number(c.props.level ?? 0) || 0);
      t.ldrs.set(c.id, { a: net('1'), b: net('2'), ohms, initial, level: initial });
      break;
    }
    case 'LED': t.leds.set(c.id, { anode: net('A'), cathode: net('K'), lit: false, duty: newDuty() }); break;
    case '7SEG-BCD': t.bcd.set(c.id, ['E3', 'E2', 'E1', 'E0'].map(net)); break;
    case '7SEG-CC': {
      const k = net('K');
      t.cc.set(c.id, { segments: [...SEGMENTS, 'dp'].map(net), k, kAlone: pinCount(k) === 1 });
      break;
    }
    case 'TRAFFIC_LIGHTS': t.traffic.set(c.id, [net('R'), net('A'), net('G')]); break;
    case 'PIC16F84A':
    case 'CAP':
    case 'CRYSTAL':
      break; // no DC behaviour (the CLOCK property sets the speed; capacitors are open in DC)
  }
}
