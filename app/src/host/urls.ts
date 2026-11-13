// Navigation rules of the Mac app (electron/security.ts): the window only ever shows PIC Studio's own page;
// web and mail links go to the default browser / mail app. Pure and DOM-free (unit-tested here).

/** URLs handed to the default browser or mail app. */
export function isExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:';
  } catch {
    return false;
  }
}

/**
 * True when `url` is the app's own page: the same file (file:///…/app/dist/index.html, any query or hash) or the
 * same dev-server origin (http://localhost:5173/…).
 */
export function isAppUrl(url: string, appUrl: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(appUrl);
    if (a.protocol !== b.protocol) return false;
    if (a.protocol === 'file:') return decodeURIComponent(a.pathname) === decodeURIComponent(b.pathname);
    return a.origin === b.origin;
  } catch {
    return false;
  }
}

/**
 * True when an IPC message comes from the app's own page: `frame` is the sender frame of the message (null once the
 * frame is gone; reading a disposed frame throws). Any other page — wherever the window was made to go — is refused.
 */
export function isAppFrame(frame: { readonly url: string } | null | undefined, appUrl: string): boolean {
  try {
    return !!frame && isAppUrl(frame.url, appUrl);
  } catch {
    return false;
  }
}

/** Development switches read from the environment by electron/main.ts. */
export interface DeveloperSettings {
  /** Vite dev server to load instead of the built page (npm run app:dev), or null. */
  devUrl: string | null;
  /** « Recharger » and the developer tools in the menu. */
  developer: boolean;
}

/**
 * PIC_STUDIO_DEV_URL and PIC_STUDIO_DEVTOOLS, for development builds only: the packaged app ignores them, so a
 * variable left in the shell can never make PIC Studio.app load another page (which would get window.picStudio:
 * file writes, the copilot) or open the developer tools.
 */
export function developerSettings(env: Readonly<Record<string, string | undefined>>, packaged: boolean): DeveloperSettings {
  if (packaged) return { devUrl: null, developer: false };
  const devUrl = env.PIC_STUDIO_DEV_URL?.trim() || null;
  return { devUrl, developer: devUrl !== null || env.PIC_STUDIO_DEVTOOLS === '1' };
}
