// Pure schematic edits used by the editor: placing, moving (wires follow), rotating, mirroring, deleting, wiring.
// Every function returns a new Schematic and keeps the unchanged components/wires as the same objects, so the
// memoized symbol views only re-render what really changed.
import {
  buildNetlist, componentBounds, getSymbol, labelLayout, pinTips, pointInsideSegment, pointKey, pointOnSegment, pointsEqual, rotateBy, snap,
  type ComponentInstance, type ComponentKind, type Point, type Schematic, type Wire,
} from '@pic/circuit';

export interface Rect { x: number; y: number; w: number; h: number }

export interface Selection {
  components: readonly string[];
  wires: readonly string[];
}

export const EMPTY_SELECTION: Selection = { components: [], wires: [] };

export const isEmptySelection = (s: Selection): boolean => s.components.length === 0 && s.wires.length === 0;

/** Default id prefix of parts ISIS shows without reference (LOGICSTATE, terminals...). */
const ID_PREFIX: Readonly<Record<ComponentKind, string>> = {
  PIC16F84A: 'U', LED: 'D', LOGICSTATE: 'LS', BUTTON: 'BTN', RES: 'R', '7SEG-BCD': 'SEG', '7SEG-CC': 'SEG',
  TRAFFIC_LIGHTS: 'TL', TORCH_LDR: 'LDR', CAP: 'C', CRYSTAL: 'X', POWER: 'PWR', GROUND: 'GND',
};

function nextFree(prefix: string, used: ReadonlySet<string>): string {
  for (let n = 1; ; n++) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

/** Fresh id and reference for a new part (U1, D3, R2... or '' for unlabelled parts). */
export function nextIdentity(schematic: Schematic, kind: ComponentKind, props: Record<string, string | number> = {}): { id: string; ref: string } {
  const symbol = getSymbol(kind, props);
  const refs = new Set(schematic.components.map((c) => c.ref));
  const ids = new Set(schematic.components.map((c) => c.id));
  const ref = symbol.refPrefix ? nextFree(symbol.refPrefix, refs) : '';
  const id = ref && !ids.has(ref) ? ref : nextFree(ID_PREFIX[kind], ids);
  return { id, ref };
}

export interface PartSpec {
  kind: ComponentKind;
  props?: Record<string, string | number>;
  value?: string;
  rotation?: ComponentInstance['rotation'];
  mirror?: boolean;
}

/** A component instance for `spec` at `at` (not yet in the schematic). */
export function makeComponent(schematic: Schematic, spec: PartSpec, at: Point): ComponentInstance {
  const symbol = getSymbol(spec.kind, spec.props);
  const { id, ref } = nextIdentity(schematic, spec.kind, spec.props);
  const c: ComponentInstance = {
    id,
    kind: spec.kind,
    ref,
    at: { x: at.x, y: at.y },
    rotation: spec.rotation ?? 0,
    props: { ...symbol.defaultProps, ...spec.props },
  };
  const value = spec.value ?? symbol.defaultValue;
  if (value !== undefined) c.value = value;
  if (spec.mirror) c.mirror = true;
  return c;
}

export function addComponent(schematic: Schematic, component: ComponentInstance): Schematic {
  return { ...schematic, components: [...schematic.components, component] };
}

// ------------------------------------------------------------------------------------------------ wires

const key = pointKey;

/**
 * Remove repeated points and interior points lying straight between their neighbours, except where a pin tip sits
 * (pins connect only to wire vertices).
 */
export function simplifyPolyline(points: readonly Point[], keep: ReadonlySet<string> = new Set()): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    if (out.length > 0 && pointsEqual(out[out.length - 1], p)) continue;
    out.push({ x: p.x, y: p.y });
  }
  for (let i = 1; i + 1 < out.length;) {
    const a = out[i - 1];
    const b = out[i];
    const c = out[i + 1];
    const straight = (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y);
    // Only drop a vertex between its neighbours (not a reversal) and never a pin connection point.
    const between = Math.min(a.x, c.x) <= b.x && b.x <= Math.max(a.x, c.x) && Math.min(a.y, c.y) <= b.y && b.y <= Math.max(a.y, c.y);
    if (straight && between && !keep.has(key(b))) out.splice(i, 1);
    else i++;
  }
  return out;
}

/** Orthogonal path from `a` to `b` with one corner ('h': horizontal leg first). Includes both ends. */
export function orthogonalRoute(a: Point, b: Point, first: 'h' | 'v'): Point[] {
  if (a.x === b.x || a.y === b.y) return [a, b];
  const corner = first === 'h' ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
  return [a, corner, b];
}

/**
 * Preview leg of a wire being drawn, from its last vertex to `target`: the first leg follows the pin the wire
 * starts on (or the dominant direction), later legs turn at right angles to the previous segment.
 */
export function draftRoute(draft: { points: readonly Point[]; startDir: 'h' | 'v' | null }, target: Point): Point[] {
  const pts = draft.points;
  const last = pts[pts.length - 1];
  let first: 'h' | 'v';
  if (pts.length >= 2) {
    const prev = pts[pts.length - 2];
    first = prev.y === last.y ? 'v' : 'h';
  } else {
    first = draft.startDir ?? (Math.abs(target.x - last.x) >= Math.abs(target.y - last.y) ? 'h' : 'v');
  }
  return orthogonalRoute(last, target, first);
}

export function nextWireId(schematic: Schematic): string {
  return nextFree('W', new Set(schematic.wires.map((w) => w.id)));
}

