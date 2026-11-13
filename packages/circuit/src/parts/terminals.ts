// POWER ($TERPOWER, +5 V rail) and GROUND ($TERGROUND, 0 V rail) terminals. Unlabelled in every TP circuit.
import { ISIS_COLORS } from './colors';
import { VALUE_SIZE, defineSymbol, label, line, pin, polyline, pt } from './builders';
import type { SymbolDef } from './types';

// The connection node sits 1 grid below the origin, the arrow points up.
export const POWER_SYMBOL: SymbolDef = defineSymbol({
  kind: 'POWER',
  isisName: 'POWER',
  refPrefix: '',
  showValue: true,
  showText: false,
  pins: [pin({ name: 'VDD', tip: pt(0, 1), base: pt(0, 1) })],
  body: [
    line(0, 1, 0, -0.8, ISIS_COLORS.wire),
    polyline([pt(-0.45, 0), pt(0, -0.8), pt(0.45, 0)], ISIS_COLORS.wire),
    line(-0.45, 0, 0.45, 0, ISIS_COLORS.wire),
  ],
  layers: {},
  labels: {
    ref: label(0, -1.1, 'bottom', VALUE_SIZE, 'middle'),
    value: label(0, -1.1, 'bottom', VALUE_SIZE, 'middle'),
    text: label(0, -1.9, 'bottom', VALUE_SIZE, 'middle'),
  },
  actuators: [],
  defaultProps: {},
});

// The connection node sits 1 grid above the origin, the bars hang below.
export const GROUND_SYMBOL: SymbolDef = defineSymbol({
  kind: 'GROUND',
  isisName: 'GROUND',
  refPrefix: '',
  showValue: true,
  showText: false,
  pins: [pin({ name: 'GND', tip: pt(0, -1), base: pt(0, -1) })],
  body: [
    line(0, -1, 0, 0, ISIS_COLORS.wire),
    line(-0.8, 0, 0.8, 0, ISIS_COLORS.wire),
    line(-0.5, 0.3, 0.5, 0.3, ISIS_COLORS.wire),
    line(-0.2, 0.6, 0.2, 0.6, ISIS_COLORS.wire),
  ],
  layers: {},
  labels: {
    ref: label(0, 1.0, 'top', VALUE_SIZE, 'middle'),
    value: label(0, 1.0, 'top', VALUE_SIZE, 'middle'),
    text: label(0, 1.8, 'top', VALUE_SIZE, 'middle'),
  },
  actuators: [],
  defaultProps: {},
});
