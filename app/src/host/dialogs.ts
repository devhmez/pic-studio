// window.confirm / window.alert inside the Mac app: Electron's built-in JavaScript dialogs have English buttons
// (« Cancel »), so host/install.ts routes them to a native French message box (electron/main.ts).
// Pure and DOM-free (unit-tested here).

export interface MessageBoxText {
  /** First paragraph, shown in bold. */
  message: string;
  /** The rest (may be empty). */
  detail: string;
}

/** Split a browser-style message into the bold title and the detail text of a macOS alert. */
export function messageBoxText(text: unknown): MessageBoxText {
  const value = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  const cut = value.indexOf('\n');
  if (cut < 0) return { message: value, detail: '' };
  return { message: value.slice(0, cut).trim(), detail: value.slice(cut + 1).replace(/^\n+/, '').trim() };
}

/** Buttons of the confirm box: « OK » first (default, ↩), « Annuler » second (Esc). */
export const CONFIRM_BUTTONS = ['OK', 'Annuler'] as const;
