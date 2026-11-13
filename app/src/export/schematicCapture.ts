// The schematic as it looks during the simulation, for the « Rendu du TP » and the « Capture du schéma » PNG:
// pin squares (red 1, blue 0, grey floating), LED glow and lit segments from a simulation snapshot, plus a legend.
// Drawn in PIC Studio's own schematic look (never another program's window). Pure and DOM-free (tested in Node).
import {
  buildNetlist, ISIS_COLORS, isLedColor, LED_COLORS, schematicToSvg, transformPoint,
  type CircuitSimulator, type ComponentVisual, type Schematic, type SessionSnapshot,
} from '@pic/circuit';
import type { Program } from '@pic/program-model';
import { formatTraceTime, isInputVisual, traceLabels, visualText } from './trace';

/** A read-only simulator view of a worker snapshot, so the drawing shows LEDs and pin states as they are. */
export function snapshotSimulator(schematic: Schematic, snapshot: SessionSnapshot): CircuitSimulator {
  const netlist = buildNetlist(schematic);
  return {
    netlist,
    solve() {},
    advance() {},
    interact() {},
    visual: (id) => snapshot.visuals[id] ?? { kind: 'NONE' },
    netLevel: (id) => snapshot.nets[id] ?? 'Z',
  };
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v: number): string => String(Math.round(v * 1000) / 1000);

const GLOW_ID = 'pic-studio-led-glow';

/** Halo under each lit LED, like the schematic panel (radius 2.2 grid steps, opacity follows the brightness). */
function glowSvg(schematic: Schematic, snapshot: SessionSnapshot): string {
  const halos: string[] = [];
  for (const c of schematic.components) {
    if (c.kind !== 'LED') continue;
    const v = snapshot.visuals[c.id];
    if (v?.kind !== 'LED' || v.brightness <= 0.05) continue;
    const color = isLedColor(c.props.color) ? LED_COLORS[c.props.color].on : LED_COLORS.RED.on;
    const at = transformPoint({ x: 0, y: 0 }, c);
    halos.push(`<circle cx="${num(at.x)}" cy="${num(at.y)}" r="2.2" fill="${color}" opacity="${num(0.45 * v.brightness)}" filter="url(#${GLOW_ID})"/>`);
  }
  if (halos.length === 0) return '';
  return `<defs><filter id="${GLOW_ID}" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="0.7"/></filter></defs><g>${halos.join('')}</g>`;
}

/**
 * The drawing alone (no grid, no `<TEXT>` placeholders), with the live state of `snapshot` when given. The halos
 * go right above the sheet, under the wires and the parts.
 */
export function schematicSimSvg(schematic: Schematic, snapshot: SessionSnapshot | null): string {
  const simulator = snapshot ? snapshotSimulator(schematic, snapshot) : undefined;
  const svg = schematicToSvg(schematic, { placeholders: false, grid: false, simulator });
  if (!snapshot) return svg;
  const glow = glowSvg(schematic, snapshot);
  if (!glow) return svg;
  const sheet = `fill="${ISIS_COLORS.background}"/>`;
  const at = svg.indexOf(sheet);
  return at < 0 ? svg : `${svg.slice(0, at + sheet.length)}\n${glow}${svg.slice(at + sheet.length)}`;
}

// ------------------------------------------------------------------------------------------------ legend

export interface LegendItem {
  /** Square colour (pin states) or halo colour (LED). */
  color: string;
  text: string;
  shape: 'square' | 'glow';
}

/** What the pin squares of a simulated schematic mean. */
const PIN_LEGEND: readonly LegendItem[] = [
  { color: ISIS_COLORS.pinHigh, text: 'broche à 1 (5 V)', shape: 'square' },
  { color: ISIS_COLORS.pinLow, text: 'broche à 0 (0 V)', shape: 'square' },
  { color: ISIS_COLORS.pinFloating, text: 'non reliée (flottante)', shape: 'square' },
  { color: ISIS_COLORS.pinContention, text: 'conflit (deux sorties opposées)', shape: 'square' },
];

/** Legend entry of the halo drawn under lit LEDs. */
export const LED_HALO_TEXT = 'LED allumée (halo)';

/**
 * What the colours of this simulated schematic mean: the pin squares, and the LED halo only when the circuit has an
 * LED (in the colour of its first one). A traffic light or a 7-segment display has no halo.
 */
export function simLegend(schematic: Schematic): LegendItem[] {
  const led = schematic.components.find((c) => c.kind === 'LED');
  if (!led) return [...PIN_LEGEND];
  const color = isLedColor(led.props.color) ? LED_COLORS[led.props.color].on : LED_COLORS.RED.on;
  return [...PIN_LEGEND, { color, text: LED_HALO_TEXT, shape: 'glow' }];
}

