// What each command of the Mac app's menu bar does (electron/menu.ts → window.picStudioShell.onCommand). They run
// the same code as the toolbar buttons and the keyboard shortcuts.
import {
  exportCFile, exportCodeCapture, exportHex, exportOrganigramme, exportRenduPdf, exportSchematic, exportSchematicCapture,
  exportWiringSheet,
} from '../export/actions';
import { redo as redoSchematic, undo as undoSchematic } from '../schematic/editorStore';
import { focusPanelContent } from '../shell/shortcuts';
import { newProject, openPendingFiles, openProject, saveProject } from '../shell/projectFiles';
import { notify } from '../shell/toast';
import { getApp } from '../state/store';
import type { PanelId } from '../state/types';
import { hostErrorMessage } from './errors';
import type { ShellCommand } from './shell';

const showPanel = (panel: PanelId) => () => {
  getApp().focusPanel(panel);
  focusPanelContent(panel);
};

/** The focused element as Édition → Annuler sees it (document.activeElement; a plain object in the tests). */
export interface FocusTarget {
  readonly tagName: string;
  readonly isContentEditable?: boolean;
  closest(selector: string): unknown;
}

/**
 * Whether Édition → Annuler / Rétablir is for the schematic's own history: the focus is in the Schéma panel, or
 * nowhere in particular while that panel is the active one. Never for a text field or the code editor: the native
 * command, run first by the main process, has already served them.
 */
export function menuUndoIsForSchematic(active: FocusTarget | null, focusedPanel: PanelId): boolean {
  if (active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return false;
  if (active?.closest('[data-panel="schema"]')) return true;
  return (!active || active.tagName === 'BODY') && focusedPanel === 'schema';
}

function undoRedo(command: 'undo' | 'redo'): void {
  const app = getApp();
  const active = typeof document === 'undefined' ? null : document.activeElement;
  // Locked while the simulation runs, like the panel's own Annuler / Rétablir buttons.
  if (app.sim.status === 'running' || !menuUndoIsForSchematic(active, app.ui.focusedPanel)) return;
  (command === 'undo' ? undoSchematic : redoSchematic)();
}

/** Every menu command, typed exhaustively: adding one to SHELL_COMMANDS without a handler does not compile. */
export const SHELL_COMMAND_HANDLERS: Readonly<Record<ShellCommand, () => void | Promise<void>>> = {
  new: () => newProject(),
  open: () => openProject(),
  'open:pending': () => openPendingFiles(),
  save: () => saveProject(false),
  saveAs: () => saveProject(true),
  templates: () => getApp().setTemplatePickerOpen(true),
  undo: () => undoRedo('undo'),
  redo: () => undoRedo('redo'),
  'export:rendu-pdf': () => exportRenduPdf(),
  'export:c': () => exportCFile(),
  'export:hex': () => exportHex(),
  'export:code-png': () => exportCodeCapture(),
  'export:organigramme-pdf': () => exportOrganigramme('pdf'),
  'export:organigramme-png': () => exportOrganigramme('png'),
  'export:schematic-png': () => exportSchematic('png'),
  'export:schematic-capture': () => exportSchematicCapture(),
  'export:wiring-pdf': () => exportWiringSheet('print'),
  'panel:schema': showPanel('schema'),
  'panel:code': showPanel('code'),
  'panel:asm': showPanel('asm'),
  'panel:organigramme': showPanel('organigramme'),
  'drawer:assistant': () => getApp().setAssistantOpen(!getApp().ui.assistantOpen),
  'drawer:learn': () => getApp().setLearnOpen(!getApp().ui.learnOpen),
  'drawer:copilot': () => getApp().setCopilotOpen(!getApp().ui.copilotOpen),
  'drawer:learn:open': () => getApp().setLearnOpen(true),
};

/** Run a menu command; failures end up in a toast instead of an unhandled rejection. */
export async function runShellCommand(command: ShellCommand): Promise<void> {
  const handler = SHELL_COMMAND_HANDLERS[command];
  if (!handler) return;
  try {
    await handler();
  } catch (e) {
    notify(hostErrorMessage(e), 'error');
  }
}
