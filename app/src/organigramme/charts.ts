// Which program the organigramme draws, and the link between chart boxes and C lines. Pure and DOM-free (shared by
// the panel and the export menu, tested in Node). The renderer itself is in ./render.ts, so the export menu (always
// loaded) does not pull @pic/organigramme into the first chunk.
import type { CompileResultEx } from '@pic/compiler';
import type { ProgramChart } from '@pic/organigramme';
import { fromAstDetailed, type Program } from '@pic/program-model';
import { generateWithMap, type SourceMap } from '@pic/style-c';
import { asProgram } from '../assistant/model';
import type { Project } from '../state/types';

/** 'model': the assistant's program (code generated from it); 'code': rebuilt from the C code with fromAst. */
export type ChartOrigin = 'model' | 'code';

export interface ChartSource {
  program: Program;
  origin: ChartOrigin;
  /** fromAst remarks: what the C has that the organigramme cannot show exactly (French). */
  notes: readonly string[];
}

interface FromCode {
  program: Program;
  notes: string[];
}

const fromCodeCache = new WeakMap<CompileResultEx, Map<string, FromCode>>();

/** Program rebuilt from a compile result's AST (cached per result, title and clock). */
export function programFromCompile(result: CompileResultEx | null, title: string, clockHz: number): FromCode | null {
  if (!result?.ast || !result.ok) return null;
  let perResult = fromCodeCache.get(result);
  if (!perResult) {
    perResult = new Map();
    fromCodeCache.set(result, perResult);
  }
  const key = `${title}\u0000${clockHz}`;
  let hit = perResult.get(key);
  if (!hit) {
    hit = fromAstDetailed(result.ast, result.source, { title, clockHz });
    perResult.set(key, hit);
  }
  return hit;
}

/**
 * The program behind the organigramme:
 * - the assistant's model while the code is the one it generated;
 * - otherwise the program rebuilt from the C code (hand-written or edited code), when it compiles;
 * - otherwise the model if there is one (the caller greys it out: the code no longer matches);
 * - null when there is nothing to draw yet.
 */
export type ChartProjectFields = Pick<Project, 'program' | 'sourceOrigin' | 'name' | 'clockHz'>;

export function resolveChartSource(project: ChartProjectFields, result: CompileResultEx | null): (ChartSource & { stale: boolean }) | null {
  const model = asProgram(project.program);
  if (model && project.sourceOrigin === 'generated') return { program: model, origin: 'model', notes: [], stale: false };
  const code = programFromCompile(result, project.name, project.clockHz);
  if (code) return { program: code.program, origin: 'code', notes: code.notes, stale: false };
  if (model) return { program: model, origin: 'model', notes: [], stale: true };
  return null;
}

/** Diamond wording, section prose and drawing options (per-viewer preferences). */
export interface ChartPrefs {
  logic: 'words' | 'c';
  wording: 'tp' | 'generic';
  /** Busy waits: the condition that ends the wait (`non` loops back) or the C loop condition (`oui` loops back). */
  waits: 'exit' | 'loop';
  /** `for` repetitions: one box (« clignote 3 fois ») or the explicit counter loop. */
  counters: 'box' | 'loop';
}

export const DEFAULT_CHART_PREFS: ChartPrefs = { logic: 'words', wording: 'tp', waits: 'exit', counters: 'box' };

/** width / height attributes of a standalone SVG string. */
export function svgSize(svg: string): { width: number; height: number } {
  const head = /<svg\b[^>]*>/.exec(svg)?.[0] ?? '';
  const num = (name: string) => Number(new RegExp(`\\b${name}="([0-9.]+)"`).exec(head)?.[1] ?? 0);
  return { width: num('width'), height: num('height') };
}

/**
 * Every chart side by side on one sheet (main program, interrupt routine, sub-programs), as one standalone SVG:
 * each chart stays a nested <svg> (their marker ids are already distinct), top-aligned with a gap between them.
 */
export function combineChartsSvg(charts: readonly Pick<ProgramChart, 'svg' | 'title'>[], gap = 48): string {
  if (charts.length === 1) return charts[0].svg;
  let x = 0;
  let height = 0;
  const parts: string[] = [];
  for (const c of charts) {
    const { width, height: h } = svgSize(c.svg);
    parts.push(c.svg.trim().replace(/^<svg\b/, `<svg x="${x}" y="0"`));
    x += width + gap;
    height = Math.max(height, h);
  }
  const width = Math.max(0, x - gap);
  const label = charts.map((c) => c.title).join(', ');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Organigrammes : ${escapeXml(label)}">`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`,
    ...parts,
    '</svg>',
    '',
  ].join('\n');
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ------------------------------------------------------------------------------------------------ chart ↔ code

