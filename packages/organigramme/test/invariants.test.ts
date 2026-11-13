// Layout invariants for EVERY template in /templates, every chart (main + functions), both styles:
// inside the canvas, no overlapping shapes or labels, orthogonal edges joined to ports, no crossings, everything
// connected Début → Fin, `oui` / `non` on every decision, all text fits its shape.
import { describe, expect, it } from 'vitest';
import { emptyProgram, type Program } from '@pic/program-model';
import { layout, layoutFunction, renderProgramCharts, renderSvg, type Diagram, type DiagramStyle } from '../src';
import { allProblems, checkConnectivity, checkEdges, checkNoOverlaps, checkTextFits, visible } from './geometry';
import { EXTRA_PROGRAMS, loadTemplate, TEMPLATE_IDS } from './support';

const STYLES: readonly DiagramStyle[] = ['prof', 'bw'];

function chartsOf(program: Program, style: DiagramStyle): { name: string; diagram: Diagram }[] {
  return [
    { name: 'main', diagram: layout(program, { style }) },
    ...program.functions.map((f) => ({ name: f.name, diagram: layoutFunction(program, f, { style }) })),
  ];
}

describe('every template chart satisfies the layout invariants', () => {
  it('covers all thirteen templates', () => {
    expect(TEMPLATE_IDS).toEqual([
      'tp0-exemple1', 'tp0-exemple2', 'tp1-demux', 'tp-status', 'tp-vote', 'tp-traffic', 'tp-pupitre',
      'tp4-inte', 'ch5-manip-rb0', 'tp-traffic-int', 'tp5-int-rb0', 'ch6-exo-rbie', 'tp6-rbie',
    ]);
  });

  for (const id of TEMPLATE_IDS) {
    for (const style of STYLES) {
      it(`${id} (${style})`, () => {
        const program = loadTemplate(id);
        for (const { name, diagram } of chartsOf(program, style)) {
          expect(allProblems(diagram), `${id} ${name} ${style}`).toEqual([]);
          expect(diagram.style).toBe(style);
        }
      });
    }
  }

  it('the prof style keeps her branch directions: if `oui` exits down, `non` exits right', () => {
    for (const id of TEMPLATE_IDS) {
      const d = layout(loadTemplate(id));
      for (const e of d.edges.filter((x) => x.label)) {
        const from = d.nodes.find((n) => n.id === e.from)!;
        if (from.shape !== 'decision' || !from.id.startsWith('dec-b')) continue; // if / else-if diamonds
        const [p0, p1] = e.points;
        const cx = from.box.x + from.box.w / 2;
        if (e.label!.text === 'oui') {
          expect(p0, `${id} ${e.id}`).toEqual({ x: cx, y: from.box.y + from.box.h });
          expect(p1.x).toBe(p0.x);
          expect(p1.y).toBeGreaterThan(p0.y);
        } else {
          expect(p0, `${id} ${e.id}`).toEqual({ x: from.box.x + from.box.w, y: from.box.y + from.box.h / 2 });
          expect(p1.y).toBe(p0.y);
          expect(p1.x).toBeGreaterThan(p0.x);
        }
      }
    }
  });

  it('every infinite loop has its « Boucle infinie » tag touching a left return line', () => {
    for (const id of TEMPLATE_IDS) {
      const program = loadTemplate(id);
      const d = layout(program);
      const tags = d.nodes.filter((n) => n.shape === 'tag');
      expect(tags.length, id).toBe(program.loop ? 1 : 0);
      if (!program.loop) continue;
      const tip = { x: tags[0].box.x + tags[0].box.w, y: tags[0].box.y + tags[0].box.h / 2 };
      const loops = d.edges.filter((e) => e.kind === 'loop' && e.from.startsWith('j') && e.to.startsWith('j'));
      const touching = loops.filter((e) => e.points.some((p, i) => {
        const q = e.points[i + 1];
        return q && p.x === tip.x && q.x === tip.x && Math.min(p.y, q.y) < tip.y && Math.max(p.y, q.y) > tip.y;
      }));
      expect(touching.length, id).toBe(1);
      // The return line is left of every shape inside the loop.
      const returnX = tip.x;
      const spine = d.nodes.find((n) => n.shape === 'start')!;
      expect(returnX).toBeLessThan(spine.box.x);
    }
  });

  it('renders every chart of every template to a well-formed standalone SVG', () => {
    for (const id of TEMPLATE_IDS) {
      for (const style of STYLES) {
        for (const chart of renderProgramCharts(loadTemplate(id), { style })) {
          const svg = chart.svg;
          expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
          expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
          expect(svg).toContain('<marker');
          expect(svg).toContain('fill="#FFFFFF"');
          expect(svg).not.toMatch(/NaN|undefined|Infinity/);
          // Balanced tags (cheap well-formedness check: every <g …> closes).
          expect((svg.match(/<g /g) ?? []).length).toBe((svg.match(/<\/g>/g) ?? []).length);
          expect((svg.match(/<text /g) ?? []).length).toBe((svg.match(/<\/text>/g) ?? []).length);
        }
      }
    }
  });
});

