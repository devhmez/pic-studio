// Proteus ISIS .DSN importer → Schematic (grid units, Y down). Built on the reverse-engineered reader in ./dsn/reader.
import type { ComponentInstance, ComponentKind, Point, Schematic, Wire } from './api';
import { DSN_UNIT, DsnReader, parseProps, type RawComponent, type RawDsn, type RawPoint, type RawTerminal } from './dsn/reader';
import { clean, normalizeRotation, pinTip, pointsEqual } from './geometry';
import { isLedColor } from './symbols';
import { parseFrequency } from './units';

export { DSN_UNIT, DsnReader, parseProps } from './dsn/reader';
export type { RawComponent, RawDsn, RawPin, RawTerminal, RawWire } from './dsn/reader';

export interface DsnImport {
  schematic: Schematic;
  /** French messages for parts that were skipped or could not be matched exactly. */
  warnings: string[];
  raw: RawDsn;
}

interface KindMapping {
  kind: ComponentKind;
  props: Record<string, string | number>;
  /** DSN pin name → our symbol pin name, when they differ. */
  pinNames?: Readonly<Record<string, string>>;
  /** Prefix for generated ids of parts that have no reference (LOGICSTATE, 7SEG, TRAFFIC LIGHTS). */
  idPrefix: string;
}

const BCD_PINS = { D3: 'E3', D2: 'E2', D1: 'E1', D0: 'E0' } as const;
const TRAFFIC_PINS = { D0: 'R', D1: 'A', D2: 'G' } as const;
const PIC_PINS = { $MCLR$: 'MCLR' } as const;
/** TORCH_LDR library defaults R(0)..R(9); only overridden values are copied into props. */
const DEFAULT_LDR = ['1M', '200K', '100K', '50K', '20K', '10K', '5K', '2K', '1K', '500'];

function stateOf(raw: RawComponent): number {
  const own = parseProps(raw.props).STATE ?? raw.state;
  const n = Number(own);
  return Number.isFinite(n) ? n : 0;
}

function mapDevice(raw: RawComponent): KindMapping | null {
  const dev = raw.device;
  const led = /^LED-(RED|GREEN|BLUE|YELLOW)$/.exec(dev);
  if (led && isLedColor(led[1])) return { kind: 'LED', props: { color: led[1] }, idPrefix: 'D' };
  const bcd = /^7SEG-BCD(?:-(BLUE|GRN|GREEN))?$/.exec(dev);
  if (bcd) {
    const color = bcd[1] === 'BLUE' ? 'BLUE' : bcd[1] ? 'GREEN' : 'RED';
    return { kind: '7SEG-BCD', props: { color }, pinNames: BCD_PINS, idPrefix: 'SEG' };
  }
  switch (dev) {
    case 'PIC16F84A': {
      const p = parseProps(raw.props);
      return {
        kind: 'PIC16F84A',
        props: { clock: p.CLOCK ?? '1MHz', cfgword: p.CFGWORD ?? '0x3FFB' },
        pinNames: PIC_PINS,
        idPrefix: 'U',
      };
    }
    case 'LOGICSTATE': return { kind: 'LOGICSTATE', props: { state: stateOf(raw) === 1 ? 1 : 0 }, idPrefix: 'LS' };
    case 'BUTTON': return { kind: 'BUTTON', props: {}, idPrefix: 'BTN' };
    case 'RES': return { kind: 'RES', props: {}, idPrefix: 'R' };
    case 'TRAFFIC LIGHTS': return { kind: 'TRAFFIC_LIGHTS', props: {}, pinNames: TRAFFIC_PINS, idPrefix: 'TL' };
    case 'TORCH_LDR': {
      const props: Record<string, string | number> = { level: Math.max(0, Math.min(9, stateOf(raw))) };
      const p = parseProps(raw.props);
      for (let i = 0; i <= 9; i++) {
        const key = `R(${i})`;
        if (p[key] !== undefined && p[key] !== DEFAULT_LDR[i]) props[key] = p[key];
      }
      return { kind: 'TORCH_LDR', props, idPrefix: 'LDR' };
    }
    case 'CAP': return { kind: 'CAP', props: {}, idPrefix: 'C' };
    case 'CRYSTAL': {
      const freq = parseProps(raw.props).FREQ;
      return { kind: 'CRYSTAL', props: freq ? { freq } : {}, idPrefix: 'X' };
    }
    default: return null;
  }
}

/** DSN units (Y up) → grid units (Y down). */
export function fromDsnPoint(p: RawPoint): Point {
  return { x: clean(p.x / DSN_UNIT), y: clean(-p.y / DSN_UNIT) };
}

/**
 * DSN placement = R_ccw(θ) · Mx^bit0 · My^bit1 in a Y-up frame. A Y-mirror is an X-mirror plus a half turn,
 * and flipping the Y axis turns a counter-clockwise angle into a clockwise one on screen.
 */