/** All visible pin tips of the schematic (keys). */
export function pinPointKeys(components: readonly ComponentInstance[]): Set<string> {
  const out = new Set<string>();
  for (const c of components) for (const p of pinTips(c)) out.add(key(p.at));
  return out;
}

/** Add a wire through `points` (simplified). Returns the schematic unchanged for a wire of zero length. */
export function addWire(schematic: Schematic, points: readonly Point[]): Schematic {
  const pts = simplifyPolyline(points, pinPointKeys(schematic.components));
  if (pts.length < 2) return schematic;
  const wire: Wire = { id: nextWireId(schematic), points: pts };
  return { ...schematic, wires: [...schematic.wires, wire] };
}

/** Nearest point of a wire to `p`, on the grid along the segment, with the index of that segment. */
export function pointOnWire(p: Point, wire: Wire): { at: Point; segment: number; distance: number } | null {
  let best: { at: Point; segment: number; distance: number } | null = null;
  for (let i = 0; i + 1 < wire.points.length; i++) {
    const a = wire.points[i];
    const b = wire.points[i + 1];
    let at: Point;
    if (a.y === b.y) at = { x: Math.min(Math.max(Math.round(p.x), Math.min(a.x, b.x)), Math.max(a.x, b.x)), y: a.y };
    else if (a.x === b.x) at = { x: a.x, y: Math.min(Math.max(Math.round(p.y), Math.min(a.y, b.y)), Math.max(a.y, b.y)) };
    else {
      // Diagonal segment (imported drawing): fall back to the nearest vertex.
      at = Math.hypot(p.x - a.x, p.y - a.y) <= Math.hypot(p.x - b.x, p.y - b.y) ? a : b;
    }
    const distance = Math.hypot(p.x - at.x, p.y - at.y);
    if (!best || distance < best.distance) best = { at, segment: i, distance };
  }
  return best;
}

// ------------------------------------------------------------------------------------------------ rubber band

/** New position of one wire end; keeps the segment next to it horizontal/vertical as it was. */
function moveEnd(points: Point[], end: 'first' | 'last', to: Point): Point[] {
  const n = points.length;
  const i = end === 'first' ? 0 : n - 1;
  const j = end === 'first' ? 1 : n - 2;
  const old = points[i];
  const nb = points[j];
  const out = points.slice();
  out[i] = to;
  if (to.x === old.x && to.y === old.y) return out;
  const horizontal = old.y === nb.y && old.x !== nb.x;
  const vertical = old.x === nb.x && old.y !== nb.y;
  if (n === 2) {
    if (to.x === nb.x || to.y === nb.y) return out;
    // A straight wire becomes a Z that leaves both ends in their original direction.
    if (horizontal || (!vertical && Math.abs(to.x - nb.x) >= Math.abs(to.y - nb.y))) {
      const mx = Math.round((to.x + nb.x) / 2);
      const mid = end === 'first' ? [{ x: mx, y: to.y }, { x: mx, y: nb.y }] : [{ x: mx, y: nb.y }, { x: mx, y: to.y }];
      return end === 'first' ? [to, ...mid, nb] : [nb, ...mid, to];
    }
    const my = Math.round((to.y + nb.y) / 2);
    const mid = end === 'first' ? [{ x: to.x, y: my }, { x: nb.x, y: my }] : [{ x: nb.x, y: my }, { x: to.x, y: my }];
    return end === 'first' ? [to, ...mid, nb] : [nb, ...mid, to];
  }
  if (horizontal) out[j] = { x: nb.x, y: to.y };
  else if (vertical) out[j] = { x: to.x, y: nb.y };
  else {
    // The end coincided with its neighbour (zero-length leg): add a corner.
    out.splice(end === 'first' ? 1 : n - 1, 0, end === 'first' ? { x: nb.x, y: to.y } : { x: to.x, y: nb.y });
  }
  return out;
}

/** Insert corners where a segment became diagonal. */
function orthogonalize(points: Point[]): Point[] {
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = out[out.length - 1];
    const b = points[i];
    if (a.x !== b.x && a.y !== b.y) out.push({ x: b.x, y: a.y });
    out.push(b);
  }
  return out;
}

/**
 * Safe variant of the rubber band for one wire: the old polyline is kept as it is (so whatever was connected along
 * it stays connected) and a new orthogonal leg runs from each old end to the pin's new position. The last leg
 * keeps the direction in which the wire used to reach the pin.
 */
function extendEnds(points: readonly Point[], first: Point | undefined, last: Point | undefined, flip = false): Point[] {
  const leg = (from: Point, prev: Point | undefined, to: Point): Point[] => {
    if (from.x === to.x || from.y === to.y) return [to];
    // Old approach horizontal (prev → from along y = const): turn vertical first, then reach `to` horizontally
    // (`flip`: the other corner).
    const horizontal = (prev !== undefined && prev.y === from.y && prev.x !== from.x) !== flip;
    return [horizontal ? { x: from.x, y: to.y } : { x: to.x, y: from.y }, to];
  };
  let pts = points.slice();
  if (last) pts = [...pts, ...leg(pts[pts.length - 1], pts[pts.length - 2], last)];
  if (first) pts = [...leg(pts[0], pts[1], first).reverse(), ...pts];
  return pts;
}

interface Anchor {
  at: Point;
  vertex: boolean;
  /**
   * Set when the anchor is the free end of another wire joined here in a T (not on a pin): that wire may follow the
   * reshaped wire instead of pinning it to its old route.
   */
  tee?: { wire: string; end: 'first' | 'last' };
}

