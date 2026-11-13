// PIC16F84A, exactly as decoded from the prof's DSN library (research 05 §2), converted to Y-down.
// Origin = OSC1/CLKIN tip. Body (2,-1)..(13,14). Port A at the top right, one-pitch gap, then port B.
import type { PinName } from '@pic/emulator/api';
import { ISIS_COLORS } from './colors';
import { REF_SIZE, VALUE_SIZE, defineSymbol, label, pin, pt, rect } from './builders';
import type { SymbolDef, SymbolPin } from './types';

const left = (name: string, number: number, y: number, overbar = false): SymbolPin =>
  pin({ name, number, tip: pt(0, y), base: pt(2, y), showName: true, showNumber: true, overbar });

const right = (name: string, number: number, y: number): SymbolPin =>
  pin({ name, number, tip: pt(15, y), base: pt(13, y), showName: true, showNumber: true });

const PIC_PINS: SymbolPin[] = [
  left('OSC1/CLKIN', 16, 0),
  left('OSC2/CLKOUT', 15, 1),
  left('MCLR', 4, 3, true),
  right('RA0', 17, 0),
  right('RA1', 18, 1),
  right('RA2', 1, 2),
  right('RA3', 2, 3),
  right('RA4/T0CKI', 3, 4),
  right('RB0/INT', 6, 6),
  right('RB1', 7, 7),
  right('RB2', 8, 8),
  right('RB3', 9, 9),
  right('RB4', 10, 10),
  right('RB5', 11, 11),
  right('RB6', 12, 12),
  right('RB7', 13, 13),
  // VDD/VSS are hidden in ISIS and tied to the default power rails; they are not part of any drawn net.
  pin({ name: 'VDD', number: 14, tip: pt(7, -3), base: pt(7, -1), hidden: true }),
  pin({ name: 'VSS', number: 5, tip: pt(7, 16), base: pt(7, 14), hidden: true }),
];

/** Symbol pin name → emulator GPIO name ('RB0/INT' → 'RB0', 'RA4/T0CKI' → 'RA4'). */
export const PIC_GPIO_PINS: Readonly<Record<string, PinName>> = {
  RA0: 'RA0', RA1: 'RA1', RA2: 'RA2', RA3: 'RA3', 'RA4/T0CKI': 'RA4',
  'RB0/INT': 'RB0', RB1: 'RB1', RB2: 'RB2', RB3: 'RB3', RB4: 'RB4', RB5: 'RB5', RB6: 'RB6', RB7: 'RB7',
};

export const PIC16F84A_SYMBOL: SymbolDef = defineSymbol({
  kind: 'PIC16F84A',
  isisName: 'PIC16F84A',
  refPrefix: 'U',
  showValue: true,
  showText: true,
  pins: PIC_PINS,
  body: [rect(2, -1, 11, 15, ISIS_COLORS.body)],
  layers: {},
  labels: {
    ref: label(1.92, -1.25, 'bottom', REF_SIZE),
    value: label(1.92, 14.08, 'top', VALUE_SIZE),
    text: label(1.92, 15.08, 'top', VALUE_SIZE),
  },
  actuators: [],
  defaultValue: 'PIC16F84A',
  defaultProps: { clock: '1MHz', cfgword: '0x3FFB' },
});
