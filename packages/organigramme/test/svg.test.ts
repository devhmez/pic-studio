// SVG output: file snapshots (viewable .svg files in test/__snapshots__/) plus the properties the export relies on.
import { describe, expect, it } from 'vitest';
import { layout, layoutFunction, renderProgramCharts, renderSvg } from '../src';
import { loadTemplate } from './support';

const SNAPSHOTS: readonly [string, string][] = [
  ['tp-status', 'prof'],
  ['tp-status', 'bw'],
  ['tp0-exemple1', 'prof'],
  ['tp-vote', 'prof'],
  ['tp-traffic', 'bw'],
];

describe('SVG snapshots', () => {
  for (const [id, style] of SNAPSHOTS) {
    it(`${id} (${style})`, async () => {
      const svg = renderSvg(layout(loadTemplate(id), { style: style as 'prof' | 'bw' }));
      await expect(svg).toMatchFileSnapshot(`./__snapshots__/${id}-${style}.svg`);
    });
  }

  it('tp5-int-rb0 interrupt routine (prof)', async () => {
    const program = loadTemplate('tp5-int-rb0');
    const svg = renderSvg(layoutFunction(program, 'interrupt', { style: 'prof', title: "Programme d'interruption" }));
    await expect(svg).toMatchFileSnapshot('./__snapshots__/tp5-int-rb0-interrupt-prof.svg');
  });
});

describe('renderSvg', () => {
  const status = loadTemplate('tp-status');

  it('is a standalone document: namespace, size, white background, embedded arrowhead, Georgia', () => {
    const d = layout(status);
    const svg = renderSvg(d);
    expect(svg).toMatch(new RegExp(`^<svg xmlns="http://www.w3.org/2000/svg" width="${d.width}" height="${d.height}" viewBox="0 0 ${d.width} ${d.height}"`));
    expect(svg).toContain(`<rect x="0" y="0" width="${d.width}" height="${d.height}" fill="#FFFFFF"/>`);
    expect(svg).toContain('<marker id="org-arrow"');
    expect(svg).toContain('marker-end="url(#org-arrow)"');
    expect(svg).toContain('font-family="Georgia, \'Times New Roman\', Times, serif"');
    expect(svg).not.toMatch(/<image|href=|<style|class=/); // nothing external, inline attributes only
  });

  it('prof style uses her palette; bw uses none of it', () => {
    const prof = renderSvg(layout(status));
    for (const colour of ['#FFD966', '#FFC000', '#F9B57E', '#E26C09', '#C3DFB0', '#385723', '#5B9BD5', '#CEDDAF', '#FF0000']) {
      expect(prof).toContain(colour);
    }
    const bw = renderSvg(layout(status, { style: 'bw' }));
    for (const colour of ['#FFD966', '#F9B57E', '#C3DFB0', '#5B9BD5', '#CEDDAF', '#FF0000']) expect(bw).not.toContain(colour);
    expect(bw).toContain('rx="13"'); // rounded terminals
  });

  it('can recolour a layout in the other style', () => {
    const d = layout(status);
    expect(renderSvg(d, { style: 'bw' })).not.toContain('#5B9BD5');
  });

  it('escapes text and keeps ids apart with idPrefix', () => {
    const vote = loadTemplate('tp-vote');
    const svg = renderSvg(layout(vote), { idPrefix: 'chart 2' });
    expect(svg).toContain('<marker id="chart_2-arrow"');
    expect(svg).toContain('>// var1&gt; var2</text>');
    expect(svg).toContain('>// var1&lt;var2</text>');
    expect(svg).not.toMatch(/<text[^>]*>[^<]*>[^<]*<\/text>/); // no raw '>' left in any text
    expect(svg).toContain('Afficher la lettre \'E\'');
  });

  it('marks nodes with their program ids and outlines highlighted statements', () => {
    const d = layout(status);
    const plain = renderSvg(d);
    expect(plain).toContain('<g data-node="dec-b1" data-refs="s11 b1">');
    expect(plain).not.toContain('#0A84FF');
    const hl = renderSvg(d, { highlight: ['s13'] });
    expect((hl.match(/#0A84FF/g) ?? []).length).toBe(1);
    expect(renderSvg(d, { highlight: ['b1'] }).match(/<polygon[^>]*#0A84FF/)).not.toBeNull();
  });

  it('uses the title as accessible name', () => {
    expect(renderSvg(layout(status))).toContain('aria-label="Organigramme"');
    expect(renderSvg(layout(status, { title: 'Programme Principal' }))).toContain('<title>Programme Principal</title>');
    expect(renderSvg(layout(status), { ariaLabel: 'TP STATUS' })).toContain('aria-label="TP STATUS"');
  });
});

describe('renderProgramCharts', () => {
  it('one chart for a program without functions, untitled like her slides', () => {
    const charts = renderProgramCharts(loadTemplate('tp-status'));
    expect(charts.map((c) => [c.id, c.title])).toEqual([['main', 'Programme Principal']]);
    expect(charts[0].diagram.title).toBeUndefined();
    expect(charts[0].svg).toBe(renderSvg(layout(loadTemplate('tp-status')), { idPrefix: 'org-main' }));
  });

  it('main program then the interrupt routine, each titled, with distinct marker ids', () => {
    const program = loadTemplate('tp5-int-rb0');
    const charts = renderProgramCharts(program, { style: 'bw' });
    expect(charts.map((c) => c.title)).toEqual(['Programme Principal', "Programme d'interruption"]);
    expect(charts[1].id).toBe(program.functions[0].id);
    expect(charts[0].diagram.title).toBe('Programme Principal');
    expect(charts[0].svg).toContain('<marker id="org-main-arrow"');
    expect(charts[1].svg).toContain(`<marker id="org-${program.functions[0].id}-arrow"`);
    expect(charts.every((c) => c.diagram.style === 'bw')).toBe(true);
    // The routine returns to its caller.
    const ends = charts[1].diagram.nodes.filter((n) => n.shape === 'end');
    expect(ends.map((n) => n.lines[0]?.text)).toEqual(['Retour']);
    expect(ends[0].refs).toEqual([program.functions[0].id]);
  });

  it('titles can be forced on or off', () => {
    expect(renderProgramCharts(loadTemplate('tp-status'), { showTitles: true })[0].svg).toContain('>Programme Principal</text>');
    expect(renderProgramCharts(loadTemplate('tp6-rbie'), { showTitles: false })[1].diagram.title).toBeUndefined();
  });

  it('sub-programme titles name the function', () => {
    const program = loadTemplate('tp5-int-rb0');
    program.functions.push({ id: 'f9', name: 'temporisation', kind: 'function', body: [] });
    const charts = renderProgramCharts(program);
    expect(charts.map((c) => c.title)).toEqual(['Programme Principal', "Programme d'interruption", 'Sous-programme temporisation()']);
  });
});