export interface LineRange {
  /** 1-based, inclusive. */
  line: number;
  endLine: number;
}

export interface CodeLink {
  /** Generated C of the charted program, with the lines of every statement / branch / function id. */
  map: SourceMap;
  /** Lines of the generated text, used to find the same lines in hand-edited code. */
  generated: string[];
  /** True when the editor holds exactly the generated text (line numbers match one to one). */
  exact: boolean;
  actual: string[];
}

const normalizeEol = (s: string): string => s.replace(/\r\n?/g, '\n');

const linkCache = new WeakMap<Program, { source: string; link: CodeLink | null }>();

/** How the charted program's ids map onto the code in the editor (null if the generator fails). */
export function codeLinkFor(program: Program, source: string): CodeLink | null {
  const hit = linkCache.get(program);
  if (hit && hit.source === source) return hit.link;
  let link: CodeLink | null = null;
  try {
    const g = generateWithMap(program);
    const generated = normalizeEol(g.source).replace(/\n$/, '');
    const actual = normalizeEol(source).replace(/\n$/, '');
    link = { map: g.map, generated: generated.split('\n'), actual: actual.split('\n'), exact: generated === actual };
  } catch {
    link = null;
  }
  linkCache.set(program, { source, link });
  return link;
}

/**
 * Lines of a chart node from its refs. A node often lists its container too (a diamond: the whole `if` and its
 * branch; a branch box: the branch and its statements): containers are dropped so the most specific lines remain.
 */
export function rangeForRefs(map: SourceMap, refs: readonly string[]): LineRange | null {
  const ranges = refs.map((r) => map[r]).filter((m): m is { line: number; endLine: number } => !!m);
  if (ranges.length === 0) return null;
  const contains = (a: LineRange, b: LineRange) => a.line <= b.line && a.endLine >= b.endLine && (a.line !== b.line || a.endLine !== b.endLine);
  const specific = ranges.filter((r) => !ranges.some((o) => contains(r, o)));
  const kept = specific.length ? specific : ranges;
  return { line: Math.min(...kept.map((r) => r.line)), endLine: Math.max(...kept.map((r) => r.endLine)) };
}

/** Code of a line without its trailing comment and with spacing normalised (comparison key). */
export function lineKey(text: string): string {
  return text.replace(/\/\/.*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Where a generated range sits in the editor's code. Identical texts map one to one; for hand-edited code the first
 * line is looked up by its code (the n-th occurrence of the same line), and the range keeps its length.
 */
export function locateRange(link: CodeLink, range: LineRange): LineRange | null {
  if (link.exact) return range;
  const first = link.generated[range.line - 1];
  if (first === undefined) return null;
  const key = lineKey(first);
  if (!key || key === '{' || key === '}') return null;
  let occurrence = 0;
  for (let i = 0; i < range.line - 1; i++) if (lineKey(link.generated[i]) === key) occurrence++;
  const hits: number[] = [];
  link.actual.forEach((l, i) => { if (lineKey(l) === key) hits.push(i + 1); });
  if (hits.length === 0) return null;
  const start = hits[Math.min(occurrence, hits.length - 1)];
  const end = Math.min(link.actual.length, start + (range.endLine - range.line));
  return { line: start, endLine: end };
}

/** Code lines of a chart node, or null when they cannot be found. */
export function codeRangeForRefs(link: CodeLink | null, refs: readonly string[]): LineRange | null {
  if (!link) return null;
  const range = rangeForRefs(link.map, refs);
  return range ? locateRange(link, range) : null;
}

/**
 * Ids whose code contains editor line `line` (innermost first): the statement being executed while paused, then the
 * blocks around it. Only meaningful when the editor holds the generated text.
 */
export function refsAtLine(link: CodeLink | null, line: number): string[] {
  if (!link?.exact) return [];
  return Object.entries(link.map)
    .filter(([, r]) => r.line <= line && line <= r.endLine)
    .sort((a, b) => (a[1].endLine - a[1].line) - (b[1].endLine - b[1].line))
    .map(([id]) => id);
}

/** File-friendly chart name: « organigramme », « organigramme-interruption », « organigramme-clignoter ». */
export function chartFileSuffix(chart: Pick<ProgramChart, 'id' | 'title'>): string {
  if (chart.id === 'main') return 'organigramme';
  if (/interruption/i.test(chart.title)) return 'organigramme-interruption';
  const fn = /Sous-programme\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(chart.title)?.[1];
  return fn ? `organigramme-${fn.toLowerCase()}` : `organigramme-${chart.id}`;
}
