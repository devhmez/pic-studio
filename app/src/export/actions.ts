// What each « Exporter » entry does. Shared by the export menu, the organigramme panel's own buttons and the Mac
// app's menu bar (host/commands.ts).
import { schematicToSvg, type SessionSnapshot } from '@pic/circuit';
import { toMikroCFile } from '@pic/style-c';
import { chartFileSuffix, combineChartsSvg, resolveChartSource, svgSize } from '../organigramme/charts';
import { chartPrefsStore } from '../organigramme/prefs';
import { platform } from '../platform';
import { formatClock } from '../shell/format';
import { notify } from '../shell/toast';
import { saveProject } from '../shell/projectFiles';
import { getApp } from '../state/store';
import type { Project } from '../state/types';
import { exportPdf } from '../host/print';
import { svgPrintPage, svgToPng } from './raster';
import { fileBase } from './names';
import { renduPrefsStore } from './renduPrefs';
import { captureCaption, schematicCaptureSvg, schematicSimSvg, simLegend, snapshotSimulator } from './schematicCapture';
import { lastLiveCapture, recordedRun } from './traceHook';
import { buildWiringSheet, renderWiringSheetHtml } from './wiring';

export { snapshotSimulator };

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function save(name: string, data: string | Uint8Array, mime: string): Promise<void> {
  try {
    const saved = await platform.saveFile(name, data, mime, { saveAs: true });
    if (saved) notify(`Exporté : ${saved}`, 'success');
  } catch (e) {
    notify(`Export impossible : ${errorText(e)}`, 'error');
  }
}

/** A printable page as PDF: saved directly in the Mac app, through the print dialog in the browser. */
async function savePdf(name: string, html: string): Promise<void> {
  const outcome = await exportPdf({ name, html });
  if (outcome.kind === 'saved') notify(`Exporté : ${outcome.name}`, 'success');
}

/** The compile result of the current source (builds first when the code changed since the last build). */
function freshBuild() {
  const app = getApp();
  return app.compile.stale || !app.compile.result ? app.build() : app.compile.result;
}

// ------------------------------------------------------------------------------------------------ code, hex, project

export async function exportCFile(): Promise<void> {
  const { project } = getApp();
  await save(`${fileBase(project.name)}.c`, toMikroCFile(project.source), 'text/x-csrc');
}

export async function exportHex(): Promise<void> {
  const result = freshBuild();
  if (!result.ok || !result.hex) {
    notify('Le programme ne compile pas : corrigez les erreurs du panneau Code avant d’exporter le .hex.', 'error');
    getApp().focusPanel('code');
    return;
  }
  await save(`${fileBase(getApp().project.name)}.hex`, result.hex.replace(/\r?\n/g, '\r\n'), 'application/octet-stream');
}

export async function exportProjectFile(): Promise<void> {
  await saveProject(true);
}

// ------------------------------------------------------------------------------------------------ organigramme

export type ChartFormat = 'png' | 'svg' | 'pdf';

/** The organigramme renderer, loaded on first use (its own chunk, shared with the organigramme panel). */
const loadRenderer = () => import('../organigramme/render');

/** Charts of the current project, as the organigramme panel shows them. */
export async function currentCharts() {
  const { project, compile } = getApp();
  const source = resolveChartSource(project, compile.result);
  if (!source) return null;
  const { chartsFor } = await loadRenderer();
  return { source, charts: chartsFor(source.program, project.organigrammeStyle, chartPrefsStore.getState(), 'export') };
}

/**
 * Export the organigramme. `chartId` picks one chart (the panel's current tab); without it every chart goes on one
 * sheet (main program and interrupt routine side by side).
 */
export async function exportOrganigramme(format: ChartFormat, chartId?: string): Promise<void> {
  let current: Awaited<ReturnType<typeof currentCharts>>;
  try {
    current = await currentCharts();
  } catch (e) {
    notify(`Export de l’organigramme impossible : ${errorText(e)}`, 'error');
    return;
  }
  if (!current) {
    notify('Pas encore d’organigramme : écrivez un programme qui compile ou utilisez l’assistant.', 'error');
    return;
  }
  const { charts } = current;
  const chosen = chartId ? charts.filter((c) => c.id === chartId) : charts;
  if (chosen.length === 0) return;
  const svg = chosen.length === 1 ? chosen[0].svg : combineChartsSvg(chosen);
  const { width, height } = svgSize(svg);
  const name = getApp().project.name;
  const base = `${fileBase(name)}-${chosen.length === 1 ? chartFileSuffix(chosen[0]) : 'organigrammes'}`;
  try {
    if (format === 'svg') await save(`${base}.svg`, svg, 'image/svg+xml');
    else if (format === 'png') await save(`${base}.png`, await svgToPng(svg, width, height), 'image/png');
    else await savePdf(`${base}.pdf`, svgPrintPage(svg, `Organigramme — ${name}`, width, height));
  } catch (e) {
    notify(`Export de l’organigramme impossible : ${errorText(e)}`, 'error');
  }
}

// ------------------------------------------------------------------------------------------------ schematic

/** Schematic drawing in the ISIS palette, with the simulation state while it runs or is paused. */
export function schematicSvg(project: Project, snapshot: SessionSnapshot | null): string {
  const simulator = snapshot ? snapshotSimulator(project.schematic, snapshot) : undefined;
  return schematicToSvg(project.schematic, { placeholders: false, simulator });
}