describe('constructs outside the templates', () => {
  for (const [name, p] of Object.entries(EXTRA_PROGRAMS)) {
    for (const style of STYLES) {
      it(`${name} (${style})`, () => {
        for (const { name: chart, diagram } of chartsOf(p, style)) {
          expect([...checkNoOverlaps(diagram), ...checkEdges(diagram), ...checkConnectivity(diagram), ...checkTextFits(diagram)], `${name} ${chart}`).toEqual([]);
          expect(allProblems(diagram), `${name} ${chart}`).toEqual([]);
          expect(renderSvg(diagram)).not.toMatch(/NaN|undefined/);
        }
      });
    }
  }

  it('an empty loop still gets a box so the « Boucle infinie » has something to loop on', () => {
    const d = layout(emptyProgram());
    expect(visible(d).map((n) => n.lines.map((l) => l.text).join(' / '))).toContain('Aucune instruction');
  });

  it('is deterministic', () => {
    const p = loadTemplate('tp-vote');
    expect(JSON.stringify(layout(p))).toBe(JSON.stringify(layout(loadTemplate('tp-vote'))));
    expect(renderSvg(layout(p))).toBe(renderSvg(layout(p)));
  });
});

describe('the invariant checks themselves catch broken diagrams', () => {
  const fresh = () => layout(loadTemplate('tp-status'));
  const find = (d: Diagram, pred: (n: Diagram['nodes'][number]) => boolean) => d.nodes.find(pred)!;

  it('overlapping shapes', () => {
    const d = fresh();
    const boxes = visible(d).filter((n) => n.shape === 'process');
    boxes[1].box.y = boxes[0].box.y + 5;
    expect(checkNoOverlaps(d).some((m) => m.includes('overlap'))).toBe(true);
  });

  it('diagonal segments and edges detached from their nodes', () => {
    const d = fresh();
    d.edges[0].points[1].x += 3;
    const problems = checkEdges(d);
    expect(problems.some((m) => m.includes('diagonal'))).toBe(true);
    expect(problems.some((m) => m.includes('does not end on a port'))).toBe(true);
  });

  it('edges crossing each other or running through a shape', () => {
    const d = fresh();
    const merges = d.edges.filter((e) => e.kind === 'merge');
    expect(merges).toHaveLength(2);
    // Lift the lower merge row above the upper one: it now cuts the other column's drop.
    const [upper, lower] = merges[0].points[1].y < merges[1].points[1].y ? merges : [merges[1], merges[0]];
    const y = upper.points[1].y - 5;
    lower.points[1].y = y;
    lower.points[2].y = y;
    expect(checkEdges(d).some((m) => m.includes(`edges ${upper.id} and ${lower.id} cross`) || m.includes(`edges ${lower.id} and ${upper.id} cross`))).toBe(true);
    // Run the return line of the loop through the loop body.
    const d2 = fresh();
    const loop = d2.edges.find((e) => e.kind === 'loop')!;
    const body = d2.nodes.find((n) => n.role === 'action' && n.lines[0]?.text === 'Les Leds sont éteintes')!;
    for (const p of loop.points) if (p.x < loop.points[0].x) p.x = body.box.x + 10;
    expect(checkEdges(d2).some((m) => m.includes(`crosses node ${body.id}`))).toBe(true);
  });

  it('text that does not fit', () => {
    const d = fresh();
    const dec = find(d, (n) => n.shape === 'decision');
    dec.lines = [{ text: 'une condition beaucoup trop longue pour ce losange' }];
    const box = find(d, (n) => n.id === 'config');
    box.box.w = 60;
    const problems = checkTextFits(d);
    expect(problems.some((m) => m.includes('diamond'))).toBe(true);
    expect(problems.some((m) => m.startsWith('config'))).toBe(true);
  });

  it('a decision without its `non` exit', () => {
    const d = fresh();
    d.edges = d.edges.filter((e) => e.label?.text !== 'non');
    expect(checkConnectivity(d).some((m) => m.includes('exits'))).toBe(true);
  });
});
