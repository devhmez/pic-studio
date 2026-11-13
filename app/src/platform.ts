// Host adapter for files. In the browser: the File System Access API when available (real "Save" to the same
// file), otherwise an <input type=file> / <a download> fallback. In the Mac app (window.picStudio, see
// host/bridge.ts) the native dialogs of the Electron main process are used instead (createHostPlatform).
import type { HostPlatform } from './host/bridge';
import { hostErrorMessage } from './host/errors';

export interface OpenedFile {
  /** File name, without directories. */
  name: string;
  /** Content decoded as UTF-8 (use `bytes` for CP1252 C files or binary .DSN files). */
  text: string;
  bytes: Uint8Array;
  /**
   * The file on disk, when the platform can write back to it: pass it as SaveOptions.fileId once this file has
   * become the open project, so ⌘S replaces it without asking.
   */
  fileId?: string;
}

export interface OpenOptions {
  /** Mac app: take the next file the Finder asked to open (no dialog); resolves null when there is none left. */
  pending?: boolean;
}

export interface SaveOptions {
  /** Always ask for a location (« Enregistrer sous… »). */
  saveAs?: boolean;
  /** Write back to this opened file (OpenedFile.fileId) without asking. */
  fileId?: string;
}

export interface Platform {
  /** Ask the student for a project (or C / DSN) file. Resolves null when cancelled. */
  openProjectFile(options?: OpenOptions): Promise<OpenedFile | null>;
  /**
   * Save data under `name`; resolves the name actually used, or null when cancelled. Without `saveAs`, writes
   * without asking to the file given by `fileId`, or else to the file saved under that name earlier in the session.
   */
  saveFile(name: string, data: string | Uint8Array, mime: string, options?: SaveOptions): Promise<string | null>;
}

/** Extensions accepted by « Ouvrir ». */
export const OPEN_ACCEPT = ['.picproj', '.json', '.c', '.dsn', '.DSN'];

// Minimal typings of the File System Access API (not in lib.dom yet).
interface FsWritable { write(data: Blob | BufferSource | string): Promise<void>; close(): Promise<void> }
interface FsFileHandle { readonly name: string; getFile(): Promise<File>; createWritable(): Promise<FsWritable> }
interface FsPickerType { description: string; accept: Record<string, string[]> }
interface FsWindow {
  showOpenFilePicker?(options: { types?: FsPickerType[]; multiple?: boolean; excludeAcceptAllOption?: boolean }): Promise<FsFileHandle[]>;
  showSaveFilePicker?(options: { suggestedName?: string; types?: FsPickerType[] }): Promise<FsFileHandle>;
}

const OPEN_TYPES: FsPickerType[] = [
  { description: 'Projet PIC Studio', accept: { 'application/json': ['.picproj', '.json'] } },
  { description: 'Programme C (MikroC)', accept: { 'text/x-csrc': ['.c'] } },
  { description: 'Schéma ISIS (.DSN)', accept: { 'application/octet-stream': ['.dsn'] } },
];

const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function saveTypes(name: string, mime: string): FsPickerType[] {
  const ext = extensionOf(name);
  if (!ext) return [];
  return [{ description: `Fichier ${ext}`, accept: { [mime.split(';')[0] || 'application/octet-stream']: [ext] } }];
}

async function readFile(file: File): Promise<OpenedFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { name: file.name, text: new TextDecoder('utf-8').decode(bytes), bytes };
}

function toBlob(data: string | Uint8Array, mime: string): Blob {
  return new Blob([typeof data === 'string' ? data : new Uint8Array(data)], { type: mime });
}

/**
 * Browser implementation. ⌘S writes back to the same file: files saved are remembered by name, files opened under
 * an id (OpenedFile.fileId) that the page passes back only for the file it adopted as its project.
 */
export function createBrowserPlatform(): Platform {
  const saved = new Map<string, FsFileHandle>();
  const opened = new Map<string, FsFileHandle>();
  let openCount = 0;
  const fsWindow = (): FsWindow => (typeof window === 'undefined' ? {} : (window as unknown as FsWindow));

  const pickWithInput = (): Promise<OpenedFile | null> => new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = OPEN_ACCEPT.join(',');
    input.style.display = 'none';
    let settled = false;
    const finish = (value: OpenedFile | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) finish(null);
      else readFile(file).then(finish, () => finish(null));
    });
    input.addEventListener('cancel', () => finish(null));
    document.body.appendChild(input);
    input.click();
  });

  const downloadWithAnchor = (name: string, data: string | Uint8Array, mime: string): string => {
    const url = URL.createObjectURL(toBlob(data, mime));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return name;
  };

  return {
    async openProjectFile(options = {}) {
      // No Finder in the browser: nothing is ever waiting to be opened.
      if (options.pending) return null;
      const w = fsWindow();
      if (w.showOpenFilePicker) {
        try {
          const [handle] = await w.showOpenFilePicker({ types: OPEN_TYPES, multiple: false });
          if (!handle) return null;
          const fileId = `fichier-${++openCount}`;
          opened.set(fileId, handle);
          return { ...(await readFile(await handle.getFile())), fileId };
        } catch (e) {
          if (isAbort(e)) return null;
          // Some embedders expose the API but refuse it (sandboxed iframe): fall back to the input.
        }
      }
      return pickWithInput();
    },

    async saveFile(name, data, mime, options = {}) {
      const w = fsWindow();
      if (w.showSaveFilePicker) {
        try {
          let handle = options.saveAs ? undefined : options.fileId !== undefined ? opened.get(options.fileId) : saved.get(name);
          handle ??= await w.showSaveFilePicker({ suggestedName: name, types: saveTypes(name, mime) });
          const writable = await handle.createWritable();
          await writable.write(toBlob(data, mime));
          await writable.close();
          saved.set(handle.name, handle);
          return handle.name;
        } catch (e) {
          if (isAbort(e)) return null;
        }
      }
      return downloadWithAnchor(name, data, mime);
    },
  };
}

/**
 * Mac app implementation over window.picStudio.platform: native « Ouvrir » / « Enregistrer » dialogs with French
 * titles; ⌘S writes back to the file opened or saved before (the main process remembers its path, see
 * host/files.ts RememberedFiles). Errors keep only their French message (no IPC wrapper text).
 */
export function createHostPlatform(host: Pick<HostPlatform, 'openProjectFile' | 'saveFile'>): Platform {
  const clean = <T>(promise: Promise<T>): Promise<T> =>
    promise.catch((e: unknown) => {
      throw new Error(hostErrorMessage(e));
    });
  return {
    openProjectFile: (options) => clean(host.openProjectFile(options)),
    saveFile: (name, data, mime, options) => clean(host.saveFile(name, data, mime, options)),
  };
}

/** The Mac app's platform when the page runs inside it (the preload exposes window.picStudio). */
function detectHostPlatform(): Platform | null {
  const host = typeof window === 'undefined' ? undefined : window.picStudio;
  return host?.platform ? createHostPlatform(host.platform) : null;
}

let current: Platform | null = null;

/** The active platform: the Mac app's native dialogs inside PIC Studio.app, the browser's otherwise. */
export function getPlatform(): Platform {
  current ??= detectHostPlatform() ?? createBrowserPlatform();
  return current;
}

/** Replace the platform (host/install.ts does it at start-up inside the Mac app; tests use it too). */
export function setPlatform(platform: Platform): void {
  current = platform;
}

/** Convenience wrappers over the active platform. */
export const platform: Platform = {
  openProjectFile: (options) => getPlatform().openProjectFile(options),
  saveFile: (name, data, mime, options) => getPlatform().saveFile(name, data, mime, options),
};
