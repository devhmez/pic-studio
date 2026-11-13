// Simulation trace for the « Rendu du TP »: which inputs the student set (LOGICSTATE, BUTTON, LDR) and what the
// outputs did (LEDs, 7-segment displays, traffic lights), with the simulated time of each change.
// The recorder is fed the store's simulation state (see traceHook.ts); everything here is pure and DOM-free.
import { buildNetlist, ledFrame, type ComponentVisual, type Schematic, type SessionSnapshot } from '@pic/circuit';
import { busPins, pinListText, type PinName, type Program } from '@pic/program-model';
import type { SimStatus } from '../state/types';

export interface TraceChange {
  /** Simulated seconds. */
  time: number;
  componentId: string;
  before: ComponentVisual | null;
  after: ComponentVisual;
}

export interface TraceLog {
  /** State of every component at the first snapshot of the run. */
  initial: Record<string, ComponentVisual>;
  initialTime: number;
  changes: TraceChange[];
  /** Changes not kept once the log was full. */
  dropped: number;
  /** Simulated time of the last snapshot seen. */
  lastTime: number;
}

const INPUT_KINDS = new Set<ComponentVisual['kind']>(['LOGICSTATE', 'BUTTON', 'TORCH_LDR']);

export const isInputVisual = (v: ComponentVisual): boolean => INPUT_KINDS.has(v.kind);

/**
 * An LED as the schematic draws it: lit from the first of its 7 brightness frames on (duty cycle over 20 ms). The
 * instantaneous `lit` flag is not used: a program that switches all LEDs off then one on in its loop (status.c)
 * would read as dark whenever a snapshot falls between the two writes.
 */
export const ledShown = (v: Extract<ComponentVisual, { kind: 'LED' }>): boolean => ledFrame(v.brightness) > 0;

/** True when two visuals show the same thing (LED brightness changes are ignored: only shown lit / dark counts). */
export function sameVisual(a: ComponentVisual | null | undefined, b: ComponentVisual): boolean {
  if (!a || a.kind !== b.kind) return false;
  switch (b.kind) {
    case 'LED': return ledShown(a as typeof b) === ledShown(b);
    case '7SEG-BCD': return (a as typeof b).value === b.value;
    case '7SEG-CC': return (a as typeof b).segments === b.segments;
    case 'TRAFFIC_LIGHTS': {
      const x = a as typeof b;
      return x.red === b.red && x.amber === b.amber && x.green === b.green;
    }
    case 'LOGICSTATE': return (a as typeof b).state === b.state;
    case 'BUTTON': return (a as typeof b).pressed === b.pressed;
    case 'TORCH_LDR': return (a as typeof b).level === b.level;
    case 'NONE': return true;
  }
}

/**
 * Records one simulation run: a new log starts when the simulation starts from « arrêté » or is reset (its time goes
 * back); the last run's log stays available after « Arrêter ».
 */
export class TraceRecorder {
  private log: TraceLog | null = null;
  private last: Record<string, ComponentVisual> = {};
  private status: SimStatus = 'stopped';
  private lastSnapshot: SessionSnapshot | null = null;

  constructor(private readonly limit = 2000) {}

  /** Feed the current simulation state (called on every store change; cheap when nothing changed). */
  observe(status: SimStatus, snapshot: SessionSnapshot | null): void {
    const started = this.status === 'stopped' && status !== 'stopped';
    this.status = status;
    if (status === 'stopped' || !snapshot || snapshot === this.lastSnapshot) {
      if (status === 'stopped') this.lastSnapshot = null;
      return;
    }
    this.lastSnapshot = snapshot;
    if (started || !this.log || snapshot.time < this.log.lastTime) {
      this.log = { initial: { ...snapshot.visuals }, initialTime: snapshot.time, changes: [], dropped: 0, lastTime: snapshot.time };
      this.last = { ...snapshot.visuals };
      return;
    }
    const log = this.log;
    for (const [id, v] of Object.entries(snapshot.visuals)) {
      const before = this.last[id] ?? null;
      if (sameVisual(before, v)) continue;
      if (log.changes.length < this.limit) log.changes.push({ time: snapshot.time, componentId: id, before, after: v });
      else log.dropped++;
      this.last[id] = v;
    }
    log.lastTime = snapshot.time;
  }

  /** The current (or last) run, or null when nothing ran yet. */
  current(): TraceLog | null {
    return this.log;
  }

  clear(): void {
    this.log = null;
    this.last = {};
    this.lastSnapshot = null;
  }
}

// ------------------------------------------------------------------------------------------------ French wording

