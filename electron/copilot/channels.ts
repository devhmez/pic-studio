// IPC channels of the copilot (window.picStudio.copilot in app/src/host/bridge.ts).
// Shared by electron/preload.ts (ipcRenderer.invoke) and electron/copilot/service.ts (ipcMain.handle).
// Created by the electron agent as the agreed contract; the copilot agent owns this folder and keeps these names.
export const CHANNELS = {
  status: 'copilot:status',
  run: 'copilot:run',
  cancel: 'copilot:cancel',
} as const;

export type CopilotChannel = (typeof CHANNELS)[keyof typeof CHANNELS];
