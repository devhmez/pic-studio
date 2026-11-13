// PIC Studio — Electron main process: one window with the renderer from app/ (Vite build, or the dev server when
// PIC_STUDIO_DEV_URL is set in a development build), native file dialogs and PDF export for window.picStudio, French
// menu, copilot IPC.
import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, webContents, type IpcMainEvent, type MessageBoxSyncOptions,
} from 'electron';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIRM_BUTTONS, messageBoxText } from '../app/src/host/dialogs';
import {
  HOST_CHANNELS, isDrawerState, isShellCommand, isShellTheme, SMOKE_SWITCH, VERSION_SWITCH, type RendererReadyInfo,
  type ShellCommand,
} from '../app/src/host/shell';
import { developerSettings } from '../app/src/host/urls';
import { registerCopilotIpc } from './copilot/service';
import { buildMenu, showDrawers } from './menu';
import { hasPendingOpen, queuePendingOpen, registerPlatformIpc } from './platformIpc';
import { appOnlyIpc, installSecurity } from './security';
import { initialBounds, loadWindowState, MIN_SIZE, trackWindowState } from './windowState';

/** Dev server and developer tools: development builds only (the packaged app ignores both variables). */
const { devUrl: DEV_URL, developer: DEVELOPER } = developerSettings(process.env, app.isPackaged);
/** Packaging smoke test (scripts/smoke-app.mjs): append lifecycle events as JSON lines to this file. */
const SMOKE_LOG = process.env.PIC_STUDIO_SMOKE_LOG?.trim() || null;
/** Smoke test only: write a PNG of the page here once the renderer is ready (proves it painted). */
const SMOKE_CAPTURE = (SMOKE_LOG && process.env.PIC_STUDIO_SMOKE_CAPTURE?.trim()) || null;

/** The renderer: built page next to this bundle (out/electron/main.cjs → app/dist/index.html), inside app.asar once packaged. */
const RENDERER_FILE = path.join(__dirname, '..', '..', 'app', 'dist', 'index.html');
const appUrl = (): string => DEV_URL ?? pathToFileURL(RENDERER_FILE).href;

function smokeLog(event: string, data: Record<string, unknown> = {}): void {
  if (!SMOKE_LOG) return;
  try {
    appendFileSync(SMOKE_LOG, `${JSON.stringify({ event, time: new Date().toISOString(), pid: process.pid, ...data })}\n`);
  } catch {
    // The smoke test reads the file; nothing else depends on it.
  }
}

// ------------------------------------------------------------------------------------------------ identity

app.setName('PIC Studio');
// French everywhere Chromium draws its own UI (text-field context menu, form validation, PDF viewer).
app.commandLine.appendSwitch('lang', 'fr');
const userDataOverride = process.env.PIC_STUDIO_USER_DATA?.trim();
if (userDataOverride) app.setPath('userData', userDataOverride);
else if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'PIC Studio (dev)'));

app.setAboutPanelOptions({
  applicationName: 'PIC Studio',
  applicationVersion: app.getVersion(),
  copyright: 'Schéma, code C, assembleur et organigramme pour le PIC16F84A.',
  credits: 'Simulateur PIC16F84A, compilateur MikroC et organigrammes intégrés. Aucun autre logiciel à installer.',
});

// ------------------------------------------------------------------------------------------------ window

let mainWindow: BrowserWindow | null = null;
/** Renderer of mainWindow has called rendererReady (menu commands can be delivered). */
let rendererReady = false;
/** Commands that arrived before the renderer was ready (e.g. « Ouvrir » from the Finder at launch). */
const queuedCommands: ShellCommand[] = [];

function loadRenderer(win: BrowserWindow): void {
  const loading = DEV_URL ? win.loadURL(DEV_URL) : win.loadFile(RENDERER_FILE);
  loading.catch((error: unknown) => smokeLog('load-error', { message: error instanceof Error ? error.message : String(error) }));
}

