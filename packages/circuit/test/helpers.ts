/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Drive, Level, McuPins, PinName } from '@pic/emulator/api';
import { PIN_NAMES } from '@pic/emulator/api';
import type { Schematic } from '../src/api';
import type { BuiltNetlist } from '../src/netlist';
import { isisPartName } from '../src/symbols';

export const repoPath = (rel: string): string => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));

export const readBytes = (rel: string): Uint8Array => new Uint8Array(readFileSync(repoPath(rel)));

/** The prof's five DSN files, with the template name each one produces. */
export const DSN_FILES = [
  { file: 'EXEMPLE1.DSN', template: 'tp0-exemple1', name: 'TP0 — Exemple 1 : allumer une LED (RA0)' },
  { file: 'EXEMPLE2.DSN', template: 'tp0-exemple2', name: 'TP0 — Exemple 2 : commander une LED par un bouton' },
  { file: 'tp demux.DSN', template: 'tp1-demux', name: 'TP1 — Atelier Démultiplexeur 1 vers 4' },
  { file: 'manipulation status.DSN', template: 'tp-status', name: 'TP — Manipulation du registre STATUS' },
  { file: 'traffic lightdesign.DSN', template: 'tp-traffic', name: 'TP — Feu tricolore' },
] as const;

interface ResearchCircuit {
  components: { ref: string; device: string; key: string }[];
  nets: string[][];
}

export function researchCircuits(): Record<string, ResearchCircuit> {
  return JSON.parse(readFileSync(repoPath('research/05_dsn_circuits.json'), 'utf8')) as Record<string, ResearchCircuit>;
}

/** Our pin names → the ISIS library pin names used by research/05 (7SEG D3..D0, TRAFFIC D0..D2, $MCLR$). */
const ISIS_PIN_NAME: Record<string, Record<string, string>> = {
  '7SEG-BCD': { E3: 'D3', E2: 'D2', E1: 'D1', E0: 'D0' },
  TRAFFIC_LIGHTS: { R: 'D0', A: 'D1', G: 'D2' },
  PIC16F84A: { MCLR: '$MCLR$' },
};

/** Multi-member nets written the way research/05 writes them ("U1.RA0", "LOGICSTATE#1.Q0", "$TERGROUND"). */
export function researchStyleNets(schematic: Schematic, netlist: BuiltNetlist): string[][] {
  const keyOf = new Map<string, string>();
  const counters = new Map<string, number>();
  for (const c of schematic.components) {
    if (c.kind === 'POWER') keyOf.set(c.id, '$TERPOWER');
    else if (c.kind === 'GROUND') keyOf.set(c.id, '$TERGROUND');
    else if (c.ref) keyOf.set(c.id, c.ref);
    else {
      const part = isisPartName(c);
      const n = (counters.get(part) ?? 0) + 1;
      counters.set(part, n);
      keyOf.set(c.id, `${part}#${n}`);
    }
  }
  const kindOf = new Map(schematic.components.map((c) => [c.id, c.kind] as const));
  return netlist.nets
    .filter((n) => n.pins.length > 1)
    .map((n) => n.pins.map((p) => {
      const key = keyOf.get(p.componentId)!;
      if (key.startsWith('$TER')) return key;
      const pin = ISIS_PIN_NAME[kindOf.get(p.componentId)!]?.[p.pin] ?? p.pin;
      return `${key}.${pin}`;
    }).sort())
    .sort((a, b) => a.join('|').localeCompare(b.join('|')));
}

export const normalizeNets = (nets: string[][]): string[][] =>
  nets.map((n) => [...n].sort()).sort((a, b) => a.join('|').localeCompare(b.join('|')));

/** Minimal McuPins: tests set drives / pull-ups and read back what the circuit pushed. */
export class FakeMcu implements McuPins {
  readonly pinNames: readonly PinName[] = PIN_NAMES;
  readonly drive = new Map<PinName, Drive>();
  readonly pullup = new Set<PinName>();
  readonly inputs = new Map<PinName, Level>();
  readonly history: [PinName, Level][] = [];

  getDrive(pin: PinName): Drive { return this.drive.get(pin) ?? 'Z'; }
  hasWeakPullup(pin: PinName): boolean { return this.pullup.has(pin); }
  setInput(pin: PinName, level: Level): void {
    this.inputs.set(pin, level);
    this.history.push([pin, level]);
  }
  input(pin: PinName): Level | undefined { return this.inputs.get(pin); }
}
