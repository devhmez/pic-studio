// SVG → PNG (canvas) with the right physical resolution, and printing a standalone page (PDF through the system
// print dialog; the Electron shell can later swap in printToPDF through platform.ts).

/** Screen CSS pixels per inch: SVG user units are CSS pixels. */
const CSS_DPI = 96;
/** Largest canvas we ask for (WebKit refuses bigger ones silently). */
const MAX_SIDE = 12_000;
const MAX_AREA = 60_000_000;

// ------------------------------------------------------------------------------------------------ PNG pHYs

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const readU32 = (b: Uint8Array, at: number): number => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const writeU32 = (b: Uint8Array, at: number, v: number): void => {
  b[at] = (v >>> 24) & 0xff;
  b[at + 1] = (v >>> 16) & 0xff;
  b[at + 2] = (v >>> 8) & 0xff;
  b[at + 3] = v & 0xff;
};

/**
 * Same PNG with a pHYs chunk saying `dpi` (Word, Pages and printers then place it at its real size). Replaces an
 * existing pHYs. Returns the input unchanged when it is not a PNG.
 */
export function withPngDpi(png: Uint8Array, dpi: number): Uint8Array {
  if (png.length < 33 || !PNG_SIGNATURE.every((v, i) => png[i] === v)) return png;
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  writeU32(chunk, 0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // 'pHYs'
  writeU32(chunk, 8, ppm);
  writeU32(chunk, 12, ppm);
  chunk[16] = 1; // unit: metre
  writeU32(chunk, 17, crc32(chunk, 4, 17));
  // Walk the chunks: drop any pHYs, insert ours right after IHDR.
  const parts: Uint8Array[] = [png.subarray(0, 8)];
  let at = 8;
  let inserted = false;
  while (at + 12 <= png.length) {
    const len = readU32(png, at);
    const type = String.fromCharCode(png[at + 4], png[at + 5], png[at + 6], png[at + 7]);
    const end = at + 12 + len;
    if (end > png.length) return png;
    if (type !== 'pHYs') parts.push(png.subarray(at, end));
    if (type === 'IHDR' && !inserted) {
      parts.push(chunk);
      inserted = true;
    }
    at = end;
  }
  if (!inserted) return png;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ rasterizing

/** Scale actually used for a w × h drawing (the requested one, reduced to stay within canvas limits). */
export function rasterScale(width: number, height: number, wanted: number): number {
  if (!(width > 0 && height > 0)) return wanted;
  let s = wanted;
  s = Math.min(s, MAX_SIDE / width, MAX_SIDE / height);
  s = Math.min(s, Math.sqrt(MAX_AREA / (width * height)));
  return Math.max(0.1, s);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image SVG illisible.'));
    img.src = url;
  });
}

export interface PngOptions {
  /** Target resolution (default 300 dpi, i.e. ≈ 3.1 device pixels per CSS pixel). */
  dpi?: number;
  /** Background painted under the drawing (default white). */
  background?: string;
}

/** Draw a standalone SVG on a canvas and return PNG bytes (with its dpi recorded). */
export async function svgToPng(svg: string, width: number, height: number, options: PngOptions = {}): Promise<Uint8Array> {
  const dpi = options.dpi ?? 300;
  const scale = rasterScale(width, height, dpi / CSS_DPI);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Le dessin sur canvas n’est pas disponible.');
    ctx.fillStyle = options.background ?? '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('La conversion en PNG a échoué.');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return withPngDpi(bytes, CSS_DPI * scale);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ------------------------------------------------------------------------------------------------ printing

/**
 * Print a standalone HTML page through a hidden iframe (the system dialog offers « Enregistrer au format PDF »).
 * Resolves once the dialog has been opened.
 */
export function printHtml(html: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0', opacity: '0' });
    let done = false;
    const cleanup = () => setTimeout(() => frame.remove(), 1000);
    frame.onload = () => {
      if (done) return;
      done = true;
      const win = frame.contentWindow;
      if (!win) {
        frame.remove();
        reject(new Error('Impression impossible dans cette fenêtre.'));
        return;
      }
      // Let fonts and the SVG lay out before the dialog snapshots the page.
      setTimeout(() => {
        try {
          win.addEventListener('afterprint', cleanup, { once: true });
          win.focus();
          win.print();
          resolve();
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        } finally {
          // Some engines never fire afterprint: remove the frame later anyway.
          setTimeout(() => frame.remove(), 60_000);
        }
      }, 120);
    };
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}

/** A print page holding only an SVG drawing, fitted to the page (landscape when wider than tall). */
export function svgPrintPage(svg: string, title: string, width: number, height: number): string {
  const landscape = width > height * 1.15;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 12mm; }
  html, body { margin: 0; background: #fff; }
  .page { display: flex; align-items: flex-start; justify-content: center; }
  .page > svg { width: 100%; height: auto; max-height: ${landscape ? '180mm' : '268mm'}; }
</style></head>
<body><div class="page">${svg}</div></body></html>
`;
}
