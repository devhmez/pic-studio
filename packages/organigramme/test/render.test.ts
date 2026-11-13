/// <reference types="node" />
// render: writes every template's organigrammes to packages/organigramme/out/ for a human to look at:
//   out/<id>-<style>.svg            the main program chart
//   out/<id>-<function id>-<style>.svg  each function / interrupt routine chart
//   out/extra-<name>-<style>.svg      the synthetic programs of support.ts (constructs the templates lack)
// Run alone with:  npx vitest run packages/organigramme/test/render.test.ts   (or -t render)
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderProgramCharts, type DiagramStyle } from '../src';
import { EXTRA_PROGRAMS, loadTemplate, TEMPLATE_IDS } from './support';

const OUT = fileURLToPath(new URL('../out/', import.meta.url));
const STYLES: readonly DiagramStyle[] = ['prof', 'bw'];

describe('render', () => {
  it('render: writes every template chart to out/<id>-<style>.svg', () => {
    mkdirSync(OUT, { recursive: true });
    let count = 0;
    for (const id of TEMPLATE_IDS) {
      const program = loadTemplate(id);
      for (const style of STYLES) {
        for (const chart of renderProgramCharts(program, { style })) {
          const name = chart.id === 'main' ? `${id}-${style}.svg` : `${id}-${chart.id}-${style}.svg`;
          writeFileSync(`${OUT}${name}`, chart.svg);
          count++;
        }
      }
    }
    expect(count).toBeGreaterThanOrEqual(TEMPLATE_IDS.length * STYLES.length);
  });

  it('render: writes the synthetic test programs to out/extra-<name>-<style>.svg', () => {
    mkdirSync(OUT, { recursive: true });
    for (const [name, program] of Object.entries(EXTRA_PROGRAMS)) {
      for (const style of STYLES) {
        for (const chart of renderProgramCharts(program, { style })) {
          const file = chart.id === 'main' ? `extra-${name}-${style}.svg` : `extra-${name}-${chart.id}-${style}.svg`;
          writeFileSync(`${OUT}${file}`, chart.svg);
        }
      }
    }
  });
});
