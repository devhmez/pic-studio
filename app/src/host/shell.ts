// Second, app-shell-only contract between electron/preload.ts and the renderer, exposed as
// `window.picStudioShell` next to `window.picStudio` (bridge.ts). It carries what the fixed bridge does not:
// application-menu commands, full-screen changes, the theme and the « renderer ready » ping. Imported by both
// sides (electron/menu.ts bundles the command list), so it must stay free of DOM/React imports.

/** Commands sent by the native application menu (and by the Finder « Ouvrir avec » flow: 'open:pending'). */
export const SHELL_COMMANDS = [
  'new',
  'open',
  /** Open the files the Finder sent (double-click, « Ouvrir avec », Recent items), one after the other; no dialog. */
  'open:pending',
  'save',
  'saveAs',
  'templates',
  /** Édition → Annuler / Rétablir: the main process already ran the native command (text fields, code editor). */
  'undo',
  'redo',
  'export:rendu-pdf',
  'export:c',
  'export:hex',
  'export:code-png',
  'export:organigramme-pdf',
  'export:organigramme-png',
  'export:schematic-png',
  'export:schematic-capture',
  'export:wiring-pdf',
  'panel:schema',
  'panel:code',
  'panel:asm',
  'panel:organigramme',
  'drawer:assistant',
  'drawer:learn',
  'drawer:copilot',
  /** Aide → Comprendre le PIC16F84A: opens the drawer (never closes it, unlike the Affichage toggle). */
  'drawer:learn:open',
] as const;

export type ShellCommand = (typeof SHELL_COMMANDS)[number];

export function isShellCommand(value: unknown): value is ShellCommand {
  return typeof value === 'string' && (SHELL_COMMANDS as readonly string[]).includes(value);
}

/** Which side drawer is open: the « Affichage » menu shows a check mark next to it. */
export interface DrawerState {
  assistant: boolean;
  learn: boolean;
  copilot: boolean;
}

/** The « Affichage » menu item of each drawer: a checkbox whose id is its toggle command. */
export const DRAWER_COMMANDS = {
  assistant: 'drawer:assistant',
  learn: 'drawer:learn',
  copilot: 'drawer:copilot',
} as const satisfies Record<keyof DrawerState, ShellCommand>;

export function isDrawerState(value: unknown): value is DrawerState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (Object.keys(DRAWER_COMMANDS) as (keyof DrawerState)[]).every((k) => typeof v[k] === 'boolean');
}

/** The app's theme setting (Toolbar), mirrored to the native window (dialogs, scrollbars, traffic lights). */
export type ShellTheme = 'system' | 'light' | 'dark';

export function isShellTheme(value: unknown): value is ShellTheme {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** Result of one smoke check run by the renderer for the packaging test. */
export type SmokeCheck = 'ok' | 'timeout' | 'error' | 'skipped';

/** What the renderer reports once it has rendered (also written to the smoke-test log). */
export interface RendererReadyInfo {
  /** location.href of the page (file:// in the packaged app, http://localhost:5173 in dev). */
  href: string;
  /** True when the platform was switched to the native host (window.picStudio). */
  hostPlatform: boolean;
  /** Smoke test only: the simulation Web Worker loaded a program and stepped it. */
  simWorker?: SmokeCheck;
  /** Program counter seen in the worker's snapshot during the smoke check. */
  simPc?: number;
  /** Smoke test only: pdf.js parsed a PDF in its own Web Worker. */
  pdfWorker?: SmokeCheck;
  /** Smoke test only: files saved through window.picStudio (project, PNG, fiche de câblage PDF). */
  saves?: SmokeCheck;
  /** Names the main process reported for those files. */
  savedFiles?: string[];
  /** Smoke test only: Content-Security-Policy violations seen by the page. */
  cspViolations?: string[];
  /** Milliseconds from navigation start to the first render. */
  renderMs?: number;
  detail?: string;
}

export interface PicStudioShell {
  /** Subscribe to menu commands. Returns an unsubscribe function. */
  onCommand(listener: (command: ShellCommand) => void): () => void;
  /** Subscribe to full-screen changes (the traffic lights disappear in full screen). */
  onFullScreen(listener: (fullScreen: boolean) => void): () => void;
  /** Mirror the app's theme to the native window. */
  setTheme(theme: ShellTheme): void;
  /** Unsaved changes: macOS shows a dot in the window's close button. */
  setEdited(edited: boolean): void;
  /** Which drawer is open (check marks of the « Affichage » menu). */
  setDrawers(drawers: DrawerState): void;
  /** Native French « OK / Annuler » box (replaces window.confirm, whose Electron buttons are English). */
  confirm(message: string): boolean;
  /** Native French « OK » box (replaces window.alert). */
  alert(message: string): void;
  /** Tell the main process the UI is up (flushes a pending Finder « open file »). */
  rendererReady(info: RendererReadyInfo): void;
  /** True when the app was started for the packaging smoke test (PIC_STUDIO_SMOKE_LOG). */
  smoke: boolean;
}

declare global {
  interface Window {
    picStudioShell?: PicStudioShell;
  }
}

/** IPC channel names shared by electron/main.ts and electron/preload.ts (renderer code never uses them). */
export const HOST_CHANNELS = {
  openProjectFile: 'platform:open-project-file',
  saveFile: 'platform:save-file',
  savePdf: 'platform:save-pdf',
  openDocument: 'platform:open-document',
  command: 'shell:command',
  fullScreen: 'shell:full-screen',
  theme: 'shell:theme',
  edited: 'shell:edited',
  drawers: 'shell:drawers',
  confirm: 'shell:confirm',
  alert: 'shell:alert',
  rendererReady: 'shell:renderer-ready',
} as const;

/** Command-line switch carrying the app version to the sandboxed preload (process.argv). */
export const VERSION_SWITCH = '--pic-studio-version=';
/** Command-line switch telling the preload the app runs the packaging smoke test. */
export const SMOKE_SWITCH = '--pic-studio-smoke';
