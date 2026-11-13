// ⌘S never overwrites a file the open project was not saved to or opened from: a TP template or a new project always
// goes through the save dialog, and a file opened then refused is never written to. Opening a .c / .DSN asks before
// dropping unsaved changes and can be undone; files sent by the Finder open one after the other, without a dialog.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPlatform, setPlatform, type OpenedFile, type Platform, type SaveOptions } from '../platform';
import { editor, isOwnSchematic, undo as undoSchematic } from '../schematic/editorStore';
import { appStore, getApp, serializeProject } from '../state/store';
import { currentToasts } from './toast';
import { openPendingFiles, openProject, saveProject } from './projectFiles';

const original = getPlatform();
afterEach(() => {
  setPlatform(original);
  vi.unstubAllGlobals();
});

function recording(answer: (name: string) => string | null, open: () => OpenedFile | null = () => null) {
  const calls: { name: string; options: SaveOptions | undefined }[] = [];
  const platform: Platform = {
    openProjectFile: async () => open(),
    saveFile: async (name, _data, _mime, options) => { calls.push({ name, options }); return answer(name); },
  };
  setPlatform(platform);
  return calls;
}

/** window.confirm answering `answer`; returns the questions asked. */
function confirming(answer: boolean): string[] {
  const asked: string[] = [];
  vi.stubGlobal('window', { confirm: (message: string) => { asked.push(message); return answer; } });
  return asked;
}

const text = (name: string, content: string, fileId?: string): OpenedFile =>
  ({ name, text: content, bytes: new TextEncoder().encode(content), ...(fileId ? { fileId } : {}) });

const lastToast = () => currentToasts()[currentToasts().length - 1];

describe('saveProject', () => {
  it('a template (never saved) always asks where to save, even with the name of a file saved earlier', async () => {
    const calls = recording((n) => n);
    await getApp().loadTemplate('tp-status');
    expect(getApp().fileName).toBeNull();
    await saveProject();
    expect(calls[0].options?.saveAs).toBe(true);
    expect(getApp().fileName).toBe(calls[0].name);
    // Saved once: ⌘S writes back to that file.
    await saveProject();
    expect(calls[1]).toEqual({ name: calls[0].name, options: { saveAs: false } });
    // « Nouveau » then ⌘S: asked again.
    getApp().newProject();
    await saveProject();
    expect(calls[2].options?.saveAs).toBe(true);
  });

  it('⇧⌘S always asks', async () => {
    const calls = recording((n) => n);
    getApp().newProject();
    await saveProject();
    await saveProject(true);
    expect(calls.map((c) => c.options?.saveAs)).toEqual([true, true]);
  });

  it('a cancelled dialog keeps the project unsaved', async () => {
    recording(() => null);
    getApp().newProject();
    await saveProject();
    expect(getApp().fileName).toBeNull();
  });

  it('writes back to the file the project was opened from, never to a same-named file opened then refused', async () => {
    await getApp().loadTemplate('tp-status');
    const json = serializeProject(getApp().project);
    let next = text('TP.picproj', json, 'bureau');
    const calls = recording((n) => n, () => next);
    await openProject();
    expect(getApp().fileName).toBe('TP.picproj');
    // Unsaved changes, then another TP.picproj (another folder) opened and refused: ⌘S still goes to the first one.
    getApp().renameProject('Mon TP');
    const asked = confirming(false);
    next = text('TP.picproj', json, 'telechargements');
    await openProject();
    expect(asked).toHaveLength(1);
    expect(getApp().project.name).toBe('Mon TP');
    // An unreadable project with that name does not take its place either.
    next = text('TP.picproj', '{ pas du json', 'casse');
    await openProject();
    await saveProject();
    expect(calls).toEqual([{ name: 'TP.picproj', options: { saveAs: false, fileId: 'bureau' } }]);
    // Saved: from now on the platform knows the file by the name it saved it under.
    await saveProject();
    expect(calls[1]).toEqual({ name: 'TP.picproj', options: { saveAs: false } });
  });
});

