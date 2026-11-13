/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { compile } from '@pic/compiler';
import { parseProgramJson, type Program } from '@pic/program-model';
import { generate } from '@pic/style-c';
import { parseSchematicJson } from '@pic/circuit';
import { describe, expect, it } from 'vitest';
import type { Project } from '../state/types';
import {
  chartFileSuffix, codeLinkFor, codeRangeForRefs, combineChartsSvg, lineKey, locateRange, programFromCompile,
  rangeForRefs, refsAtLine, resolveChartSource, svgSize,
} from './charts';
import { chartsFor } from './render';

const REPO = new URL('../../../', import.meta.url);
const read = (f: string) => readFileSync(new URL(`templates/${f}`, REPO), 'utf8');
const program = (id: string): Program => parseProgramJson(read(`${id}.program.json`));

function project(id: string, patch: Partial<Project> = {}): Project {
  const p = program(id);
  return {
    name: p.title,
    schematic: parseSchematicJson(read(`${id}.schematic.json`)),
    source: generate(p),
    clockHz: p.clockHz,
    config: 0x3ffb,
    program: p,
    sourceOrigin: 'generated',
    organigrammeStyle: 'prof',
    ...patch,
  };
}

describe('resolveChartSource', () => {
  it('uses the model while the code is the generated one', () => {
    const pr = project('tp-status');
    const src = resolveChartSource(pr, compile(pr.source));
    expect(src).toMatchObject({ origin: 'model', stale: false });
  });

  it('rebuilds from the code when it was edited by hand', () => {
    const pr = project('tp-status', { sourceOrigin: 'manual' });
    pr.source = pr.source.replace('// Boucle principale', '// Boucle principale (modifiée)');
    const result = compile(pr.source);
    const src = resolveChartSource(pr, result);
    expect(src?.origin).toBe('code');
    // Cached per compile result.
    expect(programFromCompile(result, pr.name, pr.clockHz)).toBe(programFromCompile(result, pr.name, pr.clockHz));
  });

  it('falls back to the (stale) model when the edited code does not compile', () => {
    const pr = project('tp-status', { sourceOrigin: 'manual', source: 'void main() { x = ; }' });
    expect(resolveChartSource(pr, compile(pr.source))).toMatchObject({ origin: 'model', stale: true });
    expect(resolveChartSource({ ...pr, program: null }, compile(pr.source))).toBeNull();
  });
});

describe('charts', () => {
  it('draws one chart per function and caches them', () => {
    const p = program('tp5-int-rb0');
    const charts = chartsFor(p, 'prof');
    expect(charts.map((c) => c.title)).toEqual(['Programme Principal', "Programme d'interruption"]);
    expect(chartsFor(p, 'prof')).toBe(charts);
    expect(chartsFor(p, 'bw')).not.toBe(charts);
    expect(charts.map(chartFileSuffix)).toEqual(['organigramme', 'organigramme-interruption']);
  });

  it('combines several charts side by side into one SVG', () => {
    const charts = chartsFor(program('tp5-int-rb0'), 'prof');
    const svg = combineChartsSvg(charts);
    const a = svgSize(charts[0].svg);
    const b = svgSize(charts[1].svg);
    expect(svgSize(svg)).toEqual({ width: a.width + 48 + b.width, height: Math.max(a.height, b.height) });
    expect(svg.match(/<svg\b/g)).toHaveLength(3);
    expect(svg).toContain(`<svg x="${a.width + 48}" y="0"`);
    const single = chartsFor(program('tp-status'), 'prof');
    expect(combineChartsSvg(single)).toBe(single[0].svg);
  });
});

describe('chart ↔ code lines', () => {
  it('maps a node of the STATUS chart to its exact lines', () => {
    const pr = project('tp-status');
    const p = pr.program as Program;
    const link = codeLinkFor(p, pr.source)!;
    expect(link.exact).toBe(true);
    const chart = chartsFor(p, 'prof')[0];
    const decision = chart.diagram.nodes.find((n) => n.shape === 'decision')!;
    const range = codeRangeForRefs(link, decision.refs)!;
    expect(range.line).toBeGreaterThan(0);
    const text = pr.source.split('\n').slice(range.line - 1, range.endLine).join('\n');
    expect(text).toContain('STATUS.F2');
    // And back: the lines of that range lead to its ids, innermost first.
    const ids = refsAtLine(link, range.line);
    expect(decision.refs.some((r) => ids.includes(r))).toBe(true);
  });

  it('finds the same lines in hand-edited code', () => {
    const pr = project('tp1-demux');
    const p = pr.program as Program;
    const edited = `// Mon en-tête\n// ajouté à la main\n${pr.source.replace(/ {7}\/\/ RA0 : entrée L0/, '   // L0')}`;
    const link = codeLinkFor(p, edited)!;
    expect(link.exact).toBe(false);
    const exact = codeLinkFor(p, pr.source)!;
    const someIf = Object.entries(exact.map).find(([, r]) => exact.generated[r.line - 1].includes('if ('))!;
    const original = exact.map[someIf[0]];
    const moved = locateRange(link, original)!;
    expect(moved.line).toBe(original.line + 2);
    expect(refsAtLine(link, moved.line)).toEqual([]); // only exact links follow the execution line
  });

  it('ignores comments and spacing when comparing lines', () => {
    expect(lineKey('    D0=1;       // allumée')).toBe('d0=1;');
    expect(lineKey('}')).toBe('}');
    expect(rangeForRefs({ a: { line: 3, endLine: 4 }, b: { line: 6, endLine: 9 } }, ['a', 'b', 'zz'])).toEqual({ line: 3, endLine: 9 });
    // A diamond lists the whole if (s1) and its branch (b2): the branch lines win.
    expect(rangeForRefs({ s1: { line: 10, endLine: 30 }, b2: { line: 15, endLine: 20 } }, ['s1', 'b2'])).toEqual({ line: 15, endLine: 20 });
    expect(rangeForRefs({}, ['x'])).toBeNull();
  });
});
