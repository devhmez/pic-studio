// Small helpers shared by the part definitions.
import type { Point } from '../api';
import { ISIS_COLORS } from './colors';
import type { LabelSpec, Primitive, Rect, SymbolDef, SymbolPin, TextAnchor, TextBaseline } from './types';

/** ISIS thin line width in grid units. */
export const LINE = 0.08;
export const REF_SIZE = 1.0;
export const VALUE_SIZE = 0.75;
export const PIN_NAME_SIZE = 0.7;
export const PIN_NUMBER_SIZE = 0.65;

export const pt = (x: number, y: number): Point => ({ x, y });

export function line(x1: number, y1: number, x2: number, y2: number, stroke: string = ISIS_COLORS.outline): Primitive {
  return { type: 'line', from: pt(x1, y1), to: pt(x2, y2), stroke, strokeWidth: LINE };
}

export function rect(x: number, y: number, w: number, h: number, fill?: string, stroke: string = ISIS_COLORS.outline): Primitive {
  return { type: 'rect', x, y, w, h, fill, stroke, strokeWidth: LINE };
}

export function circle(cx: number, cy: number, r: number, fill?: string, stroke: string = ISIS_COLORS.outline): Primitive {
  return { type: 'circle', center: pt(cx, cy), r, fill, stroke, strokeWidth: LINE };
}

/** Closed polygon; pass `stroke: null` for a fill-only shape (7-segment bars, light beams). */
export function polygon(points: Point[], fill?: string, stroke: string | null = ISIS_COLORS.outline): Primitive {
  return stroke === null
    ? { type: 'polyline', points, closed: true, fill }
    : { type: 'polyline', points, closed: true, fill, stroke, strokeWidth: LINE };
}

export function polyline(points: Point[], stroke: string = ISIS_COLORS.outline): Primitive {
  return { type: 'polyline', points, stroke, strokeWidth: LINE };
}

export function text(
  x: number, y: number, s: string, size: number,
  anchor: TextAnchor = 'start', baseline: TextBaseline = 'middle', color: string = ISIS_COLORS.text,
): Primitive {
  return { type: 'text', at: pt(x, y), text: s, size, anchor, baseline, color };
}

export function label(x: number, y: number, baseline: TextBaseline, size: number, anchor: TextAnchor = 'start'): LabelSpec {
  return { at: pt(x, y), anchor, baseline, size };
}

interface PinSpec {
  name: string;
  number?: number;
  tip: Point;
  base: Point;
  hidden?: boolean;
  showName?: boolean;
  showNumber?: boolean;
  overbar?: boolean;
}

/**
 * The pin-state square sits on the pin, a little away from the body, offset to the side
 * (above horizontal pins, right of vertical pins), as in the prof's ISIS captures.
 */
function markerFor(tip: Point, base: Point): Point {
  const dx = tip.x - base.x;
  const dy = tip.y - base.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: tip.x + 0.4, y: tip.y };
  const along = Math.min(0.5, len / 2);
  const ux = dx / len;
  const uy = dy / len;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  return {
    x: base.x + ux * along + (horizontal ? 0 : 0.35),
    y: base.y + uy * along + (horizontal ? -0.35 : 0),
  };
}

export function pin(spec: PinSpec): SymbolPin {
  return { ...spec, marker: markerFor(spec.tip, spec.base) };
}

/** Pin lines (plus IC pin names/numbers) to append to a body. Hidden pins and zero-length terminal pins draw nothing. */
export function pinGraphics(pins: readonly SymbolPin[]): Primitive[] {
  const out: Primitive[] = [];
  for (const p of pins) {
    if (p.hidden) continue;
    if (p.tip.x !== p.base.x || p.tip.y !== p.base.y) out.push(line(p.base.x, p.base.y, p.tip.x, p.tip.y));
    const pointsRight = p.tip.x > p.base.x;
    if (p.showName) {
      const inset = 0.4;
      const x = pointsRight ? p.base.x - inset : p.base.x + inset;
      out.push({
        type: 'text', at: pt(x, p.base.y), text: p.name, size: PIN_NAME_SIZE,
        anchor: pointsRight ? 'end' : 'start', baseline: 'middle', color: ISIS_COLORS.text, overbar: p.overbar,
      });
    }
    if (p.showNumber && p.number !== undefined) {
      const mid = (p.base.x + p.tip.x) / 2;
      out.push(text(mid, p.base.y - 0.1, String(p.number), PIN_NUMBER_SIZE, 'middle', 'bottom'));
    }
  }
  return out;
}

function extend(r: { x0: number; y0: number; x1: number; y1: number }, x: number, y: number): void {
  r.x0 = Math.min(r.x0, x); r.y0 = Math.min(r.y0, y);
  r.x1 = Math.max(r.x1, x); r.y1 = Math.max(r.y1, y);
}

/** Bounding box of the graphics (text excluded) and visible pin tips. */
export function computeBounds(prims: readonly Primitive[], pins: readonly SymbolPin[]): Rect {
  const r = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const p of prims) {
    switch (p.type) {
      case 'line': extend(r, p.from.x, p.from.y); extend(r, p.to.x, p.to.y); break;
      case 'rect': extend(r, p.x, p.y); extend(r, p.x + p.w, p.y + p.h); break;
      case 'circle':
      case 'arc': extend(r, p.center.x - p.r, p.center.y - p.r); extend(r, p.center.x + p.r, p.center.y + p.r); break;
      case 'polyline': for (const q of p.points) extend(r, q.x, q.y); break;
      case 'text': break;
    }
  }
  for (const p of pins) if (!p.hidden) extend(r, p.tip.x, p.tip.y);
  if (!Number.isFinite(r.x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0 };
}

type SymbolInput = Omit<SymbolDef, 'bounds' | 'body'> & { body: Primitive[] };

/** Finish a symbol: append pin graphics to the body and compute bounds over body + layers. */
export function defineSymbol(input: SymbolInput): SymbolDef {
  const body = [...input.body, ...pinGraphics(input.pins)];
  const all = [...body, ...Object.values(input.layers).flat()];
  return { ...input, body, bounds: computeBounds(all, input.pins) };
}
