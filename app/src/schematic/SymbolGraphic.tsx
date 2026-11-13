// SVG rendering of @pic/circuit symbols in the ISIS look. Grid units everywhere (the canvas scales the root group).
// Static parts are memoized per component object: an edit re-renders only the parts it replaced.
import { memo, useMemo, type CSSProperties, type ReactElement } from 'react';
import {
  activeLayers, ISIS_COLORS, labelLayout, placeText, svgTransform, symbolFor,
  type ComponentInstance, type Placement, type PlacedText, type Primitive, type SymbolDef, type TextPrimitive,
} from '@pic/circuit';

export const SCHEMATIC_FONT = 'Arial, Helvetica, sans-serif';
const BASELINE = { top: 'hanging', middle: 'central', bottom: 'alphabetic' } as const;
/** ISIS thin line; thicker strokes carry their width in --sw. */
const LINE = 0.08;

type Shape = Exclude<Primitive, { type: 'text' }>;

function strokeStyle(p: { strokeWidth?: number }): CSSProperties | undefined {
  const w = p.strokeWidth;
  return w && Math.abs(w - LINE) > 1e-6 ? ({ '--sw': `${w}px` } as CSSProperties) : undefined;
}

/** One non-text primitive in local symbol coordinates. */
export function shapeElement(p: Shape, key: number | string, opacity = 1): ReactElement {
  const fill = p.fill ?? 'none';
  const stroke = p.stroke ?? 'none';
  const common = { fill, stroke, strokeWidth: p.strokeWidth, style: strokeStyle(p), opacity: opacity < 1 ? opacity : undefined };
  switch (p.type) {
    case 'line':
      return <line key={key} x1={p.from.x} y1={p.from.y} x2={p.to.x} y2={p.to.y} {...common} />;
    case 'rect':
      return <rect key={key} x={p.x} y={p.y} width={p.w} height={p.h} {...common} />;
    case 'circle':
      return <circle key={key} cx={p.center.x} cy={p.center.y} r={p.r} {...common} />;
    case 'arc': {
      const rad = (d: number) => (d * Math.PI) / 180;
      const ax = p.center.x + p.r * Math.cos(rad(p.startDeg));
      const ay = p.center.y + p.r * Math.sin(rad(p.startDeg));
      const bx = p.center.x + p.r * Math.cos(rad(p.endDeg));
      const by = p.center.y + p.r * Math.sin(rad(p.endDeg));
      const large = (((p.endDeg - p.startDeg) % 360) + 360) % 360 > 180 ? 1 : 0;
      return <path key={key} d={`M${ax} ${ay}A${p.r} ${p.r} 0 ${large} 1 ${bx} ${by}`} {...common} />;
    }
    case 'polyline': {
      const pts = p.points.map((q) => `${q.x},${q.y}`).join(' ');
      return p.closed
        ? <polygon key={key} points={pts} {...common} />
        : <polyline key={key} points={pts} {...common} />;
    }
  }
}

/** Upright text at a world position. */
export function textElement(t: PlacedText, text: string, color: string, key: number | string, extra: { overbar?: boolean; bold?: boolean; opacity?: number } = {}): ReactElement {
  return (
    <text
      key={key}
      x={t.at.x}
      y={t.at.y}
      fontSize={t.size}
      textAnchor={t.anchor}
      dominantBaseline={BASELINE[t.baseline]}
      fill={color}
      fontWeight={extra.bold ? 700 : undefined}
      textDecoration={extra.overbar ? 'overline' : undefined}
      opacity={extra.opacity !== undefined && extra.opacity < 1 ? extra.opacity : undefined}
    >
      {text}
    </text>
  );
}

/** Primitives of a symbol layer drawn for a placement: shapes in the transform group, texts upright. */
export function placedPrimitives(prims: readonly Primitive[], placement: Placement, keyPrefix: string, opacity = 1): ReactElement[] {
  const shapes: ReactElement[] = [];
  const texts: ReactElement[] = [];
  prims.forEach((p, i) => {
    if (p.type === 'text') {
      const t = p as TextPrimitive;
      texts.push(textElement(placeText(t, placement), t.text, t.color ?? ISIS_COLORS.text, `${keyPrefix}t${i}`, { overbar: t.overbar, bold: t.bold, opacity }));
    } else {
      shapes.push(shapeElement(p, i, opacity));
    }
  });
  return [<g key={`${keyPrefix}g`} transform={svgTransform(placement)}>{shapes}</g>, ...texts];
}

function labels(c: ComponentInstance, symbol: SymbolDef, placeholders: boolean): ReactElement[] {
  const layout = labelLayout(c);
  const out: ReactElement[] = [];
  if (c.ref) out.push(textElement(layout.ref, c.ref, ISIS_COLORS.text, 'ref'));
  if (symbol.showValue && c.value) out.push(textElement(layout.value, c.value, ISIS_COLORS.text, 'value'));
  if (symbol.showText && placeholders) out.push(textElement(layout.text, '<TEXT>', ISIS_COLORS.placeholder, 'text'));
  return out;
}

export interface ComponentViewProps {
  component: ComponentInstance;
  /** Draw the grey `<TEXT>` placeholder like ISIS (default true). */
  placeholders?: boolean;
  /** Draw the rest state of interactive parts (LOGICSTATE 0/1, released BUTTON, torch position): true when not simulating. */
  rest?: boolean;
  className?: string;
}

/** Body, pins, labels of one part (static). */
export const ComponentView = memo(function ComponentView({ component, placeholders = true, rest = true, className }: ComponentViewProps) {
  const content = useMemo(() => {
    const symbol = symbolFor(component);
    const parts = placedPrimitives(symbol.body, component, 'b');
    if (rest) {
      for (const layer of activeLayers(component)) {
        parts.push(...placedPrimitives(symbol.layers[layer.name] ?? [], component, `l-${layer.name}`, layer.opacity));
      }
    }
    parts.push(...labels(component, symbol, placeholders));
    return parts;
  }, [component, placeholders, rest]);
  return <g className={className} data-id={component.id}>{content}</g>;
});

/** Small preview of a symbol for the palette (fits its bounds). */
export const SymbolThumb = memo(function SymbolThumb({ symbol, size = 36 }: { symbol: SymbolDef; size?: number }) {
  const b = symbol.bounds;
  const pad = 0.6;
  const view = `${b.x - pad} ${b.y - pad} ${b.w + 2 * pad} ${b.h + 2 * pad}`;
  const placement: Placement = { at: { x: 0, y: 0 }, rotation: 0 };
  // Pin names of the PIC are unreadable at this size: shapes only.
  const shapes = symbol.body.filter((p): p is Shape => p.type !== 'text').map((p, i) => shapeElement(p, i));
  return (
    <svg className="symbol-thumb" width={size} height={size} viewBox={view} aria-hidden="true" preserveAspectRatio="xMidYMid meet">
      <g transform={svgTransform(placement)}>{shapes}</g>
    </svg>
  );
});