/** A T-joined wire end to move onto the new route of the wire it joins. */
interface TeeMove { wire: string; end: 'first' | 'last'; from: Point; to: Point }

/** True when `anchor` still connects to a wire running through `points` (see the netlist rules). */
function anchorHolds(anchor: Anchor, points: readonly Point[]): boolean {
  if (points.some((p) => pointsEqual(p, anchor.at))) return true;
  if (anchor.vertex) return false;
  for (let i = 0; i + 1 < points.length; i++) if (pointOnSegment(anchor.at, points[i], points[i + 1])) return true;
  return false;
}

/**
 * Apply pin moves to the wires: `moves` maps an old pin-tip key to its new position. Wires in `translate` move as a
 * whole by `delta`. Other wires keep their shape, only the ends that sat on a moved pin follow it.
 *
 * A move never disconnects anything: when reshaping a wire would leave behind something attached along it (a pin or
 * a wire on one of its corners), the wire keeps its old route and gets an extra leg to the moved pin instead. A
 * wire that only ends on it in a T follows it instead when `dragTees` is set (its end slides along its own last
 * leg onto the new route, as ISIS drags a junction). A moved pin that sat on a corner in the middle of a wire gets
 * a short wire back to it.
 */
function rubberBand(
  schematic: Schematic,
  moves: ReadonlyMap<string, Point>,
  translate: ReadonlySet<string>,
  delta: Point,
  components: ComponentInstance[],
  dragTees: boolean,
): { wires: Wire[]; teeMoves: number } {
  const keep = pinPointKeys(components);
  // Pass 1: the tidy reshape (moving ends drag their neighbouring corner along).
  const reshaped = schematic.wires.map((w) => followPins(w));

  // What stays where it was: pins of parts that did not move, wire ends and corners left in place.
  const fixedPins = new Set<string>();
  const oldPins = new Map<string, Point>();
  for (const c of schematic.components) for (const p of pinTips(c)) oldPins.set(`${c.id}:${p.name}`, p.at);
  for (const c of components) {
    for (const p of pinTips(c)) {
      const before = oldPins.get(`${c.id}:${p.name}`);
      if (before && pointsEqual(before, p.at)) fixedPins.add(key(p.at));
    }
  }
  const stayingPoints = (i: number): Set<string> => {
    const now = new Set(reshaped[i].points.map(key));
    return new Set(schematic.wires[i].points.map(key).filter((k) => now.has(k)));
  };
  const staying = schematic.wires.map((_, i) => stayingPoints(i));

  // Pass 2: check each reshaped wire against what was attached along it; fall back to extending its ends.
  const stubs: Point[][] = [];
  const out: Wire[] = [];
  /** Wires whose two ends now meet (a pin moved onto the far end): [old wire, meeting point]. */
  const collapsed: [Wire, Point][] = [];
  const teeMoves: TeeMove[] = [];
  /** End of wire `w2` sitting at `p`, when nothing else holds it there (no pin): a candidate for a T drag. */
  const freeEnd = (w2: Wire, p: Point): 'first' | 'last' | null => {
    const k = key(p);
    if (keep.has(k) || fixedPins.has(k) || moves.has(k)) return null;
    if (pointsEqual(w2.points[0], p)) return 'first';
    if (pointsEqual(w2.points[w2.points.length - 1], p)) return 'last';
    return null;
  };
  schematic.wires.forEach((w, i) => {
    let next = reshaped[i];
    if (next !== w && !translate.has(w.id) && w.points.length >= 2) {
      const anchors: Anchor[] = [];
      w.points.forEach((v, vi) => {
        const k = key(v);
        const interior = vi > 0 && vi < w.points.length - 1;
        if (fixedPins.has(k)) anchors.push({ at: v, vertex: true });
        else if (interior && moves.has(k)) {
          // A moving pin on a corner in the middle of the wire: keep the corner and link it to the pin.
          anchors.push({ at: v, vertex: true });
          stubs.push(orthogonalRoute(v, moves.get(k)!, 'h'));
        }
        schematic.wires.forEach((w2, j) => {
          if (j === i || !staying[j].has(k) || !w2.points.some((p) => pointsEqual(p, v))) return;
          const end = w2.points.length >= 2 ? freeEnd(w2, v) : null;
          anchors.push(end ? { at: v, vertex: true, tee: { wire: w2.id, end } } : { at: v, vertex: true });
        });
      });
      schematic.wires.forEach((w2, j) => {
        if (j === i || w2.points.length < 2) return;
        for (const e of [w2.points[0], w2.points[w2.points.length - 1]]) {
          if (!staying[j].has(key(e)) || !anchorHolds({ at: e, vertex: false }, w.points)) continue;
          const end = freeEnd(w2, e);
          anchors.push(end ? { at: e, vertex: false, tee: { wire: w2.id, end } } : { at: e, vertex: false });
        }
      });
      const broken = anchors.filter((a) => !anchorHolds(a, next.points));
      // T-joined wires follow the new route when nothing else (a pin, a corner shared with a third wire) holds it.
      const planned = dragTees && broken.every((a) => a.tee)
        ? broken.map((a) => teeTarget(schematic.wires.find((x) => x.id === a.tee!.wire)!, a.tee!.end, next.points))
        : null;
      if (planned && planned.every((t): t is TeeMove => t !== null)) {
        teeMoves.push(...planned);
      } else if (broken.length > 0) {
        const first = moves.get(key(w.points[0]));
        const last = moves.get(key(w.points[w.points.length - 1]));
        const keepHere = new Set([...keep, ...anchors.map((a) => key(a.at))]);
        next = { ...w, points: simplifyPolyline(orthogonalize(extendEnds(w.points, first, last)), keepHere) };
      }
    }
    // A wire whose two ends now meet carries no connection any more.
    if (next.points.length >= 2) out.push(next);
    else if (next.points.length === 1) collapsed.push([w, next.points[0]]);
  });
  // The pin now sits where the vanished wire joined another one in a T: that wire needs a corner there (pins only
  // connect to wire corners).
  for (const [gone, at] of collapsed) {
    const ends = [gone.points[0], gone.points[gone.points.length - 1]];
    out.forEach((w2, k) => {
      const old = schematic.wires.find((x) => x.id === w2.id);
      if (!old || !ends.some((e) => anchorHolds({ at: e, vertex: false }, old.points))) return;
      const seg = w2.points.findIndex((a, vi) => vi + 1 < w2.points.length && pointInsideSegment(at, a, w2.points[vi + 1]));
      if (seg >= 0) out[k] = { ...w2, points: [...w2.points.slice(0, seg + 1), { x: at.x, y: at.y }, ...w2.points.slice(seg + 1)] };
    });
  }
  // Slide the T-joined ends onto the new routes (the wire keeps its shape, its last leg stretches or bends).
  for (const t of teeMoves) {
    const k = out.findIndex((w2) => w2.id === t.wire);
    if (k < 0) continue;
    const pts = out[k].points;
    const at = t.end === 'first' ? pts[0] : pts[pts.length - 1];
    if (!pointsEqual(at, t.from)) continue;
    const moved = simplifyPolyline(orthogonalize(moveEnd(pts.slice(), t.end, t.to)), new Set([...keep, key(t.to)]));
    if (moved.length < 2) continue;
    out[k] = { ...out[k], points: moved };
  }
  const ids = new Set(out.map((w) => w.id));
  for (const pts of stubs) {
    const points = simplifyPolyline(pts, keep);
    if (points.length < 2) continue;
    const id = nextFree('W', ids);
    ids.add(id);
    out.push({ id, points });
  }
  // Planned drags are reported even when one could not be applied: the caller then checks the connections.
  return { wires: out, teeMoves: teeMoves.length };

  function followPins(w: Wire): Wire {
    if (translate.has(w.id)) return { ...w, points: w.points.map((p) => ({ x: p.x + delta.x, y: p.y + delta.y })) };
    if (w.points.length < 2) return w;
    const first = moves.get(key(w.points[0]));
    const last = moves.get(key(w.points[w.points.length - 1]));
    const interiorPin = w.points.some((p, vi) => vi > 0 && vi < w.points.length - 1 && moves.has(key(p)));
    if (!first && !last) return interiorPin ? { ...w } : w;
    let pts = w.points.slice();
    const n = w.points.length;
    if (first && last && first.x - w.points[0].x === delta.x && first.y - w.points[0].y === delta.y
      && last.x - w.points[n - 1].x === delta.x && last.y - w.points[n - 1].y === delta.y) {
      // Both ends move together: the whole wire follows.
      return { ...w, points: pts.map((p) => ({ x: p.x + delta.x, y: p.y + delta.y })) };
    }
    if (first) pts = moveEnd(pts, 'first', first);
    if (last) pts = moveEnd(pts, 'last', last);
    return { ...w, points: simplifyPolyline(orthogonalize(pts), keep) };
  }
}

