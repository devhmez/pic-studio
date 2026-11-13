// HTML → PDF with Chromium's printer (webContents.printToPDF) in a hidden, locked-down window.
import { BrowserWindow, session, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface PdfOptions {
  landscape?: boolean;
}

const RENDER_TIMEOUT_MS = 30_000;
/** Pause after load so web fonts and the SVG layout settle before the printer snapshots the page. */
const SETTLE_MS = 150;
const PARTITION = 'pic-studio-print';

let sessionReady = false;

/**
 * The print window lives in its own in-memory session that only lets the page load itself (and inline data:),
 * so a generated page can never reach the network or other local files.
 */
function printSession(allowedUrl: () => string | null): Session {
  const ses = session.fromPartition(PARTITION, { cache: false });
  if (!sessionReady) {
    sessionReady = true;
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.webRequest.onBeforeRequest((details, callback) => {
      const ok = details.url.startsWith('data:') || details.url === allowedUrl();
      callback({ cancel: !ok });
    });
  }
  return ses;
}

let currentUrl: string | null = null;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

// One render at a time: the session's request filter allows a single page.
let queue: Promise<unknown> = Promise.resolve();

/** Render a self-contained HTML document to PDF bytes (A4, background graphics, the page's own @page rules win). */
export function htmlToPdf(html: string, options: PdfOptions = {}): Promise<Buffer> {
  const job = queue.then(() => render(html, options));
  queue = job.catch(() => undefined);
  return job;
}

async function render(html: string, options: PdfOptions): Promise<Buffer> {
  const file = path.join(tmpdir(), `pic-studio-print-${randomUUID()}.html`);
  await writeFile(file, html, { encoding: 'utf8', mode: 0o600 });
  const url = pathToFileURL(file).href;
  currentUrl = url;
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1400,
    webPreferences: {
      session: printSession(() => currentUrl),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      javascript: false,
      spellcheck: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  try {
    await withTimeout(win.loadURL(url), RENDER_TIMEOUT_MS, 'La page à imprimer ne s’est pas chargée à temps.');
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    return await withTimeout(
      win.webContents.printToPDF({
        pageSize: 'A4',
        landscape: options.landscape ?? false,
        printBackground: true,
        preferCSSPageSize: true,
      }),
      RENDER_TIMEOUT_MS,
      'La création du PDF a pris trop de temps.',
    );
  } finally {
    currentUrl = null;
    if (!win.isDestroyed()) win.destroy();
    await rm(file, { force: true }).catch(() => undefined);
  }
}
