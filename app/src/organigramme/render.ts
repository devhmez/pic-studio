// The organigramme renderer (@pic/organigramme), cached per program and options. Kept apart from ./charts.ts so it
// loads with the organigramme panel or on the first export, not with the app's first chunk.
import { renderProgramCharts, type DiagramStyle, type ProgramChart } from '@pic/organigramme';
import type { Program } from '@pic/program-model';
import { DEFAULT_CHART_PREFS, type ChartPrefs } from './charts';

const chartsCache = new WeakMap<Program, Map<string, ProgramChart[]>>();

/** All charts of a program (main, then each function / the interrupt routine), cached per program and options. */
export function chartsFor(program: Program, style: DiagramStyle, prefs: ChartPrefs = DEFAULT_CHART_PREFS, idPrefix = 'org'): ProgramChart[] {
  let perProgram = chartsCache.get(program);
  if (!perProgram) {
    perProgram = new Map();
    chartsCache.set(program, perProgram);
  }
  const key = `${style}|${prefs.logic}|${prefs.wording}|${prefs.waits}|${prefs.counters}|${idPrefix}`;
  let charts = perProgram.get(key);
  if (!charts) {
    charts = renderProgramCharts(program, {
      style, logic: prefs.logic, wording: prefs.wording, waits: prefs.waits, counters: prefs.counters, idPrefix,
    });
    perProgram.set(key, charts);
  }
  return charts;
}
