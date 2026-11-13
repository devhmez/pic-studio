// Raw records of a Proteus ISIS .DSN binary (reverse engineered, research/05 §6). TypeScript port of
// research/05_dsn_parser/dsn.py + netlist.py:build. Coordinates stay in DSN units (10 nm, Y axis UP).
import { ByteReader, ascii, isDigit, isUpper, lengthPrefixed } from './bytes';

/** One grid step (100 thou) in DSN units of 10 nm. */
export const DSN_UNIT = 254000;

const PIN_LENGTH: Readonly<Record<string, number>> = { $PINDEFAULT: 2 * DSN_UNIT, $PINSHORT: DSN_UNIT };
const TERMINAL_NODE: Readonly<Record<string, readonly [number, number]>> = {
  $TERGROUND: [0, DSN_UNIT], $TERPOWER: [0, -DSN_UNIT], $TERDEFAULT: [DSN_UNIT, 0],
  $TERINPUT: [DSN_UNIT, 0], $TEROUTPUT: [-DSN_UNIT, 0], $TERBIDIR: [-DSN_UNIT, 0],
};
const LABEL_KINDS = ['COMPONENT ID', 'COMPONENT VALUE', 'SUBCKT NAME', 'TERMINAL LABEL', 'WIRE LABEL', 'PROPERTIES'] as const;
type LabelKind = (typeof LABEL_KINDS)[number];

export interface RawPoint { x: number; y: number }

export interface RawLibPin {
  offset: number;
  style: string;
  x: number;
  y: number;
  angle10: number;
  mirror: number;
  name: string;
  number: string;
}

export interface RawPin { name: string; number: string; tip: RawPoint }

export interface RawComponent {
  offset: number;
  device: string;
  x: number;
  y: number;
  /** Rotation in tenths of a degree, counter-clockwise (Y up). */
  angle10: number;
  /** Bit 0 = X mirror, bit 1 = Y mirror. */
  mirror: number;
  ref: string;
  value: string;
  /** Property block text (`{CLOCK=1MHz}{CFGWORD=0x3FFB}...`), or '' when the part has no own block. */
  props: string;
  /** STATE stored in the PROPERTIES label just before an RTDSTATE / RTSWITCH part (LOGICSTATE, TORCH_LDR). */
  state: string | null;
  pins: RawPin[];
}

export interface RawTerminal {
  offset: number;
  kind: string;
  x: number;
  y: number;
  angle10: number;
  mirror: number;
  label: string;
  node: RawPoint;
}

export interface RawWire { offset: number; points: RawPoint[] }

export interface RawDsn {
  components: RawComponent[];
  terminals: RawTerminal[];
  wires: RawWire[];
}

interface RawLabel { offset: number; kind: LabelKind; text: string | null }

/** Mirror bits first, then CCW rotation by a multiple of 90° (DSN convention, Y up). */
export function dsnTransform(p: RawPoint, angle10: number, mirror: number): RawPoint {
  let { x, y } = p;
  if (mirror & 1) x = -x;
  if (mirror & 2) y = -y;
  const a = (angle10 / 10) * (Math.PI / 180);
  const c = Math.round(Math.cos(a));
  const s = Math.round(Math.sin(a));
  return { x: x * c - y * s, y: x * s + y * c };
}

const NAME_CHAR = (b: number) => isUpper(b) || isDigit(b) || b === 0x5f || b === 0x2d || b === 0x2b || b === 0x20;

export class DsnReader {
  private readonly r: ByteReader;
  readonly libEnd: number;
  readonly objStart: number;
  readonly objEnd: number;

  constructor(bytes: Uint8Array) {
    this.r = new ByteReader(bytes);
    if (this.r.indexOf(ascii('ISIS SCHEMATIC FILE'), 0, 32) !== 0) {
      throw new Error('Fichier DSN invalide : en-tête « ISIS SCHEMATIC FILE » introuvable.');
    }
    const circuits = this.r.findAll(ascii('ISIS CIRCUIT FILE'));
    if (circuits.length < 2) throw new Error('Fichier DSN invalide : sections « ISIS CIRCUIT FILE » manquantes.');
    const objectData = this.r.indexOf(ascii('OBJECT DATA'), circuits[0]);
    if (objectData < 0) throw new Error('Fichier DSN invalide : section « OBJECT DATA » introuvable.');
    this.libEnd = circuits[0];
    this.objStart = objectData + 'OBJECT DATA'.length;
    this.objEnd = circuits[1];
  }

