// Automatic schematic from a netlist (the copilot describes circuits as parts + links, not coordinates).
//
// Placement follows the prof's ISIS drawings and the bundled templates:
//   - U1 (PIC16F84A) at the origin, never rotated; RA0..RB7 tips on its right (x = 15);
//   - everything driven by / driving a right-side pin goes in one column to the right of the PIC, top to bottom in
//     pin order (so the fan-out wires never cross): LEDs horizontal with their cathodes on one shared GND bus,
//     LOGICSTATEs mirrored (pointing at the PIC), BUTTONs with their pull-down (or pull-up) resistor, TRAFFIC LIGHTS,
//     7SEG-BCD displays (fed from below, like the traffic and vote templates);
//   - the LDR divider (POWER → TORCH_LDR → node → RES → GND, node → pin) on the left of the PIC, below its pins,
//     as in the traffic template; crystal / reset parts on the left;
//   - anything else in a free row below the drawing.
// Wires inside a part group are drawn explicitly; the PIC ↔ part wires are found by an orthogonal maze router on a
// 0.5 grid that never lets two nets touch (no shared vertex, no T on another net, crossings only at right angles).
// The result is checked with buildNetlist: each requested net is one schematic net, no dangling wire end.
import type { ComponentInstance, ComponentKind, Point, Schematic } from './api';
import { componentBounds, labelLayout, pinTips, transformVector, type PlacedText, type Rotation } from './geometry';
import { buildNetlist, pinKey } from './netlist';
import type { Rect } from './parts/types';
import { getSymbol, symbolFor } from './symbols';
import { UnionFind } from './union-find';

// ------------------------------------------------------------------------------------------------ public types

export type AutoPartKind = 'LED' | 'LOGICSTATE' | 'BUTTON' | 'RES' | '7SEG-BCD' | 'TRAFFIC_LIGHTS' | 'TORCH_LDR' | 'CAP' | 'CRYSTAL';

export const AUTO_PART_KINDS: readonly AutoPartKind[] = [
  'LED', 'LOGICSTATE', 'BUTTON', 'RES', '7SEG-BCD', 'TRAFFIC_LIGHTS', 'TORCH_LDR', 'CAP', 'CRYSTAL',
];

export interface AutoPart {
  /** Identifier used by the links (D1, R1, LS1, VALIDER...). Becomes the component id. */
  ref: string;
  kind: AutoPartKind;
  /** Name shown on the schematic instead of the ref (ISIS custom ID such as X_SUPERIEUR). */
  label?: string;
  /** LED: RED GREEN BLUE YELLOW; 7SEG-BCD: RED BLUE GREEN (French colour names accepted). */
  color?: string;
  /** RES '220' / '10k'; CAP '22pF'; CRYSTAL '20MHz'; LOGICSTATE initial state '0' / '1'; TORCH_LDR light level '0'..'9'. */
  value?: string;
}

/** A wire between two endpoints: 'U1.RA0' (or 'RA0'), 'D1.A', 'R1.2', 'LS1', 'GND', 'VDD'. */
export interface AutoLink { from: string; to: string }

export interface AutoNetlist {
  /** PIC clock (Hz), default 1 MHz. */
  clockHz?: number;
  parts: readonly AutoPart[];
  links: readonly AutoLink[];
}

export type AutoLayoutProblemCode =
  | 'BAD_REF' | 'DUPLICATE_REF' | 'UNKNOWN_KIND' | 'UNKNOWN_PART' | 'UNKNOWN_PIN' | 'SHORT' | 'UNCONNECTED' | 'ROUTE';

export interface AutoLayoutProblem {
  code: AutoLayoutProblemCode;
  /** French, for the student and for the copilot's correction turn. */
  message: string;
  ref?: string;
}

export interface AutoLayoutResult {
  schematic: Schematic;
  problems: AutoLayoutProblem[];
  /** Upper-case part ref → component id in the schematic ('U1' for the PIC). */
  ids: Record<string, string>;
}

/** A resolved endpoint. */
export type AutoEndpoint = { rail: 'GND' | 'VDD' } | { ref: string; pin: string };

export const AUTO_MCU_REF = 'U1';

// ------------------------------------------------------------------------------------------------ endpoints

const PIC_PIN_ALIASES: Readonly<Record<string, string>> = {
  RA0: 'RA0', RA1: 'RA1', RA2: 'RA2', RA3: 'RA3', RA4: 'RA4/T0CKI', 'RA4/T0CKI': 'RA4/T0CKI', T0CKI: 'RA4/T0CKI',
  RB0: 'RB0/INT', 'RB0/INT': 'RB0/INT', INT: 'RB0/INT', RB1: 'RB1', RB2: 'RB2', RB3: 'RB3', RB4: 'RB4', RB5: 'RB5',
  RB6: 'RB6', RB7: 'RB7', OSC1: 'OSC1/CLKIN', 'OSC1/CLKIN': 'OSC1/CLKIN', CLKIN: 'OSC1/CLKIN', OSC2: 'OSC2/CLKOUT',
  'OSC2/CLKOUT': 'OSC2/CLKOUT', CLKOUT: 'OSC2/CLKOUT', MCLR: 'MCLR', '/MCLR': 'MCLR', 'MCLR\\': 'MCLR', '~MCLR': 'MCLR',
};

const RAIL_ALIASES: Readonly<Record<string, 'GND' | 'VDD'>> = {
  GND: 'GND', GROUND: 'GND', MASSE: 'GND', VSS: 'GND', '0V': 'GND', '0': 'GND',
  VDD: 'VDD', VCC: 'VDD', POWER: 'VDD', ALIM: 'VDD', '+5V': 'VDD', '5V': 'VDD', '+VCC': 'VDD', '+5': 'VDD',
};

const PIN_ALIASES: Readonly<Record<AutoPartKind, Readonly<Record<string, string>>>> = {
  LED: { A: 'A', ANODE: 'A', '+': 'A', '1': 'A', K: 'K', C: 'K', CATHODE: 'K', '-': 'K', '2': 'K' },
  LOGICSTATE: { Q0: 'Q0', Q: 'Q0', OUT: 'Q0', S: 'Q0', '1': 'Q0', SORTIE: 'Q0' },
  BUTTON: { '1': '1', '2': '2', A: '1', B: '2' },
  RES: { '1': '1', '2': '2', A: '1', B: '2' },
  CAP: { '1': '1', '2': '2', A: '1', B: '2', '+': '1', '-': '2' },
  CRYSTAL: { '1': '1', '2': '2', A: '1', B: '2' },
  TORCH_LDR: { '1': '1', '2': '2', A: '1', B: '2' },
  '7SEG-BCD': {
    E0: 'E0', E1: 'E1', E2: 'E2', E3: 'E3', D0: 'E0', D1: 'E1', D2: 'E2', D3: 'E3',
    A: 'E0', B: 'E1', C: 'E2', D: 'E3', '0': 'E0', '1': 'E1', '2': 'E2', '3': 'E3',
  },
  TRAFFIC_LIGHTS: {
    R: 'R', ROUGE: 'R', RED: 'R', D0: 'R', A: 'A', O: 'A', ORANGE: 'A', AMBRE: 'A', AMBER: 'A', J: 'A', JAUNE: 'A',
    Y: 'A', YELLOW: 'A', D1: 'A', G: 'G', V: 'G', VERT: 'G', GREEN: 'G', D2: 'G',
  },
};

/** Pin names of each kind, for messages. */
const PIN_LIST: Readonly<Record<AutoPartKind, string>> = {
  LED: 'A (anode), K (cathode)', LOGICSTATE: '(une seule broche : écrire juste la référence)', BUTTON: '1, 2', RES: '1, 2',
  CAP: '1, 2', CRYSTAL: '1, 2', TORCH_LDR: '1, 2', '7SEG-BCD': 'E0, E1, E2, E3', TRAFFIC_LIGHTS: 'R, A, G',
};

const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, '');

/**
 * Resolve 'U1.RA0', 'RA0', 'D1.A', 'LS1', 'GND'... against the parts (case-insensitive).
 * Returns a French error message when the endpoint cannot be resolved.
 */
