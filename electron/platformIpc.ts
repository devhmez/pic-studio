// Main-process side of window.picStudio.platform (app/src/host/bridge.ts → HostPlatform): native open/save
// dialogs with French titles, writing files, and PDF export.
import {
  app, BrowserWindow, dialog,
  type IpcMainInvokeEvent, type OpenDialogOptions, type SaveDialogOptions, type WebContents,
} from 'electron';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { OpenedFile } from '../app/src/platform';
import {
  documentFilters, extensionOf, isRecentDocument, PROJECT_FILTERS, RememberedFiles, safeFileName, saveDialogFor,
  TEXT_EXTENSIONS, withExtension,
} from '../app/src/host/files';
import { HOST_CHANNELS } from '../app/src/host/shell';
import { htmlToPdf } from './pdf';
import type { AppIpc } from './security';

/** Refuse files larger than this (a project is a few hundred kB; an énoncé PDF a few MB). */
const MAX_OPEN_BYTES = 64 * 1024 * 1024;

/**
 * Packaging smoke test only (both variables set by scripts/smoke-app.mjs): « Enregistrer » writes into this folder
 * without showing the dialog, so the test can check the files the page saves.
 */
const SMOKE_SAVE_DIR = (process.env.PIC_STUDIO_SMOKE_LOG?.trim() && process.env.PIC_STUDIO_SMOKE_SAVE_DIR?.trim()) || null;

async function readOpened(filePath: string, decodeText: boolean): Promise<OpenedFile> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`« ${path.basename(filePath)} » n’est pas un fichier.`);
  if (info.size > MAX_OPEN_BYTES) throw new Error(`« ${path.basename(filePath)} » est trop volumineux (plus de 64 Mo).`);
  const buffer = await readFile(filePath);
  // Copy into an exact-size array: IPC clones the whole underlying ArrayBuffer of a view.
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return { name: path.basename(filePath), text: decodeText ? new TextDecoder('utf-8').decode(bytes) : '', bytes };
}

// ------------------------------------------------------------------------------------------------ state

/** Files opened or saved by each window: ⌘S writes back to the project's own file without asking (like the browser). */
const rememberedFiles = new WeakMap<WebContents, RememberedFiles>();
let lastDirectory: string | null = null;

function filesOf(sender: WebContents): RememberedFiles {
  let files = rememberedFiles.get(sender);
  if (!files) rememberedFiles.set(sender, (files = new RememberedFiles()));
  return files;
}

/** Next dialogs open in the same folder; projects, C files and schematics go in « Ouvrir un élément récent ». */
function noteUsed(filePath: string): void {
  lastDirectory = path.dirname(filePath);
  if (isRecentDocument(filePath)) app.addRecentDocument(filePath);
}

const defaultDirectory = (): string => lastDirectory ?? app.getPath('documents');

/**
 * Files the Finder asked us to open (double-click, « Ouvrir avec », Dock drop, Recent items; one open-file event per
 * file), served one by one to the page's « open:pending » command — never by ⌘O, which always shows the dialog.
 */
const pendingOpens: string[] = [];

export function queuePendingOpen(filePath: string): void {
  if (!pendingOpens.includes(filePath)) pendingOpens.push(filePath);
}

export function hasPendingOpen(): boolean {
  return pendingOpens.length > 0;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const windowOf = (event: IpcMainInvokeEvent): BrowserWindow | null => BrowserWindow.fromWebContents(event.sender);

async function askSavePath(event: IpcMainInvokeEvent, name: string): Promise<string | null> {
  if (SMOKE_SAVE_DIR) return path.join(SMOKE_SAVE_DIR, name);
  const { title, filters } = saveDialogFor(name);
  const options: SaveDialogOptions = {
    title,
    buttonLabel: 'Enregistrer',
    nameFieldLabel: 'Nom :',
    defaultPath: path.join(defaultDirectory(), name),
    filters,
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  };
  const win = windowOf(event);
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  return result.canceled || !result.filePath ? null : result.filePath;
}

async function askOpenPath(event: IpcMainInvokeEvent, options: OpenDialogOptions): Promise<string | null> {
  const win = windowOf(event);
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

// ------------------------------------------------------------------------------------------------ handlers

export function registerPlatformIpc(ipcMain: AppIpc): void {
  ipcMain.handle(HOST_CHANNELS.openProjectFile, async (event, options?: unknown): Promise<OpenedFile | null> => {
    // A Finder file is taken off the queue before it is read: an unreadable one does not block the others.
    const filePath = isRecord(options) && options.pending === true
      ? (pendingOpens.shift() ?? null)
      : await askOpenPath(event, {
        title: 'Ouvrir un projet, un programme C ou un schéma ISIS',
        message: 'Choisissez un projet PIC Studio (.picproj), un programme MikroC (.c) ou un schéma ISIS (.DSN).',
        buttonLabel: 'Ouvrir',
        defaultPath: defaultDirectory(),
        properties: ['openFile'],
        filters: PROJECT_FILTERS.map((f) => ({ name: f.name, extensions: [...f.extensions] })),
      });
    if (!filePath) return null;
    const file = await readOpened(filePath, true);
    noteUsed(filePath);
    return { ...file, fileId: filesOf(event.sender).noteOpened(filePath) };
  });

  ipcMain.handle(
    HOST_CHANNELS.saveFile,
    async (event, name: unknown, data: unknown, _mime: unknown, options?: unknown): Promise<string | null> => {
      if (typeof data !== 'string' && !(data instanceof Uint8Array)) throw new Error('Données à enregistrer invalides.');
      const fileName = safeFileName(name);
      const files = filesOf(event.sender);
      const known = files.target(fileName, {
        saveAs: isRecord(options) && options.saveAs === true,
        fileId: isRecord(options) && typeof options.fileId === 'string' ? options.fileId : undefined,
      });
      const target = known ?? (await askSavePath(event, fileName));
      if (!target) return null;
      await writeFile(target, typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      files.noteSaved(target);
      noteUsed(target);
      return path.basename(target);
    },
  );

  ipcMain.handle(
    HOST_CHANNELS.savePdf,
    async (event, name: unknown, html: unknown, options?: unknown): Promise<string | null> => {
      if (typeof html !== 'string') throw new Error('Page à imprimer invalide.');
      const landscape = typeof options === 'object' && options !== null && (options as { landscape?: unknown }).landscape === true;
      const fileName = withExtension(safeFileName(name, 'document.pdf'), 'pdf');
      const target = await askSavePath(event, fileName);
      if (!target) return null;
      const pdf = await htmlToPdf(html, { landscape });
      await writeFile(target, pdf);
      lastDirectory = path.dirname(target);
      return path.basename(target);
    },
  );

  ipcMain.handle(HOST_CHANNELS.openDocument, async (event, accept: unknown): Promise<OpenedFile | null> => {
    const filePath = await askOpenPath(event, {
      title: 'Choisir un document',
      buttonLabel: 'Ouvrir',
      defaultPath: app.getPath('downloads'),
      properties: ['openFile'],
      filters: documentFilters(accept),
    });
    if (!filePath) return null;
    return readOpened(filePath, TEXT_EXTENSIONS.has(extensionOf(filePath)));
  });
}
