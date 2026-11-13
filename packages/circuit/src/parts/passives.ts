// Passive parts: RES, TORCH_LDR (torch + light dependent resistor), CAP, CRYSTAL.
import { ISIS_COLORS } from './colors';
import { LINE, REF_SIZE, VALUE_SIZE, circle, defineSymbol, label, line, pin, polygon, polyline, pt, rect } from './builders';
import type { Primitive, SymbolDef } from './types';

// RES: horizontal box, origin not centred (decoded): pin 1 tip (-2,0), pin 2 tip (3,0).
export const RES_SYMBOL: SymbolDef = defineSymbol({
  kind: 'RES',
  isisName: 'RES',
  refPrefix: 'R',
  showValue: true,
  showText: true,
  pins: [
    pin({ name: '1', tip: pt(-2, 0), base: pt(-1, 0) }),
    pin({ name: '2', tip: pt(3, 0), base: pt(2, 0) }),
  ],
  body: [rect(-1, -0.4, 3, 0.8, ISIS_COLORS.body)],
  layers: {},
  labels: {
    ref: label(-1.08, -0.48, 'bottom', REF_SIZE),
    value: label(-1.08, 0.48, 'top', VALUE_SIZE),
    text: label(-1.08, 1.28, 'top', VALUE_SIZE),
  },
  actuators: [],
  defaultValue: '10k',
  defaultProps: {},
});

/** Resistance of the ORP-12 model for each torch level (TORCH_LDR defaults, from the DSN). */
export const LDR_LEVEL_OHMS: readonly number[] = [1e6, 200e3, 100e3, 50e3, 20e3, 10e3, 5e3, 2e3, 1e3, 500];

/** Torch graphic; moves 0.5 grid closer to the LDR for every light level (ISIS TORCHMOV_0..9 frames). */
function torch(level: number): Primitive[] {
  const dx = level * 0.5;
  const x = -8 + dx;
  return [
    rect(x, -0.35, 1.3, 0.7, '#606060', '#202020'),
    polygon([pt(x + 1.3, -0.35), pt(x + 2.0, -0.8), pt(x + 2.0, 0.8), pt(x + 1.3, 0.35)], '#C0C0C0', '#202020'),
    line(x + 2.0, -0.8, x + 2.0, 0.8, '#FFFF80'),
  ];
}

function beam(level: number): Primitive[] {
  if (level === 0) return [];
  const x = -6 + level * 0.5;
  return [polygon([pt(x, -0.8), pt(-0.2, -1.4), pt(-0.2, 1.4), pt(x, 0.8)], '#FFFFA0', null)];
}

function zigzag(): Primitive {
  const pts = [pt(2, -1.5)];
  for (let i = 0; i < 6; i++) pts.push(pt(i % 2 === 0 ? 2.45 : 1.55, -1.25 + i * 0.5));
  pts.push(pt(2, 1.5));
  return polyline(pts, '#E0E0D0');
}

const torchLayers: Record<string, Primitive[]> = {};
for (let level = 0; level < LDR_LEVEL_OHMS.length; level++) {
  torchLayers[`torch-${level}`] = torch(level);
  torchLayers[`beam-${level}`] = beam(level);
}

// TORCH_LDR: LDR circle centred (2,0) radius 2, short pins 1 (top) and 2 (bottom); torch on the left.
export const TORCH_LDR_SYMBOL: SymbolDef = defineSymbol({
  kind: 'TORCH_LDR',
  isisName: 'TORCH_LDR',
  refPrefix: 'LDR',
  showValue: true,
  showText: true,
  pins: [
    pin({ name: '1', tip: pt(2, -3), base: pt(2, -2) }),
    pin({ name: '2', tip: pt(2, 3), base: pt(2, 2) }),
  ],
  body: [
    circle(2, 0, 2, '#181818'),
    zigzag(),
    circle(-9.6, -0.45, 0.25, ISIS_COLORS.actuator),
    circle(-9.6, 0.45, 0.25, ISIS_COLORS.actuator),
  ],
  layers: torchLayers,
  labels: {
    ref: label(4.4, -1.6, 'top', REF_SIZE),
    value: label(4.4, -0.4, 'top', VALUE_SIZE),
    text: label(4.4, 0.5, 'top', VALUE_SIZE),
  },
  actuators: [
    { action: 'increment', center: pt(-9.6, -0.45), r: 0.4 },
    { action: 'decrement', center: pt(-9.6, 0.45), r: 0.4 },
  ],
  defaultValue: 'TORCH_LDR',
  defaultProps: { level: 0 },
});

export const CAP_SYMBOL: SymbolDef = defineSymbol({
  kind: 'CAP',
  isisName: 'CAP',
  refPrefix: 'C',
  showValue: true,
  showText: true,
  pins: [
    pin({ name: '1', tip: pt(-2, 0), base: pt(-0.2, 0) }),
    pin({ name: '2', tip: pt(2, 0), base: pt(0.2, 0) }),
  ],
  body: [
    { type: 'line', from: pt(-0.2, -0.8), to: pt(-0.2, 0.8), stroke: ISIS_COLORS.outline, strokeWidth: LINE * 2 },
    { type: 'line', from: pt(0.2, -0.8), to: pt(0.2, 0.8), stroke: ISIS_COLORS.outline, strokeWidth: LINE * 2 },
  ],
  layers: {},
  labels: {
    ref: label(-1, -1.0, 'bottom', REF_SIZE),
    value: label(-1, 1.0, 'top', VALUE_SIZE),
    text: label(-1, 1.8, 'top', VALUE_SIZE),
  },
  actuators: [],
  defaultValue: '22pF',
  defaultProps: {},
});

// CRYSTAL: vertical, as in the Ch1 oscillator drawing. Decorative: the PIC CLOCK property sets the speed.
export const CRYSTAL_SYMBOL: SymbolDef = defineSymbol({
  kind: 'CRYSTAL',
  isisName: 'CRYSTAL',
  refPrefix: 'X',
  showValue: true,
  showText: true,
  pins: [
    pin({ name: '1', tip: pt(0, -2), base: pt(0, -0.7) }),
    pin({ name: '2', tip: pt(0, 2), base: pt(0, 0.7) }),
  ],
  body: [
    line(-0.8, -0.7, 0.8, -0.7),
    line(-0.8, 0.7, 0.8, 0.7),
    rect(-0.6, -0.4, 1.2, 0.8, ISIS_COLORS.body),
  ],
  layers: {},
  labels: {
    ref: label(1.2, -1.2, 'top', REF_SIZE),
    value: label(1.2, 0, 'top', VALUE_SIZE),
    text: label(1.2, 0.8, 'top', VALUE_SIZE),
  },
  actuators: [],
  defaultValue: 'CRYSTAL',
  defaultProps: { freq: '20MHz' },
});