  read(): RawDsn {
    return { components: this.components(), terminals: this.terminals(), wires: this.wires() };
  }

  /**
   * Every `[len][A-Z0-9 _-+]*` string of 2..40 bytes in the library area, in file order. These are the
   * candidate library device names; a pin belongs to the closest one before it.
   */
  private libraryNameOccurrences(): { offset: number; name: string }[] {
    const { bytes } = this.r;
    const out: { offset: number; name: string }[] = [];
    for (let p = 0; p < this.libEnd - 2; p++) {
      const len = bytes[p];
      if (len < 2 || len > 40 || p + 1 + len > this.libEnd) continue;
      const first = bytes[p + 1];
      if (!(isUpper(first) || isDigit(first))) continue;
      let ok = true;
      for (let k = 2; k <= len && ok; k++) ok = NAME_CHAR(bytes[p + k]);
      if (ok) out.push({ offset: p, name: this.r.text(p + 1, p + 1 + len) });
    }
    return out;
  }

  private libraryPins(): RawLibPin[] {
    const out: RawLibPin[] = [];
    const { r } = this;
    for (let p = r.indexOf(ascii('$PIN'), 0, this.libEnd); p >= 0; p = r.indexOf(ascii('$PIN'), p + 1, this.libEnd)) {
      let q = p + 4;
      while (q < this.libEnd && isUpper(r.u8(q))) q++;
      if (q === p + 4 || r.u8(q) !== 0) continue;
      const style = r.text(p, q);
      const nameStart = q + 1;
      const nameEnd = r.nul(nameStart);
      const numberEnd = r.nul(nameEnd + 1);
      out.push({
        offset: p, style,
        x: r.i32(p - 12), y: r.i32(p - 8), angle10: r.i16(p - 4), mirror: r.u8(p - 2),
        name: r.text(nameStart, nameEnd), number: r.text(nameEnd + 1, numberEnd),
      });
    }
    return out;
  }

