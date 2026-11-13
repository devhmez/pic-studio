// Geometric invariants of a laid-out Diagram, shared by the tests. Each check returns a list of human-readable
// problems (empty = OK) so a failure says exactly what is wrong where.
import { FONTS, METRICS, textWidth, type Diagram, type DiagramEdge, type DiagramNode, type Point, type Rect, type TextLine } from '../src';

const EPS = 1e-6;

export const visible = (d: Diagram): DiagramNode[] => d.nodes.filter((n) => n.shape !== 'junction');

export function nodeById(d: Diagram, id: string): DiagramNode {
  const n = d.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
}

const fmtRect = (r: Rect) => `(${r.x.toFixed(1)},${r.y.toFixed(1)} ${r.w.toFixed(1)}×${r.h.toFixed(1)})`;
const fmtPt = (p: Point) => `(${p.x.toFixed(1)},${p.y.toFixed(1)})`;

/** Interiors intersect (shrunk by `inset` on every side). */
export function rectsOverlap(a: Rect, b: Rect, inset = 0.5): boolean {
  return a.x + inset < b.x + b.w - inset && b.x + inset < a.x + a.w - inset
    && a.y + inset < b.y + b.h - inset && b.y + inset < a.y + a.h - inset;
}

/** Connection points of a node: junction point, diamond vertices, or the middles of a rectangle's sides. */
export function ports(n: DiagramNode): Point[] {
  const { x, y, w, h } = n.box;
  if (n.shape === 'junction') return [{ x, y }];
  return [
    { x: x + w / 2, y },
    { x: x + w / 2, y: y + h },
    { x, y: y + h / 2 },
    { x: x + w, y: y + h / 2 },
  ];
}

const samePoint = (a: Point, b: Point) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;

interface Segment {
  a: Point;
  b: Point;
}

const segmentsOf = (e: DiagramEdge): Segment[] => e.points.slice(1).map((b, i) => ({ a: e.points[i], b }));

/** Contact between two axis-aligned segments: none, one point, or a collinear overlap of positive length. */
function contact(s: Segment, t: Segment): { kind: 'none' } | { kind: 'point'; p: Point } | { kind: 'overlap' } {
  const sv = Math.abs(s.a.x - s.b.x) < EPS;
  const tv = Math.abs(t.a.x - t.b.x) < EPS;
  const range = (u: number, v: number) => [Math.min(u, v), Math.max(u, v)] as const;
  if (sv && tv) {
    if (Math.abs(s.a.x - t.a.x) > EPS) return { kind: 'none' };
    const [s0, s1] = range(s.a.y, s.b.y);
    const [t0, t1] = range(t.a.y, t.b.y);
    const len = Math.min(s1, t1) - Math.max(s0, t0);
    if (len > EPS) return { kind: 'overlap' };
    if (len > -EPS) return { kind: 'point', p: { x: s.a.x, y: Math.max(s0, t0) } };
    return { kind: 'none' };
  }
  if (!sv && !tv) {
    if (Math.abs(s.a.y - t.a.y) > EPS) return { kind: 'none' };
    const [s0, s1] = range(s.a.x, s.b.x);
    const [t0, t1] = range(t.a.x, t.b.x);
    const len = Math.min(s1, t1) - Math.max(s0, t0);
    if (len > EPS) return { kind: 'overlap' };
    if (len > -EPS) return { kind: 'point', p: { x: Math.max(s0, t0), y: s.a.y } };
    return { kind: 'none' };
  }
  const v = sv ? s : t;
  const h = sv ? t : s;
  const [vy0, vy1] = range(v.a.y, v.b.y);
  const [hx0, hx1] = range(h.a.x, h.b.x);
  const px = v.a.x;
  const py = h.a.y;
  if (px >= hx0 - EPS && px <= hx1 + EPS && py >= vy0 - EPS && py <= vy1 + EPS) return { kind: 'point', p: { x: px, y: py } };
  return { kind: 'none' };
}

/** Does an axis-aligned segment pass through the interior of `r` (shrunk by `inset`)? */
function segmentHitsRect(s: Segment, r: Rect, inset: number): boolean {
  const x0 = Math.min(s.a.x, s.b.x);
  const x1 = Math.max(s.a.x, s.b.x);
  const y0 = Math.min(s.a.y, s.b.y);
  const y1 = Math.max(s.a.y, s.b.y);
  return x1 > r.x + inset && x0 < r.x + r.w - inset && y1 > r.y + inset && y0 < r.y + r.h - inset;
}

// ---------------------------------------------------------------------------------------------------------------