export async function exportSchematic(format: 'png' | 'svg'): Promise<void> {
  const { project, sim } = getApp();
  const live = sim.status !== 'stopped' ? sim.snapshot : null;
  try {
    const svg = schematicSvg(project, live);
    const base = `${fileBase(project.name)}-schema${live ? '-simulation' : ''}`;
    if (format === 'svg') await save(`${base}.svg`, svg, 'image/svg+xml');
    else {
      const { width, height } = svgSize(svg);
      await save(`${base}.png`, await svgToPng(svg, width, height), 'image/png');
    }
  } catch (e) {
    notify(`Export du schéma impossible : ${errorText(e)}`, 'error');
  }
}

// ------------------------------------------------------------------------------------------------ wiring sheet

export function wiringSheetHtml(): string {
  const { project, compile } = getApp();
  const source = resolveChartSource(project, compile.result);
  const sheet = buildWiringSheet(project.schematic, {
    title: project.name,
    program: source?.program ?? null,
    hexFile: `${fileBase(project.name)}.hex`,
    config: project.config,
    clockHz: project.clockHz,
  });
  return renderWiringSheetHtml(sheet);
}

export async function exportWiringSheet(format: 'print' | 'html'): Promise<void> {
  try {
    const html = wiringSheetHtml();
    if (format === 'html') await save(`${fileBase(getApp().project.name)}-cablage.html`, html, 'text/html');
    else await savePdf(`${fileBase(getApp().project.name)}-cablage.pdf`, html);
  } catch (e) {
    notify(`Fiche de câblage impossible : ${errorText(e)}`, 'error');
  }
}

// ------------------------------------------------------------------------------------------------ captures, rendu

/** Simulation state to draw: live (running / paused), else the moment the last run stopped if nothing changed since. */
export function captureSnapshot(): { snapshot: SessionSnapshot; state: 'running' | 'paused' | 'stopped' } | null {
  const { sim, project } = getApp();
  if (sim.status !== 'stopped' && sim.snapshot) return { snapshot: sim.snapshot, state: sim.status };
  const last = lastLiveCapture();
  if (last && last.schematic === project.schematic && last.source === project.source) return { snapshot: last.snapshot, state: 'stopped' };
  return null;
}

const codeDetail = (project: Project): string => `PIC16F84A · ${formatClock(project.clockHz)}`;

/** « Capture du code » : the C code with coloured syntax and line numbers, as a 300 dpi PNG. */
export async function exportCodeCapture(): Promise<void> {
  const { project } = getApp();
  try {
    const { codeToSvg } = await import('./codeView');
    const base = fileBase(project.name);
    const svg = codeToSvg(project.source, { fileName: `${base}.c`, detail: codeDetail(project) });
    const { width, height } = svgSize(svg);
    await save(`${base}-code.png`, await svgToPng(svg, width, height), 'image/png');
  } catch (e) {
    notify(`Capture du code impossible : ${errorText(e)}`, 'error');
  }
}

/** « Capture du schéma en simulation » : LEDs, pin states and a legend, as a 300 dpi PNG. */
export async function exportSchematicCapture(): Promise<void> {
  const { project } = getApp();
  const capture = captureSnapshot();
  if (!capture) notify('Astuce : lancez la simulation (▶) avant la capture pour voir les LEDs allumées et l’état des broches.', 'info');
  try {
    const drawing = schematicSimSvg(project.schematic, capture?.snapshot ?? null);
    const caption = capture ? captureCaption(capture.state, capture.snapshot.time) : captureCaption('idle', null);
    const svg = schematicCaptureSvg(drawing, { title: project.name, caption, legend: capture ? simLegend(project.schematic) : null });
    const { width, height } = svgSize(svg);
    await save(`${fileBase(project.name)}-schema-simulation.png`, await svgToPng(svg, width, height), 'image/png');
  } catch (e) {
    notify(`Capture du schéma impossible : ${errorText(e)}`, 'error');
  }
}

/** The « Rendu du TP » document of the current project (self-contained HTML, printed to PDF). */
export async function renduHtml(date = new Date()): Promise<string> {
  const result = freshBuild();
  const { project } = getApp();
  const chartSource = resolveChartSource(project, result);
  const { chartsFor } = await loadRenderer();
  const charts = chartSource ? chartsFor(chartSource.program, project.organigrammeStyle, chartPrefsStore.getState(), 'rendu') : [];
  const run = recordedRun();
  const ids = new Set(project.schematic.components.map((c) => c.id));
  // The trace only goes in when it was recorded with the current code and parts.
  const runMatches = run !== null && run.source === project.source && Object.keys(run.log.initial).every((id) => ids.has(id));
  const { renderRenduHtml, renduInput } = await import('./rendu');
  const input = renduInput({
    title: project.name,
    schematic: project.schematic,
    source: project.source,
    clockHz: project.clockHz,
    program: chartSource?.program ?? null,
    charts: charts.map((c) => ({ title: c.title, svg: c.svg })),
    chartNote: chartSource?.stale ? 'Cet organigramme correspond à la dernière version du programme qui compilait.' : null,
    usage: result.ok ? { rom: result.usage.rom, ram: result.usage.ram } : null,
    capture: captureSnapshot(),
    run: runMatches ? run.log : null,
    fileName: `${fileBase(project.name)}.c`,
  }, renduPrefsStore.getState(), date);
  return renderRenduHtml(input);
}

/** « Rendu du TP (PDF) »: organigramme, code, schematic during the simulation and the trace, ready to hand in. */
export async function exportRenduPdf(): Promise<void> {
  const { project } = getApp();
  if (!captureSnapshot()) notify('Astuce : lancez la simulation et réglez les entrées avant d’exporter : la page du schéma montrera les LEDs allumées.', 'info');
  try {
    await savePdf(`${fileBase(project.name)}-rendu.pdf`, await renduHtml());
  } catch (e) {
    notify(`Rendu du TP impossible : ${errorText(e)}`, 'error');
  }
}
