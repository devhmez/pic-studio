// Pan / zoom of the infinite canvas. Screen = world × k + (x, y), world in grid units (0.1 in).
import type { Point } from '@pic/circuit';
import type { Rect } from './editing';

export interface View {
  x: number;
  y: number;
  /** Pixels per grid step. */
  k: number;
}

export const MIN_ZOOM = 2;
export const MAX_ZOOM = 60;
export const DEFAULT_VIEW: View = { x: 40, y: 40, k: 10 };

export const clampZoom = (k: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

export function toWorld(view: View, sx: number, sy: number): Point {
  return { x: (sx - view.x) / view.k, y: (sy - view.y) / view.k };
}

export function toScreen(view: View, p: Point): Point {
  return { x: p.x * view.k + view.x, y: p.y * view.k + view.y };
}

/** Zoom by `factor` keeping the screen point (sx, sy) fixed. */
export function zoomAt(view: View, sx: number, sy: number, factor: number): View {
  const k = clampZoom(view.k * factor);
  const f = k / view.k;
  return { k, x: sx - (sx - view.x) * f, y: sy - (sy - view.y) * f };
}

/** View that shows `r` centred in a w×h viewport with a margin (in px). */
export function fitRect(r: Rect | null, w: number, h: number, margin = 32, maxZoom = 24): View {
  if (!r || w <= 0 || h <= 0) return { ...DEFAULT_VIEW, x: w / 2, y: h / 2 };
  const k = clampZoom(Math.min((w - 2 * margin) / Math.max(r.w, 1), (h - 2 * margin) / Math.max(r.h, 1), maxZoom));
  return { k, x: w / 2 - (r.x + r.w / 2) * k, y: h / 2 - (r.y + r.h / 2) * k };
}

/** Visible world rectangle. */
export function visibleWorld(view: View, w: number, h: number): Rect {
  const a = toWorld(view, 0, 0);
  return { x: a.x, y: a.y, w: w / view.k, h: h / view.k };
}

/** Grid dot spacing for a zoom level (dots closer than ~6 px would be noise). */
export function gridStep(k: number): number {
  if (k >= 6) return 1;
  if (k >= 2.4) return 5;
  return 10;
}
