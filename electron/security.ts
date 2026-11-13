// Hardening shared by every web contents: no new windows, no navigation away from the app, links open in the
// default browser, only harmless permissions, and IPC answered for the app's own page only.
import { app, session, shell, type IpcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { isAppFrame, isAppUrl, isExternalUrl } from '../app/src/host/urls';

/** Permissions the UI may need (copy buttons, full screen); everything else (camera, location…) is refused. */
const ALLOWED_PERMISSIONS = new Set<string>(['clipboard-sanitized-write', 'fullscreen']);

export function installSecurity(appUrl: () => string): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isExternalUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event) => {
      const url = event.url;
      if (isAppUrl(url, appUrl())) return;
      event.preventDefault();
      if (isExternalUrl(url)) void shell.openExternal(url);
    });
    contents.on('will-redirect', (event) => {
      if (!isAppUrl(event.url, appUrl())) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

/** The part of ipcMain the handlers use (electron/platformIpc.ts, electron/copilot/service.ts, main.ts). */
export interface AppIpc {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void;
  on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): void;
}

/**
 * ipcMain for messages from the app's own page only (the sender frame's URL is checked against `appUrl`): the
 * bridge saves files, prints PDFs and runs the copilot, so no other page may use it. A refused `invoke` rejects; a
 * refused synchronous message still gets an answer (null), or the page would hang.
 */
export function appOnlyIpc(ipcMain: IpcMain, appUrl: () => string): AppIpc {
  const fromApp = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => isAppFrame(event.senderFrame, appUrl());
  return {
    handle(channel, listener) {
      ipcMain.handle(channel, (event, ...args: unknown[]) => {
        if (!fromApp(event)) throw new Error('Requête refusée : elle ne vient pas de la page de PIC Studio.');
        return listener(event, ...args);
      });
    },
    on(channel, listener) {
      ipcMain.on(channel, (event, ...args: unknown[]) => {
        if (fromApp(event)) listener(event, ...args);
        else event.returnValue = null;
      });
    },
  };
}