export interface TraceRow {
  /** « 0,000 s ». */
  time: string;
  kind: 'Entrée' | 'Sortie';
  text: string;
}

export interface TraceReport {
  /** State when the simulation started: « L0 (RA0) = 0 », « Led égalité (RB1) éteinte ». */
  initialInputs: string[];
  initialOutputs: string[];
  rows: TraceRow[];
  /** Output changes left out of `rows` (row limit or full log). */
  omitted: number;
  /** Simulated duration covered (seconds). */
  duration: number;
}

const BCD_GLYPHS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'b', 'C', 'd', 'E', 'F'];

/** « 1,250 s » (French decimal comma). */
export function formatTraceTime(seconds: number): string {
  return `${seconds.toFixed(3).replace('.', ',')} s`;
}

/** How the trace names one component (« Led égalité (RB1) »); `feminine` agrees « allumée » / « éteinte ». */
export interface TraceLabel { name: string; feminine: boolean }

type Labeled = TraceLabel;

/**
 * How each component is named in the trace: its program signal (« L0 (RA0) », « Led égalité (RB1) »), its bus
 * (« Afficheur 7 segments BCD (RB0 à RB3) »), or its reference with the PIC pin it is wired to (« D1 (RB0) »).
 */
export function traceLabels(schematic: Schematic, program: Program | null): Map<string, Labeled> {
  const out = new Map<string, Labeled>();
  const pinsOf = picPinsByComponent(schematic);
  for (const c of schematic.components) {
    const pins = pinsOf.get(c.id) ?? [];
    const where = pins.length ? ` (${pinListText(pins)})` : '';
    const ref = c.ref?.trim() || c.id;
    let name: string;
    switch (c.kind) {
      case 'LED': name = `Led ${ref}${where}`; break;
      case 'LOGICSTATE': name = `LOGICSTATE ${ref}${where}`; break;
      case 'BUTTON': name = `Bouton ${ref}${where}`; break;
      case 'TORCH_LDR': name = `Capteur de lumière ${ref}${where}`; break;
      case '7SEG-BCD': case '7SEG-CC': name = `Afficheur ${ref}${where}`; break;
      case 'TRAFFIC_LIGHTS': name = `Feu tricolore ${ref}${where}`; break;
      default: name = `${ref}${where}`;
    }
    out.set(c.id, { name, feminine: c.kind === 'LED' });
  }
  if (program) {
    for (const s of program.signals) {
      // The three lamps of a TRAFFIC LIGHTS share one component: keep « Feu tricolore » for it.
      if (!s.componentId || !out.has(s.componentId) || s.device === 'lamp') continue;
      out.set(s.componentId, { name: `${s.label} (${s.pin})`, feminine: s.device === 'led' });
    }
    for (const b of program.buses) {
      if (!b.componentId || !out.has(b.componentId)) continue;
      out.set(b.componentId, { name: `${b.label} (${pinListText(busPins(b))})`, feminine: false });
    }
  }
  return out;
}

/** GPIO pins of the PIC wired to each component, directly or through one series resistor. */
function picPinsByComponent(schematic: Schematic): Map<string, PinName[]> {
  const out = new Map<string, PinName[]>();
  const pic = schematic.components.find((c) => c.kind === 'PIC16F84A');
  if (!pic) return out;
  const nl = buildNetlist(schematic);
  const byId = new Map(schematic.components.map((c) => [c.id, c] as const));
  const add = (id: string, pin: PinName) => {
    const list = out.get(id) ?? [];
    if (!list.includes(pin)) list.push(pin);
    out.set(id, list);
  };
  for (const net of nl.nets) {
    if (net.rail) continue;
    const gpios = net.pins.filter((p) => p.componentId === pic.id).map((p) => p.pin.split('/')[0]).filter(isGpio);
    if (gpios.length === 0) continue;
    for (const p of net.pins) {
      if (p.componentId === pic.id) continue;
      const c = byId.get(p.componentId);
      if (!c) continue;
      for (const g of gpios) add(c.id, g);
      if (c.kind === 'RES') {
        // One hop through a series resistor (demux: RB0 → R4 220 → D1).
        const other = nl.pinToNet.get(`${c.id}:${p.pin === '1' ? '2' : '1'}`);
        const far = nl.nets.find((n) => n.id === other);
        if (far && !far.rail) for (const q of far.pins) if (q.componentId !== c.id && q.componentId !== pic.id) for (const g of gpios) add(q.componentId, g);
      }
    }
  }
  return out;
}

const isGpio = (s: string): s is PinName => /^R[AB][0-7]$/.test(s) && !(s[1] === 'A' && Number(s[2]) > 4);