export function resolveEndpoint(text: string, parts: ReadonlyMap<string, AutoPart>): AutoEndpoint | { error: string; code: 'UNKNOWN_PART' | 'UNKNOWN_PIN' } {
  const raw = norm(String(text ?? ''));
  if (!raw) return { error: 'extrémité vide', code: 'UNKNOWN_PIN' };
  if (RAIL_ALIASES[raw]) return { rail: RAIL_ALIASES[raw] };
  const dot = raw.indexOf('.');
  const head = dot < 0 ? raw : raw.slice(0, dot);
  const tail = dot < 0 ? '' : raw.slice(dot + 1);
  if (head === AUTO_MCU_REF || head === 'PIC' || head === 'PIC16F84A' || head === 'MCU') {
    if (tail === 'VDD' || tail === 'VSS') return { rail: tail === 'VDD' ? 'VDD' : 'GND' };
    const pin = PIC_PIN_ALIASES[tail];
    return pin ? { ref: AUTO_MCU_REF, pin } : { error: `la broche « ${tail || '?'} » n'existe pas sur le PIC16F84A (RA0 à RA4, RB0 à RB7)`, code: 'UNKNOWN_PIN' };
  }
  if (dot < 0 && PIC_PIN_ALIASES[raw] && !parts.has(raw)) return { ref: AUTO_MCU_REF, pin: PIC_PIN_ALIASES[raw] };
  const part = parts.get(head);
  if (!part) return { error: `le composant « ${head} » n'existe pas dans la liste des composants`, code: 'UNKNOWN_PART' };
  if (part.kind === 'LOGICSTATE' && (tail === '' || PIN_ALIASES.LOGICSTATE[tail])) return { ref: head, pin: 'Q0' };
  if (tail === '') return { error: `il faut préciser la broche de ${head} (${PIN_LIST[part.kind]})`, code: 'UNKNOWN_PIN' };
  const pin = PIN_ALIASES[part.kind][tail];
  return pin ? { ref: head, pin } : { error: `${head} (${part.kind}) n'a pas de broche « ${tail} » (broches : ${PIN_LIST[part.kind]})`, code: 'UNKNOWN_PIN' };
}

// ------------------------------------------------------------------------------------------------ geometry helpers

type Dir = 0 | 1 | 2 | 3; // +x, +y, -x, -y
const DX = [1, 0, -1, 0] as const;
const DY = [0, 1, 0, -1] as const;
const RIGHT: Dir = 0;
const DOWN: Dir = 1;
const LEFT: Dir = 2;
const UP: Dir = 3;
const opposite = (d: Dir): Dir => ((d + 2) % 4) as Dir;

function dirOf(v: Point): Dir {
  if (Math.abs(v.x) >= Math.abs(v.y)) return v.x >= 0 ? RIGHT : LEFT;
  return v.y >= 0 ? DOWN : UP;
}

const LED_COLORS: Readonly<Record<string, string>> = {
  RED: 'RED', ROUGE: 'RED', R: 'RED', GREEN: 'GREEN', VERT: 'GREEN', VERTE: 'GREEN', V: 'GREEN', BLUE: 'BLUE', BLEU: 'BLUE',
  BLEUE: 'BLUE', B: 'BLUE', YELLOW: 'YELLOW', JAUNE: 'YELLOW', J: 'YELLOW', ORANGE: 'YELLOW', AMBRE: 'YELLOW',
};
const SEG_COLORS: Readonly<Record<string, string>> = {
  RED: 'RED', ROUGE: 'RED', BLUE: 'BLUE', BLEU: 'BLUE', BLEUE: 'BLUE', GREEN: 'GREEN', VERT: 'GREEN', VERTE: 'GREEN',
};

function rectUnion(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x0 = Math.min(a.x, b.x); const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w); const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function textRect(t: PlacedText, s: string): Rect {
  const w = s.length * t.size * 0.6;
  const x = t.anchor === 'start' ? t.at.x : t.anchor === 'end' ? t.at.x - w : t.at.x - w / 2;
  const y = t.baseline === 'top' ? t.at.y : t.baseline === 'bottom' ? t.at.y - t.size : t.at.y - t.size / 2;
  return { x, y, w, h: t.size };
}

/** Text boxes of the labels ISIS prints next to a component (ref, value, <TEXT>). */
export function labelRects(c: ComponentInstance): Rect[] {
  const symbol = symbolFor(c);
  const l = labelLayout(c);
  const out: Rect[] = [];
  if (c.ref) out.push(textRect(l.ref, c.ref));
  if (symbol.showValue && c.value) out.push(textRect(l.value, c.value));
  if (symbol.showText) out.push(textRect(l.text, '<TEXT>'));
  return out;
}

/** Bounds of a component with its labels. */
function footprint(c: ComponentInstance): Rect {
  let r: Rect = componentBounds(c);
  for (const t of labelRects(c)) r = rectUnion(r, t);
  return r;
}

const rectsOverlap = (a: Rect, b: Rect, gap = 0) =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

// ------------------------------------------------------------------------------------------------ draft

interface DraftWire { points: Point[]; net: number }
interface Port { net: number; at: Point; dir: Dir }

/** Components and wires of a part group, built at an offset, plus where the router must connect it. */
interface Group {
  components: ComponentInstance[];
  wires: DraftWire[];
  ports: Port[];
  /** GND chain ends waiting for the shared bus (stack only). */
  gndEnds: Point[];
}

const emptyGroup = (): Group => ({ components: [], wires: [], ports: [], gndEnds: [] });

function translateGroup(g: Group, dxRaw: number, dyRaw: number): Group {
  // Keep every pin on the 0.5 routing grid.
  const dx = Math.round(dxRaw * 2) / 2;
  const dy = Math.round(dyRaw * 2) / 2;
  const mv = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
  return {
    components: g.components.map((c) => ({ ...c, at: mv(c.at) })),
    wires: g.wires.map((w) => ({ net: w.net, points: w.points.map(mv) })),
    ports: g.ports.map((p) => ({ ...p, at: mv(p.at) })),
    gndEnds: g.gndEnds.map(mv),
  };
}

function groupBounds(g: Group): Rect | null {
  let r: Rect | null = null;
  for (const c of g.components) r = rectUnion(r, footprint(c));
  for (const w of g.wires) for (const p of w.points) r = rectUnion(r, { x: p.x, y: p.y, w: 0, h: 0 });
  return r;
}

/** Local pin tip of a component placed with rotation / mirror at the origin. */
function localTip(kind: ComponentKind, props: Record<string, string | number>, pin: string, rotation: Rotation, mirror = false): Point {
  const p = getSymbol(kind, props).pins.find((q) => q.name === pin);
  if (!p) throw new Error(`pin ${pin}`);
  return transformVector(p.tip, rotation, mirror);
}

