// Pure helpers of the Mac app shell: file names and dialog filters, navigation rules, window placement, CSP,
// IPC error messages, the host-backed platform and the menu command table.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostPlatform } from '../platform';
import { getApp } from '../state/store';
import { menuUndoIsForSchematic, SHELL_COMMAND_HANDLERS, type FocusTarget } from './commands';
import { buildCsp, injectCsp, inlineScripts, serializeCsp } from './csp';
import type { PicStudioHost } from './bridge';
import { CONFIRM_BUTTONS, messageBoxText } from './dialogs';
import { hostErrorMessage } from './errors';
import { exportPdf, savesPdfDirectly } from './print';
import {
  baseName, documentFilters, extensionOf, isRecentDocument, PROJECT_EXTENSIONS, RememberedFiles, safeFileName, saveDialogFor,
  withExtension,
} from './files';
import { DRAWER_COMMANDS, HOST_CHANNELS, isDrawerState, isShellCommand, isShellTheme, SHELL_COMMANDS } from './shell';
import { developerSettings, isAppFrame, isAppUrl, isExternalUrl } from './urls';
import { DEFAULT_WINDOW_SIZE, fitWindowBounds, isRect, MIN_WINDOW_SIZE } from './windowBounds';
import { OPEN_ACCEPT } from '../platform';

describe('file names', () => {
  it('reads extensions from names and paths', () => {
    expect(extensionOf('tp-status.PICPROJ')).toBe('picproj');
    expect(extensionOf('/Users/a/TP.v2/SCHEMA.DSN')).toBe('dsn');
    expect(extensionOf('Makefile')).toBe('');
    expect(extensionOf('.hidden')).toBe('');
    expect(extensionOf('C:\\TP\\demux.c')).toBe('c');
  });

  it('keeps only a plain, visible file name', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('a:b*c?.c')).toBe('a-b-c-.c');
    expect(safeFileName('..secret.picproj')).toBe('secret.picproj');
    expect(safeFileName('   ')).toBe('sans-titre');
    expect(safeFileName(undefined, 'document.pdf')).toBe('document.pdf');
    expect(safeFileName('Démultiplexeur.c')).toBe('Démultiplexeur.c'.normalize('NFC'));
  });

  it('completes or replaces the extension', () => {
    expect(withExtension('organigramme', 'pdf')).toBe('organigramme.pdf');
    expect(withExtension('organigramme.html', 'pdf')).toBe('organigramme.pdf');
    expect(withExtension('FICHE.PDF', 'pdf')).toBe('FICHE.PDF');
  });

  it('opens the same extensions as the browser version', () => {
    const browser = new Set(OPEN_ACCEPT.map((e) => e.slice(1).toLowerCase()));
    expect(new Set(PROJECT_EXTENSIONS)).toEqual(browser);
  });

  it('builds French save dialogs from the file name', () => {
    expect(saveDialogFor('tp-status.c')).toEqual({ title: 'Exporter le code C', filters: [{ name: 'Programme C (MikroC)', extensions: ['c'] }] });
    expect(saveDialogFor('projet.picproj').title).toBe('Enregistrer le projet');
    expect(saveDialogFor('x.pdf').title).toBe('Enregistrer le PDF');
    expect(saveDialogFor('notes.xyz')).toEqual({ title: 'Enregistrer', filters: [{ name: 'Fichier .xyz', extensions: ['xyz'] }] });
    expect(saveDialogFor('README')).toEqual({ title: 'Enregistrer', filters: [] });
  });

  it('turns an accept list into one document filter', () => {
    expect(documentFilters(['.pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.PDF'])).toEqual([
      { name: 'Documents (.pdf, .docx)', extensions: ['pdf', 'docx'] },
    ]);
    expect(documentFilters([])).toEqual([]);
    expect(documentFilters('pdf')).toEqual([]);
    expect(documentFilters(['.p df', 'text/unknown'])).toEqual([]);
  });

  it('lists projects, C files and schematics as recent documents only', () => {
    expect(isRecentDocument('/a/tp.picproj')).toBe(true);
    expect(isRecentDocument('/a/demux.C')).toBe(true);
    expect(isRecentDocument('/a/fiche.pdf')).toBe(false);
  });
});

