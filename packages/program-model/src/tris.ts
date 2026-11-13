// How a program configures its ports: one whole-register TRIS write (`TRISB = 0x00;`, status.c) or one bit per pin
// (`TRISA.RA0 = 1;`, demux.c). Shared by the C generator (@pic/style-c) and the organigramme prose, so the
// CONFIGURATION box says « PORTB est en sortie » exactly when the code writes the whole register (research 00 §3.7 #1).
import { busPins, comparePins, pinBit, pinPort } from './pins';
import type { PinName, Port, Program } from './types';

/** Ports configured with one whole-register TRIS write ('auto' resolved). */
export function trisMode(program: Program, port: Port): 'bits' | 'port' {
  const mode = program.style.tris[port];
  if (mode !== 'auto') return mode;
  const bus = program.buses.find((b) => b.port === port);
  if (!bus) return 'bits';
  const signalsOnPort = program.signals.filter((s) => pinPort(s.pin) === port);
  const otherBuses = program.buses.filter((b) => b.port === port);
  return signalsOnPort.every((s) => s.dir === bus.dir) && otherBuses.every((b) => b.dir === bus.dir) ? 'port' : 'bits';
}

export interface PinUse { pin: PinName; dir: 'in' | 'out'; name: string }

/** Pins of `port` used by the program (signals and bus bits), in pin order. */
export function pinUses(program: Program, port: Port): PinUse[] {
  const uses: PinUse[] = program.signals
    .filter((s) => pinPort(s.pin) === port)
    .map((s) => ({ pin: s.pin, dir: s.dir, name: s.useDefine === false ? '' : s.name }));
  for (const b of program.buses) if (b.port === port) for (const p of busPins(b)) uses.push({ pin: p, dir: b.dir, name: b.name });
  return uses.sort((a, b) => comparePins(a.pin, b.pin));
}

/** TRIS value of a whole-port write: inputs 1, outputs 0, unused bits 0 if the port has an output, else 1. */
export function trisValue(program: Program, port: Port): number {
  const uses = pinUses(program, port);
  const width = port === 'A' ? 5 : 8;
  const anyOut = uses.some((u) => u.dir === 'out');
  let value = 0;
  for (let bit = 0; bit < width; bit++) {
    const u = uses.find((x) => pinBit(x.pin) === bit);
    if (u ? u.dir === 'in' : !anyOut) value |= 1 << bit;
  }
  return value;
}
