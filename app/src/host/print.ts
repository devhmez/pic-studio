// PDF exports that work in both hosts: in the Mac app the page is rendered straight to a PDF file (Electron
// printToPDF, A4, backgrounds kept) after a native « Enregistrer » dialog; in the browser it goes through the system
// print dialog (« Enregistrer au format PDF »). Used by the organigramme, the fiche de câblage and the Rendu du TP.
import { printHtml } from '../export/raster';
import { getHost } from './bridge';
import { hostErrorMessage } from './errors';

export type PdfOutcome =
  /** Mac app: the PDF was written under this file name. */
  | { kind: 'saved'; name: string }
  /** Mac app: the student closed the « Enregistrer » dialog. */
  | { kind: 'cancelled' }
  /** Browser: the system print dialog was opened (the student saves the PDF from there). */
  | { kind: 'print-dialog' };

export interface PdfRequest {
  /** Suggested file name (« .pdf » is added when missing). */
  name: string;
  /** Self-contained HTML page (inline SVG and styles, `@page` rules for size and margins). */
  html: string;
  /** Force landscape when the page has no `@page { size }` rule of its own. */
  landscape?: boolean;
}

/** True when PDF exports save a file directly (Mac app) rather than opening the print dialog (browser). */
export function savesPdfDirectly(): boolean {
  return typeof getHost()?.platform.savePdf === 'function';
}

/** Save `html` as a PDF (Mac app) or open the print dialog (browser). Throws with a French message on failure. */
export async function exportPdf({ name, html, landscape }: PdfRequest): Promise<PdfOutcome> {
  const host = getHost();
  if (host && typeof host.platform.savePdf === 'function') {
    const fileName = /\.pdf$/i.test(name) ? name : `${name}.pdf`;
    try {
      const saved = await host.platform.savePdf(fileName, html, landscape ? { landscape: true } : undefined);
      return saved ? { kind: 'saved', name: saved } : { kind: 'cancelled' };
    } catch (e) {
      throw new Error(hostErrorMessage(e));
    }
  }
  await printHtml(html);
  return { kind: 'print-dialog' };
}