describe('files « Enregistrer » writes without asking', () => {
  it('writes back to a saved file by its name, and to an opened file only by the id the page passes back', () => {
    const files = new RememberedFiles();
    expect(files.target('TP.picproj')).toBeNull();
    files.noteSaved('/Users/eleve/Desktop/TP.picproj');
    expect(files.target('TP.picproj')).toBe('/Users/eleve/Desktop/TP.picproj');
    expect(files.target('TP.picproj', { saveAs: true })).toBeNull();
    // Opening another TP.picproj does not redirect ⌘S of the project saved above (the page may refuse that file).
    const id = files.noteOpened('/Users/eleve/Downloads/TP.picproj');
    expect(files.target('TP.picproj')).toBe('/Users/eleve/Desktop/TP.picproj');
    // Once the page took it as its project, it saves with its id.
    expect(files.target('TP.picproj', { fileId: id })).toBe('/Users/eleve/Downloads/TP.picproj');
    expect(files.target('TP.picproj', { fileId: id, saveAs: true })).toBeNull();
    // An unknown id, or the id of a file with another name: the dialog.
    expect(files.target('TP.picproj', { fileId: 'fichier-99' })).toBeNull();
    expect(files.target('Autre.picproj', { fileId: id })).toBeNull();
    expect(files.noteOpened('/Users/eleve/Downloads/TP.picproj')).not.toBe(id);
  });

  it('compares names in NFC, as the page sends them', () => {
    // « é » as e + combining acute accent, as some file paths come back from the system.
    const decomposed = '/Users/eleve/De\u0301mux.picproj';
    expect(decomposed).not.toBe(decomposed.normalize('NFC'));
    const files = new RememberedFiles();
    files.noteSaved(decomposed);
    expect(baseName(decomposed)).toBe('Démux.picproj'.normalize('NFC'));
    expect(files.target(safeFileName('Démux.picproj'))).toBe(decomposed);
  });
});

describe('navigation rules', () => {
  const built = 'file:///Applications/PIC%20Studio.app/Contents/Resources/app.asar/app/dist/index.html';

  it('sends web and mail links to the default apps', () => {
    expect(isExternalUrl('https://www.microchip.com/fr')).toBe(true);
    expect(isExternalUrl('mailto:prof@esprit.tn')).toBe(true);
    expect(isExternalUrl('file:///etc/hosts')).toBe(false);
    expect(isExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isExternalUrl('not a url')).toBe(false);
  });

  it('only accepts the app page itself', () => {
    expect(isAppUrl(`${built}#organigramme`, built)).toBe(true);
    expect(isAppUrl('file:///Applications/PIC Studio.app/Contents/Resources/app.asar/app/dist/index.html?x=1', built)).toBe(true);
    expect(isAppUrl('file:///Users/eleve/Downloads/page.html', built)).toBe(false);
    expect(isAppUrl('https://example.com/', built)).toBe(false);
    expect(isAppUrl('http://localhost:5173/src/main.tsx', 'http://localhost:5173')).toBe(true);
    expect(isAppUrl('http://localhost:5174/', 'http://localhost:5173')).toBe(false);
  });

  it('answers IPC from the app page only', () => {
    expect(isAppFrame({ url: `${built}#schema` }, built)).toBe(true);
    expect(isAppFrame({ url: 'https://example.com/' }, built)).toBe(false);
    expect(isAppFrame({ url: 'file:///Users/eleve/Downloads/page.html' }, built)).toBe(false);
    expect(isAppFrame(null, built)).toBe(false);
    // A frame already disposed throws when read.
    const disposed = { get url(): string { throw new Error('Render frame was disposed'); } };
    expect(isAppFrame(disposed, built)).toBe(false);
  });

  it('ignores the development variables in the packaged app', () => {
    const env = { PIC_STUDIO_DEV_URL: ' https://example.com/ ', PIC_STUDIO_DEVTOOLS: '1' };
    expect(developerSettings(env, true)).toEqual({ devUrl: null, developer: false });
    expect(developerSettings(env, false)).toEqual({ devUrl: 'https://example.com/', developer: true });
    expect(developerSettings({ PIC_STUDIO_DEVTOOLS: '1' }, false)).toEqual({ devUrl: null, developer: true });
    expect(developerSettings({}, false)).toEqual({ devUrl: null, developer: false });
  });
});