describe('opening a .c or a .DSN into the current project', () => {
  const C_SOURCE = 'void main() {\r\n  TRISB = 0;\r\n}\r\n';

  it('asks before replacing unsaved code, and « Annuler » on the message brings the old code back', async () => {
    await getApp().loadTemplate('tp-status');
    const generated = getApp().project.source;
    const origin = getApp().project.sourceOrigin;
    recording((n) => n, () => text('status.c', C_SOURCE));
    // Nothing unsaved: no question.
    const asked = confirming(true);
    await openProject();
    expect(asked).toEqual([]);
    expect(getApp().project.source).toBe('void main() {\n  TRISB = 0;\n}\n');
    const toast = lastToast();
    expect(toast.message).toBe('Code importé depuis status.c');
    expect(toast.action?.label).toBe('Annuler');
    toast.action!.run();
    expect(getApp().project.source).toBe(generated);
    expect(getApp().project.sourceOrigin).toBe(origin);

    // Unsaved changes: asked first; « Annuler » keeps the student's code.
    getApp().setSource(`${generated}// mes notes\n`);
    const refused = confirming(false);
    await openProject();
    expect(refused).toEqual(['Le projet actuel contient des modifications non enregistrées.\nRemplacer le code C par celui de « status.c » quand même ?']);
    expect(getApp().project.source).toBe(`${generated}// mes notes\n`);
  });

  const dsn = path.resolve(__dirname, '../../../cours/traffic lightdesign.DSN');
  it.skipIf(!fs.existsSync(dsn))('imports a .DSN as a schematic edit: ⌘Z brings the previous drawing back, clock included', async () => {
    await getApp().loadTemplate('tp-status');
    const before = getApp().project.schematic;
    const bytes = new Uint8Array(fs.readFileSync(dsn));
    recording((n) => n, () => ({ name: 'traffic lightdesign.DSN', text: '', bytes }));
    confirming(true);
    const seen: unknown[] = [];
    const unsubscribe = appStore.subscribe((s, prev) => {
      if (s.project.schematic !== prev.project.schematic) seen.push(s.project.schematic);
    });
    await openProject();
    unsubscribe();
    // The 8 MHz circuit: the project clock follows in the same update, and the store holds the very drawing the
    // editor recorded (the Schéma panel tells its own edits from external ones by identity, and resets its history
    // on an external one).
    expect(seen).toHaveLength(1);
    expect(isOwnSchematic(seen[0] as never)).toBe(true);
    expect(getApp().project.clockHz).toBe(8_000_000);
    expect(getApp().project.schematic).not.toBe(before);
    expect(editor().past[editor().past.length - 1]).toBe(before);
    undoSchematic();
    expect(getApp().project.schematic).toBe(before);
    expect(getApp().project.clockHz).toBe(1_000_000);
  });
});

describe('files sent by the Finder', () => {
  it('opens every file of a batch, one after the other, never through the open dialog', async () => {
    await getApp().loadTemplate('tp-status');
    getApp().renameProject('Travail en cours');
    const project = serializeProject({ ...getApp().project, name: 'Projet du Finder' });
    const queue = [text('Projet du Finder.picproj', project, 'f1'), text('status.c', 'void main() {}\n', 'f2')];
    const dialogs: unknown[] = [];
    setPlatform({
      openProjectFile: async (options) => {
        if (!options?.pending) { dialogs.push(options); return null; }
        return queue.shift() ?? null;
      },
      saveFile: async (name) => name,
    });
    const asked = confirming(true);
    await openPendingFiles();
    expect(dialogs).toEqual([]);
    expect(queue).toEqual([]);
    expect(getApp().project.name).toBe('Projet du Finder');
    expect(getApp().project.source).toBe('void main() {}\n');
    // Unsaved changes confirmed once for the whole batch.
    expect(asked).toHaveLength(1);
    // Nothing waiting: nothing happens (and still no dialog).
    await openPendingFiles();
    expect(dialogs).toEqual([]);
  });

  it('goes on with the next file when one cannot be read', async () => {
    const queue: (OpenedFile | Error)[] = [new Error('« perdu.picproj » est introuvable.'), text('demux.c', 'void main() { }\n')];
    setPlatform({
      openProjectFile: async () => {
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next ?? null;
      },
      saveFile: async (name) => name,
    });
    confirming(true);
    await openPendingFiles();
    expect(queue).toEqual([]);
    expect(getApp().project.source).toBe('void main() { }\n');
  });
});
