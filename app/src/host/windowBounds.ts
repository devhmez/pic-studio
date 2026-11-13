// Where the Mac app's window opens (electron/windowState.ts): the saved bounds when they are still mostly on a
// connected display (the student may have unplugged an external screen), otherwise the default size, centred.
// Pure and DOM-free (unit-tested here).

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export const DEFAULT_WINDOW_SIZE: Size = { width: 1440, height: 900 };
export const MIN_WINDOW_SIZE: Size = { width: 1100, height: 720 };

/** Visible part needed for saved bounds to be reused (enough to grab the title bar). */
const MIN_VISIBLE = { width: 200, height: 100 } as const;

export function isRect(v: unknown): v is Rect {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (['x', 'y', 'width', 'height'] as const).every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]));
}

const overlap = (a0: number, a1: number, b0: number, b1: number): number => Math.min(a1, b1) - Math.max(a0, b0);

/**
 * Bounds to open the window with. `displays` are the work areas of the connected screens, `primary` the work area
 * of the main one. Without usable saved bounds: the default size (shrunk to the screen, never below the minimum),
 * centred on the main screen.
 */
export function fitWindowBounds(saved: Rect | undefined, displays: readonly Rect[], primary: Rect): Rect {
  if (saved && isRect(saved)) {
    const width = Math.max(MIN_WINDOW_SIZE.width, Math.round(saved.width));
    const height = Math.max(MIN_WINDOW_SIZE.height, Math.round(saved.height));
    const x = Math.round(saved.x);
    const y = Math.round(saved.y);
    const visible = displays.some((a) =>
      overlap(x, x + width, a.x, a.x + a.width) >= MIN_VISIBLE.width &&
      overlap(y, y + height, a.y, a.y + a.height) >= MIN_VISIBLE.height);
    if (visible) return { x, y, width, height };
  }
  const width = Math.max(MIN_WINDOW_SIZE.width, Math.min(DEFAULT_WINDOW_SIZE.width, primary.width));
  const height = Math.max(MIN_WINDOW_SIZE.height, Math.min(DEFAULT_WINDOW_SIZE.height, primary.height));
  return {
    x: Math.round(primary.x + (primary.width - width) / 2),
    y: Math.round(primary.y + Math.max(0, (primary.height - height) / 2)),
    width,
    height,
  };
}