function createWindow(): BrowserWindow {
  const state = loadWindowState();
  const win = new BrowserWindow({
    ...initialBounds(state),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: 'PIC Studio',
    show: false,
    titleBarStyle: 'hiddenInset',
    // Vertically centred in the 46 px toolbar (app/src/host/electron.css leaves room on its left).
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161615' : '#f3f3f0',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: DEVELOPER || !app.isPackaged,
      additionalArguments: [`${VERSION_SWITCH}${app.getVersion()}`, ...(SMOKE_LOG ? [SMOKE_SWITCH] : [])],
    },
  });
  if (state.maximized) win.maximize();
  if (state.fullScreen) win.setFullScreen(true);
  trackWindowState(win);

  let shown = false;
  const show = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
  };
  win.once('ready-to-show', show);
  // Never stay invisible if ready-to-show is missed (slow first paint).
  setTimeout(show, 4000);

  win.on('enter-full-screen', () => win.webContents.send(HOST_CHANNELS.fullScreen, true));
  win.on('leave-full-screen', () => win.webContents.send(HOST_CHANNELS.fullScreen, false));
  win.on('unresponsive', () => smokeLog('unresponsive'));

  const contents = win.webContents;
  // A new page in the main frame (reload, dev-server refresh): wait for its own renderer-ready ping.
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument && win === mainWindow) rendererReady = false;
  });
  contents.on('did-finish-load', () => smokeLog('did-finish-load', { url: contents.getURL() }));
  contents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    smokeLog('did-fail-load', { code, description, url, isMainFrame });
    // Dev server not up yet (or restarting): try again shortly.
    if (DEV_URL && isMainFrame && code !== -3) setTimeout(() => !win.isDestroyed() && loadRenderer(win), 1000);
  });
  contents.on('preload-error', (_e, preloadPath, error) => smokeLog('preload-error', { preloadPath, message: error.message }));
  contents.on('render-process-gone', (_e, details) => smokeLog('render-process-gone', { reason: details.reason, exitCode: details.exitCode }));
  contents.on('console-message', (event) => {
    if (SMOKE_LOG && (event.level === 'error' || event.level === 'warning')) {
      smokeLog(`console-${event.level}`, { message: event.message, source: event.sourceId, line: event.lineNumber });
    }
  });

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
      rendererReady = false;
    }
  });

  loadRenderer(win);
  smokeLog('window-created', { url: appUrl() });
  return win;
}

function ensureWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) {
    rendererReady = false;
    mainWindow = createWindow();
  }
  return mainWindow;
}

function focusWindow(): void {
  const win = ensureWindow();
  if (win.isMinimized()) win.restore();
  if (win.isVisible()) win.focus();
}

/** Deliver a menu command to the renderer, waiting for it to be ready if needed. */
function sendCommand(command: ShellCommand): void {
  const win = ensureWindow();
  if (rendererReady) win.webContents.send(HOST_CHANNELS.command, command);
  else if (!queuedCommands.includes(command)) queuedCommands.push(command);
}

function onRendererReady(event: IpcMainEvent, info: unknown): void {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win !== mainWindow) return;
  rendererReady = true;
  const report = (typeof info === 'object' && info !== null ? info : {}) as Partial<RendererReadyInfo>;
  smokeLog('renderer-ready', { ...report, appVersion: app.getVersion(), packaged: app.isPackaged });
  // The window may have been restored in full screen before the page could hear about it.
  if (win.isFullScreen()) win.webContents.send(HOST_CHANNELS.fullScreen, true);
  for (const command of queuedCommands.splice(0)) win.webContents.send(HOST_CHANNELS.command, command);
  if (SMOKE_CAPTURE) void captureForSmoke(win, SMOKE_CAPTURE);
}

async function captureForSmoke(win: BrowserWindow, file: string): Promise<void> {
  try {
    const image = await win.webContents.capturePage();
    writeFileSync(file, image.toPNG());
    smokeLog('captured', { file, ...image.getSize() });
  } catch (error) {
    smokeLog('capture-error', { message: error instanceof Error ? error.message : String(error) });
  }
}

function onTheme(_event: IpcMainEvent, theme: unknown): void {
  if (!isShellTheme(theme)) return;
  nativeTheme.themeSource = theme;
}

function onEdited(event: IpcMainEvent, edited: unknown): void {
  BrowserWindow.fromWebContents(event.sender)?.setDocumentEdited(edited === true);
}

/** Check marks of the « Affichage » drawer items follow the page. */
function onDrawers(event: IpcMainEvent, drawers: unknown): void {
  if (!isDrawerState(drawers) || BrowserWindow.fromWebContents(event.sender) !== mainWindow) return;
  showDrawers(Menu.getApplicationMenu(), drawers);
}

