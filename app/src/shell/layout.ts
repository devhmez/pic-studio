// Splitter positions of the 2×2 panel grid, persisted per browser.
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

export interface GridLayout {
  /** Width fraction of the left column (Schéma / Assembleur). */
  col: number;
  /** Height fraction of the top panel in the left column. */
  left: number;
  /** Height fraction of the top panel in the right column. */
  right: number;
}

export const DEFAULT_LAYOUT: GridLayout = { col: 0.56, left: 0.6, right: 0.58 };
const KEY = 'pic-studio.layout.v1';
const MIN = 0.15;
const MAX = 0.85;

export const clampFraction = (v: number): number => Math.min(MAX, Math.max(MIN, v));

function read(): GridLayout {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<GridLayout> | null;
    if (!raw) return DEFAULT_LAYOUT;
    const pick = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? clampFraction(v) : d);
    return { col: pick(raw.col, DEFAULT_LAYOUT.col), left: pick(raw.left, DEFAULT_LAYOUT.left), right: pick(raw.right, DEFAULT_LAYOUT.right) };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

const layoutStore = createStore<GridLayout>(() => read());
let saveTimer: ReturnType<typeof setTimeout> | null = null;

layoutStore.subscribe((state) => {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // Storage unavailable: the layout simply is not remembered.
    }
  }, 300);
});

export function useGridLayout(): GridLayout {
  return useStore(layoutStore);
}

export function setGridLayout(patch: Partial<GridLayout>): void {
  const next = { ...layoutStore.getState() };
  for (const key of Object.keys(patch) as (keyof GridLayout)[]) {
    const v = patch[key];
    if (v !== undefined) next[key] = clampFraction(v);
  }
  layoutStore.setState(next);
}

export function resetGridLayout(key?: keyof GridLayout): void {
  layoutStore.setState(key ? { ...layoutStore.getState(), [key]: DEFAULT_LAYOUT[key] } : DEFAULT_LAYOUT);
}
