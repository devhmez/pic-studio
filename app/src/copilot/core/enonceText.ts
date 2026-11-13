// Énoncé (TP handout) → plain text for the copilot's prompt. DOCX: word/document.xml unzipped with fflate, paragraphs
// and tables (cells joined with « | »); PDF: pdf.js text items glued back into lines. Figures are not read.
import { strFromU8, unzipSync } from 'fflate';

/** Longest énoncé sent to the copilot (characters). */
export const ENONCE_MAX_CHARS = 12_000;

const ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

interface TableState { rows: string[][]; row: string[] | null; cell: string[] | null }

interface Paragraph { text: string; listItem: boolean }

/**
 * Text of a WordprocessingML body: one line per paragraph, tables as « a | b | c » rows, list items with « • ».
 * Paragraphs nest (a text box inside a paragraph holds its own <w:p>): each one is a buffer on a stack, so the outer
 * paragraph keeps its own text. The <mc:Fallback> copy of an <mc:AlternateContent> block is skipped (it repeats the
 * <mc:Choice> content for old Word versions).
 */
export function docxXmlToText(xml: string): string {
  const out: string[] = [];
  const tables: TableState[] = [];
  const paras: Paragraph[] = [];
  let fallbackDepth = 0;
  let inText = false;
  const top = () => paras[paras.length - 1];
  const emit = (line: string) => {
    const t = tables[tables.length - 1];
    if (t?.cell) t.cell.push(line);
    else out.push(line);
  };
  const tag = /<(\/?)([A-Za-z0-9_]+:)?([A-Za-z0-9_]+)\b[^>]*?(\/?)>|([^<]+)/g;
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    if (m[5] !== undefined) {
      const p = top();
      if (inText && p && fallbackDepth === 0) p.text += decodeXmlEntities(m[5]);
      continue;
    }
    const closing = m[1] === '/';
    const ns = m[2] ?? '';
    const name = m[3];
    const selfClosing = m[4] === '/';
    if (ns === 'mc:' && name === 'Fallback' && !selfClosing) {
      fallbackDepth = Math.max(0, fallbackDepth + (closing ? -1 : 1));
      continue;
    }
    if (ns !== 'w:' || fallbackDepth > 0) continue;
    switch (name) {
      case 'p':
        if (closing) {
          const p = paras.pop();
          if (p) emit((p.listItem ? '• ' : '') + p.text.replace(/[ \t\u00a0]+$/g, ''));
        } else if (selfClosing) {
          emit('');
        } else {
          paras.push({ text: '', listItem: false });
        }
        break;
      case 'numPr': {
        const p = top();
        if (!closing && p) p.listItem = true;
        break;
      }
      case 't':
        inText = !closing && !selfClosing;
        break;
      case 'tab': {
        const p = top();
        if (p && !closing) p.text += '\t';
        break;
      }
      case 'br':
      case 'cr': {
        const p = top();
        if (p && !closing) p.text += '\n';
        break;
      }
      case 'tbl':
        if (!closing) tables.push({ rows: [], row: null, cell: null });
        else {
          const t = tables.pop();
          if (t) emit(t.rows.map((r) => r.join(' | ')).join('\n'));
        }
        break;
      case 'tr': {
        const t = tables[tables.length - 1];
        if (!t) break;
        if (!closing) t.row = [];
        else if (t.row) { t.rows.push(t.row); t.row = null; }
        break;
      }
      case 'tc': {
        const t = tables[tables.length - 1];
        if (!t) break;
        if (!closing) t.cell = [];
        else if (t.cell) { t.row?.push(t.cell.filter((x) => x.trim() !== '').join(' ').trim()); t.cell = null; }
        break;
      }
      default:
        break;
    }
  }
  return tidyText(out.join('\n'));
}

/** Text of a .docx file (throws a French error when it is not a Word document). */
export function docxToText(bytes: Uint8Array): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => f.name === 'word/document.xml' });
  } catch {
    throw new Error('Ce fichier n’est pas un document Word (.docx) lisible.');
  }
  const doc = files['word/document.xml'];
  if (!doc) throw new Error('Document Word sans contenu texte (word/document.xml introuvable).');
  return docxXmlToText(strFromU8(doc));
}

/** pdf.js text item (the fields used here). */
export interface PdfTextItem {
  str: string;
  hasEOL?: boolean;
  /** [a, b, c, d, x, y] */
  transform?: readonly number[];
  width?: number;
  height?: number;
}

