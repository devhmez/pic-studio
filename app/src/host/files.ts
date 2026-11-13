// File-name and dialog helpers of the Mac app's native « Ouvrir » / « Enregistrer » dialogs (electron/platformIpc.ts).
// Pure and DOM-free so they are unit-tested here and bundled into the Electron main process.

/** Same shape as Electron's FileFilter. */
export interface DialogFilter {
  name: string;
  extensions: string[];
}

/** Lower-case extension without the dot ('' when none). Works on bare names and on paths. */
export function extensionOf(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** A plain file name: no directories, no characters the Finder or Windows reject, never empty or hidden. */
export function safeFileName(name: unknown, fallback = 'sans-titre'): string {
  const raw = typeof name === 'string' ? name : '';
  const base = raw.slice(Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')) + 1).normalize('NFC');
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^[.\s]+/, '').trim();
  return cleaned || fallback;
}

/** `name` with its extension replaced by (or completed with) `ext`. */
export function withExtension(name: string, ext: string): string {
  if (extensionOf(name) === ext.toLowerCase()) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}.${ext}`;
}

/** Projects, MikroC code and ISIS schematics accepted by « Ouvrir » (same list as OPEN_ACCEPT in ../platform.ts). */
export const PROJECT_EXTENSIONS = ['picproj', 'json', 'c', 'dsn'] as const;

/** Filters of the « Ouvrir un projet » dialog. */
export const PROJECT_FILTERS: readonly DialogFilter[] = [
  { name: 'Projets PIC Studio, code C, schémas ISIS', extensions: [...PROJECT_EXTENSIONS] },
  { name: 'Projet PIC Studio (.picproj)', extensions: ['picproj', 'json'] },
  { name: 'Programme C MikroC (.c)', extensions: ['c'] },
  { name: 'Schéma Proteus ISIS (.DSN)', extensions: ['dsn'] },
];

/** Extensions whose content is decoded as text for openDocument (others travel as bytes only). */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt', 'md', 'c', 'h', 'json', 'picproj', 'csv', 'asm', 'lst', 'html', 'htm', 'xml', 'hex',
]);

const MIME_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  'application/pdf': ['pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/msword': ['doc'],
  'text/plain': ['txt'],
  'text/markdown': ['md'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
};

/** Filters of the openDocument dialog, from an <input accept>-style list (['.pdf', 'application/pdf', ...]). */
export function documentFilters(accept: unknown): DialogFilter[] {
  const list = Array.isArray(accept) ? accept.filter((a): a is string => typeof a === 'string') : [];
  const extensions = new Set<string>();
  for (const entry of list) {
    const value = entry.trim().toLowerCase();
    if (value.startsWith('.')) extensions.add(value.slice(1));
    else for (const ext of MIME_EXTENSIONS[value] ?? []) extensions.add(ext);
  }
  const exts = [...extensions].filter((e) => /^[a-z0-9]+$/.test(e));
  if (exts.length === 0) return [];
  return [{ name: `Documents (${exts.map((e) => `.${e}`).join(', ')})`, extensions: exts }];
}

const SAVE_TITLES: Readonly<Record<string, readonly [title: string, label: string]>> = {
  picproj: ['Enregistrer le projet', 'Projet PIC Studio'],
  c: ['Exporter le code C', 'Programme C (MikroC)'],
  hex: ['Exporter le programme compilé', 'Fichier HEX (Proteus, programmateur)'],
  png: ['Exporter l’image', 'Image PNG'],
  svg: ['Exporter le dessin', 'Dessin vectoriel SVG'],
  pdf: ['Enregistrer le PDF', 'Document PDF'],
  html: ['Enregistrer la page', 'Page web HTML'],
  docx: ['Enregistrer le document', 'Document Word'],
  json: ['Enregistrer', 'Fichier JSON'],
};

/** Title and filters of the save dialog, from the file the renderer wants to write. */
export function saveDialogFor(name: string): { title: string; filters: DialogFilter[] } {
  const ext = extensionOf(name);
  const [title, label] = SAVE_TITLES[ext] ?? ['Enregistrer', ext ? `Fichier .${ext}` : 'Fichier'];
  return { title, filters: ext ? [{ name: label, extensions: [ext] }] : [] };
}

/** Files that go in « Ouvrir un élément récent ». */
export function isRecentDocument(name: string): boolean {
  const ext = extensionOf(name);
  return ext === 'picproj' || ext === 'c' || ext === 'dsn';
}

/** File name of a path (either separator), NFC like the names the page sends (safeFileName). */
export function baseName(filePath: string): string {
  return filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1).normalize('NFC');
}

/**
 * Files « Enregistrer » may write to without a dialog, for one window. A file the page saved is remembered by its
 * name (the page then calls its project by that name). A file it opened is remembered under an id sent to the page
 * with the content (OpenedFile.fileId), which the page passes back (SaveOptions.fileId) only for the file it took
 * as its project: a file opened then refused (« Annuler » on the unsaved-changes question, unreadable project) is
 * never written to, even when it has the name of the open project.
 */
export class RememberedFiles {
  private readonly saved = new Map<string, string>();
  private readonly opened = new Map<string, string>();
  private count = 0;

  /** A file the student opened: returns the id that lets the page save back to it. */
  noteOpened(filePath: string): string {
    const id = `fichier-${++this.count}`;
    this.opened.set(id, filePath);
    return id;
  }

  /** A file the page saved (it now knows it under its name). */
  noteSaved(filePath: string): void {
    this.saved.set(baseName(filePath), filePath);
  }

  /** Where « Enregistrer » writes `name` without asking, or null to show the save dialog. */
  target(name: string, options: { saveAs?: boolean; fileId?: string } = {}): string | null {
    if (options.saveAs) return null;
    if (options.fileId !== undefined) {
      const opened = this.opened.get(options.fileId);
      return opened !== undefined && baseName(opened) === name ? opened : null;
    }
    return this.saved.get(name) ?? null;
  }
}