const between = (v: number, a: number, b: number): boolean => Math.min(a, b) <= v && v <= Math.max(a, b);
const clamp = (v: number, a: number, b: number): number => Math.min(Math.max(v, Math.min(a, b)), Math.max(a, b));

/**
 * Where the free end of `w2` (joined in a T) should land on `route`, the new polyline of the wire it joins: straight
 * along its own last leg, which only stretches or shortens. Null when that leg's line no longer meets the route
 * (or only past the leg's other corner, which would fold the wire back): the joined wire then keeps its old route.
 */
function teeTarget(w2: Wire, end: 'first' | 'last', route: readonly Point[]): TeeMove | null {
  const n = w2.points.length;
  if (n < 2 || route.length < 2) return null;
  const e = end === 'first' ? w2.points[0] : w2.points[n - 1];
  const nb = end === 'first' ? w2.points[1] : w2.points[n - 2];
  const vertical = nb.x === e.x && nb.y !== e.y;
  const horizontal = nb.y === e.y && nb.x !== e.x;
  const candidates: Point[] = [];
  for (let s = 0; s + 1 < route.length; s++) {
    const a = route[s];
    const b = route[s + 1];
    if (vertical) {
      if (a.y === b.y && between(e.x, a.x, b.x)) candidates.push({ x: e.x, y: a.y });
      else if (a.x === b.x && a.x === e.x) candidates.push({ x: e.x, y: clamp(e.y, a.y, b.y) });
    } else if (horizontal) {
      if (a.x === b.x && between(e.y, a.y, b.y)) candidates.push({ x: a.x, y: e.y });
      else if (a.y === b.y && a.y === e.y) candidates.push({ x: clamp(e.x, a.x, b.x), y: e.y });
    }
  }
  // Crossing over the leg's other corner would fold the wire back on itself.
  const folds = (p: Point): boolean => (vertical
    ? Math.sign(p.y - nb.y) !== Math.sign(e.y - nb.y)
    : Math.sign(p.x - nb.x) !== Math.sign(e.x - nb.x));
  const along = candidates
    .filter((p) => !folds(p))
    .sort((p, q) => (Math.abs(p.x - e.x) + Math.abs(p.y - e.y)) - (Math.abs(q.x - e.x) + Math.abs(q.y - e.y)));
  const to = along[0];
  if (!to) return null;
  return { wire: w2.id, end, from: e, to: { x: to.x, y: to.y } };
}

