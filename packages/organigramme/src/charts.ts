// All the organigrammes of a program: the main program, then one chart per function / the interrupt routine
// (Ch5–Ch6: « Programme d'interruption » is drawn as its own chart, like the code keeps it in its own function).
import { functionTitle, type Program } from '@pic/program-model';
import { layout, layoutFunction } from './layout';
import { renderSvg } from './svg';
import type { ChartOptions, LayoutOptions, ProgramChart } from './types';

// Her lexicon (research 06 §4.9): « Programme Principal », capital P.
export const MAIN_CHART_TITLE = 'Programme Principal';

export function renderProgramCharts(program: Program, options: ChartOptions = {}): ProgramChart[] {
  const { showTitles, idPrefix = 'org', highlight, ...rest } = options;
  const titled = showTitles ?? program.functions.length > 0;
  const layoutOptions = (title: string): LayoutOptions => (titled ? { ...rest, title } : { ...rest });
  const svgOptions = (suffix: string) => ({ idPrefix: `${idPrefix}-${suffix}`, ...(highlight ? { highlight } : {}) });

  const main = layout(program, layoutOptions(MAIN_CHART_TITLE));
  const charts: ProgramChart[] = [
    { id: 'main', title: MAIN_CHART_TITLE, diagram: main, svg: renderSvg(main, svgOptions('main')) },
  ];
  program.functions.forEach((f, i) => {
    const title = functionTitle(f);
    const id = f.id || `f${i + 1}`;
    const diagram = layoutFunction(program, f, layoutOptions(title));
    charts.push({ id, title, diagram, svg: renderSvg(diagram, svgOptions(id)) });
  });
  return charts;
}
