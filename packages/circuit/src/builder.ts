// Programmatic schematic construction (templates, tests, the assistant's auto-wiring).
import type { ComponentInstance, ComponentKind, PinRef, Point, Schematic, Wire } from './api';
import { pinTip, type Rotation } from './geometry';
import { getSymbol } from './symbols';

export interface PlaceOptions {
  at: Point;
  id?: string;
  /** Defaults to the next free `<prefix><n>` (U1, D1, R1...) or '' for parts ISIS shows without reference. */
  ref?: string;
  value?: string;
  rotation?: Rotation;
  mirror?: boolean;
  props?: Record<string, string | number>;
}

const ID_PREFIX: Readonly<Record<ComponentKind, string>> = {
  PIC16F84A: 'U', LED: 'D', LOGICSTATE: 'LS', BUTTON: 'BTN', RES: 'R', '7SEG-BCD': 'SEG', '7SEG-CC': 'SEG',
  TRAFFIC_LIGHTS: 'TL', TORCH_LDR: 'LDR', CAP: 'C', CRYSTAL: 'X', POWER: 'PWR', GROUND: 'GND',
};

export type WirePoint = Point | PinRef;

const isPinRef = (p: WirePoint): p is PinRef => 'componentId' in p;

export class SchematicBuilder {
  private readonly components: ComponentInstance[] = [];
  private readonly wires: Wire[] = [];
  private readonly usedIds = new Set<string>();
  private readonly usedRefs = new Set<string>();

  constructor(private readonly clockHz = 1_000_000) {}

  place(kind: ComponentKind, opts: PlaceOptions): ComponentInstance {
    const symbol = getSymbol(kind, opts.props);
    const ref = opts.ref ?? (symbol.refPrefix ? this.next(symbol.refPrefix, this.usedRefs) : '');
    if (ref) this.usedRefs.add(ref);
    const id = opts.id ?? (ref && !this.usedIds.has(ref) ? ref : this.next(ID_PREFIX[kind], this.usedIds));
    if (this.usedIds.has(id)) throw new Error(`Identifiant déjà utilisé : « ${id} ».`);
    this.usedIds.add(id);
    const component: ComponentInstance = {
      id,
      kind,
      ref,
      at: { ...opts.at },
      rotation: opts.rotation ?? 0,
      props: { ...symbol.defaultProps, ...opts.props },
    };
    const value = opts.value ?? symbol.defaultValue;
    if (value !== undefined) component.value = value;
    if (opts.mirror) component.mirror = true;
    this.components.push(component);
    return component;
  }

  /** World position of a pin tip. */
  pin(componentId: string, pin: string): Point {
    const c = this.components.find((x) => x.id === componentId);
    const tip = c && pinTip(c, pin);
    if (!tip) throw new Error(`Broche introuvable : ${componentId}.${pin}`);
    return tip;
  }

  /** A polyline wire through the given points; pin references resolve to their tips. */
  wire(...points: WirePoint[]): Wire {
    const wire: Wire = {
      id: `W${this.wires.length + 1}`,
      points: points.map((p) => (isPinRef(p) ? this.pin(p.componentId, p.pin) : { x: p.x, y: p.y })),
    };
    this.wires.push(wire);
    return wire;
  }

  build(): Schematic {
    return { clockHz: this.clockHz, components: this.components.map((c) => ({ ...c })), wires: this.wires.map((w) => ({ ...w })) };
  }

  private next(prefix: string, used: Set<string>): string {
    for (let n = 1; ; n++) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`;
  }
}

/** Shorthand for a pin reference. */
export const pinRef = (componentId: string, pin: string): PinRef => ({ componentId, pin });