/** How the capture was taken, for its caption. */
export type CaptureState = 'running' | 'paused' | 'stopped' | 'idle';

/** « Simulation en cours, t = 1,250 s », « Schéma au repos (simulation non lancée) ». */
export function captureCaption(state: CaptureState, time: number | null): string {
  const t = time !== null ? `, t = ${formatTraceTime(time)}` : '';
  switch (state) {
    case 'running': return `Simulation en cours${t}`;
    case 'paused': return `Simulation en pause${t}`;
    case 'stopped': return `État à l’arrêt de la dernière simulation${t}`;
    case 'idle': return 'Schéma au repos (simulation non lancée)';
  }
}

/** Inputs and outputs of the snapshot in words (« L0 (RA0) = 1 », « Led égalité (RB1) allumée »). */
export function snapshotStateLines(
  schematic: Schematic,
  program: Program | null,
  visuals: Readonly<Record<string, ComponentVisual>>,
): { inputs: string[]; outputs: string[] } {
  const labels = traceLabels(schematic, program);
  const inputs: string[] = [];
  const outputs: string[] = [];
  for (const [id, label] of labels) {
    const v = visuals[id];
    if (!v || v.kind === 'NONE') continue;
    const text = visualText(label, v);
    if (text) (isInputVisual(v) ? inputs : outputs).push(text);
  }
  return { inputs, outputs };
}

// ------------------------------------------------------------------------------------------------ PNG capture card

/** Width of the drawing and height of the caption band, in CSS pixels. */
function svgBox(svg: string): { width: number; height: number } {
  const head = /<svg\b[^>]*>/.exec(svg)?.[0] ?? '';
  const read = (name: string) => Number(new RegExp(`\\b${name}="([0-9.]+)"`).exec(head)?.[1] ?? 0);
  return { width: read('width'), height: read('height') };
}

export interface CaptureCardOptions {
  /** First line of the band (« TP — Manipulation du registre STATUS »). */
  title: string;
  /** Second line (captureCaption). */
  caption: string;
  /** Colour legend to draw (simLegend; only meaningful with a snapshot), or null for none. */
  legend: readonly LegendItem[] | null;
}

/**
 * The simulated schematic with a caption band underneath (title, time, colour legend), as one standalone SVG for
 * the PNG capture. The band uses PIC Studio's interface colours, not any other program's.
 */
export function schematicCaptureSvg(drawing: string, options: CaptureCardOptions): string {
  const { width: w0, height: h0 } = svgBox(drawing);
  const font = "-apple-system, 'Helvetica Neue', Arial, sans-serif";
  const pad = 16;
  const legend = options.legend ?? [];
  const legendRow = legend.length > 0 ? 26 : 0;
  const band = 52 + legendRow;
  // Approximate text advance of the 11 px interface font (≈ 0.52 em per character).
  const itemWidth = (item: LegendItem) => 15 + Math.ceil(item.text.length * 5.7) + 16;
  const legendWidth = legend.reduce((n, item) => n + itemWidth(item), 0);
  const width = Math.ceil(Math.max(w0, 560, legendWidth + pad));
  const height = h0 + band;
  const x0 = Math.round((width - w0) / 2);
  const inner = drawing.trim().replace(/^<svg\b/, `<svg x="${x0}" y="0"`);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(options.title)} — ${esc(options.caption)}">`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#FFFFFF"/>`,
    `<rect x="0" y="0" width="${width}" height="${h0}" fill="${ISIS_COLORS.background}"/>`,
    inner,
    `<path d="M0 ${h0 + 0.5}H${width}" stroke="#D4D4D0"/>`,
    `<text x="${pad}" y="${h0 + 22}" font-family="${esc(font)}" font-size="13" font-weight="600" fill="#1F2328">${esc(options.title)}</text>`,
    `<text x="${pad}" y="${h0 + 41}" font-family="${esc(font)}" font-size="12" fill="#5B6068">${esc(options.caption)}</text>`,
  ];
  if (legend.length > 0) {
    let x = pad;
    const y = h0 + 52 + 13;
    for (const item of legend) {
      if (item.shape === 'square') parts.push(`<rect x="${x}" y="${y - 5}" width="10" height="10" fill="${item.color}" stroke="#00000033"/>`);
      else parts.push(`<circle cx="${x + 5}" cy="${y}" r="6" fill="${item.color}" opacity="0.55"/><circle cx="${x + 5}" cy="${y}" r="3" fill="${item.color}"/>`);
      parts.push(`<text x="${x + 15}" y="${y}" dominant-baseline="central" font-family="${esc(font)}" font-size="11" fill="#3A3F45">${esc(item.text)}</text>`);
      x += itemWidth(item);
    }
  }
  parts.push('</svg>', '');
  return parts.join('\n');
}
