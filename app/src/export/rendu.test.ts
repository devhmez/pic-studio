/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { LED_COLORS, parseSchematicJson, SimSession, type Schematic, type SessionSnapshot } from '@pic/circuit';
import { compile } from '@pic/compiler';
import { renderProgramCharts } from '@pic/organigramme';
import { parseProgramJson, type Program } from '@pic/program-model';
import { describe, expect, it } from 'vitest';
import { codeToSvg, tokenizeC } from './codeView';
import { renderRenduHtml, renduInput, type RenduSources } from './rendu';
import { captureCaption, LED_HALO_TEXT, schematicCaptureSvg, schematicSimSvg, simLegend, snapshotStateLines } from './schematicCapture';
import { describeTrace, TraceRecorder, traceLabels, type TraceLog } from './trace';

const REPO = new URL('../../../', import.meta.url);
const read = (f: string) => readFileSync(new URL(`templates/${f}`, REPO), 'utf8');
const DATE = new Date(2026, 9, 13);

interface Run {
  schematic: Schematic;
  program: Program;
  source: string;
  session: SimSession;
  recorder: TraceRecorder;
  snapshots: SessionSnapshot[];
}

/** A template running in the simulator, observed like the app's trace hook does (one snapshot per 10 ms slice). */
function start(id: string): Run {
  const schematic = parseSchematicJson(read(`${id}.schematic.json`));
  const program = parseProgramJson(read(`${id}.program.json`));
  const source = read(`${id}.c`);
  const compiled = compile(source, { clockHz: schematic.clockHz });
  expect(compiled.ok).toBe(true);
  const session = new SimSession(schematic, compiled.program!, schematic.clockHz, { config: compiled.config });
  const recorder = new TraceRecorder();
  recorder.observe('stopped', null);
  return { schematic, program, source, session, recorder, snapshots: [] };
}

function runFor(r: Run, seconds: number): SessionSnapshot {
  const end = r.session.time + seconds;
  while (r.session.time < end - 1e-9) {
    r.session.runFor(Math.min(0.01, end - r.session.time));
    const snap = r.session.snapshot();
    r.snapshots.push(snap);
    r.recorder.observe('running', snap);
  }
  return r.snapshots[r.snapshots.length - 1];
}

function sources(r: Run, snapshot: SessionSnapshot | null, log: TraceLog | null): RenduSources {
  const charts = renderProgramCharts(r.program, { style: 'prof', idPrefix: 'rendu' });
  return {
    title: 'TP — Manipulation du registre <STATUS> & co',
    schematic: r.schematic,
    source: r.source,
    clockHz: r.schematic.clockHz,
    program: r.program,
    charts: charts.map((c) => ({ title: c.title, svg: c.svg })),
    chartNote: null,
    usage: { rom: 41, ram: 3 },
    capture: snapshot ? { snapshot, state: 'running' } : null,
    run: log,
    fileName: 'tp-status.c',
  };
}

const ids = (html: string): string[] => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);

