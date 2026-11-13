// Preload (sandboxed, context-isolated): exposes window.picStudio (app/src/host/bridge.ts, PicStudioHost) and
// window.picStudioShell (app/src/host/shell.ts) to the renderer. Only invoke/send wrappers on fixed channels:
// the page never gets ipcRenderer itself.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  CopilotBridge, CopilotRunRequest, CopilotRunResult, CopilotStatus, HostPlatform, PicStudioHost,
} from '../app/src/host/bridge';
import {
  HOST_CHANNELS, isDrawerState, isShellCommand, isShellTheme, SMOKE_SWITCH, VERSION_SWITCH,
  type DrawerState, type PicStudioShell, type RendererReadyInfo, type ShellCommand, type ShellTheme,
} from '../app/src/host/shell';
import type { OpenedFile, OpenOptions, SaveOptions } from '../app/src/platform';
import { CHANNELS } from './copilot/channels';

const argValue = (prefix: string): string | undefined =>
  process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);

/** Only the known fields cross the bridge. */
const saveOptions = (options: SaveOptions): SaveOptions => ({
  saveAs: options.saveAs === true,
  ...(typeof options.fileId === 'string' ? { fileId: options.fileId } : {}),
});

const platform: HostPlatform = {
  openProjectFile: (options?: OpenOptions) =>
    ipcRenderer.invoke(HOST_CHANNELS.openProjectFile, options?.pending === true ? { pending: true } : undefined) as Promise<OpenedFile | null>,
  saveFile: (name: string, data: string | Uint8Array, mime: string, options?: SaveOptions) =>
    ipcRenderer.invoke(HOST_CHANNELS.saveFile, name, data, mime, options ? saveOptions(options) : undefined) as Promise<string | null>,
  savePdf: (name: string, html: string, options?: { landscape?: boolean }) =>
    ipcRenderer.invoke(HOST_CHANNELS.savePdf, name, html, options ? { landscape: options.landscape === true } : undefined) as Promise<string | null>,
  openDocument: (accept: string[]) =>
    ipcRenderer.invoke(HOST_CHANNELS.openDocument, Array.isArray(accept) ? [...accept] : []) as Promise<OpenedFile | null>,
};

const copilot: CopilotBridge = {
  status: () => ipcRenderer.invoke(CHANNELS.status) as Promise<CopilotStatus>,
  run: (request: CopilotRunRequest) => ipcRenderer.invoke(CHANNELS.run, request) as Promise<CopilotRunResult>,
  cancel: (requestId: string) => ipcRenderer.invoke(CHANNELS.cancel, requestId) as Promise<void>,
};

const host: PicStudioHost = {
  platform,
  copilot,
  os: process.platform,
  appVersion: argValue(VERSION_SWITCH) ?? '0.0.0',
};

function subscribe<T>(channel: string, accept: (value: unknown) => value is T, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: unknown) => {
    if (accept(value)) listener(value);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const shell: PicStudioShell = {
  onCommand: (listener: (command: ShellCommand) => void) => subscribe(HOST_CHANNELS.command, isShellCommand, listener),
  onFullScreen: (listener: (fullScreen: boolean) => void) =>
    subscribe(HOST_CHANNELS.fullScreen, (v): v is boolean => typeof v === 'boolean', listener),
  setTheme: (theme: ShellTheme) => {
    if (isShellTheme(theme)) ipcRenderer.send(HOST_CHANNELS.theme, theme);
  },
  setEdited: (edited: boolean) => ipcRenderer.send(HOST_CHANNELS.edited, edited === true),
  setDrawers: (drawers: DrawerState) => {
    if (isDrawerState(drawers)) {
      ipcRenderer.send(HOST_CHANNELS.drawers, { assistant: drawers.assistant, learn: drawers.learn, copilot: drawers.copilot });
    }
  },
  // Synchronous on purpose: window.confirm / window.alert block the page until answered.
  confirm: (message: string) => ipcRenderer.sendSync(HOST_CHANNELS.confirm, String(message)) === true,
  alert: (message: string) => {
    ipcRenderer.sendSync(HOST_CHANNELS.alert, String(message));
  },
  rendererReady: (info: RendererReadyInfo) => ipcRenderer.send(HOST_CHANNELS.rendererReady, info),
  smoke: process.argv.includes(SMOKE_SWITCH),
};

contextBridge.exposeInMainWorld('picStudio', host);
contextBridge.exposeInMainWorld('picStudioShell', shell);
