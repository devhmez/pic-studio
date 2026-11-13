// French number formatting for the toolbar and the status bar.

const fr2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fr3 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const fr1 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const frInt = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

/** Simulated time: « 12,4 ms », « 3,250 s », « 2 min 05,1 s ». */
export function formatSimTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 s';
  if (seconds < 1e-3) return `${fr1.format(seconds * 1e6)} µs`;
  if (seconds < 1) return `${fr1.format(seconds * 1e3)} ms`;
  if (seconds < 60) return `${fr3.format(seconds)} s`;
  const min = Math.floor(seconds / 60);
  const rest = seconds - min * 60;
  return `${min} min ${rest < 10 ? '0' : ''}${fr1.format(rest)} s`;
}

/** Cycle counter with French digit grouping. */
export function formatCount(n: number): string {
  return frInt.format(n);
}

/** Real-time ratio: « ×0,98 », « ×12 ». */
export function formatRatio(ratio: number): string {
  if (!(ratio > 0)) return '—';
  if (ratio >= 100) return `×${frInt.format(ratio)}`;
  if (ratio >= 10) return `×${fr1.format(ratio)}`;
  return `×${fr2.format(ratio)}`;
}

/** Program address the way the course writes it: 0004h. */
export function formatAddr(addr: number): string {
  return `${addr.toString(16).toUpperCase().padStart(4, '0')}h`;
}

/** Clock frequency: « 1 MHz », « 32,768 kHz ». */
export function formatClock(hz: number): string {
  if (hz >= 1e6) return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 }).format(hz / 1e6)} MHz`;
  if (hz >= 1e3) return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 }).format(hz / 1e3)} kHz`;
  return `${frInt.format(hz)} Hz`;
}

/** Speed multiplier label: « ×0,25 », « max ». */
export function formatSpeed(speed: number): string {
  if (!Number.isFinite(speed)) return 'max';
  return `×${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(speed)}`;
}

/** « 1 erreur », « 3 erreurs ». */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(n)} ${n > 1 ? pluralForm : singular}`;
}

/** True on macOS (⌘ shortcuts), false elsewhere (Ctrl). */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Modifier symbol for tooltips. */
export const MOD = IS_MAC ? '⌘' : 'Ctrl+';

/** PIC clocks offered in the toolbar and the PIC properties (the prof uses 1 MHz, and 8 MHz for the traffic light). */
export const CLOCK_OPTIONS: readonly number[] = [1_000_000, 4_000_000, 8_000_000, 20_000_000];
