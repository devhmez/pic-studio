// Suggest signals and buses from a wired schematic (the assistant's starting point): which PIC pin drives an LED,
// reads a LOGICSTATE or a BUTTON, feeds a 7SEG-BCD, a traffic light or reads the LDR divider.
import { buildNetlist, type ComponentInstance, type Netlist, type Schematic } from '@pic/circuit';
import { gpioOfSchematicPin, pinBit, pinOf, pinPort, schematicPinName } from './pins';
import type { Bus, Level, PinName, Port, Signal } from './types';

export interface DerivedIo {
  signals: Signal[];
  buses: Bus[];
}

const COLOR_FR: Readonly<Record<string, { name: string; label: string }>> = {
  RED: { name: 'ROUGE', label: 'rouge' },
  GREEN: { name: 'VERTE', label: 'verte' },
  BLUE: { name: 'BLEUE', label: 'bleue' },
  YELLOW: { name: 'JAUNE', label: 'jaune' },
};

const LAMPS: Readonly<Record<string, { name: string; label: string }>> = {
  R: { name: 'ROUGE', label: 'Feu rouge' },
  A: { name: 'ORANGE', label: 'Feu orange' },
  G: { name: 'VERT', label: 'Feu vert' },
};

/** A component reference chosen by the student (EGALITE, VALIDER), not an automatic one (D1, R2, LS3). */
function customRef(c: ComponentInstance): string | null {
  const ref = c.ref?.trim();
  if (!ref || /^(D|R|U|LS|BTN|SEG|TL|LDR|C|X|PWR|GND)\d+$/i.test(ref)) return null;
  return ref;
}

/** C identifier from free text: upper case, accents removed, non-alphanumerics → '_'. */
export function toIdentifier(text: string): string {
  const id = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return /^[0-9]/.test(id) ? `_${id}` : id || 'SIGNAL';
}

/** 'X_SUPERIEUR' → 'x superieur'. */
const prettyRef = (ref: string) => ref.toLowerCase().replace(/_+/g, ' ');

interface PinMember { componentId: string; pin: string }

class Topology {
  readonly byId: Map<string, ComponentInstance>;
  constructor(readonly schematic: Schematic, readonly netlist: Netlist) {
    this.byId = new Map(schematic.components.map((c) => [c.id, c]));
  }

  netOf(componentId: string, pin: string) {
    const id = this.netlist.pinToNet.get(`${componentId}:${pin}`);
    return id ? this.netlist.nets.find((n) => n.id === id) : undefined;
  }

  /** Other pins on the same net as (componentId, pin). */
  peers(componentId: string, pin: string): PinMember[] {
    const net = this.netOf(componentId, pin);
    return net ? net.pins.filter((p) => !(p.componentId === componentId && p.pin === pin)) : [];
  }

  rail(componentId: string, pin: string): 'VDD' | 'GND' | undefined {
    return this.netOf(componentId, pin)?.rail;
  }

  kind(id: string) {
    return this.byId.get(id)?.kind;
  }

  /** The other pin of a two-pin part. */
  otherPin(componentId: string, pin: string): string | undefined {
    const kind = this.kind(componentId);
    if (kind === 'RES' || kind === 'BUTTON' || kind === 'TORCH_LDR' || kind === 'CAP' || kind === 'CRYSTAL') return pin === '1' ? '2' : '1';
    if (kind === 'LED') return pin === 'A' ? 'K' : 'A';
    return undefined;
  }

  /** Pins reached from (componentId, pin): the net, plus the far side of series resistors (one hop). */
  reach(componentId: string, pin: string): { member: PinMember; viaResistor: boolean }[] {
    const out: { member: PinMember; viaResistor: boolean }[] = [];
    for (const p of this.peers(componentId, pin)) {
      out.push({ member: p, viaResistor: false });
      if (this.kind(p.componentId) === 'RES') {
        const other = this.otherPin(p.componentId, p.pin)!;
        if (this.rail(p.componentId, other)) continue; // pull-up / pull-down, not a series resistor
        for (const q of this.peers(p.componentId, other)) out.push({ member: q, viaResistor: true });
      }
    }
    return out;
  }
}

/**
 * Signals and buses suggested by the circuit around U1 (the PIC16F84A):
 * - pin → LED anode (directly or through a series RES), cathode to GND → output, active high (`LED_ROUGE`, « Led rouge »);
 * - LOGICSTATE → input (`INTER_RA0`, or the part's custom reference);
 * - BUTTON with a pull-down (button to +5 V) → input active high; with a pull-up → active low;
 * - TRAFFIC LIGHTS R/A/G → outputs ROUGE / ORANGE / VERT (« Feu rouge »…);
 * - TORCH_LDR divider → input CAPTEUR « Capteur de luminosité » (1 = lumière when the LDR goes to +5 V);
 * - 7SEG-BCD E0..E3 on consecutive pins of one port → bus AFFICHEUR.
 * Custom component references (EGALITE, VALIDER, DEMARRER…) become the signal names.
 */
