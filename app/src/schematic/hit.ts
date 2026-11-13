// Hit-testing in world coordinates (grid units) for the editor's pointer handling.
import {
  componentAt, hitTestActuator, hitTestWire, symbolFor, transformPoint,
  type Actuator, type ComponentInstance, type Point, type Schematic,
} from '@pic/circuit';
import { pointOnWire } from './editing';

export interface PinHit {
  componentId: string;
  pin: string;
  at: Point;
  /** Direction of the pin line: a wire leaving it starts along it. */
  dir: 'h' | 'v';
}

/** Nearest visible pin tip within `tolerance`. */
export function hitPin(schematic: Schematic, p: Point, tolerance: number): PinHit | null {
  let best: PinHit | null = null;
  let bestD = tolerance;
  for (const c of schematic.components) {
    for (const pin of symbolFor(c).pins) {
      if (pin.hidden) continue;
      const at = transformPoint(pin.tip, c);
      const d = Math.hypot(at.x - p.x, at.y - p.y);
      if (d <= bestD) {
        const base = transformPoint(pin.base, c);
        const dir: 'h' | 'v' = Math.abs(at.x - base.x) >= Math.abs(at.y - base.y) ? 'h' : 'v';
        best = { componentId: c.id, pin: pin.name, at, dir };
        bestD = d;
      }
    }
  }
  return best;
}

/** Click target of an interactive part (LOGICSTATE, BUTTON, torch +/-), topmost first. */
export function hitActuator(schematic: Schematic, p: Point): { component: ComponentInstance; actuator: Actuator } | null {
  for (let i = schematic.components.length - 1; i >= 0; i--) {
    const c = schematic.components[i];
    const actuator = hitTestActuator(p, c);
    if (actuator) return { component: c, actuator };
  }
  return null;
}

export function hitComponent(schematic: Schematic, p: Point): ComponentInstance | undefined {
  return componentAt(p, schematic.components, 0.15);
}

/** Topmost wire within `tolerance`, with the nearest grid point on it. */
export function hitWire(schematic: Schematic, p: Point, tolerance: number): { id: string; at: Point } | null {
  for (let i = schematic.wires.length - 1; i >= 0; i--) {
    const w = schematic.wires[i];
    if (hitTestWire(p, w, tolerance) < 0) continue;
    const on = pointOnWire(p, w);
    if (on) return { id: w.id, at: on.at };
  }
  return null;
}