/** Rotation that puts `entry` on the left and `exit` on the right, on one horizontal line (2-pin parts). */
function horizontalRotation(kind: ComponentKind, props: Record<string, string | number>, entry: string, exit: string): Rotation | null {
  for (const r of [0, 90, 180, 270] as Rotation[]) {
    const a = localTip(kind, props, entry, r);
    const b = localTip(kind, props, exit, r);
    if (Math.abs(a.y - b.y) < 1e-6 && a.x < b.x) return r;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ router

const STEP = 0.5;
const COST_STEP = 1;
const COST_BEND = 7;
const COST_HALF_LINE = 2.5;
const COST_CROSS = 14;
const COST_NEAR_WIRE = 3;
const COST_LABEL = 4;
const COST_NEAR_BODY = 1.5;

/** Cell flags of other nets' wires. */
const W_NONE = 0;
const W_H = 1; // horizontal interior: crossable vertically
const W_V = 2; // vertical interior: crossable horizontally
const W_SOLID = 3; // vertex, end or crossing: impassable

class Router {
  readonly x0: number;
  readonly y0: number;
  readonly w: number;
  readonly h: number;
  private readonly block: Uint8Array;
  private readonly soft: Float32Array;
  /** Piece id of the wire / pin at a cell (-1 none). Pieces of one net merge as they get connected. */
  private readonly piece: Int32Array;
  private readonly wkind: Uint8Array;
  private readonly pinOut: Int8Array;
  /** Cells where two different nets already cross: nobody may stop or turn there. */
  private readonly cross: Uint8Array;
  private readonly pieceNet: number[] = [];
  private readonly uf: number[] = [];

  constructor(bounds: Rect) {
    this.x0 = Math.floor(bounds.x) - 2;
    this.y0 = Math.floor(bounds.y) - 2;
    this.w = Math.ceil((bounds.w + 4) / STEP) + 1;
    this.h = Math.ceil((bounds.h + 4) / STEP) + 1;
    const n = this.w * this.h;
    this.block = new Uint8Array(n);
    this.soft = new Float32Array(n);
    this.piece = new Int32Array(n).fill(-1);
    this.wkind = new Uint8Array(n);
    this.pinOut = new Int8Array(n).fill(-1);
    this.cross = new Uint8Array(n);
  }

  private ix(x: number): number { return Math.round((x - this.x0) / STEP); }
  private iy(y: number): number { return Math.round((y - this.y0) / STEP); }
  private cell(p: Point): number {
    const i = this.ix(p.x); const j = this.iy(p.y);
    return i < 0 || j < 0 || i >= this.w || j >= this.h ? -1 : j * this.w + i;
  }
  private point(c: number): Point { return { x: this.x0 + (c % this.w) * STEP, y: this.y0 + Math.floor(c / this.w) * STEP }; }

  newPiece(net: number): number {
    const id = this.pieceNet.length;
    this.pieceNet.push(net);
    this.uf.push(id);
    return id;
  }

  root(p: number): number {
    while (this.uf[p] !== p) { this.uf[p] = this.uf[this.uf[p]]; p = this.uf[p]; }
    return p;
  }

  merge(a: number, b: number): void {
    const ra = this.root(a); const rb = this.root(b);
    if (ra !== rb) this.uf[rb] = ra;
  }

  pieceAt(p: Point): number {
    const c = this.cell(p);
    return c < 0 ? -1 : this.piece[c];
  }

  /** Mark a rectangle: hard obstacle (component body) or extra cost. */
  rect(r: Rect, mode: 'block' | number, margin = 0): void {
    const i0 = Math.max(0, Math.ceil((r.x - margin - this.x0) / STEP - 1e-6));
    const i1 = Math.min(this.w - 1, Math.floor((r.x + r.w + margin - this.x0) / STEP + 1e-6));
    const j0 = Math.max(0, Math.ceil((r.y - margin - this.y0) / STEP - 1e-6));
    const j1 = Math.min(this.h - 1, Math.floor((r.y + r.h + margin - this.y0) / STEP + 1e-6));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * this.w + i;
        if (mode === 'block') this.block[c] = 1;
        else this.soft[c] = Math.max(this.soft[c], mode);
      }
    }
  }

  pin(at: Point, piece: number, outward: Dir): void {
    const c = this.cell(at);
    if (c < 0) return;
    this.piece[c] = piece;
    this.pinOut[c] = outward;
    this.wkind[c] = W_SOLID;
  }

  /** Register a wire of `piece` (points on the routing grid). */
  wire(points: readonly Point[], piece: number): void {
    for (let s = 0; s + 1 < points.length; s++) {
      const a = points[s]; const b = points[s + 1];
      const ca = this.cell(a); const cb = this.cell(b);
      if (ca < 0 || cb < 0) continue;
      const horizontal = Math.abs(a.y - b.y) < 1e-9;
      const n = Math.round(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / STEP);
      for (let k = 0; k <= n; k++) {
        const p = { x: a.x + ((b.x - a.x) * k) / Math.max(1, n), y: a.y + ((b.y - a.y) * k) / Math.max(1, n) };
        const c = this.cell(p);
        if (c < 0) continue;
        const interior = k > 0 && k < n;
        if (this.piece[c] >= 0 && this.root(this.piece[c]) !== this.root(piece)) {
          this.wkind[c] = W_SOLID; // two nets cross here
          this.cross[c] = 1;
        } else if (!interior || (this.wkind[c] !== W_NONE && this.wkind[c] !== (horizontal ? W_H : W_V))) this.wkind[c] = W_SOLID;
        else this.wkind[c] = horizontal ? W_H : W_V;
        if (this.piece[c] < 0) this.piece[c] = piece;
      }
    }
    for (const p of points) {
      const c = this.cell(p);
      if (c >= 0) this.wkind[c] = W_SOLID;
    }
  }

  /**
   * Shortest orthogonal path from `start` (leaving in `dir`) to any cell of another piece of the same net.
   * Returns the polyline and the piece it reached, or null.
   */
  route(start: Port, startPiece: number, prefX: number | null): { points: Point[]; reached: number } | null {
    const net = this.pieceNet[startPiece];
    const startRoot = this.root(startPiece);
    const s = this.cell(start.at);
    if (s < 0) return null;
    const N = this.w * this.h;
    const dist = new Float64Array(N * 4).fill(Infinity);
    const prev = new Int32Array(N * 4).fill(-1);
    const heap = new MinHeap();
    const s0 = s * 4 + start.dir;
    dist[s0] = 0;
    heap.push(s0, 0);
    let found = -1;
    let reached = -1;
    while (heap.size > 0) {
      const [state, d] = heap.pop();
      if (d > dist[state]) continue;
      const c = state >> 2;
      const dir = (state & 3) as Dir;
      // Target: a cell owned by another piece of the same net.
      if (c !== s) {
        const pc = this.piece[c];
        if (pc >= 0 && !this.cross[c] && this.pieceNet[pc] === net && this.root(pc) !== startRoot) {
          found = state;
          reached = pc;
          break;
        }
      }
      const crossing = c !== s && this.piece[c] >= 0; // passing straight over another net's wire
      for (let nd = 0 as Dir; nd < 4; nd = (nd + 1) as Dir) {
        if (c === s && nd !== start.dir) continue;
        if (nd === opposite(dir) && c !== s) continue;
        if (crossing && nd !== dir) continue;
        const i = (c % this.w) + DX[nd]; const j = Math.floor(c / this.w) + DY[nd];
        if (i < 0 || j < 0 || i >= this.w || j >= this.h) continue;
        const n = j * this.w + i;
        const pn = this.piece[n];
        let extra = 0;
        if (pn >= 0) {
          if (this.cross[n]) continue;
          const same = this.pieceNet[pn] === net;
          const own = this.root(pn) === startRoot;
          if (own) continue;
          if (same) {
            // Arriving on a pin of the net: only along its pin line.
            if (this.pinOut[n] >= 0 && this.pinOut[n] !== opposite(nd)) continue;
          } else {
            const k = this.wkind[n];
            if (k === W_SOLID) continue;
            if (k === W_H && (nd === LEFT || nd === RIGHT)) continue;
            if (k === W_V && (nd === UP || nd === DOWN)) continue;
            extra += COST_CROSS;
          }
        } else if (this.block[n]) {
          continue;
        }
        const p = this.point(n);
        const horizontal = nd === LEFT || nd === RIGHT;
        let cost = COST_STEP + this.soft[n] + extra;
        if (nd !== dir && c !== s) cost += COST_BEND;
        if (horizontal ? !Number.isInteger(p.y) : !Number.isInteger(p.x)) cost += COST_HALF_LINE;
        cost += this.nearWire(n, horizontal, net);
        if (!horizontal && prefX !== null) cost += 0.02 * Math.abs(p.x - prefX);
        const ns = n * 4 + nd;
        const nd2 = d + cost;
        if (nd2 < dist[ns]) {
          dist[ns] = nd2;
          prev[ns] = state;
          heap.push(ns, nd2);
        }
      }
    }
    if (found < 0) return null;
    const cells: number[] = [];
    for (let st = found; st >= 0; st = prev[st]) cells.push(st >> 2);
    cells.reverse();
    return { points: simplify(cells.map((c) => this.point(c))), reached };
  }

  /** Cost of running next to another net's parallel wire (keeps one grid step between wires). */
  private nearWire(c: number, horizontal: boolean, net: number): number {
    const i = c % this.w; const j = Math.floor(c / this.w);
    let cost = 0;
    const look = (ii: number, jj: number) => {
      if (ii < 0 || jj < 0 || ii >= this.w || jj >= this.h) return;
      const n = jj * this.w + ii;
      const pn = this.piece[n];
      if (pn >= 0 && this.pieceNet[pn] !== net) {
        const k = this.wkind[n];
        if (k === W_SOLID || k === (horizontal ? W_H : W_V)) cost += COST_NEAR_WIRE;
      }
    };
    if (horizontal) { look(i, j - 1); look(i, j + 1); } else { look(i - 1, j); look(i + 1, j); }
    return cost;
  }
}

