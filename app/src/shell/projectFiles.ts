// « Ouvrir », « Enregistrer » and « Nouveau » for the toolbar, the keyboard shortcuts, the menu bar and the Finder.
import { importDsn } from '@pic/circuit';
import { decodeSource } from '@pic/compiler';
import { platform, type OpenedFile } from '../platform';
import { fitToView } from '../schematic/commands';
import { EMPTY_SELECTION } from '../schematic/editing';
import { commit, pruneSelection, undo as undoSchematic } from '../schematic/editorStore';
import { getApp, parseProjectFile, serializeProject, withClock } from '../state/store';
import { notify } from './toast';

/** File name derived from the project name (no characters the Finder or Windows reject). */
export function projectFileName(name: string): string {
  const base = name.normalize('NFC').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'projet';
  return `${base}.picproj`;
}

function confirmDiscard(action: string): boolean {
  if (!getApp().dirty) return true;
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
  return window.confirm(`Le projet actuel contient des modifications non enregistrées.\n${action} quand même ?`);
}

/**
 * The .picproj the open project was read from in this session, with the platform's id for it: ⌘S writes back to
 * that very file. Files opened but not taken (« Annuler », unreadable) never get here, so ⌘S cannot overwrite them.
 */
let openedFrom: { name: string; fileId: string } | null = null;

/**
 * ⌘S / ⇧⌘S: write the project as .picproj — the same file again when this project was opened from or saved to one,
 * else (a TP template, « Nouveau ») always through the save dialog: a project never saved must not silently
 * overwrite an earlier file that happens to have its name.
 */
export async function saveProject(saveAs = false): Promise<void> {
  const { project, fileName } = getApp();
  const sameFile = !saveAs && !!fileName?.endsWith('.picproj');
  const name = sameFile ? fileName! : projectFileName(project.name);
  // Opened in this session: back to that file by its id. Saved in this session: the platform knows it by name.
  const fileId = sameFile && openedFrom?.name === fileName ? openedFrom.fileId : undefined;
  try {
    const saved = await platform.saveFile(name, serializeProject(project), 'application/json', { saveAs: !sameFile, ...(fileId ? { fileId } : {}) });
    if (!saved) return;
    openedFrom = null;
    getApp().markSaved(saved);
    notify(`Projet enregistré : ${saved}`, 'success');
  } catch (e) {
    notify(`Impossible d’enregistrer le projet : ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
}

/**
 * A MikroC .c file replaces the code. The editor starts a fresh undo history for a replaced text, so the message
 * carries « Annuler », which brings back the previous code (and its assistant link).
 */
function importCode(file: OpenedFile, ask: boolean): boolean {
  const source = decodeSource(file.bytes).replace(/\r\n?/g, '\n');
  if (ask && !confirmDiscard(`Remplacer le code C par celui de « ${file.name} »`)) return false;
  const app = getApp();
  const { source: before, sourceOrigin, program } = app.project;
  app.setSource(source);
  app.focusPanel('code');
  notify(`Code importé depuis ${file.name}`, 'success', source === before ? undefined : {
    label: 'Annuler',
    run: () => {
      // Only while the imported code is still there (not after the student edited it).
      if (getApp().project.source !== source) return;
      if (sourceOrigin === 'generated' && program) getApp().setProgram(program, before);
      else getApp().setSource(before);
    },
  });
  return true;
}

/** An ISIS .DSN file replaces the schematic, as an edit of the schematic editor: ⌘Z (or « Annuler ») brings the old one back. */
function importSchematic(file: OpenedFile, ask: boolean): boolean {
  const imported = importDsn(file.bytes);
  if (ask && !confirmDiscard(`Remplacer le schéma par celui de « ${file.name} »`)) return false;
  // With its clock written into the PIC, as the store keeps it: the editor's history then recognises its own edit.
  const schematic = withClock(imported, imported.clockHz);
  commit(schematic, EMPTY_SELECTION);
  pruneSelection(schematic);
  fitToView();
  getApp().focusPanel('schema');
  notify(`Schéma importé depuis ${file.name}`, 'success', {
    label: 'Annuler',
    run: () => {
      if (getApp().project.schematic === schematic) undoSchematic();
    },
  });
  return true;
}

/**
 * Bring an opened file into the app: a .picproj project replaces the project, a MikroC .c file the code, an ISIS
 * .DSN file the schematic. With `ask`, unsaved changes are confirmed first. True when the file was taken.
 */
function openFile(file: OpenedFile, ask = true): boolean {
  const lower = file.name.toLowerCase();
  try {
    if (lower.endsWith('.c')) return importCode(file, ask);
    if (lower.endsWith('.dsn')) return importSchematic(file, ask);
    const project = parseProjectFile(file.text);
    if (ask && !confirmDiscard('Ouvrir un autre projet')) return false;
    getApp().loadProject(project, file.name);
    openedFrom = file.fileId ? { name: file.name, fileId: file.fileId } : null;
    notify(`Projet ouvert : ${file.name}`, 'success');
    return true;
  } catch (e) {
    notify(e instanceof Error ? e.message : `Fichier illisible : ${file.name}`, 'error');
    return false;
  }
}

/** ⌘O: open a .picproj project, or bring a single piece (.c code, .DSN schematic) into the current project. */
export async function openProject(): Promise<void> {
  const file = await platform.openProjectFile();
  if (file) openFile(file);
}

/** At most this many Finder files per batch (each call takes one off the queue, readable or not). */
const MAX_PENDING_FILES = 50;
let openingPending = false;

/**
 * Files the Finder sent to the Mac app (double-click, « Ouvrir avec », several at once, Recent items), opened one
 * after the other without any dialog. Unsaved changes are confirmed once: the files of one batch were chosen together
 * (e.g. status.c with its status.DSN). A file sent while a batch runs joins it.
 */
export async function openPendingFiles(): Promise<void> {
  if (openingPending) return;
  openingPending = true;
  try {
    let ask = true;
    for (let i = 0; i < MAX_PENDING_FILES; i++) {
      let file: OpenedFile | null;
      try {
        file = await platform.openProjectFile({ pending: true });
      } catch (e) {
        notify(e instanceof Error ? e.message : String(e), 'error');
        continue;
      }
      if (!file) break;
      if (openFile(file, ask)) ask = false;
    }
  } finally {
    openingPending = false;
  }
}

/** ⌘N: blank project (one PIC16F84A, empty main). */
export function newProject(): void {
  if (!confirmDiscard('Créer un nouveau projet')) return;
  getApp().newProject();
}
