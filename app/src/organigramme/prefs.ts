// Per-viewer organigramme preferences (diamond wording, section prose), shared by the panel and the exports.
// Kept in localStorage: they are about how this student likes to read the chart, not part of the project.
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { DEFAULT_CHART_PREFS, type ChartPrefs } from './charts';

const KEY = 'pic-studio.organigramme.v1';

function load(): ChartPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return DEFAULT_CHART_PREFS;
    const v = JSON.parse(raw) as Partial<ChartPrefs>;
    return {
      logic: v.logic === 'c' ? 'c' : 'words',
      wording: v.wording === 'generic' ? 'generic' : 'tp',
      waits: v.waits === 'loop' ? 'loop' : 'exit',
      counters: v.counters === 'loop' ? 'loop' : 'box',
    };
  } catch {
    return DEFAULT_CHART_PREFS;
  }
}

export const chartPrefsStore = createStore<ChartPrefs>(() => load());

export function setChartPrefs(patch: Partial<ChartPrefs>): void {
  chartPrefsStore.setState(patch);
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(chartPrefsStore.getState()));
  } catch {
    // Storage unavailable: the preference lasts for this session only.
  }
}

export function useChartPrefs(): ChartPrefs {
  return useStore(chartPrefsStore);
}