/** Glue pdf.js text items of each page back into lines; pages separated by a blank line. */
export function pdfItemsToText(pages: readonly (readonly PdfTextItem[])[]): string {
  const out: string[] = [];
  for (const items of pages) {
    let line = '';
    let lastY = Number.NaN; let lastEnd = Number.NaN; let lastH = 0;
    const lines: string[] = [];
    for (const it of items) {
      if (typeof it.str !== 'string') continue;
      const x = it.transform?.[4] ?? Number.NaN;
      const y = it.transform?.[5] ?? Number.NaN;
      const h = Math.abs(it.height ?? it.transform?.[3] ?? 0) || lastH || 10;
      if (line !== '' && Number.isFinite(y) && Number.isFinite(lastY) && Math.abs(y - lastY) > h * 0.6) {
        lines.push(line);
        line = '';
      } else if (line !== '' && Number.isFinite(x) && Number.isFinite(lastEnd) && x - lastEnd > h * 0.2 && !/\s$/.test(line) && !/^\s/.test(it.str)) {
        line += ' ';
      }
      line += it.str;
      if (Number.isFinite(x)) lastEnd = x + (it.width ?? 0);
      if (Number.isFinite(y)) lastY = y;
      lastH = h;
      if (it.hasEOL) { lines.push(line); line = ''; lastY = Number.NaN; }
    }
    if (line !== '') lines.push(line);
    out.push(lines.join('\n'));
  }
  return tidyText(out.join('\n\n'));
}

/** Control characters that are never text (C0 except tab and newline, DEL): NUL in particular cannot go into argv. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Remove control characters (NUL...) that a badly decoded file or a PDF text layer may contain. */
export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, '');
}

/** Trim spaces at line ends, at most one blank line in a row, no control characters. */
export function tidyText(text: string): string {
  return stripControlChars(text.replace(/\r\n?/g, '\n'))
    .replace(/[ \t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface CappedText {
  text: string;
  truncated: boolean;
  originalLength: number;
}

/** At most `max` characters, cut at a paragraph (or line, or word) boundary. */
export function capText(text: string, max = ENONCE_MAX_CHARS): CappedText {
  const clean = tidyText(text);
  if (clean.length <= max) return { text: clean, truncated: false, originalLength: clean.length };
  const head = clean.slice(0, max);
  const cut = Math.max(head.lastIndexOf('\n\n'), head.lastIndexOf('\n'), head.lastIndexOf(' '));
  const kept = cut > max * 0.6 ? head.slice(0, cut) : head;
  return { text: kept.trimEnd(), truncated: true, originalLength: clean.length };
}

/** Decode a plain-text file: UTF-8, or UTF-16 (Windows Notepad « Unicode ») when it starts with a byte-order mark. */
export function decodeTextFile(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // UTF-16BE: swap each pair of bytes and decode as UTF-16LE (supported everywhere).
    const swapped = new Uint8Array(bytes.length - 2 - ((bytes.length - 2) % 2));
    for (let i = 0; i < swapped.length; i += 2) { swapped[i] = bytes[i + 3]; swapped[i + 1] = bytes[i + 2]; }
    return new TextDecoder('utf-16le').decode(swapped);
  }
  // No BOM but every other byte is 0: UTF-16LE without a mark.
  const sample = bytes.subarray(0, Math.min(bytes.length, 400));
  let zeroOdd = 0;
  for (let i = 1; i < sample.length; i += 2) if (sample[i] === 0) zeroOdd++;
  if (sample.length >= 8 && zeroOdd >= sample.length / 2 * 0.9) return new TextDecoder('utf-16le').decode(bytes);
  const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return new TextDecoder('utf-8').decode(bytes.subarray(start));
}

export type EnonceKind = 'pdf' | 'docx' | 'text' | 'image' | 'doc' | 'unknown';

export function enonceKind(name: string, bytes?: Uint8Array): EnonceKind {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (bytes && bytes.length >= 4) {
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf'; // %PDF
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && ext !== 'pdf') return ext === 'docx' || ext === '' ? 'docx' : ext === 'zip' ? 'unknown' : 'docx';
  }
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'doc') return 'doc';
  if (['txt', 'md', 'c', 'h', 'csv'].includes(ext)) return 'text';
  if (['png', 'jpg', 'jpeg', 'gif', 'heic', 'webp', 'bmp', 'tif', 'tiff'].includes(ext)) return 'image';
  return 'unknown';
}