export function deriveSignals(schematic: Schematic, netlist: Netlist = buildNetlist(schematic)): DerivedIo {
  const topo = new Topology(schematic, netlist);
  const pic = schematic.components.find((c) => c.kind === 'PIC16F84A');
  if (!pic) return { signals: [], buses: [] };

  const signals: Signal[] = [];
  const buses: Bus[] = [];
  const usedNames = new Set<string>();
  const uniqueName = (name: string) => {
    let n = name;
    for (let k = 2; usedNames.has(n); k++) n = `${name}_${k}`;
    usedNames.add(n);
    return n;
  };
  const colorCount = new Map<string, number>();

  // 7SEG-BCD buses first: their pins are not individual signals.
  const busPinSet = new Set<PinName>();
  for (const seg of schematic.components.filter((c) => c.kind === '7SEG-BCD')) {
    const pins: (PinName | undefined)[] = [0, 1, 2, 3].map((k) => {
      const hit = topo.peers(seg.id, `E${k}`).find((p) => p.componentId === pic.id);
      return hit ? gpioOfSchematicPin(hit.pin) : undefined;
    });
    const connected = pins.filter((p): p is PinName => !!p);
    if (connected.length === 0) continue;
    const port: Port = pinPort(connected[0]);
    const lsbPin = pins[0];
    const lsb = lsbPin ? pinBit(lsbPin) : pinBit(connected[0]);
    let width = 0;
    pins.forEach((p, k) => { if (p) width = k + 1; });
    const contiguous = pins.slice(0, width).every((p, k) => p !== undefined && pinPort(p) === port && pinBit(p) === lsb + k);
    if (!contiguous) continue;
    const name = uniqueName(buses.length === 0 ? 'AFFICHEUR' : `AFFICHEUR${buses.length + 1}`);
    buses.push({
      id: name.toLowerCase(),
      name,
      port,
      lsb,
      width,
      dir: 'out',
      label: 'Afficheur 7 segments BCD',
      device: 'bcd',
      componentId: seg.id,
    });
    for (let k = 0; k < width; k++) busPinSet.add(pinOf(port, lsb + k)!);
  }

  const gpios: PinName[] = ['RA0', 'RA1', 'RA2', 'RA3', 'RA4', 'RB0', 'RB1', 'RB2', 'RB3', 'RB4', 'RB5', 'RB6', 'RB7'];
  for (const gpio of gpios) {
    if (busPinSet.has(gpio)) continue;
    const picPin = schematicPinName(gpio);
    const reached = topo.reach(pic.id, picPin);
    if (reached.length === 0) continue;
    const make = (s: Omit<Signal, 'id' | 'pin' | 'name'> & { name: string }): Signal => {
      const name = uniqueName(toIdentifier(s.name));
      return { ...s, id: name.toLowerCase(), name, pin: gpio };
    };

    // Outputs: LED anode / cathode, traffic lamps.
    const led = reached.find((r) => topo.kind(r.member.componentId) === 'LED');
    const lamp = reached.find((r) => topo.kind(r.member.componentId) === 'TRAFFIC_LIGHTS');
    const logic = reached.find((r) => topo.kind(r.member.componentId) === 'LOGICSTATE' && !r.viaResistor);
    const button = reached.find((r) => topo.kind(r.member.componentId) === 'BUTTON' && !r.viaResistor);
    const ldr = reached.find((r) => topo.kind(r.member.componentId) === 'TORCH_LDR' && !r.viaResistor);

    if (logic) {
      const c = topo.byId.get(logic.member.componentId)!;
      const ref = customRef(c);
      signals.push(make({
        name: ref ?? `INTER_${gpio}`,
        dir: 'in',
        label: ref ? `Interrupteur ${prettyRef(ref)}` : `Interrupteur ${gpio}`,
        activeLevel: 1,
        device: 'logicstate',
        componentId: c.id,
      }));
    } else if (button) {
      const c = topo.byId.get(button.member.componentId)!;
      const other = topo.otherPin(c.id, button.member.pin)!;
      const activeLevel: Level = topo.rail(c.id, other) === 'GND' ? 0 : 1;
      const ref = customRef(c);
      signals.push(make({
        name: ref ?? `BOUTON_${gpio}`,
        dir: 'in',
        label: ref ? `Bouton ${prettyRef(ref)}` : `Bouton ${gpio}`,
        activeLevel,
        device: 'button',
        componentId: c.id,
      }));
    } else if (ldr) {
      const c = topo.byId.get(ldr.member.componentId)!;
      const other = topo.otherPin(c.id, ldr.member.pin)!;
      signals.push(make({
        name: 'CAPTEUR',
        dir: 'in',
        label: 'Capteur de luminosité',
        // LDR to +5 V: more light → lower resistance → node high.
        activeLevel: topo.rail(c.id, other) === 'GND' ? 0 : 1,
        device: 'sensor',
        componentId: c.id,
      }));
    } else if (lamp) {
      const c = topo.byId.get(lamp.member.componentId)!;
      const l = LAMPS[lamp.member.pin];
      if (l) signals.push(make({ name: l.name, dir: 'out', label: l.label, activeLevel: 1, device: 'lamp', componentId: c.id }));
    } else if (led) {
      const c = topo.byId.get(led.member.componentId)!;
      const ref = customRef(c);
      const color = COLOR_FR[String(c.props.color ?? 'RED')] ?? COLOR_FR.RED;
      const count = (colorCount.get(color.name) ?? 0) + 1;
      colorCount.set(color.name, count);
      // Anode on the pin → lit at 1; cathode on the pin (anode to +5 V) → lit at 0.
      const activeLevel: Level = led.member.pin === 'K' ? 0 : 1;
      signals.push(make({
        name: ref ?? `LED_${color.name}`,
        dir: 'out',
        label: ref ? `Led ${prettyRef(ref)}` : `Led ${color.label}${count > 1 ? ` ${count}` : ''}`,
        activeLevel,
        device: 'led',
        componentId: c.id,
      }));
    }
  }
  return { signals, buses };
}