describe('window placement', () => {
  const laptop = { x: 0, y: 25, width: 1512, height: 920 };
  const external = { x: 1512, y: 0, width: 2560, height: 1415 };

  it('opens 1440 × 900 centred the first time', () => {
    expect(fitWindowBounds(undefined, [laptop], laptop)).toEqual({ x: 36, y: 35, width: 1440, height: 900 });
  });

  it('shrinks to small screens but never below the minimum size', () => {
    const small = { x: 0, y: 25, width: 1280, height: 775 };
    expect(fitWindowBounds(undefined, [small], small)).toEqual({ x: 0, y: 25, width: 1280, height: 775 });
    const tiny = { x: 0, y: 0, width: 1024, height: 640 };
    const r = fitWindowBounds(undefined, [tiny], tiny);
    expect([r.width, r.height]).toEqual([MIN_WINDOW_SIZE.width, MIN_WINDOW_SIZE.height]);
  });

  it('reuses saved bounds still visible on a screen', () => {
    const saved = { x: 1700, y: 100, width: 1600, height: 1000 };
    expect(fitWindowBounds(saved, [laptop, external], laptop)).toEqual(saved);
    expect(fitWindowBounds({ ...saved, width: 900.4 }, [laptop, external], laptop).width).toBe(MIN_WINDOW_SIZE.width);
  });

  it('comes back to the main screen when the external one is unplugged', () => {
    const saved = { x: 1700, y: 100, width: 1600, height: 1000 };
    const r = fitWindowBounds(saved, [laptop], laptop);
    expect(r.width).toBe(DEFAULT_WINDOW_SIZE.width);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(laptop.width);
  });

  it('validates stored rectangles', () => {
    expect(isRect({ x: 1, y: 2, width: 3, height: 4 })).toBe(true);
    expect(isRect({ x: 1, y: 2, width: '3', height: 4 })).toBe(false);
    expect(isRect({ x: NaN, y: 2, width: 3, height: 4 })).toBe(false);
    expect(isRect(null)).toBe(false);
  });
});

describe('Content-Security-Policy', () => {
  const html = `<!doctype html><html><head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'" />
    <script>
      document.documentElement.dataset.x = '1';
    </script>
    <script type="module" crossorigin src="./assets/index.js"></script>
    <script type="application/json">{"a":1}</script>
  </head><body></body></html>`;

  it('finds the inline classic scripts only', () => {
    expect(inlineScripts(html)).toEqual(["\n      document.documentElement.dataset.x = '1';\n    "]);
  });

  it('is strict in the build: own files, hashed inline script, no network', () => {
    const policy = serializeCsp(buildCsp({ dev: false, scriptHashes: ['sha256-abc='] }));
    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval' 'sha256-abc='");
    expect(policy).toContain("worker-src 'self' blob:");
    expect(policy).toContain("connect-src 'self' data: blob:");
    expect(policy).toContain("object-src 'none'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toMatch(/https?:/);
  });

  it('lets the dev server run React refresh and HMR', () => {
    const policy = serializeCsp(buildCsp({ dev: true }));
    expect(policy).toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).toContain('ws:');
  });

  it('replaces the meta tag, or adds one after the charset', () => {
    const replaced = injectCsp(html, "default-src 'none'");
    expect(replaced.match(/Content-Security-Policy/g)).toHaveLength(1);
    expect(replaced).toContain(`content="default-src 'none'"`);
    const added = injectCsp('<html><head><meta charset="utf-8"><title>x</title></head></html>', "default-src 'self'");
    expect(added).toMatch(/<meta charset="utf-8">\s*<meta http-equiv="Content-Security-Policy"/);
  });
});