/**
 * Édition → Annuler / Rétablir: the native command for the focused web contents (text fields, the code editor, as
 * the 'undo' / 'redo' roles do), then the page's command for the schematic, whose history lives in the page.
 */
function edit(command: 'undo' | 'redo'): void {
  const focused = webContents.getFocusedWebContents();
  if (!focused || focused.isDestroyed()) return;
  if (command === 'undo') focused.undo();
  else focused.redo();
  if (mainWindow && !mainWindow.isDestroyed() && focused === mainWindow.webContents) sendCommand(command);
}

/** window.confirm / window.alert of the page, as French native sheets (sync IPC: returnValue answers the page). */
function messageBox(event: IpcMainEvent, text: unknown, confirm: boolean): void {
  const { message, detail } = messageBoxText(text);
  const options: MessageBoxSyncOptions = {
    type: confirm ? 'question' : 'info',
    message: message || 'PIC Studio',
    detail: detail || undefined,
    buttons: confirm ? [...CONFIRM_BUTTONS] : ['OK'],
    defaultId: 0,
    cancelId: confirm ? 1 : 0,
    noLink: true,
  };
  const win = BrowserWindow.fromWebContents(event.sender);
  const answer = win ? dialog.showMessageBoxSync(win, options) : dialog.showMessageBoxSync(options);
  event.returnValue = confirm ? answer === 0 : true;
}

// ------------------------------------------------------------------------------------------------ lifecycle

/**
 * Finder: double-click on a .picproj, « Ouvrir avec », Dock drop, recent documents — one event per file when several
 * are opened together. May arrive before `ready`. The page opens the queued files one after the other.
 */
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  queuePendingOpen(filePath);
  if (app.isReady()) {
    focusWindow();
    sendCommand('open:pending');
  }
});

/** Development builds: show the PIC Studio icon in the Dock instead of Electron's. */
function devDockIcon(): void {
  if (app.isPackaged || process.platform !== 'darwin') return;
  const icon = path.join(__dirname, '..', '..', 'build', 'icon.png');
  if (existsSync(icon)) app.dock?.setIcon(icon);
}

function start(): void {
  // Every handler answers the app's own page only (security.ts).
  const ipc = appOnlyIpc(ipcMain, appUrl);
  registerPlatformIpc(ipc);
  registerCopilotIpc(ipc);
  ipc.on(HOST_CHANNELS.rendererReady, onRendererReady);
  ipc.on(HOST_CHANNELS.theme, onTheme);
  ipc.on(HOST_CHANNELS.edited, onEdited);
  ipc.on(HOST_CHANNELS.drawers, onDrawers);
  ipc.on(HOST_CHANNELS.confirm, (event, text: unknown) => messageBox(event, text, true));
  ipc.on(HOST_CHANNELS.alert, (event, text: unknown) => messageBox(event, text, false));

  app.on('second-instance', () => focusWindow());
  // Dock click with no window left: open a new one (the project comes back from the autosave).
  app.on('activate', () => {
    if (app.isReady()) focusWindow();
  });
  // The usual Mac behaviour: the app stays in the Dock until ⌘Q; clicking it reopens the window.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('will-quit', () => smokeLog('will-quit'));

  void app.whenReady().then(() => {
    smokeLog('app-ready', { version: app.getVersion(), electron: process.versions.electron, packaged: app.isPackaged });
    // Sessions exist only once the app is ready; no web contents is created before this point.
    installSecurity(appUrl);
    devDockIcon();
    const send = (command: string) => {
      if (isShellCommand(command)) sendCommand(command);
    };
    Menu.setApplicationMenu(buildMenu({ send, edit, developer: DEVELOPER }));
    ensureWindow();
    if (hasPendingOpen()) sendCommand('open:pending');
  });
}

if (SMOKE_LOG) {
  process.on('uncaughtException', (error) => smokeLog('main-error', { message: error.message, stack: error.stack }));
  process.on('unhandledRejection', (reason) => smokeLog('main-rejection', { message: String(reason) }));
}

if (!app.requestSingleInstanceLock()) {
  // Another PIC Studio is already open: it gets the focus (second-instance) and this one leaves.
  smokeLog('second-instance-exit');
  app.quit();
} else {
  start();
}
