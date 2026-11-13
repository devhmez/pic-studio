// LED-RED / LED-GREEN / LED-BLUE / LED-YELLOW (ISIS animated LED). Vertical, anode on top; short pins (length 1).
import { ISIS_COLORS, LED_COLORS, type LedColor } from './colors';
import { LINE, REF_SIZE, VALUE_SIZE, defineSymbol, label, line, pin, polygon, polyline, pt, circle } from './builders';
import type { Primitive, SymbolDef } from './types';

const R = 1.2;

function diode(stroke: string): Primitive[] {
  return [
    line(0, -1, 0, -0.4, stroke),
    polygon([pt(-0.5, -0.4), pt(0.5, -0.4), pt(0, 0.4)], undefined, stroke),
    line(-0.5, 0.4, 0.5, 0.4, stroke),
    line(0, 0.4, 0, 1, stroke),
  ];
}

/** Two small arrows leaving the LED (drawn only while lit). */
function emissionArrows(color: string): Primitive[] {
  const arrow = (x: number, y: number): Primitive[] => [
    { type: 'line', from: pt(x, y), to: pt(x - 0.7, y - 0.7), stroke: color, strokeWidth: LINE },
    polyline([pt(x - 0.35, y - 0.7), pt(x - 0.7, y - 0.7), pt(x - 0.7, y - 0.35)], color),
  ];
  return [...arrow(-1.1, -0.55), ...arrow(-0.55, -1.1)];
}

export function ledSymbol(color: LedColor): SymbolDef {
  const c = LED_COLORS[color];
  return defineSymbol({
    kind: 'LED',
    isisName: `LED-${color}`,
    refPrefix: 'D',
    showValue: true,
    showText: true,
    pins: [
      pin({ name: 'A', tip: pt(0, -2), base: pt(0, -1) }),
      pin({ name: 'K', tip: pt(0, 2), base: pt(0, 1) }),
    ],
    body: [circle(0, 0, R, c.off), ...diode(ISIS_COLORS.outline)],
    layers: {
      lit: [circle(0, 0, R, c.on), ...diode(ISIS_COLORS.outline)],
      emission: emissionArrows(c.on),
    },
    labels: {
      ref: label(1.78, -1.28, 'top', REF_SIZE),
      value: label(1.78, 0.22, 'top', VALUE_SIZE),
      text: label(1.78, 1.22, 'top', VALUE_SIZE),
    },
    actuators: [],
    defaultValue: `LED-${color}`,
    defaultProps: { color },
  });
}