export function checkBounds(d: Diagram): string[] {
  const out: string[] = [];
  const inside = (r: Rect) => r.x >= -EPS && r.y >= -EPS && r.x + r.w <= d.width + EPS && r.y + r.h <= d.height + EPS;
  for (const n of d.nodes) {
    if (!inside(n.box)) out.push(`node ${n.id} ${fmtRect(n.box)} outside ${d.width}×${d.height}`);
    if (n.label && !inside(n.label.box)) out.push(`label of ${n.id} outside the canvas`);
    if (n.shape !== 'junction' && (n.box.w <= 0 || n.box.h <= 0)) out.push(`node ${n.id} has no size`);
  }
  for (const e of d.edges) {
    for (const p of e.points) if (!inside({ ...p, w: 0, h: 0 })) out.push(`edge ${e.id} point ${fmtPt(p)} outside`);
    if (e.label && !inside(e.label.box)) out.push(`label of ${e.id} outside the canvas`);
  }
  return out;
}

export function checkNoOverlaps(d: Diagram): string[] {
  const out: string[] = [];
  const shapes = visible(d);
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      if (rectsOverlap(shapes[i].box, shapes[j].box, 0)) {
        out.push(`nodes ${shapes[i].id} ${fmtRect(shapes[i].box)} and ${shapes[j].id} ${fmtRect(shapes[j].box)} overlap`);
      }
    }
  }
  const labels = [
    ...d.nodes.filter((n) => n.label).map((n) => ({ owner: n.id, box: n.label!.box, text: n.label!.text })),
    ...d.edges.filter((e) => e.label).map((e) => ({ owner: e.id, box: e.label!.box, text: e.label!.text })),
  ];
  for (const l of labels) {
    for (const n of shapes) {
      if (rectsOverlap(l.box, n.box, 0)) out.push(`label « ${l.text} » of ${l.owner} overlaps node ${n.id}`);
    }
    for (const e of d.edges) {
      for (const s of segmentsOf(e)) {
        if (segmentHitsRect(s, l.box, 1)) out.push(`label « ${l.text} » of ${l.owner} is crossed by edge ${e.id}`);
      }
    }
  }
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      if (rectsOverlap(labels[i].box, labels[j].box, 0)) out.push(`labels « ${labels[i].text} » and « ${labels[j].text} » overlap`);
    }
  }
  return out;
}

export function checkEdges(d: Diagram): string[] {
  const out: string[] = [];
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const shapes = visible(d);
  for (const e of d.edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) {
      out.push(`edge ${e.id} references a missing node`);
      continue;
    }
    if (e.points.length < 2) out.push(`edge ${e.id} has fewer than 2 points`);
    for (const s of segmentsOf(e)) {
      const dx = Math.abs(s.a.x - s.b.x);
      const dy = Math.abs(s.a.y - s.b.y);
      if (dx > EPS && dy > EPS) out.push(`edge ${e.id} has a diagonal segment ${fmtPt(s.a)}→${fmtPt(s.b)}`);
      if (dx < EPS && dy < EPS) out.push(`edge ${e.id} has a zero-length segment at ${fmtPt(s.a)}`);
    }
    for (let i = 2; i < e.points.length; i++) {
      const [a, b, c] = [e.points[i - 2], e.points[i - 1], e.points[i]];
      const straight = (Math.abs(a.x - b.x) < EPS && Math.abs(b.x - c.x) < EPS) || (Math.abs(a.y - b.y) < EPS && Math.abs(b.y - c.y) < EPS);
      if (straight) out.push(`edge ${e.id} has a useless bend at ${fmtPt(b)}`);
    }
    const first = e.points[0];
    const last = e.points[e.points.length - 1];
    if (!ports(from).some((p) => samePoint(p, first))) out.push(`edge ${e.id} does not start on a port of ${from.id}: ${fmtPt(first)}`);
    if (!ports(to).some((p) => samePoint(p, last))) out.push(`edge ${e.id} does not end on a port of ${to.id}: ${fmtPt(last)}`);
    // No edge runs through a shape.
    for (const s of segmentsOf(e)) {
      for (const n of shapes) {
        if (segmentHitsRect(s, n.box, 1)) out.push(`edge ${e.id} crosses node ${n.id}`);
      }
    }
  }
  // Edges meet only at their end points (junctions, shared ports): no crossing, no shared stretch of line.
  for (let i = 0; i < d.edges.length; i++) {
    for (let j = i + 1; j < d.edges.length; j++) {
      const e = d.edges[i];
      const f = d.edges[j];
      const ends = [e.points[0], e.points[e.points.length - 1]];
      const fends = [f.points[0], f.points[f.points.length - 1]];
      for (const s of segmentsOf(e)) {
        for (const t of segmentsOf(f)) {
          const c = contact(s, t);
          if (c.kind === 'overlap') out.push(`edges ${e.id} and ${f.id} share a stretch of line`);
          else if (c.kind === 'point') {
            const ok = ends.some((p) => samePoint(p, c.p)) && fends.some((p) => samePoint(p, c.p));
            if (!ok) out.push(`edges ${e.id} and ${f.id} cross at ${fmtPt(c.p)}`);
          }
        }
      }
    }
  }
  return out;
}

