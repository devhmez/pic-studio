// Global keyboard shortcuts (captured before the panels, so they also work inside the code editor).
import { useEffect } from 'react';
import { run as runCommand, runDebugKey } from '../debug/commands';
import { appStore, getApp } from '../state/store';
import type { PanelId } from '../state/types';
import { IS_MAC } from './format';
import { PANELS } from './panels';
import { newProject, openProject, saveProject } from './projectFiles';

/** Move keyboard focus into a panel (the code editor, the schematic canvas...). */
export function focusPanelContent(id: PanelId): void {
  requestAnimationFrame(() => {
    const body = document.querySelector<HTMLElement>(`[data-panel="${id}"] .panel-body`);
    if (!body) return;
    const target = body.querySelector<HTMLElement>('[data-autofocus], .cm-content, [tabindex="0"], input, button') ?? body;
    if (target === body && !body.hasAttribute('tabindex')) body.tabIndex = -1;
    target.focus({ preventScroll: true });
  });
}

/**
 * Panel number of ⌘1–⌘4, from the physical key (KeyboardEvent.code): on a French AZERTY keyboard the digit row
 * types & é " ' without Shift, so e.key never holds the digit. Falls back to e.key for synthetic events.
 */
export function panelDigit(e: Pick<KeyboardEvent, 'code' | 'key'>): number | null {
  const m = /^(?:Digit|Numpad)([1-4])$/.exec(e.code ?? '') ?? /^([1-4])$/.exec(e.key);
  return m ? Number(m[1]) : null;
}

function onKeyDown(e: KeyboardEvent): void {
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  const app = getApp();
  let handled = true;

  if (mod && !e.altKey) {
    const key = e.key.toLowerCase();
    const digit = panelDigit(e);
    if (digit !== null && !e.shiftKey) {
      const panel = PANELS[digit - 1].id;
      app.focusPanel(panel);
      focusPanelContent(panel);
    } else if (key === 'b' && !e.shiftKey) app.build();
    else if (key === 'r' && !e.shiftKey) runCommand();
    else if (key === 's') void saveProject(e.shiftKey);
    else if (key === 'o' && !e.shiftKey) void openProject();
    else if (key === 'n' && !e.shiftKey) newProject();
    else handled = false;
  } else if (!mod && !e.altKey && !e.ctrlKey && !e.metaKey) {
    handled = runDebugKey(e);
  } else {
    handled = false;
  }

  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}

export function useGlobalShortcuts(): void {
  useEffect(() => {
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}

/** Compile automatically once the student stops typing (the status chip and the debugger stay up to date). */
export function useAutoBuild(delayMs = 600): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (appStore.getState().compile.stale) appStore.getState().build();
      }, delayMs);
    };
    if (appStore.getState().compile.stale) schedule();
    const unsubscribe = appStore.subscribe((s, prev) => {
      if (s.compile.stale && (s.project.source !== prev.project.source || s.project.clockHz !== prev.project.clockHz || !prev.compile.stale)) {
        schedule();
      }
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [delayMs]);
}

/** Apply the theme preference to <html data-theme>. */
export function useThemeAttribute(): void {
  useEffect(() => {
    const apply = (theme: string) => {
      const root = document.documentElement;
      if (theme === 'system') root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', theme);
    };
    apply(appStore.getState().ui.theme);
    return appStore.subscribe((s, prev) => {
      if (s.ui.theme !== prev.ui.theme) apply(s.ui.theme);
    });
  }, []);
}

/** Write the autosave before the page goes away. */
export function useAutosaveFlush(): void {
  useEffect(() => {
    const flush = () => appStore.flushAutosave();
    window.addEventListener('pagehide', flush);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}
