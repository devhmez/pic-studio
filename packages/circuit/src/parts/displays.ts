// Output displays: 7SEG-BCD (hex decoder, 4 bottom pins), 7SEG-CC (direct common cathode), TRAFFIC LIGHTS.
import type { Point } from '../api';
import { ISIS_COLORS, SEVEN_SEG_COLORS, TRAFFIC_COLORS, type SevenSegColor } from './colors';
import { REF_SIZE, VALUE_SIZE, circle, defineSymbol, label, pin, polygon, pt, rect } from './builders';
import type { Primitive, SymbolDef } from './types';

export type Segment = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g';
export const SEGMENTS: readonly Segment[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

/**
 * Glyphs of the ISIS 7SEG-BCD decoder for 0..15 (decoded from the DSN frames: 0-9 A b C d E F).
 * Bit 0 = segment a ... bit 6 = g.
 */
export const BCD_GLYPHS: readonly number[] = [
  0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f, 0x77, 0x7c, 0x39, 0x5e, 0x79, 0x71,
];

interface DigitBox { x0: number; y0: number; x1: number; y1: number }

/** Slanted 7-segment polygons (ISIS digits lean slightly right) inside a box. */
export function segmentPolygons(box: DigitBox): Record<Segment | 'dp', Point[]> {
  const t = 0.55; // segment thickness
  const gap = 0.08;
  const ym = (box.y0 + box.y1) / 2;
  const slant = 0.12;
  const sk = (p: Point): Point => ({ x: p.x + (ym - p.y) * slant, y: p.y });
  const h = (xa: number, xb: number, y: number): Point[] => [
    pt(xa + gap, y), pt(xa + gap + t / 2, y - t / 2), pt(xb - gap - t / 2, y - t / 2),
    pt(xb - gap, y), pt(xb - gap - t / 2, y + t / 2), pt(xa + gap + t / 2, y + t / 2),
  ].map(sk);
  const v = (x: number, ya: number, yb: number): Point[] => [
    pt(x, ya + gap), pt(x + t / 2, ya + gap + t / 2), pt(x + t / 2, yb - gap - t / 2),
    pt(x, yb - gap), pt(x - t / 2, yb - gap - t / 2), pt(x - t / 2, ya + gap + t / 2),
  ].map(sk);
  const { x0, y0, x1, y1 } = box;
  const r = 0.3;
  const dpx = x1 + 0.6;
  const dp: Point[] = [pt(dpx - r, y1 - r), pt(dpx + r, y1 - r), pt(dpx + r, y1 + r), pt(dpx - r, y1 + r)].map(sk);
  return {
    a: h(x0, x1, y0), b: v(x1, y0, ym), c: v(x1, ym, y1), d: h(x0, x1, y1),
    e: v(x0, ym, y1), f: v(x0, y0, ym), g: h(x0, x1, ym), dp,
  };
}

function segmentGraphics(box: DigitBox, colors: { on: string; off: string }, withDp: boolean) {
  const polys = segmentPolygons(box);
  const names = withDp ? [...SEGMENTS, 'dp' as const] : SEGMENTS;
  const unlit: Primitive[] = names.map((s) => polygon(polys[s], colors.off, null));
  const layers: Record<string, Primitive[]> = {};
  for (const s of names) layers[`seg-${s}`] = [polygon(polys[s], colors.on, null)];
  return { unlit, layers };
}

const SEVEN_SEG_VARIANT: Readonly<Record<SevenSegColor, string>> = {
  RED: '7SEG-BCD', BLUE: '7SEG-BCD-BLUE', GREEN: '7SEG-BCD-GRN',
};

// 7SEG-BCD: origin = top-left of the body (0,0)..(6.5,9.5); short pins at the bottom, E3 (MSB) on the left.
// ISIS names these pins D3..D0; the course calls them E3..E0 (status2026 p.15), which is what we use.
export function sevenSegBcdSymbol(color: SevenSegColor): SymbolDef {
  const c = SEVEN_SEG_COLORS[color];
  const seg = segmentGraphics({ x0: 1.7, y0: 1.3, x1: 4.7, y1: 8.1 }, c, false);
  const bcdPin = (name: string, x: number) => pin({ name, tip: pt(x, 10.5), base: pt(x, 9.5) });
  return defineSymbol({
    kind: '7SEG-BCD',
    isisName: SEVEN_SEG_VARIANT[color],
    refPrefix: '',
    showValue: false,
    showText: false,
    pins: [bcdPin('E3', 1), bcdPin('E2', 2.5), bcdPin('E1', 4), bcdPin('E0', 5.5)],
    body: [rect(0, 0, 6.5, 9.5, c.background), ...seg.unlit],
    layers: seg.layers,
    labels: {
      ref: label(0, -0.3, 'bottom', REF_SIZE),
      value: label(6.9, 0, 'top', VALUE_SIZE),
      text: label(6.9, 1, 'top', VALUE_SIZE),
    },
    actuators: [],
    defaultProps: { color },
  });
}

// 7SEG-CC: direct common-cathode display (status2026 p.12-14): pins a..g top→bottom on the left, dp, K at the bottom.
export function sevenSegCcSymbol(color: SevenSegColor): SymbolDef {
  const c = SEVEN_SEG_COLORS[color];
  const seg = segmentGraphics({ x0: 1.8, y0: 1.5, x1: 4.9, y1: 8.3 }, c, true);
  const names = [...SEGMENTS, 'dp'];
  return defineSymbol({
    kind: '7SEG-CC',
    isisName: '7SEG-COM-CATHODE',
    refPrefix: '',
    showValue: false,
    showText: false,
    pins: [
      ...names.map((name, i) => pin({ name, tip: pt(-1, i + 1), base: pt(0, i + 1) })),
      pin({ name: 'K', tip: pt(4, 11), base: pt(4, 10) }),
    ],
    body: [rect(0, 0, 7, 10, c.background), ...seg.unlit],
    layers: seg.layers,
    labels: {
      ref: label(0, -0.3, 'bottom', REF_SIZE),
      value: label(7.4, 0, 'top', VALUE_SIZE),
      text: label(7.4, 1, 'top', VALUE_SIZE),
    },
    actuators: [],
    defaultProps: { color },
  });
}

// TRAFFIC LIGHTS: body (-2,-5)..(2,5); three lamps; inputs on the left, top = red. ISIS names the pins D0/D1/D2.
export const TRAFFIC_LIGHTS_SYMBOL: SymbolDef = defineSymbol({
  kind: 'TRAFFIC_LIGHTS',
  isisName: 'TRAFFIC LIGHTS',
  refPrefix: '',
  showValue: false,
  showText: false,
  pins: [
    pin({ name: 'R', tip: pt(-4, -3), base: pt(-2, -3) }),
    pin({ name: 'A', tip: pt(-4, 0), base: pt(-2, 0) }),
    pin({ name: 'G', tip: pt(-4, 3), base: pt(-2, 3) }),
  ],
  body: [
    rect(-2, -5, 4, 10, ISIS_COLORS.body),
    circle(0, -3, 1, TRAFFIC_COLORS.red.off),
    circle(0, 0, 1, TRAFFIC_COLORS.amber.off),
    circle(0, 3, 1, TRAFFIC_COLORS.green.off),
  ],
  layers: {
    'red-on': [circle(0, -3, 1, TRAFFIC_COLORS.red.on)],
    'amber-on': [circle(0, 0, 1, TRAFFIC_COLORS.amber.on)],
    'green-on': [circle(0, 3, 1, TRAFFIC_COLORS.green.on)],
  },
  labels: {
    ref: label(-2, -5.3, 'bottom', REF_SIZE),
    value: label(2.4, -5, 'top', VALUE_SIZE),
    text: label(2.4, -4, 'top', VALUE_SIZE),
  },
  actuators: [],
  defaultProps: {},
});