/** Pairs of pins sharing a net (`U1:RA0~D1:A`), to compare the connections of two versions of a drawing. */
function connectionPairs(schematic: Schematic): Set<string> {
  const out = new Set<string>();
  for (const net of buildNetlist(schematic).nets) {
    const pins = net.pins.map((p) => `${p.componentId}:${p.pin}`).sort();
    for (let i = 0; i < pins.length; i++) for (let j = i + 1; j < pins.length; j++) out.add(`${pins[i]}~${pins[j]}`);
  }
  return out;
}


const isOrthogonal = (wires: readonly Wire[]): boolean =>
  wires.every((w) => w.points.every((p, i) => i === 0 || p.x === w.points[i - 1].x || p.y === w.points[i - 1].y));

/** `b` is a corner where the wire turns back on itself: a, b, c on one line and b outside a…c. */
const foldsBack = (a: Point, b: Point, c: Point): boolean =>
  ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) && !(between(b.x, a.x, c.x) && between(b.y, a.y, c.y));

const gridDistance = (a: Point, b: Point): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/**
 * Cut the stretch of `points` that runs back over itself, down to the farthest point of it something still hangs on
 * (`holds`), or entirely. When something hangs there, the fold next to an end is reordered (old route, then the pin
 * as a corner, then on to that point) and a fold in the middle of the wire becomes a short wire of its own, so no
 * stretch is drawn twice. Null when there is nothing to cut.
 */
function trimFolds(
  points: readonly Point[],
  holds: readonly Point[],
  keep: ReadonlySet<string>,
): { points: Point[]; stubs: Point[][] } | null {
  let pts = points.slice();
  const stubs: Point[][] = [];
  const corners = new Set(keep);
  for (let guard = points.length; guard > 0; guard--) {
    const i = pts.findIndex((b, j) => j > 0 && j + 1 < pts.length && foldsBack(pts[j - 1], b, pts[j + 1]));
    if (i < 0) break;
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1];
    // The stretch drawn twice runs from the nearer neighbour to the fold.
    const nearC = gridDistance(b, c) <= gridDistance(b, a);
    const near = nearC ? c : a;
    let hold: Point | null = null;
    for (const h of holds) {
      if (pointsEqual(h, near) || !pointOnSegment(h, near, b)) continue;
      if (!hold || gridDistance(near, h) > gridDistance(near, hold)) hold = h;
    }
    if (!hold) pts.splice(i, 1);
    else if (nearC && i + 2 === pts.length) pts = [...pts.slice(0, i), c, hold];
    else if (!nearC && i === 1) pts = [hold, a, ...pts.slice(i + 1)];
    else {
      pts.splice(i, 1);
      stubs.push([{ x: near.x, y: near.y }, { x: hold.x, y: hold.y }]);
      corners.add(key(near));
    }
    pts = simplifyPolyline(pts, corners);
  }
  return pts.length === points.length && stubs.length === 0 && pts.every((p, k) => pointsEqual(p, points[k]))
    ? null
    : { points: pts, stubs };
}

/**
 * Wires a move made double back over themselves — an extra leg from an old end running back along the segment before
 * it, or a corner left behind by a wire dragged along — trimmed (trimFolds). Such a stub looks like a wire running
 * past the pin, and its abandoned corner can join a pin that lands there. What a trimmed stretch must still reach:
 * pins that did not move, and the corners and ends of other wires that stayed where they were. A wire whose two ends
 * meet once trimmed is dropped. Only the wires the move changed are touched. Returns `wires` itself when nothing was
 * trimmed (the caller checks the connections of the result either way).
 */
function trimFoldBacks(wires: Wire[], schematic: Schematic, components: readonly ComponentInstance[]): Wire[] {
  const original = new Map(schematic.wires.map((w) => [w.id, w]));
  const keep = pinPointKeys(components);
  const fixed: { at: Point; wire: string | null }[] = [];
  const oldPins = new Map<string, Point>();
  for (const c of schematic.components) for (const p of pinTips(c)) oldPins.set(`${c.id}:${p.name}`, p.at);
  for (const c of components) {
    for (const p of pinTips(c)) {
      const was = oldPins.get(`${c.id}:${p.name}`);
      if (was && pointsEqual(was, p.at)) fixed.push({ at: p.at, wire: null });
    }
  }
  for (const w of wires) {
    const old = original.get(w.id);
    if (!old) continue;
    const was = new Set(old.points.map(key));
    for (const p of w.points) if (was.has(key(p))) fixed.push({ at: p, wire: w.id });
  }
  let changed = false;
  const out: Wire[] = [];
  const stubs: Point[][] = [];
  for (const w of wires) {
    const old = original.get(w.id);
    const same = old && old.points.length === w.points.length && old.points.every((p, i) => pointsEqual(p, w.points[i]));
    const cut = same ? null : trimFolds(w.points, fixed.filter((f) => f.wire !== w.id).map((f) => f.at), keep);
    if (!cut) {
      out.push(w);
      continue;
    }
    changed = true;
    if (cut.points.length >= 2) out.push({ ...w, points: cut.points });
    stubs.push(...cut.stubs);
  }
  if (!changed) return wires;
  const ids = new Set(out.map((w) => w.id));
  for (const points of stubs) {
    const id = nextFree('W', ids);
    ids.add(id);
    out.push({ id, points });
  }
  return out;
}

