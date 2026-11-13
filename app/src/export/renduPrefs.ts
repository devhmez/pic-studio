// What the student types once for the « Rendu du TP » header (name, class) and whether to add the trace page.
// Kept in localStorage: it belongs to this student on this Mac, not to a project file.
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

export interface RenduPrefs {
  /** « Nom et prénom » (empty: dotted line to fill in by hand). */
  student: string;
  /** « Classe » (e.g. 2A12). */
  className: string;
  /** Add the « Trace de la simulation » page. */
  includeTrace: boolean;
}

const KEY = 'pic-studio.rendu.v1';
const DEFAULTS: RenduPrefs = { student: '', className: '', includeTrace: true };

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

function load(): RenduPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return DEFAULTS;
    const v = JSON.parse(raw) as Partial<Record<keyof RenduPrefs, unknown>>;
    return {
      student: text(v.student, 120),
      className: text(v.className, 40),
      includeTrace: v.includeTrace !== false,
    };
  } catch {
    return DEFAULTS;
  }
}

export const renduPrefsStore = createStore<RenduPrefs>(() => load());

export function setRenduPrefs(patch: Partial<RenduPrefs>): void {
  renduPrefsStore.setState(patch);
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(renduPrefsStore.getState()));
  } catch {
    // Storage unavailable (private window): the values last for this session only.
  }
}

export function useRenduPrefs(): RenduPrefs {
  return useStore(renduPrefsStore);
}