describe('Rendu du TP', () => {
  it('puts the header, the organigramme, the code, the simulated schematic and the trace in one A4 page set', () => {
    const r = start('tp-status');
    const snap = runFor(r, 0.05);
    const html = renderRenduHtml(renduInput(sources(r, snap, r.recorder.current()), { student: 'Ben Salah Amira', className: '2A12', includeTrace: true }, DATE));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    // Self-contained and script-free (the Mac app prints it with JavaScript off and no network).
    expect(html).not.toMatch(/<script|<link|<img|https?:\/\/(?!www\.w3\.org)/);
    expect(html).toContain('@page { size: A4 portrait;');
    // Header like her handouts, with the student's fields.
    expect(html).toContain('Matière : Architecture des microcontrôleurs');
    expect(html).toContain('TP — Manipulation du registre &lt;STATUS&gt; &amp; co');
    expect(html).toMatch(/Nom et prénom :<\/span> <span class="field-value">Ben Salah Amira/);
    expect(html).toMatch(/Classe :<\/span> <span class="field-value">2A12/);
    expect(html).toContain('13 octobre 2026');
    // Page 1: her organigramme (sized by CSS, viewBox kept).
    expect(html).toContain('CONFIGURATION');
    expect(html).toContain('RB0,RB1 et RB2 sont des sorties');
    expect(html).toMatch(/<svg[^>]*viewBox="0 0 \d+ \d+"[^>]*class="fill"/);
    // Page 2: every line numbered, keywords coloured.
    const lines = tokenizeC(r.source).length;
    expect(html).toContain(`<td class="ln">${lines}</td>`);
    expect(html).not.toContain(`<td class="ln">${lines + 1}</td>`);
    expect(html).toContain('<span class="c-sfr">TRISB</span>');
    expect(html).toContain('PIC16F84A · horloge 1 MHz · 41 mots de programme sur 1024');
    // Page 3: live pin squares, the glow of the lit LED (x = 5 < y = 6: LED_INF), the legend and the states.
    expect(html).toContain('pic-studio-led-glow');
    expect(html).toContain('#FF4040');
    expect(html).toContain('broche à 1 (5 V)');
    expect(html).toContain(LED_HALO_TEXT);
    expect(html).toContain('Simulation en cours, t = 0,050 s');
    expect(html).toContain('Led inférieur (RB2) allumée');
    expect(html).toContain('Led égalité (RB1) éteinte');
    // No trace page: nothing changed during the run (the schematic page already shows the LEDs).
    expect(html).not.toContain('Trace de la simulation');
    // Code and schematic each start on a new sheet.
    expect(html.match(/class="new-page/g)).toHaveLength(2);
    // ids must stay unique once every drawing is inlined in one document.
    const all = ids(html);
    expect(new Set(all).size).toBe(all.length);
  });

  it('leaves dotted lines for the name and class, and can leave the trace out', () => {
    const r = start('tp-status');
    const snap = runFor(r, 0.02);
    const html = renderRenduHtml(renduInput(sources(r, snap, r.recorder.current()), { student: '  ', className: '', includeTrace: false }, DATE));
    expect(html.match(/class="field-blank"/g)).toHaveLength(2);
    expect(html).not.toContain('Trace de la simulation');
  });

  it('shows the circuit at rest without a legend when the simulation never ran', () => {
    const r = start('tp-status');
    const html = renderRenduHtml(renduInput(sources(r, null, null), { student: 'A', className: 'B', includeTrace: true }, DATE));
    expect(html).toContain('Schéma au repos (simulation non lancée)');
    expect(html).not.toContain('pic-studio-led-glow');
    expect(html).not.toContain('broche à 1 (5 V)');
    expect(html).not.toContain('Trace de la simulation');
  });

  it('does not see an LED the loop switches off then on again as blinking (status.c pattern)', () => {
    const r = start('tp-status');
    runFor(r, 0.5);
    const report = describeTrace(r.recorder.current()!, traceLabels(r.schematic, r.program));
    expect(report.initialOutputs).toContain('Led inférieur (RB2) allumée');
    expect(report.rows).toEqual([]);
    expect(report.omitted).toBe(0);
  });

  it('records the switches the student flips and what the LEDs do (demux)', () => {
    const r = start('tp1-demux');
    runFor(r, 0.03);
    // LS1 drives L0 (RA0), LS2 drives L1 (RA1, starts at 1): (L1,L0) = (1,0) → D2 ; flip L0 → (1,1) → D3.
    r.session.circuit.interact('LS1', { type: 'toggle' });
    runFor(r, 0.03);
    const log = r.recorder.current()!;
    const report = describeTrace(log, traceLabels(r.schematic, r.program));
    expect(report.initialInputs).toEqual(['Interrupteur L0 (RA0) = 0', 'Interrupteur L1 (RA1) = 1']);
    const inputs = report.rows.filter((row) => row.kind === 'Entrée').map((row) => row.text);
    expect(inputs).toEqual(['Interrupteur L0 (RA0) passe à 1']);
    const outputs = report.rows.filter((row) => row.kind === 'Sortie').map((row) => row.text);
    expect(outputs).toEqual(expect.arrayContaining(['Led D3 (RB3) allumée', 'Led D2 (RB2) éteinte']));
    expect(report.rows.every((row) => /^\d+,\d{3} s$/.test(row.time))).toBe(true);
    // Cause before effect: the switch comes first among the changes seen in the same slice.
    expect(report.rows[0]).toMatchObject({ kind: 'Entrée', text: 'Interrupteur L0 (RA0) passe à 1' });
    const html = renderRenduHtml(renduInput({ ...sources(r, r.snapshots.at(-1)!, log), title: 'Démultiplexeur' }, { student: '', className: '', includeTrace: true }, DATE));
    expect(html).toContain('Trace de la simulation');
    expect(html.match(/class="new-page/g)).toHaveLength(3);
    expect(html).toContain('<td class="k">Entrée</td><td>Interrupteur L0 (RA0) passe à 1</td>');
    expect(html).toContain('Interrupteur L0 (RA0) = 1');
  });
});

describe('captures', () => {
  it('draws the simulated schematic with its halo under the parts, and a caption card with the legend', () => {
    const r = start('tp-status');
    const snap = runFor(r, 0.05);
    const drawing = schematicSimSvg(r.schematic, snap);
    const glowAt = drawing.indexOf('pic-studio-led-glow');
    expect(glowAt).toBeGreaterThan(0);
    expect(glowAt).toBeLessThan(drawing.indexOf('data-id='));
    expect(schematicSimSvg(r.schematic, null)).not.toContain('pic-studio-led-glow');
    const card = schematicCaptureSvg(drawing, { title: 'TP STATUS', caption: captureCaption('paused', snap.time), legend: simLegend(r.schematic) });
    expect(card).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="(\d+)" height="(\d+)"/);
    expect(card).toContain('Simulation en pause, t = 0,050 s');
    for (const item of simLegend(r.schematic)) expect(card).toContain(item.text);
    expect(card).toContain(LED_HALO_TEXT);
    expect(snapshotStateLines(r.schematic, r.program, snap.visuals).outputs).toEqual([
      'Led supérieur (RB0) éteinte', 'Led égalité (RB1) éteinte', 'Led inférieur (RB2) allumée',
    ]);
  });

  it('has no LED halo in the legend of a circuit without LED (traffic light, 7-segment display)', () => {
    const r = start('tp-traffic');
    const snap = runFor(r, 0.02);
    expect(simLegend(r.schematic).map((item) => item.text)).toEqual([
      'broche à 1 (5 V)', 'broche à 0 (0 V)', 'non reliée (flottante)', 'conflit (deux sorties opposées)',
    ]);
    const card = schematicCaptureSvg(schematicSimSvg(r.schematic, snap), { title: 'Feux', caption: captureCaption('paused', snap.time), legend: simLegend(r.schematic) });
    expect(card).toContain('broche à 1 (5 V)');
    expect(card).not.toContain(LED_HALO_TEXT);
    const html = renderRenduHtml(renduInput(sources(r, snap, null), { student: 'A', className: 'B', includeTrace: false }, DATE));
    expect(html).toContain('broche à 1 (5 V)');
    expect(html).not.toContain(LED_HALO_TEXT);
    // An LED circuit shows the halo in the colour of its LED (EXEMPLE 1: a blue one).
    const blue = start('tp0-exemple1');
    expect(simLegend(blue.schematic).at(-1)).toEqual({ color: LED_COLORS.BLUE.on, text: LED_HALO_TEXT, shape: 'glow' });
  });

  it('names parts by reference and pin when there is no program', () => {
    const r = start('tp1-demux');
    const snap = runFor(r, 0.02);
    const lines = snapshotStateLines(r.schematic, null, snap.visuals);
    expect(lines.inputs).toEqual(['LOGICSTATE LS1 (RA0) = 0', 'LOGICSTATE LS2 (RA1) = 1']);
    expect(lines.outputs).toContain('Led D3 (RB2) allumée');
  });

  it('renders the code card with line numbers and a title strip', () => {
    const svg = codeToSvg('void main() {\n    TRISB = 0x00;  // PORTB en sortie\n}\n', { fileName: 'tp.c', detail: 'PIC16F84A · 1 MHz' });
    expect(svg).toContain('>tp.c</tspan>');
    expect(svg).toContain('PIC16F84A · 1 MHz');
    expect(svg.match(/text-anchor="end"/g)).toHaveLength(3);
    expect(svg).toContain('font-style="italic">// PORTB en sortie</tspan>');
  });
});