/**
 * Most conservative rubber band: every wire keeps its old route and gets a new leg from each old end to the moved
 * pin (`flip` picks the other corner of the L); pins on a wire corner get a stub; wires moving as a block translate.
 */
function legsOnly(
  schematic: Schematic,
  moves: ReadonlyMap<string, Point>,
  translate: ReadonlySet<string>,
  delta: Point,
  components: ComponentInstance[],
  flip: boolean,
): Wire[] {
  const keep = pinPointKeys(components);
  const out: Wire[] = [];
  const stubs: Point[][] = [];
  for (const w of schematic.wires) {
    if (translate.has(w.id)) { out.push({ ...w, points: w.points.map((p) => ({ x: p.x + delta.x, y: p.y + delta.y })) }); continue; }
    const n = w.points.length;
    if (n < 2) { out.push(w); continue; }
    w.points.forEach((v, vi) => {
      const to = vi > 0 && vi < n - 1 ? moves.get(key(v)) : undefined;
      if (to) stubs.push(orthogonalRoute(v, to, flip ? 'v' : 'h'));
    });
    const first = moves.get(key(w.points[0]));
    const last = moves.get(key(w.points[n - 1]));
    if (!first && !last) { out.push(w); continue; }
    if (first && last && first.x - w.points[0].x === last.x - w.points[n - 1].x && first.y - w.points[0].y === last.y - w.points[n - 1].y) {
      // Both ends move together: the whole wire follows.
      out.push({ ...w, points: w.points.map((p) => ({ x: p.x + first.x - w.points[0].x, y: p.y + first.y - w.points[0].y })) });
      continue;
    }
    const keepHere = new Set([...keep, ...w.points.map(key)]);
    const points = simplifyPolyline(orthogonalize(extendEnds(w.points, first, last, flip)), keepHere);
    if (points.length >= 2) out.push({ ...w, points });
  }
  const ids = new Set(out.map((w) => w.id));
  for (const pts of stubs) {
    const points = simplifyPolyline(pts, keep);
    if (points.length < 2) continue;
    const id = nextFree('W', ids);
    ids.add(id);
    out.push({ id, points });
  }
  return out;
}

/**
 * Wires dragged along: a wire with one end on a moved pin is translated with it, all but its far end, which stays
 * put and gets a corner back (a vertical run next to the PIC moves away with the pins instead of being crossed by
 * them). Only for a pure translation (`delta`); wires with no moved end stay as they are.
 */
function dragAlong(
  schematic: Schematic,
  moves: ReadonlyMap<string, Point>,
  translate: ReadonlySet<string>,
  delta: Point,
  components: ComponentInstance[],
  flip: boolean,
): Wire[] | null {
  if (delta.x === 0 && delta.y === 0) return null;
  const keep = pinPointKeys(components);
  const shift = (p: Point): Point => ({ x: p.x + delta.x, y: p.y + delta.y });
  const out: Wire[] = [];
  for (const w of schematic.wires) {
    const n = w.points.length;
    if (translate.has(w.id)) { out.push({ ...w, points: w.points.map(shift) }); continue; }
    if (n < 2) { out.push(w); continue; }
    if (w.points.some((p, vi) => vi > 0 && vi < n - 1 && moves.has(key(p)))) return null;
    const first = moves.get(key(w.points[0]));
    const last = moves.get(key(w.points[n - 1]));
    if (!first && !last) { out.push(w); continue; }
    const pts = first ? w.points.slice() : w.points.slice().reverse();
    const moved = first ?? last!;
    if (moved.x - pts[0].x !== delta.x || moved.y - pts[0].y !== delta.y) return null;
    if (first && last) { out.push({ ...w, points: w.points.map(shift) }); continue; }
    const far = pts[pts.length - 1];
    const body = pts.slice(0, -1).map(shift);
    const tail = body[body.length - 1];
    const corner = flip ? { x: far.x, y: tail.y } : { x: tail.x, y: far.y };
    const route = tail.x === far.x || tail.y === far.y ? [...body, far] : [...body, corner, far];
    const points = simplifyPolyline(orthogonalize(route), keep);
    if (points.length < 2) continue;
    out.push({ ...w, points: first ? points : points.reverse() });
  }
  return out;
}

/**
 * Connections a move may create: the nets before the move, merged with what the moved pins touch where they land
 * (the drawing with the parts moved and the wires left as they were). Anything else that ends up on one net — a
 * reshaped wire running through another pin or wire end — is a short circuit the student did not ask for.
 */
function allowedNets(schematic: Schematic, components: ComponentInstance[], translate: ReadonlySet<string>, delta: Point): (pin: string) => string {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (c !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; }
    return r;
  };
  const union = (a: string, b: string) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const landed: Schematic = {
    ...schematic, components,
    wires: schematic.wires.map((w) => (translate.has(w.id) ? { ...w, points: w.points.map((p) => ({ x: p.x + delta.x, y: p.y + delta.y })) } : w)),
  };
  for (const s of [schematic, landed]) {
    for (const net of buildNetlist(s).nets) {
      const pins = net.pins.map((p) => `${p.componentId}:${p.pin}`);
      for (let i = 1; i < pins.length; i++) union(pins[0], pins[i]);
    }
  }
  return find;
}

