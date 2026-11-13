// Reading an énoncé the student attaches (drag & drop or « Joindre un énoncé »): PDF through pdf.js (its worker is
// served from the app's files, see ../host/pdfjs.ts), DOCX through fflate, plain text as is. Images are refused
// with an explanation: the copilot does not read figures.
import { createPdfWorker, loadPdfjs } from '../host/pdfjs';
import { capText, decodeTextFile, docxToText, enonceKind, pdfItemsToText, type PdfTextItem } from './core/enonceText';

export interface LoadedEnonce {
  name: string;
  text: string;
  truncated: boolean;
  originalLength: number;
  pages?: number;
}

/** Accepted by « Joindre un énoncé ». */
export const ENONCE_ACCEPT = ['.pdf', '.docx', '.txt', '.md'];

/** Largest file read (bytes). */
const MAX_BYTES = 40 * 1024 * 1024;

async function pdfToText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const pdfjs = await loadPdfjs();
  const worker = await createPdfWorker('pic-studio-enonce');
  try {
    // pdf.js takes ownership of the buffer: give it a copy.
    const task = pdfjs.getDocument({ data: bytes.slice(), worker });
    const doc = await task.promise;
    try {
      const pages: PdfTextItem[][] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        pages.push(content.items.filter((it) => 'str' in it) as PdfTextItem[]);
        page.cleanup();
      }
      return { text: pdfItemsToText(pages), pages: doc.numPages };
    } finally {
      await task.destroy();
    }
  } finally {
    worker.destroy();
  }
}

/** Extract the text of an énoncé (throws a French message the panel shows as is). */
export async function readEnonce(name: string, bytes: Uint8Array): Promise<LoadedEnonce> {
  if (bytes.length > MAX_BYTES) throw new Error('Fichier trop volumineux (plus de 40 Mo).');
  const kind = enonceKind(name, bytes);
  let text: string;
  let pages: number | undefined;
  switch (kind) {
    case 'pdf': {
      try {
        const r = await pdfToText(bytes);
        text = r.text;
        pages = r.pages;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/password/i.test(msg)) throw new Error('Ce PDF est protégé par un mot de passe : ouvrez-le et copiez son texte dans le message.');
        throw new Error('Ce PDF n’a pas pu être lu. Copiez son texte dans le message.');
      }
      if (text.replace(/\s/g, '').length < 20) {
        throw new Error('Ce PDF ne contient pas de texte lisible (c’est sans doute un scan) : décrivez l’énoncé dans le message.');
      }
      break;
    }
    case 'docx':
      text = docxToText(bytes);
      break;
    case 'text':
      text = decodeTextFile(bytes);
      break;
    case 'image':
      throw new Error('Les images ne sont pas lues par le copilote : décrivez le circuit (quelles broches, quels composants) dans le message.');
    case 'doc':
      throw new Error('Ancien format Word (.doc) : enregistrez-le en .docx ou en PDF, puis joignez-le à nouveau.');
    default:
      throw new Error('Format non pris en charge : joignez un PDF, un document Word (.docx) ou un fichier texte.');
  }
  if (text.trim() === '') throw new Error('Ce document ne contient pas de texte.');
  const capped = capText(text);
  return { name, ...capped, ...(pages !== undefined ? { pages } : {}) };
}