/** Every shape is reachable from Début, and Fin is reachable from every shape (annotations excepted). */
export function checkConnectivity(d: Diagram): string[] {
  const out: string[] = [];
  const nextOf = new Map<string, string[]>();
  const prevOf = new Map<string, string[]>();
  for (const e of d.edges) {
    nextOf.set(e.from, [...(nextOf.get(e.from) ?? []), e.to]);
    prevOf.set(e.to, [...(prevOf.get(e.to) ?? []), e.from]);
  }
  const reach = (start: string, graph: Map<string, string[]>) => {
    const seen = new Set([start]);
    const todo = [start];
    while (todo.length) for (const n of graph.get(todo.pop()!) ?? []) if (!seen.has(n)) { seen.add(n); todo.push(n); }
    return seen;
  };
  const start = d.nodes.find((n) => n.shape === 'start');
  const end = d.nodes.find((n) => n.shape === 'end');
  if (!start || !end) return ['missing start or end'];
  const fromStart = reach(start.id, nextOf);
  const toEnd = reach(end.id, prevOf);
  for (const n of d.nodes) {
    if (n.shape === 'tag' || n.shape === 'title') continue;
    if (!fromStart.has(n.id)) out.push(`${n.id} is not reachable from Début`);
    if (!toEnd.has(n.id)) out.push(`Fin is not reachable from ${n.id}`);
  }
  // Decisions: exactly one `oui` and one `non` exit each.
  for (const n of d.nodes.filter((x) => x.shape === 'decision')) {
    const exits = d.edges.filter((e) => e.from === n.id);
    const labels = exits.map((e) => e.label?.text).filter(Boolean).sort();
    if (exits.length !== 2 || labels.join(',') !== 'non,oui') out.push(`decision ${n.id} exits: ${labels.join(',')} (${exits.length} edges)`);
  }
  return out;
}

const lineW = (l: TextLine, font: DiagramNode['font']) => {
  const f = FONTS[font];
  return textWidth(l.text, l.bold || f.bold ? f.boldFace : f.face, f.size);
};

/** Every text line fits inside its shape, with the layout's own deterministic width estimate. */
export function checkTextFits(d: Diagram): string[] {
  const out: string[] = [];
  for (const n of d.nodes) {
    const f = FONTS[n.font];
    const widths = n.lines.map((l) => lineW(l, n.font));
    const tw = Math.max(0, ...widths);
    const th = n.lines.length * f.lineHeight;
    const { w, h } = n.box;
    switch (n.shape) {
      case 'process':
      case 'subroutine': {
        const bars = n.shape === 'subroutine' ? 2 * METRICS.subroutineBar : 0;
        if (tw > w - 2 * METRICS.padX - bars + EPS) out.push(`${n.id}: text ${tw.toFixed(1)} wider than box ${w}`);
        if (th > h - 2 * METRICS.padY + EPS) out.push(`${n.id}: ${n.lines.length} lines taller than box ${h}`);
        break;
      }
      case 'decision': {
        const fill = (tw / 2 + 4) / (w / 2) + (th / 2 + 1) / (h / 2);
        if (fill > 1 + EPS) out.push(`${n.id}: text « ${n.lines.map((l) => l.text).join(' ')} » sticks out of the diamond (${fill.toFixed(3)})`);
        break;
      }
      case 'tag':
        if (tw > w - METRICS.tagTip - 2 * METRICS.tagPadX + 1) out.push(`${n.id}: tag text too wide`);
        if (th > h + EPS) out.push(`${n.id}: tag text too tall`);
        break;
      case 'start':
      case 'end':
        if (n.lines.length > 0 && tw > w - 2 * METRICS.terminalPadX + EPS) out.push(`${n.id}: terminal text too wide`);
        break;
      case 'title':
        if (tw > w + 1) out.push(`${n.id}: title wider than its box`);
        break;
      case 'junction':
        if (n.lines.length > 0) out.push(`${n.id}: junction with text`);
        break;
    }
  }
  return out;
}

export function allProblems(d: Diagram): string[] {
  return [...checkBounds(d), ...checkNoOverlaps(d), ...checkEdges(d), ...checkConnectivity(d), ...checkTextFits(d)];
}
