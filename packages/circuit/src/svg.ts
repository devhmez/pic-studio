// Standalone SVG rendering of a schematic in the ISIS look (schematic export, thumbnails, visual checks).
import type { CircuitSimulator, ComponentInstance, Point, Schematic } from './api';
import { componentBounds, labelLayout, pinMarker, placeText, svgTransform, type PlacedText } from './geometry';
import { buildNetlist, pinKey, type BuiltNetlist } from './netlist';
import { ISIS_COLORS } from './parts/colors';
import type { Primitive, Rect } from './parts/types';
import { activeLayers, symbolFor } from './symbols';

export interface SvgOptions {
  /** Pixels per grid step (0.1 in). Default 12. */
  pxPerGrid?: number;
  /** Margin around the drawing, in grid steps. Default 3. */
  margin?: number;
  /** Draw the dotted ISIS grid. Default true. */
  grid?: boolean;
  /** Show `<TEXT>` placeholders. Default true. */
  placeholders?: boolean;
  /** Live simulation: draws LED/LOGICSTATE/7-seg states and the red/blue/grey pin squares. */
  simulator?: CircuitSimulator;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => String(Math.round(v * 1000) / 1000);

function paint(p: { stroke?: string; fill?: string; strokeWidth?: number }): string {
  return `fill="${p.fill ?? 'none'}" stroke="${p.stroke ?? 'none'}"${p.strokeWidth ? ` stroke-width="${n(p.strokeWidth)}"` : ''}`;
}

const BASELINE = { top: 'hanging', middle: 'central', bottom: 'alphabetic' } as const;

function textSvg(t: PlacedText, s: string, color: string, overbar = false): string {
  const deco = overbar ? ' text-decoration="overline"' : '';
  return `<text x="${n(t.at.x)}" y="${n(t.at.y)}" font-size="${n(t.size)}" text-anchor="${t.anchor}" `
    + `dominant-baseline="${BASELINE[t.baseline]}" fill="${color}"${deco}>${esc(s)}</text>`;
}

/** Non-text primitives in local coordinates (drawn inside the component's transform group). */
function shapeSvg(p: Exclude<Primitive, { type: 'text' }>, opacity = 1): string {
  const op = opacity < 1 ? ` opacity="${n(opacity)}"` : '';
  switch (p.type) {
    case 'line': return `<line x1="${n(p.from.x)}" y1="${n(p.from.y)}" x2="${n(p.to.x)}" y2="${n(p.to.y)}" ${paint(p)}${op}/>`;
    case 'rect': return `<rect x="${n(p.x)}" y="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}" ${paint(p)}${op}/>`;
    case 'circle': return `<circle cx="${n(p.center.x)}" cy="${n(p.center.y)}" r="${n(p.r)}" ${paint(p)}${op}/>`;
    case 'arc': {
      const rad = (d: number) => (d * Math.PI) / 180;
      const a = { x: p.center.x + p.r * Math.cos(rad(p.startDeg)), y: p.center.y + p.r * Math.sin(rad(p.startDeg)) };
      const b = { x: p.center.x + p.r * Math.cos(rad(p.endDeg)), y: p.center.y + p.r * Math.sin(rad(p.endDeg)) };
      const large = (((p.endDeg - p.startDeg) % 360) + 360) % 360 > 180 ? 1 : 0;
      return `<path d="M${n(a.x)} ${n(a.y)} A${n(p.r)} ${n(p.r)} 0 ${large} 1 ${n(b.x)} ${n(b.y)}" ${paint(p)}${op}/>`;
    }
    case 'polyline': {
      const pts = p.points.map((q) => `${n(q.x)},${n(q.y)}`).join(' ');
      return `<${p.closed ? 'polygon' : 'polyline'} points="${pts}" ${paint(p)}${op}/>`;
    }
  }
}

function primitivesSvg(c: ComponentInstance, prims: readonly Primitive[], opacity = 1): string[] {
  const shapes: string[] = [];
  const texts: string[] = [];
  for (const p of prims) {
    if (p.type === 'text') texts.push(textSvg(placeText(p, c), p.text, p.color ?? ISIS_COLORS.text, p.overbar));
    else shapes.push(shapeSvg(p, opacity));
  }
  return [`<g transform="${svgTransform(c)}">${shapes.join('')}</g>`, ...texts];
}

function levelColor(level: 0 | 1 | 'Z' | 'X'): string {
  return level === 1 ? ISIS_COLORS.pinHigh : level === 0 ? ISIS_COLORS.pinLow : level === 'X' ? ISIS_COLORS.pinContention : ISIS_COLORS.pinFloating;
}

function graphicsSvg(c: ComponentInstance, sim: CircuitSimulator | undefined): string {
  const symbol = symbolFor(c);
  const out: string[] = [...primitivesSvg(c, symbol.body)];
  for (const layer of activeLayers(c, sim?.visual(c.id))) out.push(...primitivesSvg(c, symbol.layers[layer.name] ?? [], layer.opacity));
  return `<g data-id="${esc(c.id)}">${out.join('')}</g>`;
}

function labelsSvg(c: ComponentInstance, placeholders: boolean): string {
  const symbol = symbolFor(c);
  const labels = labelLayout(c);
  const out: string[] = [];
  if (c.ref) out.push(textSvg(labels.ref, c.ref, ISIS_COLORS.text));
  if (symbol.showValue && c.value) out.push(textSvg(labels.value, c.value, ISIS_COLORS.text));
  if (symbol.showText && placeholders) out.push(textSvg(labels.text, '<TEXT>', ISIS_COLORS.placeholder));
  return out.join('');
}

function pinStatesSvg(c: ComponentInstance, sim: CircuitSimulator, nl: BuiltNetlist): string {
  if (c.kind === 'POWER' || c.kind === 'GROUND') return '';
  const out: string[] = [];
  for (const pin of symbolFor(c).pins) {
    const netId = nl.pinToNet.get(pinKey(c.id, pin.name));
    const m = pinMarker(c, pin.name);
    if (pin.hidden || !netId || !m) continue;
    out.push(`<rect x="${n(m.x - 0.2)}" y="${n(m.y - 0.2)}" width="0.4" height="0.4" fill="${levelColor(sim.netLevel(netId))}"/>`);
  }
  return out.join('');
}

function drawingBounds(s: Schematic): Rect {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  const add = (p: Point) => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); };
  for (const c of s.components) {
    const b = componentBounds(c);
    add({ x: b.x, y: b.y });
    add({ x: b.x + b.w + 6, y: b.y + b.h + 2 }); // room for labels on the right / below
    add({ x: b.x, y: b.y - 1.5 });
  }
  for (const w of s.wires) w.points.forEach(add);
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 10, h: 10 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function schematicToSvg(schematic: Schematic, options: SvgOptions = {}): string {
  const opts = { pxPerGrid: options.pxPerGrid ?? 12, margin: options.margin ?? 3, grid: options.grid ?? true, placeholders: options.placeholders ?? true };
  const nl = options.simulator?.netlist as BuiltNetlist | undefined ?? buildNetlist(schematic);
  const b = drawingBounds(schematic);
  const vb = { x: Math.floor(b.x - opts.margin), y: Math.floor(b.y - opts.margin), w: Math.ceil(b.w + 2 * opts.margin), h: Math.ceil(b.h + 2 * opts.margin) };
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" width="${vb.w * opts.pxPerGrid}" height="${vb.h * opts.pxPerGrid}" font-family="Arial, Helvetica, sans-serif">`,
    `<rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="${ISIS_COLORS.background}"/>`,
  ];
  if (opts.grid) {
    parts.push(`<defs><pattern id="g" x="0" y="0" width="1" height="1" patternUnits="userSpaceOnUse"><rect width="0.06" height="0.06" fill="${ISIS_COLORS.grid}"/></pattern></defs>`);
    parts.push(`<rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="url(#g)"/>`);
  }
  for (const w of schematic.wires) {
    parts.push(`<polyline points="${w.points.map((p) => `${n(p.x)},${n(p.y)}`).join(' ')}" fill="none" stroke="${ISIS_COLORS.wire}" stroke-width="0.08"/>`);
  }
  for (const j of nl.junctions) parts.push(`<circle cx="${n(j.x)}" cy="${n(j.y)}" r="0.2" fill="${ISIS_COLORS.wire}"/>`);
  // ISIS draws text and pin-state squares above every graphic.
  for (const c of schematic.components) parts.push(graphicsSvg(c, options.simulator));
  for (const c of schematic.components) parts.push(labelsSvg(c, opts.placeholders));
  const sim = options.simulator;
  if (sim) for (const c of schematic.components) parts.push(pinStatesSvg(c, sim, nl));
  parts.push('</svg>');
  return parts.join('\n');
}
