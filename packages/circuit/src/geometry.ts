// Placement transforms, snapping and hit-testing. Grid units, Y axis DOWN.
//
// Convention: a component's local point p maps to world as  at + R(rotation) · M · p, where
//   M = mirror ? flip X : identity           (applied first, like the ISIS X-mirror bit)
//   R = clockwise rotation on screen        (the same sense as SVG `rotate()`)
// so `svgTransform()` is literally `translate(at) rotate(rotation) scale(mirror ? -1 : 1, 1)`.
import type { ComponentInstance, Point, Wire } from './api';
import { symbolFor } from './symbols';
import type { Actuator, LabelSpec, Primitive, Rect, SymbolDef, TextAnchor, TextBaseline, TextPrimitive } from './parts/types';

export type Rotation = ComponentInstance['rotation'];
export type Placement = Pick<ComponentInstance, 'at' | 'rotation' | 'mirror'>;

const EPS = 1e-6;

/** Round away floating-point noise (coordinates are multiples of 0.5 grid in practice). */
export function clean(v: number): number {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

export function normalizeRotation(deg: number): Rotation {
  const r = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return r as Rotation;
}

/** Rotate a placement by a quarter turn (+90 = clockwise on screen). */
export function rotateBy(rotation: Rotation, delta: number): Rotation {
  return normalizeRotation(rotation + delta);
}

/** Apply mirror + rotation (no translation) to a local vector. */
export function transformVector(v: Point, rotation: Rotation, mirror = false): Point {
  const x = mirror ? -v.x : v.x;
  const y = v.y;
  switch (rotation) {
    case 0: return { x: clean(x), y: clean(y) };
    case 90: return { x: clean(-y), y: clean(x) };
    case 180: return { x: clean(-x), y: clean(-y) };
    case 270: return { x: clean(y), y: clean(-x) };
  }
}

export function transformPoint(local: Point, placement: Placement): Point {
  const v = transformVector(local, placement.rotation, placement.mirror);
  return { x: clean(placement.at.x + v.x), y: clean(placement.at.y + v.y) };
}

/** World point → local symbol coordinates (inverse of transformPoint). */
export function inverseTransformPoint(world: Point, placement: Placement): Point {
  const dx = world.x - placement.at.x;
  const dy = world.y - placement.at.y;
  let x: number; let y: number;
  switch (placement.rotation) {
    case 0: x = dx; y = dy; break;
    case 90: x = dy; y = -dx; break;
    case 180: x = -dx; y = -dy; break;
    case 270: x = -dy; y = dx; break;
  }
  return { x: clean(placement.mirror ? -x : x), y: clean(y) };
}

export function transformRect(r: Rect, placement: Placement): Rect {
  const a = transformPoint({ x: r.x, y: r.y }, placement);
  const b = transformPoint({ x: r.x + r.w, y: r.y + r.h }, placement);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** SVG transform attribute reproducing transformPoint (multiply by the grid pitch outside). */
export function svgTransform(placement: Placement): string {
  const parts = [`translate(${placement.at.x} ${placement.at.y})`];
  if (placement.rotation !== 0) parts.push(`rotate(${placement.rotation})`);
  if (placement.mirror) parts.push('scale(-1 1)');
  return parts.join(' ');
}

export function snap(p: Point, step = 1): Point {
  return { x: clean(Math.round(p.x / step) * step), y: clean(Math.round(p.y / step) * step) };
}

export function pointsEqual(a: Point, b: Point, eps = EPS): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
}

/** Stable map key for a coordinate (micro-grid precision). */
export function pointKey(p: Point): string {
  return `${Math.round(p.x * 1e6)},${Math.round(p.y * 1e6)}`;
}

/** True when p lies on the closed segment [a, b]. */
export function pointOnSegment(p: Point, a: Point, b: Point, eps = EPS): boolean {
  return distanceToSegment(p, a, b) <= eps;
}

/** True when p lies on [a, b] but is neither endpoint. */
export function pointInsideSegment(p: Point, a: Point, b: Point, eps = EPS): boolean {
  return pointOnSegment(p, a, b, eps) && !pointsEqual(p, a, eps) && !pointsEqual(p, b, eps);
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export interface PlacedPin { name: string; at: Point }

/** World positions of the visible pin tips of a component. */
export function pinTips(component: ComponentInstance): PlacedPin[] {
  return symbolFor(component).pins
    .filter((p) => !p.hidden)
    .map((p) => ({ name: p.name, at: transformPoint(p.tip, component) }));
}

export function pinTip(component: ComponentInstance, pinName: string): Point | undefined {
  const p = symbolFor(component).pins.find((q) => q.name === pinName && !q.hidden);
  return p ? transformPoint(p.tip, component) : undefined;
}

/** World pin-state square centre for a pin (red/blue/grey marker). */
export function pinMarker(component: ComponentInstance, pinName: string): Point | undefined {
  const p = symbolFor(component).pins.find((q) => q.name === pinName && !q.hidden);
  return p ? transformPoint(p.marker, component) : undefined;
}

/** World bounding box of the component graphics (labels excluded). */
export function componentBounds(component: ComponentInstance, symbol: SymbolDef = symbolFor(component)): Rect {
  return transformRect(symbol.bounds, component);
}

function inRect(p: Point, r: Rect, margin: number): boolean {
  return p.x >= r.x - margin && p.x <= r.x + r.w + margin && p.y >= r.y - margin && p.y <= r.y + r.h + margin;
}

export function hitTestComponent(p: Point, component: ComponentInstance, margin = 0.2): boolean {
  return inRect(p, componentBounds(component), margin);
}

/** Topmost component under the point (last drawn wins), or undefined. */
export function componentAt(p: Point, components: readonly ComponentInstance[], margin = 0.2): ComponentInstance | undefined {
  for (let i = components.length - 1; i >= 0; i--) if (hitTestComponent(p, components[i], margin)) return components[i];
  return undefined;
}

/** Index of the wire segment within `tolerance` of p, or -1. */
export function hitTestWire(p: Point, wire: Wire, tolerance = 0.3): number {
  for (let i = 0; i + 1 < wire.points.length; i++) {
    if (distanceToSegment(p, wire.points[i], wire.points[i + 1]) <= tolerance) return i;
  }
  return -1;
}

/** Pin whose tip is within `tolerance` of p (for starting/ending a wire), or undefined. */
export function hitTestPin(p: Point, component: ComponentInstance, tolerance = 0.4): string | undefined {
  let best: string | undefined;
  let bestD = tolerance;
  for (const pin of pinTips(component)) {
    const d = Math.hypot(pin.at.x - p.x, pin.at.y - p.y);
    if (d <= bestD) { best = pin.name; bestD = d; }
  }
  return best;
}

/** Click target (LOGICSTATE box, BUTTON cap, TORCH +/-) under p, if any. */
export function hitTestActuator(p: Point, component: ComponentInstance): Actuator | undefined {
  for (const a of symbolFor(component).actuators) {
    const c = transformPoint(a.center, component);
    if (Math.hypot(c.x - p.x, c.y - p.y) <= a.r) return a;
  }
  return undefined;
}

export interface PlacedText {
  at: Point;
  anchor: TextAnchor;
  baseline: TextBaseline;
  size: number;
}

/** Text stays upright: move its anchor with the component and flip its justification when the axes flip. */
export function placeText(prim: Pick<TextPrimitive, 'at' | 'anchor' | 'baseline' | 'size'>, placement: Placement): PlacedText {
  const ex = transformVector({ x: 1, y: 0 }, placement.rotation, placement.mirror);
  const ey = transformVector({ x: 0, y: 1 }, placement.rotation, placement.mirror);
  const anchor: TextAnchor = ex.x < 0 ? ({ start: 'end', middle: 'middle', end: 'start' } as const)[prim.anchor] : prim.anchor;
  const baseline: TextBaseline = ey.y < 0 ? ({ top: 'bottom', middle: 'middle', bottom: 'top' } as const)[prim.baseline] : prim.baseline;
  return { at: transformPoint(prim.at, placement), anchor, baseline, size: prim.size };
}

/** All body primitives in world coordinates (text kept upright), ready to draw. */
export function placePrimitives(prims: readonly Primitive[], placement: Placement): Primitive[] {
  return prims.map((p): Primitive => {
    switch (p.type) {
      case 'line': return { ...p, from: transformPoint(p.from, placement), to: transformPoint(p.to, placement) };
      case 'rect': return { ...p, ...transformRect(p, placement) };
      case 'circle': return { ...p, center: transformPoint(p.center, placement) };
      case 'arc': {
        // Mirror reverses the sweep; rotation adds to both angles.
        const s = placement.mirror ? 180 - p.endDeg : p.startDeg;
        const e = placement.mirror ? 180 - p.startDeg : p.endDeg;
        return { ...p, center: transformPoint(p.center, placement), startDeg: s + placement.rotation, endDeg: e + placement.rotation };
      }
      case 'polyline': return { ...p, points: p.points.map((q) => transformPoint(q, placement)) };
      case 'text': return { ...p, ...placeText(p, placement) };
    }
  });
}

export interface LabelLayout {
  ref: PlacedText;
  value: PlacedText;
  text: PlacedText;
}

/**
 * Where to print the reference / value / `<TEXT>` lines. Unrotated parts use the ISIS offsets of the symbol
 * (mirrored, with flipped justification, when X-mirrored); rotated parts get their labels stacked to the right of a
 * vertical body, or above/below a horizontal one, which is what ISIS does after a rotation.
 */
export function labelLayout(component: ComponentInstance): LabelLayout {
  const symbol = symbolFor(component);
  const { labels } = symbol;
  if (component.rotation === 0) {
    // Unrotated (possibly X-mirrored, like the prof's LOGICSTATEs): the ISIS offsets, mirrored with flipped justification.
    const place = (l: LabelSpec): PlacedText => placeText(l, component);
    return { ref: place(labels.ref), value: place(labels.value), text: place(labels.text) };
  }
  const b = componentBounds(component, symbol);
  if (b.h > b.w) {
    const x = clean(b.x + b.w + 0.4);
    const y0 = b.y + b.h / 2 - 1.3;
    return {
      ref: { at: { x, y: clean(y0) }, anchor: 'start', baseline: 'top', size: labels.ref.size },
      value: { at: { x, y: clean(y0 + 1.2) }, anchor: 'start', baseline: 'top', size: labels.value.size },
      text: { at: { x, y: clean(y0 + 2.1) }, anchor: 'start', baseline: 'top', size: labels.text.size },
    };
  }
  return {
    ref: { at: { x: b.x, y: clean(b.y - 0.3) }, anchor: 'start', baseline: 'bottom', size: labels.ref.size },
    value: { at: { x: b.x, y: clean(b.y + b.h + 0.3) }, anchor: 'start', baseline: 'top', size: labels.value.size },
    text: { at: { x: b.x, y: clean(b.y + b.h + 1.2) }, anchor: 'start', baseline: 'top', size: labels.text.size },
  };
}