describe('errors from the Mac app', () => {
  it('keeps only the French message', () => {
    const ipc = new Error("Error invoking remote method 'platform:save-file': Error: Données à enregistrer invalides.");
    expect(hostErrorMessage(ipc)).toBe('Données à enregistrer invalides.');
    expect(hostErrorMessage(new Error("Error invoking remote method 'platform:save-pdf': TypeError: x"))).toBe('x');
    expect(hostErrorMessage(new Error('Le PDF est trop gros.'))).toBe('Le PDF est trop gros.');
    expect(hostErrorMessage(undefined)).toBe('Erreur inattendue de l’application.');
  });

  it('passes the open and save options through to the host', async () => {
    const calls: unknown[] = [];
    const platform = createHostPlatform({
      openProjectFile: (options) => { calls.push(options); return Promise.resolve(null); },
      saveFile: (name, _data, _mime, options) => { calls.push(options); return Promise.resolve(name); },
    });
    await platform.openProjectFile({ pending: true });
    await platform.saveFile('TP.picproj', '{}', 'application/json', { saveAs: false, fileId: 'fichier-1' });
    expect(calls).toEqual([{ pending: true }, { saveAs: false, fileId: 'fichier-1' }]);
  });

  it('cleans the errors of the host platform', async () => {
    const platform = createHostPlatform({
      openProjectFile: () => Promise.reject(new Error("Error invoking remote method 'platform:open-project-file': Error: « x.picproj » est trop volumineux (plus de 64 Mo).")),
      saveFile: (name) => Promise.resolve(name),
    });
    await expect(platform.openProjectFile()).rejects.toThrow(/^« x\.picproj » est trop volumineux/);
    await expect(platform.saveFile('a.c', 'x', 'text/x-csrc')).resolves.toBe('a.c');
  });
});

describe('menu-bar commands', () => {
  it('has a handler for every command of the native menu', () => {
    expect(Object.keys(SHELL_COMMAND_HANDLERS).sort()).toEqual([...SHELL_COMMANDS].sort());
    expect(isShellCommand('save')).toBe(true);
    expect(isShellCommand('rm -rf')).toBe(false);
    expect(isShellTheme('dark')).toBe(true);
    expect(isShellTheme('sepia')).toBe(false);
  });

  it('opens « Comprendre » from the Aide menu without ever closing it', () => {
    getApp().setLearnOpen(false);
    void SHELL_COMMAND_HANDLERS['drawer:learn:open']();
    expect(getApp().ui.learnOpen).toBe(true);
    void SHELL_COMMAND_HANDLERS['drawer:learn:open']();
    expect(getApp().ui.learnOpen).toBe(true);
    // The Affichage item stays a toggle.
    void SHELL_COMMAND_HANDLERS['drawer:learn']();
    expect(getApp().ui.learnOpen).toBe(false);
  });

  it('reports which drawer is open for the check marks of « Affichage »', () => {
    expect(Object.values(DRAWER_COMMANDS).every(isShellCommand)).toBe(true);
    expect(isDrawerState({ assistant: false, learn: true, copilot: false })).toBe(true);
    expect(isDrawerState({ assistant: false, learn: 'oui', copilot: false })).toBe(false);
    expect(isDrawerState({ assistant: false })).toBe(false);
    expect(isDrawerState(null)).toBe(false);
  });

  it('sends Édition → Annuler to the schematic only when the focus is there', () => {
    const element = (tagName: string, inSchema: boolean, isContentEditable = false): FocusTarget =>
      ({ tagName, isContentEditable, closest: (selector) => (inSchema && selector === '[data-panel="schema"]' ? {} : null) });
    // The canvas (or a button) of the Schéma panel.
    expect(menuUndoIsForSchematic(element('DIV', true), 'code')).toBe(true);
    // A text field of the properties popover, the code editor: served by the native command.
    expect(menuUndoIsForSchematic(element('INPUT', true), 'schema')).toBe(false);
    expect(menuUndoIsForSchematic(element('DIV', false, true), 'schema')).toBe(false);
    // Focus nowhere in particular: the active panel decides.
    expect(menuUndoIsForSchematic(element('BODY', false), 'schema')).toBe(true);
    expect(menuUndoIsForSchematic(null, 'schema')).toBe(true);
    expect(menuUndoIsForSchematic(element('BODY', false), 'organigramme')).toBe(false);
    // Another part of the window (the assistant drawer, the toolbar).
    expect(menuUndoIsForSchematic(element('BUTTON', false), 'schema')).toBe(false);
  });

  it('uses distinct IPC channels', () => {
    const channels = Object.values(HOST_CHANNELS);
    expect(new Set(channels).size).toBe(channels.length);
    expect(channels.some((c) => c.startsWith('copilot:'))).toBe(false);
  });
});

