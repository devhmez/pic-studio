// Checks run by the renderer only during the packaging smoke test (PIC_STUDIO_SMOKE_LOG, scripts/smoke-app.mjs):
// the things that break when the built page runs from file:// inside app.asar instead of the dev server.
// Loaded with a dynamic import, so it costs nothing in normal use.
import { wiringSheetHtml } from '../export/actions';
import { svgToPng } from '../export/raster';
import { getPlatform } from '../platform';
import { createSimClient } from '../sim/client';
import type { FromWorker } from '../sim/protocol';
import { appStore, serializeProject } from '../state/store';
import { createPdfWorker, loadPdfjs } from './pdfjs';
import { exportPdf } from './print';
import type { RendererReadyInfo, SmokeCheck } from './shell';

const TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e); },
    );
  });
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The simulation Web Worker: load a 3-word program (NOP, NOP, GOTO 0) into a separate worker, step twice and
 * expect PC = 2 in the debug snapshot.
 */
export async function checkSimWorker(): Promise<{ simWorker: SmokeCheck; simPc?: number; detail?: string }> {
  if (typeof Worker === 'undefined') return { simWorker: 'skipped', detail: 'Pas de Web Worker' };
  let client: ReturnType<typeof createSimClient> | null = null;
  try {
    const result = await withTimeout(new Promise<number>((resolve, reject) => {
      let steps = 0;
      client = createSimClient((msg: FromWorker) => {
        if (msg.type === 'error') reject(new Error(msg.message));
        else if (msg.type === 'snapshot' && msg.debug) {
          if (steps < 2) {
            steps++;
            client?.post({ type: 'stepInstruction' });
          } else resolve(msg.debug.pc);
        }
      });
      const program = new Uint16Array(1024);
      program[2] = 0x2800; // GOTO 0
      const { project } = appStore.getState();
      client.post({ type: 'load', schematic: project.schematic, program, clockHz: 1_000_000, config: 0x3ffb });
    }), TIMEOUT_MS);
    if (result === 'timeout') return { simWorker: 'timeout' };
    return { simWorker: result === 2 ? 'ok' : 'error', simPc: result };
  } catch (e) {
    return { simWorker: 'error', detail: `simulateur : ${message(e)}` };
  } finally {
    (client as ReturnType<typeof createSimClient> | null)?.dispose();
  }
}

/** A one-page PDF saying « PIC Studio » (valid xref offsets, Helvetica). */
export function minimalPdf(text = 'PIC Studio'): Uint8Array {
  const content = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** pdf.js in its own module worker (the copilot reads énoncé PDFs this way): extract the text of minimalPdf(). */
export async function checkPdfWorker(): Promise<{ pdfWorker: SmokeCheck; detail?: string }> {
  if (typeof Worker === 'undefined') return { pdfWorker: 'skipped', detail: 'Pas de Web Worker' };
  let worker: Awaited<ReturnType<typeof createPdfWorker>> | null = null;
  try {
    const result = await withTimeout((async () => {
      const pdfjs = await loadPdfjs();
      worker = await createPdfWorker('pic-studio-smoke-pdf');
      const task = pdfjs.getDocument({ data: minimalPdf(), worker });
      const doc = await task.promise;
      const page = await doc.getPage(1);
      const text = await page.getTextContent();
      const joined = text.items.map((item) => ('str' in item ? item.str : '')).join('');
      await task.destroy();
      return joined;
    })(), TIMEOUT_MS);
    if (result === 'timeout') return { pdfWorker: 'timeout' };
    return result.includes('PIC Studio') ? { pdfWorker: 'ok' } : { pdfWorker: 'error', detail: `pdf.js : texte lu « ${result} »` };
  } catch (e) {
    return { pdfWorker: 'error', detail: `pdf.js : ${message(e)}` };
  } finally {
    (worker as Awaited<ReturnType<typeof createPdfWorker>> | null)?.destroy();
  }
}

/**
 * Saving through the Mac app (the main process writes into the smoke folder instead of asking): the project as
 * text, a PNG as bytes (canvas rendering included) and the fiche de câblage as a PDF (hidden print window).
 */
export async function checkSaves(): Promise<{ saves: SmokeCheck; savedFiles?: string[]; detail?: string }> {
  try {
    const result = await withTimeout((async () => {
      const platform = getPlatform();
      const names: (string | null)[] = [];
      names.push(await platform.saveFile('controle.picproj', serializeProject(appStore.getState().project), 'application/json'));
      const png = await svgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#0f766e"/></svg>', 40, 20);
      names.push(await platform.saveFile('controle.png', png, 'image/png'));
      const pdf = await exportPdf({ name: 'controle-fiche-de-cablage', html: wiringSheetHtml() });
      names.push(pdf.kind === 'saved' ? pdf.name : null);
      return names;
    })(), TIMEOUT_MS * 2);
    if (result === 'timeout') return { saves: 'timeout' };
    const saved = result.filter((n): n is string => typeof n === 'string');
    return { saves: saved.length === 3 ? 'ok' : 'error', savedFiles: saved };
  } catch (e) {
    return { saves: 'error', detail: `enregistrement : ${message(e)}` };
  }
}

/** Every smoke check, merged into the renderer-ready report. */
export async function runSmokeChecks(): Promise<Partial<RendererReadyInfo>> {
  const [sim, pdf, saves] = await Promise.all([checkSimWorker(), checkPdfWorker(), checkSaves()]);
  const detail = [sim.detail, pdf.detail, saves.detail].filter(Boolean).join(' · ') || undefined;
  return {
    simWorker: sim.simWorker, simPc: sim.simPc, pdfWorker: pdf.pdfWorker, saves: saves.saves, savedFiles: saves.savedFiles, detail,
  };
}
