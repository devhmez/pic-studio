// pdf.js loaded on demand, with its Web Worker served from the app's own files: works in the browser and in the
// Mac app (file:// pages, see vite.config.ts). Use it to read an énoncé PDF instead of importing pdfjs-dist directly.
//   const pdfjs = await loadPdfjs();
//   const doc = await pdfjs.getDocument({ data: bytes }).promise;
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export type Pdfjs = typeof import('pdfjs-dist');

/** URL of pdf.js's worker module inside the built app (assets/pdf.worker.min-*.mjs). */
export const PDF_WORKER_URL: string = workerUrl;

let loading: Promise<Pdfjs> | null = null;

/** The pdf.js module (loaded once, in its own chunk) with GlobalWorkerOptions.workerSrc set. */
export function loadPdfjs(): Promise<Pdfjs> {
  loading ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    return pdfjs;
  }).catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** A dedicated pdf.js worker from PDF_WORKER_URL (never pdf.js's slow main-thread fallback). Destroy it when done. */
export async function createPdfWorker(name = 'pic-studio-pdf'): Promise<InstanceType<Pdfjs['PDFWorker']>> {
  const pdfjs = await loadPdfjs();
  return pdfjs.PDFWorker.create({ name, port: new Worker(workerUrl, { type: 'module', name }) });
}