/** One visual state in words (no subject): « = 1 », « allumée », « affiche 5 ». */
function stateText(v: ComponentVisual, feminine: boolean): string {
  switch (v.kind) {
    case 'LED': return ledShown(v) ? (feminine ? 'allumée' : 'allumé') : (feminine ? 'éteinte' : 'éteint');
    case 'LOGICSTATE': return `= ${v.state}`;
    case 'BUTTON': return v.pressed ? 'appuyé' : 'relâché';
    case 'TORCH_LDR': return `: luminosité ${v.level}/9`;
    case '7SEG-BCD': return v.value === null ? ': rien (entrées non définies)' : `affiche ${BCD_GLYPHS[v.value & 15]}`;
    case '7SEG-CC': return `: segments ${segmentNames(v.segments) || 'éteints'}`;
    case 'TRAFFIC_LIGHTS': {
      const on = [v.red && 'rouge', v.amber && 'orange', v.green && 'vert'].filter(Boolean);
      return on.length ? `: ${on.join(' + ')}` : ': éteint';
    }
    case 'NONE': return '';
  }
}

/** One component's state in words, with its name: « L0 (RA0) = 1 », « Led égalité (RB1) allumée ». Empty for NONE. */
export function visualText(label: TraceLabel, v: ComponentVisual): string {
  const s = stateText(v, label.feminine);
  return s ? `${label.name} ${s}` : '';
}

function segmentNames(bits: number): string {
  return 'abcdefg'.split('').filter((_, k) => (bits >> k) & 1).join(',') + ((bits >> 7) & 1 ? ',dp' : '');
}

/** What changed, in words: « L0 (RA0) passe à 1 », « Led égalité (RB1) allumée », « Feu rouge allumé ». */
function changeText(label: Labeled, c: TraceChange): string {
  const v = c.after;
  if (v.kind === 'LOGICSTATE') return `${label.name} passe à ${v.state}`;
  if (v.kind === 'TRAFFIC_LIGHTS' && c.before?.kind === 'TRAFFIC_LIGHTS') {
    const b = c.before;
    const lamps: string[] = [];
    if (b.red !== v.red) lamps.push(`feu rouge ${v.red ? 'allumé' : 'éteint'}`);
    if (b.amber !== v.amber) lamps.push(`feu orange ${v.amber ? 'allumé' : 'éteint'}`);
    if (b.green !== v.green) lamps.push(`feu vert ${v.green ? 'allumé' : 'éteint'}`);
    return `${label.name} : ${lamps.join(', ')}`;
  }
  return `${label.name} ${stateText(v, label.feminine)}`;
}

/**
 * The log in words, for the « Trace de la simulation » page. Every input change is kept; output changes fill the
 * remaining rows in time order (a blinking LED can produce hundreds), the rest is counted in `omitted`.
 */
export function describeTrace(log: TraceLog, labels: ReadonlyMap<string, Labeled>, maxRows = 60): TraceReport {
  const label = (id: string): Labeled => labels.get(id) ?? { name: id, feminine: false };
  const order = (id: string) => [...labels.keys()].indexOf(id);
  const ids = Object.keys(log.initial).sort((a, b) => order(a) - order(b));
  const initialInputs: string[] = [];
  const initialOutputs: string[] = [];
  for (const id of ids) {
    const v = log.initial[id];
    const l = label(id);
    const s = stateText(v, l.feminine);
    if (!s) continue;
    (isInputVisual(v) ? initialInputs : initialOutputs).push(`${l.name} ${s}`);
  }
  const inputs = log.changes.filter((c) => isInputVisual(c.after));
  const outputBudget = Math.max(0, maxRows - inputs.length);
  const outputs = log.changes.filter((c) => !isInputVisual(c.after));
  const keptOutputs = new Set(outputs.slice(0, outputBudget));
  // Within one snapshot the input the student changed comes first, then what the outputs did about it.
  const ordered = log.changes
    .map((c, k) => ({ c, k }))
    .sort((a, b) => a.c.time - b.c.time || Number(isInputVisual(b.c.after)) - Number(isInputVisual(a.c.after)) || a.k - b.k)
    .map(({ c }) => c);
  const rows: TraceRow[] = ordered
    .filter((c) => isInputVisual(c.after) || keptOutputs.has(c))
    .map((c) => ({ time: formatTraceTime(c.time), kind: isInputVisual(c.after) ? 'Entrée' : 'Sortie', text: changeText(label(c.componentId), c) }));
  return {
    initialInputs,
    initialOutputs,
    rows,
    omitted: outputs.length - keptOutputs.size + log.dropped,
    duration: Math.max(0, log.lastTime - log.initialTime),
  };
}
