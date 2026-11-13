// Connectivity by coordinates, as ISIS does it:
// - a pin tip connects to a wire when it coincides with one of the wire's vertices (not with a segment interior);
// - two wires connect when they share a vertex, or when an endpoint of one lies on a segment of the other (T-join);
// - pin tips that coincide connect directly;
// - every POWER terminal is on the global VDD rail and every GROUND terminal on the global GND rail.
import type { ComponentInstance, Net, Netlist, PinRef, Point, Schematic, Wire } from './api';
import { pinTips, pointInsideSegment, pointKey, pointOnSegment, pointsEqual } from './geometry';
import { UnionFind } from './union-find';

export interface BuiltNetlist extends Netlist {
  /** wire id → net id. */
  wireToNet: Map<string, string>;
  /** Points where ISIS draws a junction dot (three or more wire arms / pins meet). */
  junctions: Point[];
}

export const pinKey = (componentId: string, pin: string): string => `${componentId}:${pin}`;

const RAIL_VDD = 'rail:VDD';
const RAIL_GND = 'rail:GND';

interface PlacedPinRef extends PinRef { at: Point }

function placedPins(components: readonly ComponentInstance[]): PlacedPinRef[] {
  const out: PlacedPinRef[] = [];
  for (const c of components) for (const p of pinTips(c)) out.push({ componentId: c.id, pin: p.name, at: p.at });
  return out;
}

function segments(w: Wire): [Point, Point][] {
  const out: [Point, Point][] = [];
  for (let i = 0; i + 1 < w.points.length; i++) out.push([w.points[i], w.points[i + 1]]);
  return out;
}

function endpoints(w: Wire): Point[] {
  if (w.points.length === 0) return [];
  if (w.points.length === 1) return [w.points[0]];
  return [w.points[0], w.points[w.points.length - 1]];
}

function onAnySegment(p: Point, w: Wire): boolean {
  return segments(w).some(([a, b]) => pointOnSegment(p, a, b));
}

export function buildNetlist(schematic: Schematic): BuiltNetlist {
  const uf = new UnionFind();
  const pins = placedPins(schematic.components);
  const kindOf = new Map(schematic.components.map((c) => [c.id, c.kind] as const));

  for (const p of pins) {
    const key = `pin:${pinKey(p.componentId, p.pin)}`;
    uf.union(key, `pt:${pointKey(p.at)}`);
    const kind = kindOf.get(p.componentId);
    if (kind === 'POWER') uf.union(key, RAIL_VDD);
    if (kind === 'GROUND') uf.union(key, RAIL_GND);
  }
  for (const w of schematic.wires) {
    uf.id(`wire:${w.id}`);
    for (const v of w.points) uf.union(`wire:${w.id}`, `pt:${pointKey(v)}`);
  }
  for (const w of schematic.wires) {
    for (const e of endpoints(w)) {
      for (const w2 of schematic.wires) {
        if (w2 !== w && onAnySegment(e, w2)) uf.union(`wire:${w.id}`, `wire:${w2.id}`);
      }
    }
  }

  // Name nets in component/pin order: rails get 'VDD' / 'GND' (a VDD-GND short keeps 'VDD'), the others N1, N2...
  const vddRoot = uf.find(RAIL_VDD);
  const gndRoot = uf.find(RAIL_GND);
  const netOfRoot = new Map<number, Net>();
  const nets: Net[] = [];
  let counter = 0;
  const netFor = (root: number): Net => {
    let net = netOfRoot.get(root);
    if (!net) {
      const rail = root === vddRoot ? 'VDD' : root === gndRoot ? 'GND' : undefined;
      net = rail ? { id: rail, pins: [], rail } : { id: `N${++counter}`, pins: [] };
      netOfRoot.set(root, net);
      nets.push(net);
    }
    return net;
  };

  const pinToNet = new Map<string, string>();
  for (const p of pins) {
    const net = netFor(uf.find(`pin:${pinKey(p.componentId, p.pin)}`));
    net.pins.push({ componentId: p.componentId, pin: p.pin });
    pinToNet.set(pinKey(p.componentId, p.pin), net.id);
  }
  const wireToNet = new Map<string, string>();
  for (const w of schematic.wires) wireToNet.set(w.id, netFor(uf.find(`wire:${w.id}`)).id);

  return { nets, pinToNet, wireToNet, dangling: findDangling(schematic.wires, pins), junctions: findJunctions(schematic.wires, pins) };
}

/** Wire endpoints that touch no pin tip, no other wire vertex and no other wire segment. */
export function findDangling(wires: readonly Wire[], pins: readonly { at: Point }[]): Point[] {
  const pinPoints = new Set(pins.map((p) => pointKey(p.at)));
  const out: Point[] = [];
  for (const w of wires) {
    for (const e of endpoints(w)) {
      if (pinPoints.has(pointKey(e))) continue;
      if (wires.some((w2) => w2 !== w && onAnySegment(e, w2))) continue;
      out.push(e);
    }
  }
  return out;
}

/** Junction dots: vertices where wire arms (+ pin tips) number three or more. */
export function findJunctions(wires: readonly Wire[], pins: readonly { at: Point }[]): Point[] {
  const seen = new Set<string>();
  const out: Point[] = [];
  for (const w of wires) {
    for (const v of w.points) {
      const key = pointKey(v);
      if (seen.has(key)) continue;
      seen.add(key);
      let arms = pins.filter((p) => pointsEqual(p.at, v)).length;
      for (const w2 of wires) {
        for (const [a, b] of segments(w2)) {
          if (pointsEqual(v, a) || pointsEqual(v, b)) arms += 1;
          else if (pointInsideSegment(v, a, b)) arms += 2;
        }
      }
      if (arms >= 3) out.push(v);
    }
  }
  return out;
}

/** Pins of a net as "ref.pin" strings (handy for reports and the wiring sheet). */
export function describeNet(net: Net, components: readonly ComponentInstance[]): string[] {
  const byId = new Map(components.map((c) => [c.id, c] as const));
  return net.pins.map((p) => `${byId.get(p.componentId)?.ref || p.componentId}.${p.pin}`);
}
