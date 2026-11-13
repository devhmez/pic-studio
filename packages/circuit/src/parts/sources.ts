// Input parts: LOGICSTATE (latched 0/1 source) and BUTTON (momentary push button).
import { ISIS_COLORS, LOGICSTATE_COLORS } from './colors';
import { REF_SIZE, VALUE_SIZE, circle, defineSymbol, label, line, pin, polygon, pt, rect, text } from './builders';
import type { Primitive, SymbolDef } from './types';

// Arrow-shaped pentagon pointing at the output pin (decoded from the DSN), output to the right by default.
const PENTAGON = [pt(-2.5, -1), pt(-1, -1), pt(0, 0), pt(-1, 1), pt(-2.5, 1)];

function logicFrame(state: 0 | 1): Primitive[] {
  return [
    polygon(PENTAGON, LOGICSTATE_COLORS[state]),
    text(-1.5, 0, String(state), 1.1, 'middle', 'middle', LOGICSTATE_COLORS.digit),
  ];
}

export const LOGICSTATE_SYMBOL: SymbolDef = defineSymbol({
  kind: 'LOGICSTATE',
  isisName: 'LOGICSTATE',
  refPrefix: '',
  showValue: false,
  // The prof's captures show no <TEXT> under the stacked answer LOGICSTATEs.
  showText: false,
  pins: [pin({ name: 'Q0', tip: pt(2, 0), base: pt(0, 0) })],
  body: [
    polygon(PENTAGON, LOGICSTATE_COLORS[0]),
    // The two small red click markers ($MKRINCREMENT / $MKRDECREMENT) under the box.
    circle(-1.95, 1.45, 0.22, ISIS_COLORS.actuator),
    circle(-1.4, 1.45, 0.22, ISIS_COLORS.actuator),
  ],
  layers: { 'state-0': logicFrame(0), 'state-1': logicFrame(1) },
  labels: {
    ref: label(-2.5, -1.3, 'bottom', REF_SIZE),
    value: label(-2.5, 2.0, 'top', VALUE_SIZE),
    text: label(-2.5, 2.0, 'top', VALUE_SIZE),
  },
  actuators: [{ action: 'toggle', center: pt(-1.25, 0.2), r: 1.5 }],
  defaultProps: { state: 0 },
});

function buttonFrame(pressed: boolean): Primitive[] {
  const dy = pressed ? 0.3 : 0;
  return [
    line(-1.25, -0.5 + dy, 1.25, -0.5 + dy),
    rect(-0.8, -1.0 + dy, 1.6, 0.5, ISIS_COLORS.body),
  ];
}

export const BUTTON_SYMBOL: SymbolDef = defineSymbol({
  kind: 'BUTTON',
  isisName: 'BUTTON',
  refPrefix: '',
  showValue: false,
  showText: true,
  pins: [
    pin({ name: '1', tip: pt(-2.5, 0), base: pt(-1.2, 0) }),
    pin({ name: '2', tip: pt(2.5, 0), base: pt(1.2, 0) }),
  ],
  body: [
    circle(-1, 0, 0.2, ISIS_COLORS.background),
    circle(1, 0, 0.2, ISIS_COLORS.background),
    // Latch marker (red dot) shown by ISIS next to the cap.
    circle(1.65, -0.9, 0.22, ISIS_COLORS.actuator),
  ],
  layers: { released: buttonFrame(false), pressed: buttonFrame(true) },
  labels: {
    ref: label(-1.25, -1.45, 'bottom', REF_SIZE),
    value: label(-1.25, 0.5, 'top', VALUE_SIZE),
    text: label(-1.25, 0.5, 'top', VALUE_SIZE),
  },
  actuators: [{ action: 'press', center: pt(0, -0.6), r: 1.1 }],
  defaultProps: {},
});