export function fromDsnPlacement(angle10: number, mirrorBits: number): Pick<ComponentInstance, 'rotation' | 'mirror'> {
  const yMirror = (mirrorBits & 2) !== 0;
  const xMirror = (mirrorBits & 1) !== 0;
  const rotation = normalizeRotation(-(angle10 / 10 + (yMirror ? 180 : 0)));
  return xMirror !== yMirror ? { rotation, mirror: true } : { rotation };
}

/**
 * Component ids: the ISIS reference when it is unique (U1, D1, X_SUPERIEUR, LDR1), otherwise `<ref>_2`, and
 * `<prefix><n>` (LS1, SEG1, TL1, GND1, PWR1) for parts ISIS shows without a reference.
 */
function idAllocator(refs: readonly string[]): (ref: string, prefix: string) => string {
  const reserved = new Set(refs.filter(Boolean));
  const taken = new Set<string>();
  return (ref, prefix) => {
    if (ref && !taken.has(ref)) { taken.add(ref); return ref; }
    const base = ref ? `${ref}_` : prefix;
    for (let n = ref ? 2 : 1; ; n++) {
      const id = `${base}${n}`;
      if (!taken.has(id) && !reserved.has(id)) { taken.add(id); return id; }
    }
  };
}

const sanitizeRef = (ref: string): string => ref.trim().replace(/\s+/g, '_');

function terminalKind(t: RawTerminal): ComponentKind | null {
  return t.kind === '$TERPOWER' ? 'POWER' : t.kind === '$TERGROUND' ? 'GROUND' : null;
}

export function importDsnDetailed(bytes: Uint8Array): DsnImport {
  const raw = new DsnReader(bytes).read();
  const warnings: string[] = [];
  const allocateId = idAllocator(raw.components.map((c) => sanitizeRef(c.ref)));
  const placed: { offset: number; component: ComponentInstance }[] = [];
  let clockHz: number | null = null;

  for (const rc of raw.components) {
    const mapping = mapDevice(rc);
    if (!mapping) {
      warnings.push(`Composant non pris en charge : « ${rc.ref || rc.device} » (${rc.device}), ignoré.`);
      continue;
    }
    const component: ComponentInstance = {
      id: allocateId(sanitizeRef(rc.ref), mapping.idPrefix),
      kind: mapping.kind,
      ref: rc.ref.trim(),
      at: fromDsnPoint(rc),
      ...fromDsnPlacement(rc.angle10, rc.mirror),
      props: mapping.props,
    };
    if (rc.value) component.value = rc.value;
    if (mapping.kind === 'PIC16F84A' && clockHz === null) clockHz = parseFrequency(mapping.props.clock) ?? 1_000_000;
    checkPins(rc, component, mapping, warnings);
    placed.push({ offset: rc.offset, component });
  }
  for (const t of raw.terminals) {
    const kind = terminalKind(t);
    if (!kind) {
      warnings.push(`Terminal non pris en charge : ${t.kind}${t.label ? ` « ${t.label} »` : ''}, ignoré.`);
      continue;
    }
    const component: ComponentInstance = {
      id: allocateId('', kind === 'POWER' ? 'PWR' : 'GND'),
      kind,
      ref: '',
      at: fromDsnPoint(t),
      ...fromDsnPlacement(t.angle10, t.mirror),
      props: {},
    };
    if (t.label) component.value = t.label;
    placed.push({ offset: t.offset, component });
  }
  // Keep the drawing order of the file (components and terminals interleaved).
  placed.sort((a, b) => a.offset - b.offset);

  const wires: Wire[] = raw.wires.map((w, i) => ({ id: `W${i + 1}`, points: w.points.map(fromDsnPoint) }));
  return {
    schematic: { components: placed.map((p) => p.component), wires, clockHz: clockHz ?? 1_000_000 },
    warnings,
    raw,
  };
}

/** Our symbol must put every pin exactly where the DSN library does, otherwise wires would not land on it. */
function checkPins(rc: RawComponent, component: ComponentInstance, mapping: KindMapping, warnings: string[]): void {
  for (const rp of rc.pins) {
    const name = mapping.pinNames?.[rp.name] ?? rp.name;
    if (name === 'VDD' || name === 'VSS') continue;
    const ours = pinTip(component, name);
    if (!ours) {
      warnings.push(`Broche « ${rp.name} » de « ${rc.ref || rc.device} » inconnue de la bibliothèque.`);
    } else if (!pointsEqual(ours, fromDsnPoint(rp.tip))) {
      warnings.push(`Broche « ${rp.name} » de « ${rc.ref || rc.device} » : position différente du symbole ISIS.`);
    }
  }
}

/** Import a Proteus ISIS .DSN file. Throws (French message) when the file is not an ISIS schematic. */
export function importDsn(bytes: Uint8Array): Schematic {
  return importDsnDetailed(bytes).schematic;
}
