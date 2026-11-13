// Remembers the main window's position and size between launches (userData/window-state.json).
import { app, screen, type BrowserWindow } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fitWindowBounds, isRect, MIN_WINDOW_SIZE, type Rect } from '../app/src/host/windowBounds';

export const MIN_SIZE = MIN_WINDOW_SIZE;

export interface WindowState {
  bounds?: Rect;
  maximized?: boolean;
  fullScreen?: boolean;
}

const stateFile = (): string => path.join(app.getPath('userData'), 'window-state.json');

export function loadWindowState(): WindowState {
  try {
    const raw: unknown = JSON.parse(readFileSync(stateFile(), 'utf8'));
    if (typeof raw !== 'object' || raw === null) return {};
    const r = raw as Record<string, unknown>;
    return {
      bounds: isRect(r.bounds) ? r.bounds : undefined,
      maximized: r.maximized === true,
      fullScreen: r.fullScreen === true,
    };
  } catch {
    return {};
  }
}

/** Bounds to open the window with (see fitWindowBounds). */
export function initialBounds(state: WindowState): Rect {
  return fitWindowBounds(
    state.bounds,
    screen.getAllDisplays().map((d) => d.workArea),
    screen.getPrimaryDisplay().workArea,
  );
}

function save(state: WindowState): void {
  try {
    mkdirSync(path.dirname(stateFile()), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(state));
  } catch {
    // Not worth bothering the student: the window simply opens at the default size next time.
  }
}

/** Save the bounds when the window moves or resizes (debounced) and when it closes. */
export function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null;
  const snapshot = (): WindowState => ({
    // getNormalBounds: the un-maximized size, so « Zoom » / full screen are restored on top of it.
    bounds: win.getNormalBounds(),
    maximized: win.isMaximized(),
    fullScreen: win.isFullScreen(),
  });
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!win.isDestroyed()) save(snapshot());
    }, 500);
  };
  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('enter-full-screen', schedule);
  win.on('leave-full-screen', schedule);
  win.on('close', () => {
    if (timer) clearTimeout(timer);
    save(snapshot());
  });
}
