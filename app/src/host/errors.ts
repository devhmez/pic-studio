// Errors coming back from the Mac app's main process through ipcRenderer.invoke carry an English wrapper
// (« Error invoking remote method 'platform:save-file': Error: … »): keep only the French message for the toasts.

const IPC_PREFIX = /^Error invoking remote method '[^']*':\s*/;
const ERROR_NAME = /^(?:[A-Za-z]*Error):\s*/;

export function hostErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const message = raw.replace(IPC_PREFIX, '').replace(ERROR_NAME, '').trim();
  return message || 'Erreur inattendue de l’application.';
}
