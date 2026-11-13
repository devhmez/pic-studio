// Pin and port helpers of the PIC16F84A.
import type { PinName, Port } from './types';

export const PORT_A_PINS: readonly PinName[] = ['RA0', 'RA1', 'RA2', 'RA3', 'RA4'];
export const PORT_B_PINS: readonly PinName[] = ['RB0', 'RB1', 'RB2', 'RB3', 'RB4', 'RB5', 'RB6', 'RB7'];
export const ALL_PINS: readonly PinName[] = [...PORT_A_PINS, ...PORT_B_PINS];

/** Implemented bits per port (PORTA has RA0..RA4 only). */
export const PORT_WIDTH: Readonly<Record<Port, number>> = { A: 5, B: 8 };

export function isPinName(v: unknown): v is PinName {
  return typeof v === 'string' && (ALL_PINS as readonly string[]).includes(v);
}

export function pinPort(pin: PinName): Port {
  return pin[1] as Port;
}

export function pinBit(pin: PinName): number {
  return Number(pin[2]);
}

export function pinOf(port: Port, bit: number): PinName | undefined {
  const name = `R${port}${bit}`;
  return isPinName(name) ? name : undefined;
}

/** Sort key: RA0..RA4 then RB0..RB7. */
export function pinIndex(pin: PinName): number {
  return ALL_PINS.indexOf(pin);
}

export const comparePins = (a: PinName, b: PinName): number => pinIndex(a) - pinIndex(b);

/** Pins of a bus, LSB first. */
export function busPins(bus: { port: Port; lsb: number; width: number }): PinName[] {
  const out: PinName[] = [];
  for (let k = 0; k < bus.width; k++) {
    const p = pinOf(bus.port, bus.lsb + k);
    if (p) out.push(p);
  }
  return out;
}

/** Schematic pin name of a GPIO ('RB0' → 'RB0/INT', 'RA4' → 'RA4/T0CKI'). */
export function schematicPinName(pin: PinName): string {
  if (pin === 'RB0') return 'RB0/INT';
  if (pin === 'RA4') return 'RA4/T0CKI';
  return pin;
}

/** GPIO of a schematic pin name ('RB0/INT' → 'RB0'), or undefined for OSC/MCLR/VDD/VSS. */
export function gpioOfSchematicPin(name: string): PinName | undefined {
  const base = name.split('/')[0];
  return isPinName(base) ? base : undefined;
}