function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const n = out.length;
    if (n >= 2) {
      const a = out[n - 2]; const b = out[n - 1];
      if ((Math.abs(a.x - b.x) < 1e-9 && Math.abs(b.x - p.x) < 1e-9) || (Math.abs(a.y - b.y) < 1e-9 && Math.abs(b.y - p.y) < 1e-9)) {
        out[n - 1] = p;
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

class MinHeap {
  private readonly keys: number[] = [];
  private readonly vals: number[] = [];
  get size(): number { return this.keys.length; }
  push(key: number, val: number): void {
    const k = this.keys; const v = this.vals;
    k.push(key); v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (v[p] <= val) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop(): [number, number] {
    const k = this.keys; const v = this.vals;
    const topK = k[0]; const topV = v[0];
    const lastK = k.pop()!; const lastV = v.pop()!;
    if (k.length > 0) {
      let i = 0;
      const n = k.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && v[r] < v[l] ? r : l;
        if (v[m] >= lastV) break;
        k[i] = k[m]; v[i] = v[m]; i = m;
      }
      k[i] = lastK; v[i] = lastV;
    }
    return [topK, topV];
  }
}

// ------------------------------------------------------------------------------------------------ layout

interface Net {
  id: number;
  rail?: 'GND' | 'VDD';
  pins: { ref: string; pin: string }[];
}

interface Item {
  parts: AutoPart[];
  /** PIC pins (symbol names) touched by the item's nets. */
  picPins: string[];
}

const LEFT_PINS = new Set(['OSC1/CLKIN', 'OSC2/CLKOUT', 'MCLR']);

function formatClock(hz: number): string {
  if (hz >= 1e6) return `${Math.round((hz / 1e6) * 1000) / 1000}MHz`;
  if (hz >= 1e3) return `${Math.round((hz / 1e3) * 1000) / 1000}kHz`;
  return `${hz}Hz`;
}

const C_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Build a tidy ISIS-like schematic from parts + links. Never throws; problems are reported in French. */
export function autolayout(input: AutoNetlist): AutoLayoutResult {
  const problems: AutoLayoutProblem[] = [];
  const clockHz = input.clockHz && input.clockHz > 0 ? input.clockHz : 1_000_000;

  // -------------------------------------------------------------- parts
  const parts = new Map<string, AutoPart>();
  const ids: Record<string, string> = { [AUTO_MCU_REF]: AUTO_MCU_REF };
  for (const raw of input.parts ?? []) {
    const key = norm(String(raw?.ref ?? ''));
    if (!key || !C_ID.test(key)) {
      problems.push({ code: 'BAD_REF', message: `Référence de composant invalide « ${String(raw?.ref ?? '')} » (lettres, chiffres et _ seulement).`, ref: String(raw?.ref ?? '') });
      continue;
    }
    if (!AUTO_PART_KINDS.includes(raw.kind)) {
      problems.push({ code: 'UNKNOWN_KIND', message: `${key} : type « ${String(raw.kind)} » inconnu (types possibles : ${AUTO_PART_KINDS.join(', ')}).`, ref: key });
      continue;
    }
    if (key === AUTO_MCU_REF || PIC_PIN_ALIASES[key] || RAIL_ALIASES[key] || parts.has(key)) {
      const why = key === AUTO_MCU_REF ? 'elle est réservée au PIC'
        : PIC_PIN_ALIASES[key] ? 'c’est le nom d’une broche du PIC'
          : RAIL_ALIASES[key] ? (RAIL_ALIASES[key] === 'GND' ? 'ce nom est réservé à la masse' : 'ce nom est réservé à l’alimentation')
            : 'un autre composant la porte déjà';
      problems.push({ code: 'DUPLICATE_REF', message: `La référence « ${key} » ne peut pas être utilisée : ${why}.`, ref: key });
      continue;
    }
    parts.set(key, { ...raw, ref: key });
    ids[key] = key;
  }

  // -------------------------------------------------------------- nets
  const uf = new UnionFind();
  const keyOf = (e: AutoEndpoint) => ('rail' in e ? `rail:${e.rail}` : `${e.ref}:${e.pin}`);
  const endpoints = new Map<string, AutoEndpoint>();
  for (const link of input.links ?? []) {
    const a = resolveEndpoint(String(link?.from ?? ''), parts);
    const b = resolveEndpoint(String(link?.to ?? ''), parts);
    const bad = 'error' in a ? a : 'error' in b ? b : null;
    if (bad) {
      problems.push({ code: bad.code, message: `Liaison « ${String(link?.from)} → ${String(link?.to)} » : ${bad.error}.` });
      continue;
    }
    const ea = a as AutoEndpoint; const eb = b as AutoEndpoint;
    const ka = keyOf(ea); const kb = keyOf(eb);
    endpoints.set(ka, ea); endpoints.set(kb, eb);
    const ra = uf.find(ka); const rb = uf.find(kb);
    const gnd = uf.find('rail:GND'); const vdd = uf.find('rail:VDD');
    if ((ra === gnd && rb === vdd) || (ra === vdd && rb === gnd)) {
      problems.push({ code: 'SHORT', message: `Liaison « ${String(link.from)} → ${String(link.to)} » ignorée : elle relierait VDD à GND (court-circuit).` });
      continue;
    }
    uf.union(ka, kb);
  }
  const nets: Net[] = [];
  const netByRoot = new Map<number, Net>();
  const gndRoot = uf.find('rail:GND'); const vddRoot = uf.find('rail:VDD');
  const netOfKey = new Map<string, Net>();
  for (const [key, e] of endpoints) {
    const root = uf.find(key);
    let net = netByRoot.get(root);
    if (!net) {
      net = { id: nets.length, pins: [], ...(root === gndRoot ? { rail: 'GND' as const } : root === vddRoot ? { rail: 'VDD' as const } : {}) };
      netByRoot.set(root, net);
      nets.push(net);
    }
    if (!('rail' in e)) net.pins.push({ ref: e.ref, pin: e.pin });
    netOfKey.set(key, net);
  }
  const netOf = (ref: string, pin: string): Net | undefined => netOfKey.get(`${ref}:${pin}`);
  let nextNet = nets.length;
  const freshNet = () => nextNet++;
  const isPicNet = (n: Net | undefined) => !!n && !n.rail && n.pins.some((p) => p.ref === AUTO_MCU_REF);

  // -------------------------------------------------------------- items (parts glued by non-rail nets)
  const itemUf = new UnionFind();
  for (const ref of parts.keys()) itemUf.id(ref);
  for (const n of nets) {
    if (n.rail) continue;
    const refs = n.pins.map((p) => p.ref).filter((r) => r !== AUTO_MCU_REF);
    for (let i = 1; i < refs.length; i++) itemUf.union(refs[0], refs[i]);
  }
  const itemsByRoot = new Map<number, Item>();
  for (const part of parts.values()) {
    const root = itemUf.find(part.ref);
    let item = itemsByRoot.get(root);
    if (!item) { item = { parts: [], picPins: [] }; itemsByRoot.set(root, item); }
    item.parts.push(part);
  }
  for (const item of itemsByRoot.values()) {
    const pins = new Set<string>();
    for (const part of item.parts) {
      for (const pin of getSymbol(part.kind, propsOf(part)).pins) {
        const n = netOf(part.ref, pin.name);
        if (n && !n.rail) for (const p of n.pins) if (p.ref === AUTO_MCU_REF) pins.add(p.pin);
      }
    }
    item.picPins = [...pins];
    const linked = item.parts.some((part) => getSymbol(part.kind, propsOf(part)).pins.some((pin) => netOf(part.ref, pin.name)));
    if (!linked) {
      problems.push({ code: 'UNCONNECTED', message: `${item.parts.map((p) => p.ref).join(', ')} : aucune liaison, le composant est posé mais branché nulle part.`, ref: item.parts[0].ref });
    }
  }

  // -------------------------------------------------------------- PIC
  const pic: ComponentInstance = {
    id: AUTO_MCU_REF, kind: 'PIC16F84A', ref: AUTO_MCU_REF, value: 'PIC16F84A', at: { x: 0, y: 0 }, rotation: 0,
    props: { clock: formatClock(clockHz), cfgword: '0x3FFB' },
  };
  const picTip = new Map(pinTips(pic).map((p) => [p.name, p.at] as const));
  const rowOf = (pin: string) => picTip.get(pin)?.y ?? 0;

  const usedIds = new Set([AUTO_MCU_REF, ...parts.keys()]);
  const terminalId = (rail: 'GND' | 'VDD') => {
    const prefix = rail === 'GND' ? 'GND' : 'PWR';
    let n = 1;
    while (usedIds.has(`${prefix}${n}`)) n++;
    usedIds.add(`${prefix}${n}`);
    return `${prefix}${n}`;
  };
  const ctx: BuildContext = { netOf, freshNet, isPicNet, terminalId };
  const placed: Group[] = [];

  // -------------------------------------------------------------- right column (stack)
  const items = [...itemsByRoot.values()];
  const rightItems = items.filter((it) => it.picPins.some((p) => !LEFT_PINS.has(p)) && !isLdrItem(it, ctx))
    .sort((a, b) => Math.min(...a.picPins.map(rowOf)) - Math.min(...b.picPins.map(rowOf)));
  const ldrItems = items.filter((it) => it.picPins.some((p) => !LEFT_PINS.has(p)) && isLdrItem(it, ctx));
  const leftItems = items.filter((it) => it.picPins.length > 0 && it.picPins.every((p) => LEFT_PINS.has(p)));
  const looseItems = items.filter((it) => it.picPins.length === 0);

  const built = rightItems.map((it) => buildRightItem(it, ctx, rowOf));
  const portCount = built.reduce((n, b) => n + b.group.ports.length, 0);
  const X = 15 + Math.max(5, Math.min(14, portCount + 3));
  let prevBottom = -Infinity;
  const stack: Group[] = [];
  for (const b of built) {
    const local = groupBounds(b.group) ?? { x: 0, y: 0, w: 0, h: 0 };
    let dy = b.desiredY;
    if (local.y + dy < prevBottom + 1) dy = Math.ceil(prevBottom + 1 - local.y);
    const g = translateGroup(b.group, X, dy);
    stack.push(g);
    prevBottom = local.y + local.h + dy + b.extraBelow;
  }
  attachGndBus(stack, ctx);
  placed.push(...stack);

  // -------------------------------------------------------------- left side: LDR dividers, oscillator / reset parts
  const below = 19;
  ldrItems.forEach((it, i) => placed.push(buildLdrItem(it, ctx, { x: -6 - 16 * i, y: below })));
  let leftX = -6;
  for (const it of leftItems) {
    const osc = buildOscItem(it, ctx);
    if (osc) {
      placed.push(osc);
      const r = groupBounds(osc);
      if (r) leftX = Math.min(leftX, Math.floor(r.x) - 4);
      continue;
    }
    const g = buildGenericItem(it, ctx);
    const r = groupBounds(g) ?? { x: 0, y: 0, w: 0, h: 0 };
    const pinY = Math.min(...it.picPins.map(rowOf));
    const moved = translateGroup(g, Math.round(leftX - (r.x + r.w)), Math.round(pinY - r.y - 3));
    placed.push(moved);
    leftX -= r.w + 4;
  }

  // -------------------------------------------------------------- PIC pins tied straight to a rail
  // (MCLR → VDD, an unused input → GND): a short stub from the pin to its own POWER / GROUND terminal, outward.
  const stubs = emptyGroup();
  for (const n of nets) {
    if (!n.rail) continue;
    for (const p of n.pins) {
      if (p.ref !== AUTO_MCU_REF) continue;
      const def = getSymbol('PIC16F84A', {}).pins.find((q) => q.name === p.pin);
      const tip = picTip.get(p.pin);
      if (!def || !tip) continue;
      const dir = dirOf({ x: def.tip.x - def.base.x, y: def.tip.y - def.base.y });
      terminal(stubs, n.rail, tip, dir, freshNet(), terminalId(n.rail), 2);
    }
  }
  if (stubs.components.length > 0) placed.push(stubs);

  // -------------------------------------------------------------- loose parts: a row below everything
  let all = [pic, ...placed.flatMap((g) => g.components)];
  let bottom = Math.max(...all.map((c) => { const f = footprint(c); return f.y + f.h; }), ...placed.flatMap((g) => g.wires.flatMap((w) => w.points.map((p) => p.y))));
  let looseX = 0;
  for (const it of looseItems) {
    const g = buildGenericItem(it, ctx);
    const r = groupBounds(g) ?? { x: 0, y: 0, w: 0, h: 0 };
    placed.push(translateGroup(g, Math.round(looseX - r.x), Math.round(bottom + 6 - r.y)));
    looseX += Math.ceil(r.w) + 5;
  }

  // -------------------------------------------------------------- route
  all = [pic, ...placed.flatMap((g) => g.components)];
  const wires = placed.flatMap((g) => g.wires);
  let box: Rect | null = null;
  for (const c of all) box = rectUnion(box, footprint(c));
  for (const w of wires) for (const p of w.points) box = rectUnion(box, { x: p.x, y: p.y, w: 0, h: 0 });
  box = box ?? { x: 0, y: 0, w: 15, h: 15 };
  // Room around the drawing for detours (wires around the PIC, below the displays).
  const router = new Router({ x: box.x - 8, y: box.y - 8, w: box.w + 16, h: box.h + 16 });
  const routed = routeAll(router, pic, all, wires, placed.flatMap((g) => g.ports), ctx, nets, problems);

  const schematic: Schematic = {
    clockHz,
    components: all,
    wires: routed.map((w, i) => ({ id: `W${i + 1}`, points: w.points })),
  };
  problems.push(...checkLayout(schematic, nets));
  return { schematic, problems, ids };
}

// ------------------------------------------------------------------------------------------------ part builders

interface BuildContext {
  netOf(ref: string, pin: string): Net | undefined;
  freshNet(): number;
  isPicNet(n: Net | undefined): boolean;
  /** Fresh id for a GROUND / POWER terminal (GND1, PWR1...). */
  terminalId(rail: 'GND' | 'VDD'): string;
}

function propsOf(part: AutoPart): Record<string, string | number> {
  const v = norm(part.value ?? '');
  switch (part.kind) {
    case 'LED': return { color: LED_COLORS[norm(part.color ?? '')] ?? 'RED' };
    case '7SEG-BCD': return { color: SEG_COLORS[norm(part.color ?? '')] ?? 'RED' };
    case 'LOGICSTATE': return { state: v === '1' || v === 'HAUT' || v === 'ON' ? 1 : 0 };
    case 'TORCH_LDR': {
      const level = Number.parseInt(v, 10);
      return { level: Number.isFinite(level) ? Math.max(0, Math.min(9, level)) : 0 };
    }
    default: return {};
  }
}

function valueOf(part: AutoPart, props: Record<string, string | number>): string | undefined {
  switch (part.kind) {
    case 'LED': return `LED-${String(props.color)}`;
    case 'RES': return (part.value ?? '').trim() || '10k';
    case 'CAP': return (part.value ?? '').trim() || '22pF';
    case 'CRYSTAL': return (part.value ?? '').trim() || '20MHz';
    case 'BUTTON': return undefined;
    case 'TORCH_LDR': return 'TORCH_LDR';
    default: return undefined;
  }
}

/** The ref ISIS prints: the label (custom ID), else the ref for parts that show one; LOGICSTATEs show theirs too. */
function shownRef(part: AutoPart): string {
  const label = (part.label ?? '').trim();
  if (label) return label;
  if (part.kind === '7SEG-BCD' || part.kind === 'TRAFFIC_LIGHTS') return '';
  return part.ref;
}

function makeComponent(part: AutoPart, at: Point, rotation: Rotation, mirror = false): ComponentInstance {
  const props = propsOf(part);
  const c: ComponentInstance = { id: part.ref, kind: part.kind, ref: shownRef(part), at: { ...at }, rotation, props };
  const value = valueOf(part, props);
  if (value !== undefined) c.value = value;
  if (mirror) c.mirror = true;
  return c;
}

function tipOf(c: ComponentInstance, pin: string): Point {
  const p = pinTips(c).find((q) => q.name === pin);
  if (!p) throw new Error(`pin ${pin}`);
  return p.at;
}

/** Terminal (GROUND / POWER) whose tip sits `len` grid steps away from `from` in direction `dir`, with its wire. */
function terminal(g: Group, rail: 'GND' | 'VDD', from: Point, dir: Dir, net: number, id: string, len = 2): void {
  const tip = { x: from.x + DX[dir] * len, y: from.y + DY[dir] * len };
  // GROUND tip is local (0,-1) (symbol below it); POWER tip local (0,1) (symbol above it).
  const kind: ComponentKind = rail === 'GND' ? 'GROUND' : 'POWER';
  const rotation: Rotation = rail === 'GND'
    ? ({ [DOWN]: 0, [LEFT]: 90, [UP]: 180, [RIGHT]: 270 } as Record<Dir, Rotation>)[dir]
    : ({ [UP]: 0, [RIGHT]: 90, [DOWN]: 180, [LEFT]: 270 } as Record<Dir, Rotation>)[dir];
  const local = transformVector({ x: 0, y: rail === 'GND' ? -1 : 1 }, rotation);
  g.components.push({ id, kind, ref: '', at: { x: tip.x - local.x, y: tip.y - local.y }, rotation, props: {} });
  g.wires.push({ points: [from, tip], net });
}


interface BuiltItem {
  group: Group;
  /** Wanted vertical offset (aligns the first port with its PIC pin row). */
  desiredY: number;
  /** Free room to keep below the group (wires fed from below a display). */
  extraBelow: number;
}

/** Ordered series chain from a PIC net to a rail (LED → GND, RES → LED → GND, BUTTON → VDD...). */
function chainOf(item: Item, ctx: BuildContext): { steps: { part: AutoPart; entry: string; exit: string }[]; rail: 'GND' | 'VDD' } | null {
  const twoPin = (p: AutoPart) => ['LED', 'RES', 'BUTTON', 'CAP', 'CRYSTAL'].includes(p.kind);
  if (!item.parts.every(twoPin) || item.picPins.length !== 1) return null;
  const pinsOf = (p: AutoPart) => getSymbol(p.kind, propsOf(p)).pins.map((q) => q.name);
  // Start: the part with a pin on the PIC net.
  const remaining = new Set(item.parts);
  const first = item.parts.find((p) => pinsOf(p).some((pin) => ctx.isPicNet(ctx.netOf(p.ref, pin))));
  if (!first) return null;
  let current: AutoPart = first;
  let entry: string = pinsOf(first).find((pin) => ctx.isPicNet(ctx.netOf(first.ref, pin))) ?? '';
  const picNet = ctx.netOf(first.ref, entry);
  if (!picNet || picNet.pins.filter((p) => p.ref !== AUTO_MCU_REF).length !== 1) return null;
  const steps: { part: AutoPart; entry: string; exit: string }[] = [];
  for (;;) {
    remaining.delete(current);
    const part: AutoPart = current;
    const exit: string = pinsOf(part).find((p) => p !== entry) ?? '';
    steps.push({ part, entry, exit });
    const n = ctx.netOf(part.ref, exit);
    if (!n) return null;
    if (n.rail) return remaining.size === 0 ? { steps, rail: n.rail } : null;
    const others: { ref: string; pin: string }[] = n.pins.filter((p) => !(p.ref === part.ref && p.pin === exit));
    if (others.length !== 1 || others[0].ref === AUTO_MCU_REF) return null;
    const next: AutoPart | undefined = item.parts.find((p) => p.ref === others[0].ref);
    if (!next || !remaining.has(next)) return null;
    current = next;
    entry = others[0].pin;
  }
}

function buildRightItem(item: Item, ctx: BuildContext, rowOf: (pin: string) => number): BuiltItem {
  const firstRow = Math.min(...item.picPins.filter((p) => !LEFT_PINS.has(p)).map(rowOf));
  const single = item.parts.length === 1 ? item.parts[0] : null;

  // LOGICSTATE pointing at the PIC (mirrored), its tip on the port.
  if (single?.kind === 'LOGICSTATE') {
    const g = emptyGroup();
    const c = makeComponent(single, { x: 2, y: 0 }, 0, true);
    g.components.push(c);
    const net = ctx.netOf(single.ref, 'Q0');
    if (net) g.ports.push({ net: net.id, at: tipOf(c, 'Q0'), dir: LEFT });
    return { group: g, desiredY: firstRow, extraBelow: 0 };
  }

  // TRAFFIC LIGHTS: three inputs on the left.
  if (single?.kind === 'TRAFFIC_LIGHTS') {
    const g = emptyGroup();
    const c = makeComponent(single, { x: 4, y: 3 }, 0);
    g.components.push(c);
    let firstPort: number | null = null;
    for (const pin of ['R', 'A', 'G']) {
      const net = ctx.netOf(single.ref, pin);
      if (!net) continue;
      if (net.rail) { terminal(g, net.rail, tipOf(c, pin), LEFT, ctx.freshNet(), ctx.terminalId(net.rail)); continue; }
      const at = tipOf(c, pin);
      firstPort ??= at.y;
      g.ports.push({ net: net.id, at, dir: LEFT });
    }
    return { group: g, desiredY: firstRow - (firstPort ?? 0), extraBelow: 0 };
  }

  // 7SEG-BCD: inputs at the bottom, fed from below (wires come up into E3..E0).
  if (single?.kind === '7SEG-BCD') {
    const g = emptyGroup();
    const c = makeComponent(single, { x: 2, y: 0 }, 0);
    g.components.push(c);
    let n = 0;
    for (const pin of ['E3', 'E2', 'E1', 'E0']) {
      const net = ctx.netOf(single.ref, pin);
      if (!net) continue;
      if (net.rail) { terminal(g, net.rail, tipOf(c, pin), DOWN, ctx.freshNet(), ctx.terminalId(net.rail)); continue; }
      g.ports.push({ net: net.id, at: tipOf(c, pin), dir: DOWN });
      n++;
    }
    const rows = item.picPins.map(rowOf);
    // Tips just below the lowest of its rows when free, so the wires are short.
    return { group: g, desiredY: Math.max(...rows) + 2 - 10.5, extraBelow: n + 2 };
  }

  // BUTTON with a pull resistor (pull-down: BUTTON → VDD, RES → GND; or the reverse).
  const pull = pullOf(item, ctx);
  if (pull) return { group: buildPullItem(pull, ctx), desiredY: firstRow, extraBelow: 0 };

  // Series chain to a rail: LED (+ RES), BUTTON alone... drawn left to right from the port.
  const chain = chainOf(item, ctx);
  if (chain) {
    const g = emptyGroup();
    let prevOut: Point | null = null;
    for (let i = 0; i < chain.steps.length; i++) {
      const { part, entry, exit } = chain.steps[i];
      const props = propsOf(part);
      const rotation = horizontalRotation(part.kind, props, entry, exit) ?? 0;
      const e = localTip(part.kind, props, entry, rotation);
      const x = prevOut ? prevOut.x + 2 : 0;
      const c = makeComponent(part, { x: x - e.x, y: -e.y }, rotation);
      g.components.push(c);
      const inAt = tipOf(c, entry);
      const net = ctx.netOf(part.ref, entry);
      if (prevOut && net) g.wires.push({ points: [prevOut, inAt], net: net.id });
      else if (net) g.ports.push({ net: net.id, at: inAt, dir: LEFT });
      prevOut = tipOf(c, exit);
    }
    if (prevOut && chain.rail === 'GND') {
      g.gndEnds.push(prevOut);
    } else if (prevOut) {
      const net = ctx.freshNet();
      const corner = { x: prevOut.x + 2, y: prevOut.y };
      g.wires.push({ points: [prevOut, corner], net });
      terminal(g, 'VDD', corner, UP, net, ctx.terminalId('VDD'), 2);
    }
    return { group: g, desiredY: firstRow, extraBelow: 0 };
  }

  // Anything else: generic placement, routed.
  const g = buildGenericItem(item, ctx);
  const r = groupBounds(g) ?? { x: 0, y: 0, w: 0, h: 0 };
  return { group: translateGroup(g, Math.round(-r.x + 2), 0), desiredY: Math.round(firstRow - r.y), extraBelow: 2 };
}

interface Pull {
  button: AutoPart;
  buttonNode: string;
  buttonRail: string;
  res: AutoPart;
  resNode: string;
  resRail: string;
  /** Rail of the button (VDD for the pull-down wiring the course uses: active high). */
  rail: 'GND' | 'VDD';
  node: Net;
}

function pullOf(item: Item, ctx: BuildContext): Pull | null {
  if (item.parts.length !== 2 || item.picPins.length !== 1) return null;
  const button = item.parts.find((p) => p.kind === 'BUTTON' || p.kind === 'LOGICSTATE');
  const res = item.parts.find((p) => p.kind === 'RES');
  if (!button || !res || button.kind !== 'BUTTON') return null;
  const ends = (p: AutoPart) => {
    const [a, b] = ['1', '2'].map((pin) => ({ pin, net: ctx.netOf(p.ref, pin) }));
    if (a.net && ctx.isPicNet(a.net) && b.net?.rail) return { node: a.pin, rail: b.pin, nodeNet: a.net, railName: b.net.rail };
    if (b.net && ctx.isPicNet(b.net) && a.net?.rail) return { node: b.pin, rail: a.pin, nodeNet: b.net, railName: a.net.rail };
    return null;
  };
  const be = ends(button); const re = ends(res);
  if (!be || !re || be.nodeNet !== re.nodeNet || be.railName === re.railName) return null;
  if (be.nodeNet.pins.filter((p) => p.ref !== AUTO_MCU_REF).length !== 2) return null;
  return { button, buttonNode: be.node, buttonRail: be.rail, res, resNode: re.node, resRail: re.rail, rail: be.railName, node: be.nodeNet };
}

/** Port → node wire → BUTTON → rail; pull resistor hanging from the node wire to the other rail (pupitre VALIDER). */
function buildPullItem(p: Pull, ctx: BuildContext): Group {
  const g = emptyGroup();
  const bProps = propsOf(p.button);
  const bRot = horizontalRotation('BUTTON', bProps, p.buttonNode, p.buttonRail) ?? 0;
  const bEntry = localTip('BUTTON', bProps, p.buttonNode, bRot);
  const button = makeComponent(p.button, { x: 5 - bEntry.x, y: -bEntry.y }, bRot);
  g.components.push(button);
  g.wires.push({ points: [{ x: 0, y: 0 }, tipOf(button, p.buttonNode)], net: p.node.id });
  g.ports.push({ net: p.node.id, at: { x: 0, y: 0 }, dir: LEFT });
  // Button → its rail: VDD up (POWER above), GND down.
  const out = tipOf(button, p.buttonRail);
  const corner = { x: out.x + 2, y: 0 };
  const bNet = ctx.freshNet();
  g.wires.push({ points: [out, corner], net: bNet });
  terminal(g, p.rail, corner, p.rail === 'VDD' ? UP : DOWN, bNet, ctx.terminalId(p.rail), 1);
  // Resistor from the node to the other rail: down to GND for a pull-down, up to VDD for a pull-up.
  const resRail: 'GND' | 'VDD' = p.rail === 'VDD' ? 'GND' : 'VDD';
  const down = resRail === 'GND';
  const rProps = propsOf(p.res);
  // vertical: node pin at the top (pull-down) or at the bottom (pull-up)
  let rRot: Rotation = 90;
  for (const r of [90, 270] as Rotation[]) {
    const a = localTip('RES', rProps, p.resNode, r);
    const b = localTip('RES', rProps, p.resRail, r);
    if (down ? a.y < b.y : a.y > b.y) { rRot = r; break; }
  }
  const nodeLocal = localTip('RES', rProps, p.resNode, rRot);
  const nodeTip = { x: 1, y: down ? 1 : -1 };
  const res = makeComponent(p.res, { x: nodeTip.x - nodeLocal.x, y: nodeTip.y - nodeLocal.y }, rRot);
  g.components.push(res);
  g.wires.push({ points: [nodeTip, { x: 1, y: 0 }], net: p.node.id });
  terminal(g, resRail, tipOf(res, p.resRail), down ? DOWN : UP, ctx.freshNet(), ctx.terminalId(resRail), 1);
  return g;
}

/**
 * Shared GND bus to the right of the column, one per run of consecutive LED chains, with one GROUND under the last
 * cathode of the run (the prof's common cathode to a single GROUND).
 */
function attachGndBus(stack: Group[], ctx: BuildContext): void {
  const runs: Group[][] = [];
  let run: Group[] = [];
  for (const g of stack) {
    if (g.gndEnds.length > 0) run.push(g);
    else if (run.length > 0) { runs.push(run); run = []; }
  }
  if (run.length > 0) runs.push(run);
  for (const groups of runs) {
    const ends = groups.flatMap((g) => g.gndEnds);
    const yTop = Math.min(...ends.map((e) => e.y));
    const yBottom = Math.max(...ends.map((e) => e.y));
    // Right edge of everything the bus and its GROUND run past.
    let right = Math.max(...ends.map((e) => e.x)) + 1;
    for (const g of stack) {
      const r = groupBounds(g);
      if (r && r.y < yBottom + 4 && r.y + r.h > yTop - 0.5) right = Math.max(right, r.x + r.w);
    }
    const xBus = Math.ceil(right + 1.5);
    const net = ctx.freshNet();
    const host = groups[groups.length - 1];
    for (const e of ends) host.wires.push({ points: [e, { x: xBus, y: e.y }], net });
    const tip = { x: xBus, y: yBottom + 2 };
    host.wires.push({ points: [{ x: xBus, y: yTop }, tip], net });
    host.components.push({ id: ctx.terminalId('GND'), kind: 'GROUND', ref: '', at: { x: tip.x, y: tip.y + 1 }, rotation: 0, props: {} });
  }
}

/** Ch1 drawing: crystal between OSC1 and OSC2 on the left, its 22 pF capacitors to GND further left. */
function buildOscItem(item: Item, ctx: BuildContext): Group | null {
  const xtal = item.parts.filter((p) => p.kind === 'CRYSTAL');
  if (xtal.length !== 1 || !item.parts.every((p) => p.kind === 'CRYSTAL' || p.kind === 'CAP')) return null;
  const x = xtal[0];
  const g = emptyGroup();
  const c = makeComponent(x, { x: -6, y: 0.5 }, 0);
  g.components.push(c);
  for (const pin of ['1', '2']) {
    const n = ctx.netOf(x.ref, pin);
    if (!n) continue;
    if (n.rail) { terminal(g, n.rail, tipOf(c, pin), pin === '1' ? UP : DOWN, ctx.freshNet(), ctx.terminalId(n.rail)); continue; }
    g.ports.push({ net: n.id, at: tipOf(c, pin), dir: pin === '1' ? UP : DOWN });
  }
  // Capacitors: horizontal, node pin on the right, rail pin on a GROUND to the left.
  const caps = item.parts.filter((p) => p.kind === 'CAP');
  caps.forEach((cap, i) => {
    const pins = ['1', '2'];
    const nodePin = pins.find((pin) => { const n = ctx.netOf(cap.ref, pin); return n && !n.rail; }) ?? '1';
    const railPin = nodePin === '1' ? '2' : '1';
    const props = propsOf(cap);
    const rot = horizontalRotation('CAP', props, railPin, nodePin) ?? 0;
    const nodeLocal = localTip('CAP', props, nodePin, rot);
    const y = i === 0 ? -3 : 5;
    const cc = makeComponent(cap, { x: -10 - nodeLocal.x, y: y - nodeLocal.y }, rot);
    g.components.push(cc);
    const n = ctx.netOf(cap.ref, nodePin);
    if (n && !n.rail) g.ports.push({ net: n.id, at: tipOf(cc, nodePin), dir: RIGHT });
    const rail = ctx.netOf(cap.ref, railPin)?.rail;
    if (rail) terminal(g, rail, tipOf(cc, railPin), LEFT, ctx.freshNet(), ctx.terminalId(rail));
  });
  return g;
}

function isLdrItem(item: Item, ctx: BuildContext): boolean {
  return item.picPins.length === 1 && item.parts.some((p) => p.kind === 'TORCH_LDR')
    && item.parts.every((p) => p.kind === 'TORCH_LDR' || p.kind === 'RES') && item.parts.length <= 2
    && item.parts.every((p) => ['1', '2'].some((pin) => ctx.netOf(p.ref, pin)?.rail));
}

/** POWER → TORCH_LDR → node → RES → GND, node → PIC pin (traffic template), with the node at `node`. */
function buildLdrItem(item: Item, ctx: BuildContext, node: Point): Group {
  const g = emptyGroup();
  const ldr = item.parts.find((p) => p.kind === 'TORCH_LDR')!;
  const res = item.parts.find((p) => p.kind === 'RES');
  const ldrNode = ['1', '2'].find((pin) => ctx.isPicNet(ctx.netOf(ldr.ref, pin))) ?? '2';
  const ldrRailPin = ldrNode === '1' ? '2' : '1';
  const ldrRail = ctx.netOf(ldr.ref, ldrRailPin)?.rail ?? 'VDD';
  const nodeNet = ctx.netOf(ldr.ref, ldrNode)!;
  // LDR above the node (its rail at the top) when it goes to VDD, below otherwise.
  const ldrAbove = ldrRail === 'VDD' || !res;
  const props = propsOf(ldr);
  // TORCH_LDR pins are vertical on the right of the torch: pin 1 (2,-3) top, pin 2 (2,3) bottom. Upright when the
  // pin wired to the node already faces it, else half a turn.
  const rot: Rotation = (ldrNode === '2') === ldrAbove ? 0 : 180;
  const nodeLocal = localTip('TORCH_LDR', props, ldrNode, rot);
  const nodeTip = { x: node.x, y: node.y + (ldrAbove ? -3 : 3) };
  const c = makeComponent(ldr, { x: nodeTip.x - nodeLocal.x, y: nodeTip.y - nodeLocal.y }, rot);
  g.components.push(c);
  g.wires.push({ points: [tipOf(c, ldrNode), node], net: nodeNet.id });
  terminal(g, ldrRail, tipOf(c, ldrRailPin), ldrAbove ? UP : DOWN, ctx.freshNet(), ctx.terminalId(ldrRail), 2);
  if (res) {
    const rNode = ['1', '2'].find((pin) => ctx.netOf(res.ref, pin) === nodeNet) ?? '1';
    const rRailPin = rNode === '1' ? '2' : '1';
    const rRail = ctx.netOf(res.ref, rRailPin)?.rail ?? 'GND';
    const rProps = propsOf(res);
    let rRot: Rotation = 90;
    for (const r of [90, 270] as Rotation[]) {
      const a = localTip('RES', rProps, rNode, r);
      const b = localTip('RES', rProps, rRailPin, r);
      if (ldrAbove ? a.y < b.y : a.y > b.y) { rRot = r; break; }
    }
    const rLocal = localTip('RES', rProps, rNode, rRot);
    const rTip = { x: node.x, y: node.y + (ldrAbove ? 2 : -2) };
    const rc = makeComponent(res, { x: rTip.x - rLocal.x, y: rTip.y - rLocal.y }, rRot);
    g.components.push(rc);
    g.wires.push({ points: [node, rTip], net: nodeNet.id });
    terminal(g, rRail, tipOf(rc, rRailPin), ldrAbove ? DOWN : UP, ctx.freshNet(), ctx.terminalId(rRail), 2);
  }
  g.ports.push({ net: nodeNet.id, at: node, dir: RIGHT });
  return g;
}

/** Parts in a row (unrotated), rails on local terminals, every other net left to the router. */
function buildGenericItem(item: Item, ctx: BuildContext): Group {
  const g = emptyGroup();
  let x = 0;
  for (const part of item.parts) {
    const f = footprint(makeComponent(part, { x: 0, y: 0 }, 0));
    const c = makeComponent(part, { x: x - Math.floor(f.x), y: 0 }, 0);
    g.components.push(c);
    for (const tip of pinTips(c)) {
      const net = ctx.netOf(part.ref, tip.name);
      if (!net) continue;
      const pinDef = symbolFor(c).pins.find((q) => q.name === tip.name)!;
      const out = dirOf(transformVector({ x: pinDef.tip.x - pinDef.base.x, y: pinDef.tip.y - pinDef.base.y }, c.rotation, c.mirror));
      if (net.rail) terminal(g, net.rail, tip.at, out, ctx.freshNet(), ctx.terminalId(net.rail), 2);
      else g.ports.push({ net: net.id, at: tip.at, dir: out });
    }
    x += Math.ceil(f.w) + 5;
  }
  return g;
}

// ------------------------------------------------------------------------------------------------ routing

function routeAll(
  router: Router, pic: ComponentInstance, components: readonly ComponentInstance[], wires: readonly DraftWire[],
  ports: readonly Port[], ctx: BuildContext, nets: readonly Net[], problems: AutoLayoutProblem[],
): DraftWire[] {
  const out: DraftWire[] = [...wires];
  // Obstacles: bodies, labels, a thin cost halo around bodies.
  for (const c of components) {
    const b = componentBounds(c);
    router.rect(b, 'block');
    router.rect(b, COST_NEAR_BODY, 0.5);
    for (const t of labelRects(c)) router.rect(t, COST_LABEL, 0.2);
  }
  // Pieces: every pin is a piece; every explicit wire joins the pieces it touches.
  const pinPiece = new Map<string, number>();
  for (const c of components) {
    const symbol = symbolFor(c);
    for (const tip of pinTips(c)) {
      const n = c.id === AUTO_MCU_REF ? ctx.netOf(AUTO_MCU_REF, tip.name) : ctx.netOf(c.id, tip.name);
      const netId = n && !n.rail ? n.id : ctx.freshNet();
      const piece = router.newPiece(netId);
      const def = symbol.pins.find((q) => q.name === tip.name)!;
      const outward = dirOf(transformVector({ x: def.tip.x - def.base.x, y: def.tip.y - def.base.y }, c.rotation, c.mirror));
      router.pin(tip.at, piece, outward);
      pinPiece.set(pinKey(c.id, tip.name), piece);
    }
  }
  // Explicit wires: one piece each, merged with the pins on their vertices and with the wires they meet
  // (shared vertex or an end on the other's segment, exactly like buildNetlist).
  const wirePieces = wires.map((w) => router.newPiece(w.net));
  wires.forEach((w, i) => {
    for (const p of w.points) {
      const pinP = router.pieceAt(p);
      if (pinP >= 0) router.merge(wirePieces[i], pinP);
    }
  });
  for (let i = 0; i < wires.length; i++) {
    for (let j = 0; j < wires.length; j++) {
      if (i !== j && wiresTouch(wires[i].points, wires[j].points)) router.merge(wirePieces[i], wirePieces[j]);
    }
  }
  wires.forEach((w, i) => router.wire(w.points, wirePieces[i]));

  // Route each port to the rest of its net, top PIC rows first (nested fan-out, no crossings).
  const picY = (net: number) => {
    const n = nets[net];
    const ys = n?.pins.filter((p) => p.ref === AUTO_MCU_REF).map((p) => tipOf(pic, p.pin).y) ?? [];
    return ys.length ? Math.min(...ys) : Infinity;
  };
  const order = [...ports].sort((a, b) => picY(a.net) - picY(b.net) || a.at.y - b.at.y || a.at.x - b.at.x);
  const netPieces = (net: Net) => {
    const roots = new Set<number>();
    for (const p of net.pins) {
      const piece = pinPiece.get(pinKey(p.ref, p.pin));
      if (piece !== undefined) roots.add(router.root(piece));
    }
    return roots;
  };
  const tryRoute = (port: Port, piece: number, n: Net): boolean => {
    const toPic = n.pins.some((p) => p.ref === AUTO_MCU_REF);
    const prefX = toPic ? (port.at.x > 15 ? port.at.x - 1.5 : 16) : null;
    const r = router.route(port, piece, prefX);
    if (!r) return false;
    const wp = router.newPiece(n.id);
    router.merge(wp, piece);
    router.merge(wp, r.reached);
    router.wire(r.points, wp);
    out.push({ points: r.points, net: n.id });
    return true;
  };
  for (const port of order) {
    const piece = router.pieceAt(port.at);
    const n = nets[port.net];
    if (piece < 0 || !n) continue;
    const roots = netPieces(n);
    if (roots.size <= 1 && roots.has(router.root(piece))) continue;
    tryRoute(port, piece, n);
  }
  // Nets still in several pieces: start from their pins (a port may be boxed in by its own wires).
  for (const n of nets) {
    if (n.rail || n.pins.length < 2) continue;
    for (const p of n.pins) {
      if (netPieces(n).size <= 1) break;
      const piece = pinPiece.get(pinKey(p.ref, p.pin));
      const c = components.find((x) => x.id === p.ref);
      if (piece === undefined || !c) continue;
      const def = symbolFor(c).pins.find((q) => q.name === p.pin)!;
      const dir = dirOf(transformVector({ x: def.tip.x - def.base.x, y: def.tip.y - def.base.y }, c.rotation, c.mirror));
      tryRoute({ net: n.id, at: tipOf(c, p.pin), dir }, piece, n);
    }
    if (netPieces(n).size > 1) {
      problems.push({ code: 'ROUTE', message: `Fil introuvable pour ${describePort(n)} : placez ce fil à la main dans le schéma.` });
    }
  }
  return out;
}

function onSegment(p: Point, a: Point, b: Point): boolean {
  const eps = 1e-6;
  if (Math.abs(a.x - b.x) < eps) return Math.abs(p.x - a.x) < eps && p.y >= Math.min(a.y, b.y) - eps && p.y <= Math.max(a.y, b.y) + eps;
  if (Math.abs(a.y - b.y) < eps) return Math.abs(p.y - a.y) < eps && p.x >= Math.min(a.x, b.x) - eps && p.x <= Math.max(a.x, b.x) + eps;
  return false;
}

/** Two polylines are connected for ISIS: a shared vertex, or an end of one on a segment of the other. */
function wiresTouch(a: readonly Point[], b: readonly Point[]): boolean {
  const same = (p: Point, q: Point) => Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6;
  if (a.some((p) => b.some((q) => same(p, q)))) return true;
  const ends = [a[0], a[a.length - 1]];
  for (const e of ends) for (let s = 0; s + 1 < b.length; s++) if (onSegment(e, b[s], b[s + 1])) return true;
  return false;
}

function describePort(n: Net | undefined): string {
  return n ? n.pins.map((p) => `${p.ref}.${p.pin}`).join(' — ') : 'une liaison';
}

// ------------------------------------------------------------------------------------------------ checks

/**
 * The drawing implements the requested nets: every net is one schematic net, two nets never touch, rails reach
 * their terminals, no wire end is left dangling. Problems are French.
 */
function checkLayout(schematic: Schematic, nets: readonly Net[]): AutoLayoutProblem[] {
  const out: AutoLayoutProblem[] = [];
  const nl = buildNetlist(schematic);
  const seen = new Map<string, number>();
  for (const n of nets) {
    const ids = n.pins.map((p) => nl.pinToNet.get(pinKey(p.ref, p.pin))).filter((x): x is string => !!x);
    const uniq = new Set(ids);
    if (n.rail) {
      for (const p of n.pins) {
        const id = nl.pinToNet.get(pinKey(p.ref, p.pin));
        if (id !== n.rail) out.push({ code: 'ROUTE', message: `${p.ref}.${p.pin} devrait être relié à ${n.rail} mais ne l'est pas sur le schéma.` });
      }
      continue;
    }
    if (uniq.size > 1) out.push({ code: 'ROUTE', message: `Les broches ${n.pins.map((p) => `${p.ref}.${p.pin}`).join(', ')} ne sont pas toutes reliées sur le schéma.` });
    for (const id of uniq) {
      const prev = seen.get(id);
      if (prev !== undefined && prev !== n.id) out.push({ code: 'ROUTE', message: `Deux liaisons différentes se touchent sur le schéma (${n.pins.map((p) => `${p.ref}.${p.pin}`).join(', ')}).` });
      seen.set(id, n.id);
      if (id === 'GND' || id === 'VDD') out.push({ code: 'ROUTE', message: `${n.pins.map((p) => `${p.ref}.${p.pin}`).join(', ')} touche ${id} sur le schéma alors qu'il ne devrait pas.` });
    }
  }
  if (nl.dangling.length > 0) out.push({ code: 'ROUTE', message: `${nl.dangling.length} fil(s) du schéma ne mène(nt) nulle part.` });
  return out;
}

/** Pairs of components whose bodies overlap, for tests and diagnostics. */
export function layoutOverlaps(schematic: Schematic): [string, string][] {
  const out: [string, string][] = [];
  const cs = schematic.components;
  const boxes = cs.map((c) => componentBounds(c));
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      if (rectsOverlap(boxes[i], boxes[j], -0.01)) out.push([cs[i].id, cs[j].id]);
    }
  }
  return out;
}

/** Wire segments passing through a component body (other than along its own pin line), for tests. */
export function wiresThroughBodies(schematic: Schematic): string[] {
  const out: string[] = [];
  for (const w of schematic.wires) {
    for (let s = 0; s + 1 < w.points.length; s++) {
      const a = w.points[s]; const b = w.points[s + 1];
      const len = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      const n = Math.max(1, Math.round(len / 0.5));
      for (const c of schematic.components) {
        const r = componentBounds(c);
        for (let k = 1; k < n; k++) {
          const p = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
          if (p.x > r.x + 0.01 && p.x < r.x + r.w - 0.01 && p.y > r.y + 0.01 && p.y < r.y + r.h - 0.01) {
            out.push(`${w.id}→${c.id}`);
            break;
          }
        }
      }
    }
  }
  return [...new Set(out)];
}
