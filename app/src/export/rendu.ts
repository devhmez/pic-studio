// « Rendu du TP »: one A4 document with what the prof asks for each TP (organigramme + code + « captures »),
// made from PIC Studio's own drawings: header like her handouts (Matière, TP title, Nom et prénom, Classe, date),
// page 1 the organigramme in her style, page 2 the C code (coloured, numbered lines), page 3 the schematic during
// the simulation with a legend, optionally page 4 the trace of the simulation (inputs set, what the outputs did).
// Pure and DOM-free: a self-contained HTML page (no script, no external resource) that the Mac app prints to PDF.
import type { Schematic, SessionSnapshot } from '@pic/circuit';
import type { Program } from '@pic/program-model';
import { formatClock, formatCount } from '../shell/format';
import { codeCss, codeToHtml } from './codeView';
import {
  captureCaption, schematicSimSvg, simLegend, snapshotStateLines, type CaptureState, type LegendItem,
} from './schematicCapture';
import { describeTrace, formatTraceTime, traceLabels, type TraceLog, type TraceReport } from './trace';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** « 13 octobre 2026 ». */
export function frenchDate(d: Date): string {
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ------------------------------------------------------------------------------------------------ input

export interface RenduChart {
  /** 'Programme Principal', « Programme d'interruption »… */
  title: string;
  svg: string;
}

export interface RenduInput {
  /** TP title (project name). */
  title: string;
  /** Empty: a dotted line to fill in by hand. */
  student: string;
  className: string;
  date: Date;
  charts: readonly RenduChart[];
  /** Shown under the organigramme (« Reconstruit à partir du code C »), or null. */
  chartNote: string | null;
  code: {
    fileName: string;
    source: string;
    /** « PIC16F84A · horloge 1 MHz · 41 mots de programme ». */
    detail: string;
  };
  schematic: {
    /** Standalone SVG (schematicSimSvg). */
    svg: string;
    /** captureCaption(). */
    caption: string;
    /** True when the drawing shows a simulation state (the legend applies). */
    live: boolean;
    /** Colour legend (simLegend), empty when the drawing is at rest. */
    legend: readonly LegendItem[];
    inputs: readonly string[];
    outputs: readonly string[];
  };
  /** The trace page, or null to leave it out. */
  trace: TraceReport | null;
}

/** What the app state provides to build the Rendu (see actions.ts); pure so the templates can be tested in Node. */
export interface RenduSources {
  title: string;
  schematic: Schematic;
  source: string;
  clockHz: number;
  /** Program behind the organigramme (assistant model or rebuilt from the code), for the signal names. */
  program: Program | null;
  charts: readonly RenduChart[];
  chartNote: string | null;
  /** Program memory and RAM of the last successful build, or null when the code does not compile. */
  usage: { rom: number; ram: number } | null;
  /** Snapshot to draw on the schematic (null: the circuit at rest). */
  capture: { snapshot: SessionSnapshot; state: Exclude<CaptureState, 'idle'> } | null;
  /** Recorded run for the trace page (already checked to match the current code), or null. */
  run: TraceLog | null;
  fileName: string;
}

export interface RenduPrefsInput {
  student: string;
  className: string;
  includeTrace: boolean;
}

/** Assemble the document's content from the project's state. */
export function renduInput(src: RenduSources, prefs: RenduPrefsInput, date: Date): RenduInput {
  const usage = src.usage
    ? ` · ${formatCount(src.usage.rom)} mot${src.usage.rom > 1 ? 's' : ''} de programme sur 1024`
    : ' · ne compile pas encore';
  const snapshot = src.capture?.snapshot ?? null;
  const state = snapshot ? snapshotStateLines(src.schematic, src.program, snapshot.visuals) : { inputs: [], outputs: [] };
  // The trace page only says something when an input or an output changed during the run.
  const trace = prefs.includeTrace && src.run && src.run.changes.length > 0
    ? describeTrace(src.run, traceLabels(src.schematic, src.program))
    : null;
  return {
    title: src.title.trim() || 'TP',
    student: prefs.student.trim(),
    className: prefs.className.trim(),
    date,
    charts: src.charts,
    chartNote: src.chartNote,
    code: { fileName: src.fileName, source: src.source, detail: `PIC16F84A · horloge ${formatClock(src.clockHz)}${usage}` },
    schematic: {
      svg: schematicSimSvg(src.schematic, snapshot),
      caption: src.capture ? captureCaption(src.capture.state, snapshot!.time) : captureCaption('idle', null),
      live: snapshot !== null,
      legend: snapshot ? simLegend(src.schematic) : [],
      inputs: state.inputs,
      outputs: state.outputs,
    },
    trace,
  };
}

// ------------------------------------------------------------------------------------------------ HTML

/** The `<svg …>` of a standalone drawing, sized by CSS (keeps its viewBox, drops the fixed pixel size). */
function fluidSvg(svg: string, className: string): string {
  return svg.trim().replace(/^<svg\b([^>]*)>/, (_m, attrs: string) => {
    const kept = attrs.replace(/\s(width|height|preserveAspectRatio|class)="[^"]*"/g, '');
    return `<svg${kept} class="${className}" preserveAspectRatio="xMidYMin meet">`;
  });
}

/** Natural size of a standalone SVG (width / height attributes, CSS pixels). */
function naturalSize(svg: string): { width: number; height: number } {
  const head = /<svg\b[^>]*>/.exec(svg)?.[0] ?? '';
  const w = Number(/\bwidth="([0-9.]+)"/.exec(head)?.[1] ?? 0);
  const h = Number(/\bheight="([0-9.]+)"/.exec(head)?.[1] ?? 0);
  return w > 0 && h > 0 ? { width: w, height: h } : { width: 600, height: 600 };
}

/** Printable width and height of an A4 portrait page with the margins below, in millimetres. */
const PAGE_W_MM = 210 - 2 * 14;
const PAGE_H_MM = 297 - 14 - 16;
const MM_PER_PX = 25.4 / 96;

/**
 * Box for a drawing: its natural size (1 CSS pixel = 1/96 in, so the organigramme keeps her font sizes), reduced to
 * the page width and to `maxHeightMm`, never enlarged. The aspect ratio is kept.
 */
function figureBox(svg: string, maxHeightMm: number): string {
  const { width: w, height: h } = naturalSize(svg);
  const ratio = w / h;
  const width = Math.min(PAGE_W_MM, w * MM_PER_PX, maxHeightMm * ratio);
  return `width:${width.toFixed(1)}mm;height:${(width / ratio).toFixed(1)}mm`;
}

const field = (label: string, value: string, width: string): string => (value
  ? `<span class="field"><span class="field-label">${esc(label)} :</span> <span class="field-value">${esc(value)}</span></span>`
  : `<span class="field"><span class="field-label">${esc(label)} :</span> <span class="field-blank" style="width:${width}"></span></span>`);

function headerHtml(input: RenduInput): string {
  return `<header class="head">
  <div class="head-top">
    <span>Matière : Architecture des microcontrôleurs</span>
    <span>Unité pédagogique : Systèmes embarqués</span>
  </div>
  <h1>${esc(input.title)}</h1>
  <div class="head-fields">
    ${field('Nom et prénom', input.student, '62mm')}
    ${field('Classe', input.className, '24mm')}
    <span class="field"><span class="field-label">Date :</span> <span class="field-value">${esc(frenchDate(input.date))}</span></span>
  </div>
</header>`;
}

function chartsHtml(input: RenduInput): string {
  if (input.charts.length === 0) {
    return '<p class="empty">Organigramme non disponible : le programme ne compile pas encore.</p>';
  }
  // Charts of an interrupt routine or a sub-program carry their own title; each stays in one piece and follows the
  // main chart on page 1 when there is room.
  return input.charts.map((c, i) => {
    const maxH = i === 0 ? PAGE_H_MM - 62 : PAGE_H_MM - 16;
    return `<figure class="chart" aria-label="${esc(c.title)}"><div class="drawing" style="${figureBox(c.svg, maxH)}">${fluidSvg(c.svg, 'fill')}</div></figure>`;
  }).join('\n');
}

function legendHtml(legend: readonly LegendItem[]): string {
  if (legend.length === 0) return '';
  const items = legend.map((item) => {
    const swatch = item.shape === 'square'
      ? `<span class="sw" style="background:${item.color}"></span>`
      : `<span class="sw glow" style="background:${item.color};box-shadow:0 0 0 2.5px ${item.color}66"></span>`;
    return `<li>${swatch}${esc(item.text)}</li>`;
  });
  return `<ul class="legend" aria-label="Légende">${items.join('')}</ul>`;
}

function stateHtml(input: RenduInput): string {
  const { inputs, outputs, live } = input.schematic;
  if (!live) return '';
  const list = (title: string, items: readonly string[]) => (items.length
    ? `<div class="io"><h3>${esc(title)}</h3><ul>${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>`
    : '');
  const body = list('Entrées', inputs) + list('Sorties', outputs);
  return body ? `<div class="io-grid">${body}</div>` : '';
}

function traceHtml(trace: TraceReport): string {
  const start = [
    trace.initialInputs.length ? `<p><strong>Entrées au départ :</strong> ${trace.initialInputs.map(esc).join(' ; ')}.</p>` : '',
    trace.initialOutputs.length ? `<p><strong>Sorties au départ :</strong> ${trace.initialOutputs.map(esc).join(' ; ')}.</p>` : '',
  ].join('');
  const rows = trace.rows.map((r) => `<tr class="${r.kind === 'Entrée' ? 'in' : 'out'}"><td class="t">${esc(r.time)}</td><td class="k">${esc(r.kind)}</td><td>${esc(r.text)}</td></tr>`).join('\n');
  const table = trace.rows.length
    ? `<table class="trace"><thead><tr><th>Temps simulé</th><th>Type</th><th>Ce qui s’est passé</th></tr></thead><tbody>\n${rows}\n</tbody></table>`
    : '<p class="note">Aucune entrée ni sortie n’a changé pendant la simulation.</p>';
  const omitted = trace.omitted > 0
    ? `<p class="note">${formatCount(trace.omitted)} changement${trace.omitted > 1 ? 's' : ''} de sortie de plus ne ${trace.omitted > 1 ? 'sont' : 'est'} pas listé${trace.omitted > 1 ? 's' : ''} (clignotements).</p>`
    : '';
  return `<section class="new-page">
<h2><span class="n">4</span>Trace de la simulation</h2>
<p class="sub">Entrées modifiées pendant ${esc(formatTraceTime(trace.duration))} de simulation et réaction des sorties, dans l’ordre.</p>
${start}
${table}
${omitted}
</section>`;
}

/** The whole document. */
export function renderRenduHtml(input: RenduInput): string {
  const chartNote = input.chartNote ? `<p class="note">${esc(input.chartNote)}</p>` : '';
  const schematicBox = figureBox(input.schematic.svg, 150);
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Rendu — ${esc(input.title)}</title>
<style>
  @page { size: A4 portrait; margin: 14mm 14mm 16mm; }
  @page { @bottom-right { content: "Page " counter(page) " / " counter(pages); font: 8pt -apple-system, 'Helvetica Neue', Arial, sans-serif; color: #888; } }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #fff; }
  body { color: #1c1c1a; font: 10.5pt/1.45 -apple-system, 'Helvetica Neue', Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  @media screen { body { max-width: 210mm; margin: 0 auto; padding: 14mm; } }
  .head { margin: 0 0 8mm; padding: 0 0 4mm; border-bottom: 2px solid #0f766e; }
  .head-top { display: flex; justify-content: space-between; gap: 12px; color: #6d6c66; font-size: 9pt; }
  h1 { margin: 3mm 0 4mm; font-size: 17pt; line-height: 1.2; letter-spacing: -.01em; }
  .head-fields { display: flex; flex-wrap: wrap; gap: 3mm 9mm; align-items: baseline; }
  .field { white-space: nowrap; }
  .field-label { color: #6d6c66; }
  .field-value { font-weight: 600; }
  .field-blank { display: inline-block; border-bottom: 1px dotted #6d6c66; height: 1em; vertical-align: baseline; }
  h2 { display: flex; align-items: baseline; gap: 8px; margin: 0 0 4mm; font-size: 13pt; }
  h2 .n { display: inline-flex; align-items: center; justify-content: center; width: 7mm; height: 7mm; border-radius: 50%; background: #0f766e; color: #fff; font-size: 10pt; }
  h3 { margin: 0 0 1.5mm; font-size: 10pt; color: #0f766e; }
  .sub { margin: -2mm 0 4mm; color: #6d6c66; }
  .new-page { break-before: page; page-break-before: always; }
  figure { margin: 0; break-inside: avoid; page-break-inside: avoid; }
  figure.chart + figure.chart { margin-top: 8mm; }
  .drawing { margin: 0 auto; }
  .drawing svg.fill { display: block; width: 100%; height: 100%; }
  .schematic .drawing { border: 1px solid #c9c8c1; border-radius: 3mm; overflow: hidden; }
  .empty, .note { color: #6d6c66; font-size: 9.5pt; }
  .note { margin: 3mm 0 0; }
  .code-card { border: 1px solid #d4d4d0; border-radius: 3mm; overflow: hidden; }
  .code-title { display: flex; gap: 10px; align-items: baseline; padding: 2mm 4mm; background: #f4f4f1; border-bottom: 1px solid #e2e2de; font-size: 9pt; }
  .code-title strong { color: #1f2328; }
  .code-title span { color: #6b6f76; }
  table.code { width: 100%; border-collapse: collapse; font: 8.4pt/1.36 Menlo, 'SF Mono', Monaco, Consolas, 'Liberation Mono', monospace; }
  table.code tr { break-inside: avoid; }
  table.code td { padding: 0; vertical-align: top; }
  table.code td.ln { width: 1%; padding: 0 3mm 0 3mm; text-align: right; color: #9a9da3; background: #fafaf8; border-right: 1px solid #ecece8; user-select: none; }
  table.code td.src { padding: 0 3mm; white-space: pre-wrap; word-break: break-word; color: #1f2328; }
  table.code tr:first-child td { padding-top: 2mm; }
  table.code tr:last-child td { padding-bottom: 2mm; }
${codeCss().split('\n').map((l) => `  ${l}`).join('\n')}
  .legend { display: flex; flex-wrap: wrap; gap: 1.5mm 6mm; margin: 3mm 0 0; padding: 0; list-style: none; font-size: 9pt; color: #3a3f45; }
  .legend li { display: inline-flex; align-items: center; gap: 2mm; }
  .sw { display: inline-block; width: 3mm; height: 3mm; border: .2mm solid rgba(0,0,0,.25); }
  .sw.glow { border-radius: 50%; border: 0; }
  .caption { margin: 2mm 0 0; color: #3a3f45; font-size: 9.5pt; }
  .io-grid { display: flex; flex-wrap: wrap; gap: 4mm 10mm; margin-top: 4mm; }
  .io { min-width: 60mm; }
  .io ul { margin: 0; padding-left: 4.5mm; }
  .io li { margin: .5mm 0; }
  table.trace { width: 100%; border-collapse: collapse; margin-top: 3mm; font-size: 9.5pt; }
  table.trace th { white-space: nowrap; text-align: left; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .03em; color: #6d6c66; border-bottom: 1px solid #9a9993; padding: 1.5mm 2mm; }
  table.trace td { padding: 1.2mm 2mm; border-bottom: 1px solid #e6e5e0; vertical-align: top; }
  table.trace tr { break-inside: avoid; }
  table.trace td.t { white-space: nowrap; font-variant-numeric: tabular-nums; color: #3a3f45; width: 1%; }
  table.trace td.k { white-space: nowrap; width: 1%; }
  table.trace tr.in td.k { color: #0f766e; font-weight: 600; }
  table.trace tr.out td.k { color: #6d6c66; }
  footer { margin-top: 8mm; color: #9a9993; font-size: 8pt; }
</style>
</head>
<body>
${headerHtml(input)}
<section>
<h2><span class="n">1</span>Organigramme</h2>
${chartsHtml(input)}
${chartNote}
</section>
<section class="new-page">
<h2><span class="n">2</span>Programme en C</h2>
<div class="code-card">
<div class="code-title"><strong>${esc(input.code.fileName)}</strong><span>${esc(input.code.detail)}</span></div>
${codeToHtml(input.code.source)}
</div>
</section>
<section class="new-page schematic">
<h2><span class="n">3</span>Schéma du montage en simulation</h2>
<figure><div class="drawing" style="${schematicBox}">${fluidSvg(input.schematic.svg, 'fill')}</div></figure>
<p class="caption">${esc(input.schematic.caption)}</p>
${legendHtml(input.schematic.legend)}
${stateHtml(input)}
</section>
${input.trace ? traceHtml(input.trace) : ''}
<footer>Document préparé avec PIC Studio.</footer>
</body>
</html>
`;
}