describe('PDF exports in the Mac app', () => {
  afterEach(() => vi.unstubAllGlobals());

  const fakeHost = (savePdf: PicStudioHost['platform']['savePdf']) => {
    const calls: unknown[][] = [];
    const host = {
      os: 'darwin',
      appVersion: '1.0.0',
      platform: {
        openProjectFile: () => Promise.resolve(null),
        saveFile: () => Promise.resolve(null),
        openDocument: () => Promise.resolve(null),
        savePdf: (...args: Parameters<PicStudioHost['platform']['savePdf']>) => {
          calls.push(args);
          return savePdf(...args);
        },
      },
      copilot: {} as PicStudioHost['copilot'],
    } satisfies PicStudioHost;
    vi.stubGlobal('window', { picStudio: host });
    return calls;
  };

  it('writes the PDF through the host, adding .pdf to the name', async () => {
    const calls = fakeHost((name) => Promise.resolve(name));
    expect(savesPdfDirectly()).toBe(true);
    await expect(exportPdf({ name: 'tp-status-cablage', html: '<p>x</p>' })).resolves.toEqual({ kind: 'saved', name: 'tp-status-cablage.pdf' });
    await exportPdf({ name: 'organigramme.pdf', html: '<p>y</p>', landscape: true });
    expect(calls).toEqual([['tp-status-cablage.pdf', '<p>x</p>', undefined], ['organigramme.pdf', '<p>y</p>', { landscape: true }]]);
  });

  it('reports a closed dialog and French errors', async () => {
    fakeHost(() => Promise.resolve(null));
    await expect(exportPdf({ name: 'a', html: '' })).resolves.toEqual({ kind: 'cancelled' });
    fakeHost(() => Promise.reject(new Error("Error invoking remote method 'platform:save-pdf': Error: La création du PDF a pris trop de temps.")));
    await expect(exportPdf({ name: 'a', html: '' })).rejects.toThrow(/^La création du PDF a pris trop de temps\.$/);
  });

  it('falls back to the print dialog in the browser', () => {
    vi.stubGlobal('window', {});
    expect(savesPdfDirectly()).toBe(false);
  });
});

describe('confirm boxes in the Mac app', () => {
  it('puts the first line in bold and the rest as detail', () => {
    expect(messageBoxText('Le projet actuel contient des modifications non enregistrées.\nOuvrir un autre projet quand même ?')).toEqual({
      message: 'Le projet actuel contient des modifications non enregistrées.',
      detail: 'Ouvrir un autre projet quand même ?',
    });
    expect(messageBoxText('Une ligne')).toEqual({ message: 'Une ligne', detail: '' });
    expect(messageBoxText('Titre\r\n\r\nSuite\n(Annuler : rien ne change.)')).toEqual({ message: 'Titre', detail: 'Suite\n(Annuler : rien ne change.)' });
    expect(messageBoxText(undefined)).toEqual({ message: '', detail: '' });
  });

  it('answers with French buttons, OK first', () => {
    expect(CONFIRM_BUTTONS).toEqual(['OK', 'Annuler']);
  });
});