  /** Library pins grouped by the library device that precedes them. */
  private pinsByDevice(): Map<string, RawLibPin[]> {
    const occurrences = this.libraryNameOccurrences();
    const byDevice = new Map<string, RawLibPin[]>();
    for (const pin of this.libraryPins()) {
      let lo = 0;
      let hi = occurrences.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (occurrences[mid].offset < pin.offset) lo = mid + 1; else hi = mid;
      }
      const owner = occurrences[lo - 1];
      if (!owner) continue;
      const list = byDevice.get(owner.name) ?? [];
      list.push(pin);
      byDevice.set(owner.name, list);
    }
    return byDevice;
  }

  private labels(): RawLabel[] {
    const { r } = this;
    const out: RawLabel[] = [];
    const marker = ascii('Default Font\0');
    for (const p of r.findAll(marker, this.objStart, this.objEnd)) {
      const after = p + marker.length;
      const kind = LABEL_KINDS.find((k) => r.indexOf(ascii(`${k}\0`), after, after + k.length + 1) === after);
      if (!kind) continue;
      if (kind === 'PROPERTIES') {
        const q = after + kind.length + 1;
        const n = r.u32(q + 4);
        out.push({ offset: p, kind, text: r.text(q + 8, q + 8 + n) });
        continue;
      }
      // Backwards: [u8 len][text][i32 x][i32 y][26 bytes] 'Default Font'.
      let text: string | null = null;
      for (let k = 0; k < 250; k++) {
        const s = p - 26 - 8 - k - 1;
        if (s < 0) break;
        if (r.u8(s) === k) { text = r.text(s + 1, s + 1 + k); break; }
      }
      out.push({ offset: p, kind, text });
    }
    return out;
  }

  private stateBefore(offset: number): string | null {
    const seg = this.r.text(Math.max(this.objStart, offset - 700), offset);
    const all = [...seg.matchAll(/\{STATE=(\d+)\}/g)];
    return all.length ? all[all.length - 1][1] : null;
  }

  private components(): RawComponent[] {
    const { r } = this;
    const pinsByDevice = this.pinsByDevice();
    const found: Omit<RawComponent, 'ref' | 'value' | 'props' | 'state' | 'pins'>[] = [];
    for (const device of pinsByDevice.keys()) {
      for (const p of r.findAll(lengthPrefixed(device), this.objStart, this.objEnd)) {
        const npins = r.u16(p - 2);
        if (npins < 1 || npins > 200) continue;
        const q = p + 1 + device.length;
        found.push({ offset: p, device, x: r.i32(q), y: r.i32(q + 4), angle10: r.i16(q + 8), mirror: r.u8(q + 10) });
      }
    }
    found.sort((a, b) => a.offset - b.offset);
    const labels = this.labels();
    let prev = this.objStart;
    return found.map((c) => {
      const own = labels.filter((l) => l.offset >= prev && l.offset < c.offset);
      prev = c.offset;
      const byKind = new Map<LabelKind, string | null>();
      for (const l of own) if (l.kind !== 'PROPERTIES') byKind.set(l.kind, l.text);
      const props = own.filter((l) => l.kind === 'PROPERTIES').at(-1)?.text ?? '';
      const pins = (pinsByDevice.get(c.device) ?? []).map((lp): RawPin => {
        const len = PIN_LENGTH[lp.style] ?? 2 * DSN_UNIT;
        const node = dsnTransform({ x: -len, y: 0 }, lp.angle10, lp.mirror);
        const local = { x: lp.x + node.x, y: lp.y + node.y };
        const abs = dsnTransform(local, c.angle10, c.mirror);
        return { name: lp.name, number: lp.number, tip: { x: c.x + abs.x, y: c.y + abs.y } };
      });
      return {
        ...c,
        ref: byKind.get('COMPONENT ID') ?? '',
        value: byKind.get('COMPONENT VALUE') ?? '',
        props: props.startsWith('{') ? props : '',
        state: this.stateBefore(c.offset),
        pins,
      };
    });
  }

  private terminals(): RawTerminal[] {
    const { r } = this;
    const out: RawTerminal[] = [];
    for (let p = r.indexOf(ascii('$TER'), this.objStart, this.objEnd); p >= 0; p = r.indexOf(ascii('$TER'), p + 1, this.objEnd)) {
      let q = p + 4;
      while (q < this.objEnd && isUpper(r.u8(q))) q++;
      if (q === p + 4) continue;
      const kind = r.text(p, q);
      if (r.u8(p - 1) !== kind.length) continue;
      const x = r.i32(p - 13);
      const y = r.i32(p - 9);
      const angle10 = r.i16(p - 5);
      const mirror = r.u8(p - 3);
      let label = '';
      const ff = r.bytes.subarray(q, q + 8).indexOf(0xff);
      if (ff >= 0) {
        const len = r.u8(q + ff + 1);
        label = r.text(q + ff + 2, q + ff + 2 + len);
      }
      const [nx, ny] = TERMINAL_NODE[kind] ?? [0, 0];
      const node = dsnTransform({ x: nx, y: ny }, angle10, mirror);
      out.push({ offset: p, kind, x, y, angle10, mirror, label, node: { x: x + node.x, y: y + node.y } });
      p = q - 1;
    }
    return out;
  }

  private wires(): RawWire[] {
    const { r } = this;
    const marker = ascii('\x7fWIRE\0');
    return r.findAll(marker, this.objStart, this.objEnd).map((m) => {
      const p = m + marker.length;
      const n = r.u16(p + 2);
      const points: RawPoint[] = [];
      for (let k = 0; k < n; k++) points.push({ x: r.i32(p + 4 + 8 * k), y: r.i32(p + 8 + 8 * k) });
      return { offset: p, points };
    });
  }
}

/** Parse `{KEY=value}` property blocks. */
export function parseProps(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/\{([^=}]+)=([^}]*)\}/g)) out[m[1]] = m[2];
  return out;
}