/** True when the drawing joins pins that `allowed` keeps on different nets. */
function shortsIn(schematic: Schematic, allowed: (pin: string) => string): boolean {
  for (const net of buildNetlist(schematic).nets) {
    const pins = net.pins.map((p) => `${p.componentId}:${p.pin}`);
    const root = pins.length ? allowed(pins[0]) : '';
    if (pins.some((p) => allowed(p) !== root)) return true;
  }
  return false;
}

/**
 * Wires after a move, or null when every way of following the parts would join nets that must stay apart (the move
 * is then refused). Candidates, best looking first: the rubber band with T-joined wires dragged along, the rubber
 * band with its own fallback (old route + extra leg where something hung on the wire), old routes + legs with either
 * corner, then the wires dragged along with the part. The first one that keeps every connection, adds none and stays
 * orthogonal wins. A move that would short pins or cut a wire is refused rather than done silently.
 */
function followWires(
  schematic: Schematic,
  moves: ReadonlyMap<string, Point>,
  translate: ReadonlySet<string>,
  delta: Point,
  components: ComponentInstance[],
): Wire[] | null {
  const before = connectionPairs(schematic);
  let allowed: ((pin: string) => string) | null = null;
  const check = (wires: Wire[]): { short: boolean; lost: boolean } => {
    const next = { ...schematic, components, wires };
    allowed ??= allowedNets(schematic, components, translate, delta);
    const short = shortsIn(next, allowed);
    const pairs = connectionPairs(next);
    return { short, lost: [...before].some((p) => !pairs.has(p)) };
  };
  const dragged = rubberBand(schematic, moves, translate, delta, components, true);
  const safe = () => rubberBand(schematic, moves, translate, delta, components, false).wires;
  const candidates: (() => Wire[] | null)[] = [
    ...(dragged.teeMoves > 0 ? [() => dragged.wires] : []),
    dragged.teeMoves > 0 ? safe : () => dragged.wires,
    () => legsOnly(schematic, moves, translate, delta, components, false),
    () => legsOnly(schematic, moves, translate, delta, components, true),
    () => dragAlong(schematic, moves, translate, delta, components, false),
    () => dragAlong(schematic, moves, translate, delta, components, true),
  ];
  const ok = (wires: Wire[]): boolean => {
    const r = check(wires);
    return !r.short && !r.lost;
  };
  // Each candidate with its fold-backs trimmed first; then, as built, those where trimming would cut a connection.
  const untrimmed: Wire[][] = [];
  for (const make of candidates) {
    const wires = make();
    if (!wires || !isOrthogonal(wires)) continue;
    const trimmed = trimFoldBacks(wires, schematic, components);
    if (ok(trimmed)) return trimmed;
    if (trimmed !== wires) untrimmed.push(wires);
  }
  return untrimmed.find(ok) ?? null;
}

function pinMoves(before: readonly ComponentInstance[], after: ReadonlyMap<string, ComponentInstance>): Map<string, Point> {
  const moves = new Map<string, Point>();
  for (const c of before) {
    const next = after.get(c.id);
    if (!next) continue;
    const old = pinTips(c);
    const now = new Map(pinTips(next).map((p) => [p.name, p.at] as const));
    for (const p of old) {
      const to = now.get(p.name);
      if (to) moves.set(key(p.at), to);
    }
  }
  return moves;
}

/** Selected wires that can move as a block: neither end hangs on a pin of a part that stays in place. */
function movableWires(schematic: Schematic, selection: Selection): Set<string> {
  const moving = new Set(selection.components);
  const fixedPins = pinPointKeys(schematic.components.filter((c) => !moving.has(c.id)));
  const out = new Set<string>();
  for (const id of selection.wires) {
    const w = schematic.wires.find((x) => x.id === id);
    if (!w || w.points.length === 0) continue;
    const ends = [w.points[0], w.points[w.points.length - 1]];
    if (ends.every((p) => !fixedPins.has(key(p)))) out.add(id);
  }
  return out;
}

/** Shown when a move / rotation is refused because the wires would join nets that must stay apart. */
export const MOVE_REFUSED_MESSAGE = 'Déplacement impossible à cet endroit : les fils toucheraient d’autres broches (court-circuit) ou se détacheraient. Essayez un peu plus loin, ou redessinez les fils.';
export const ROTATE_REFUSED_MESSAGE = 'Rotation impossible ici : les fils toucheraient d’autres broches (court-circuit) ou se détacheraient. Déplacez d’abord le composant, ou redessinez ses fils.';

/**
 * Move the selection by `delta` grid steps; attached wires stretch (rubber band). Returns `schematic` itself when the
 * move is refused (no way to follow the parts without short-circuiting other pins).
 */
export function moveSelection(schematic: Schematic, selection: Selection, delta: Point): Schematic {
  if ((delta.x === 0 && delta.y === 0) || isEmptySelection(selection)) return schematic;
  const ids = new Set(selection.components);
  const moved = new Map<string, ComponentInstance>();
  const components = schematic.components.map((c) => {
    if (!ids.has(c.id)) return c;
    const next = { ...c, at: { x: c.at.x + delta.x, y: c.at.y + delta.y } };
    moved.set(c.id, next);
    return next;
  });
  const before = schematic.components.filter((c) => ids.has(c.id));
  const wires = followWires(schematic, pinMoves(before, moved), movableWires(schematic, selection), delta, components);
  // Refused (the wires would short pins together): the drawing stays as it was; the editor says why.
  if (!wires) return schematic;
  return { ...schematic, components, wires };
}

function transformSelected(
  schematic: Schematic,
  ids: readonly string[],
  change: (c: ComponentInstance) => ComponentInstance,
): Schematic {
  if (ids.length === 0) return schematic;
  const set = new Set(ids);
  const changed = new Map<string, ComponentInstance>();
  const components = schematic.components.map((c) => {
    if (!set.has(c.id)) return c;
    const next = change(c);
    changed.set(c.id, next);
    return next;
  });
  const before = schematic.components.filter((c) => set.has(c.id));
  const wires = followWires(schematic, pinMoves(before, changed), new Set(), { x: 0, y: 0 }, components);
  if (!wires) return schematic;
  return { ...schematic, components, wires };
}

/** Quarter turn of each selected part about its origin (+90 = clockwise). */
export function rotateComponents(schematic: Schematic, ids: readonly string[], delta = 90): Schematic {
  return transformSelected(schematic, ids, (c) => ({ ...c, rotation: rotateBy(c.rotation, delta) }));
}

/** X-mirror of each selected part (ISIS « miroir »). */
export function mirrorComponents(schematic: Schematic, ids: readonly string[]): Schematic {
  return transformSelected(schematic, ids, (c) => {
    const next = { ...c };
    if (c.mirror) delete next.mirror;
    else next.mirror = true;
    return next;
  });
}

/** Delete the selection, with the wires that were attached to a deleted part. */
export function deleteSelection(schematic: Schematic, selection: Selection): Schematic {
  if (isEmptySelection(selection)) return schematic;
  const ids = new Set(selection.components);
  const wireIds = new Set(selection.wires);
  const removedPins = pinPointKeys(schematic.components.filter((c) => ids.has(c.id)));
  const wires = schematic.wires.filter((w) => {
    if (wireIds.has(w.id)) return false;
    const n = w.points.length;
    return !(n > 0 && (removedPins.has(key(w.points[0])) || removedPins.has(key(w.points[n - 1]))));
  });
  return { ...schematic, components: schematic.components.filter((c) => !ids.has(c.id)), wires };
}

/** Replace one component (properties popover: reference, value, colour, initial state; pins stay in place). */
export function updateComponent(schematic: Schematic, id: string, change: (c: ComponentInstance) => ComponentInstance): Schematic {
  let changed = false;
  const components = schematic.components.map((c) => {
    if (c.id !== id) return c;
    const next = change(c);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...schematic, components } : schematic;
}

// ------------------------------------------------------------------------------------------------ geometry

/** World rectangle covering a part with its labels (approximate text extents). */
export function componentExtent(c: ComponentInstance): Rect {
  const b = componentBounds(c);
  let x0 = b.x;
  let y0 = b.y;
  let x1 = b.x + b.w;
  let y1 = b.y + b.h;
  const labels = labelLayout(c);
  const texts: [typeof labels.ref, string][] = [[labels.ref, c.ref], [labels.value, c.value ?? '']];
  for (const [t, s] of texts) {
    if (!s) continue;
    const w = s.length * t.size * 0.6;
    const left = t.anchor === 'start' ? t.at.x : t.anchor === 'end' ? t.at.x - w : t.at.x - w / 2;
    const top = t.baseline === 'top' ? t.at.y : t.baseline === 'bottom' ? t.at.y - t.size : t.at.y - t.size / 2;
    x0 = Math.min(x0, left);
    x1 = Math.max(x1, left + w);
    y0 = Math.min(y0, top);
    y1 = Math.max(y1, top + t.size);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Bounding box of the whole drawing, or null when it is empty. */
export function schematicExtent(schematic: Schematic): Rect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of schematic.components) {
    const r = componentExtent(c);
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  for (const w of schematic.wires) {
    for (const p of w.points) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

const inside = (p: Point, r: Rect): boolean => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

/** Parts whose body lies entirely in `r`, wires whose every vertex does (marquee selection). */
export function selectInRect(schematic: Schematic, r: Rect): Selection {
  const components = schematic.components
    .filter((c) => {
      const b = componentBounds(c);
      return inside({ x: b.x, y: b.y }, r) && inside({ x: b.x + b.w, y: b.y + b.h }, r);
    })
    .map((c) => c.id);
  const wires = schematic.wires.filter((w) => w.points.every((p) => inside(p, r))).map((w) => w.id);
  return { components, wires };
}

/** Normalized rectangle between two corners. */
export function rectFrom(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** Snap to the 0.1 in grid. */
export const snapToGrid = (p: Point): Point => snap(p, 1);

/** Copy of the selection's parts and wires shifted by `offset` with fresh ids (duplicate, ⌘D). */
export function duplicateSelection(schematic: Schematic, selection: Selection, offset: Point): { schematic: Schematic; selection: Selection } {
  let s = schematic;
  const newComponents: string[] = [];
  for (const id of selection.components) {
    const c = schematic.components.find((x) => x.id === id);
    if (!c || c.kind === 'PIC16F84A') continue;
    const { id: nid, ref } = nextIdentity(s, c.kind, c.props);
    const copy: ComponentInstance = { ...c, id: nid, ref: c.ref ? ref : '', at: { x: c.at.x + offset.x, y: c.at.y + offset.y }, props: { ...c.props } };
    s = addComponent(s, copy);
    newComponents.push(nid);
  }
  const newWires: string[] = [];
  for (const id of selection.wires) {
    const w = schematic.wires.find((x) => x.id === id);
    if (!w) continue;
    const wid = nextWireId(s);
    s = { ...s, wires: [...s.wires, { id: wid, points: w.points.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y })) }] };
    newWires.push(wid);
  }
  return { schematic: s, selection: { components: newComponents, wires: newWires } };
}
