// Source text encoding. MikroC saves .c files in Windows-1252 with CRLF line ends (the prof's demux.c: 'é' = 0xE9).

/** Windows-1252 code points for bytes 0x80–0x9F (undefined bytes map to the C1 control of the same value). */
const CP1252_HIGH: readonly number[] = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

export type SourceEncoding = 'auto' | 'cp1252' | 'utf-8';

function decodeCp1252(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += String.fromCharCode(b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b);
  }
  return out;
}

/** True when the bytes are well-formed UTF-8 containing at least one multi-byte sequence. */
function looksLikeUtf8(bytes: Uint8Array): boolean {
  let multi = false;
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    if (b < 0x80) { i++; continue; }
    let len: number;
    if (b >= 0xc2 && b <= 0xdf) len = 2;
    else if (b >= 0xe0 && b <= 0xef) len = 3;
    else if (b >= 0xf0 && b <= 0xf4) len = 4;
    else return false;
    if (i + len > bytes.length) return false;
    for (let k = 1; k < len; k++) if ((bytes[i + k] & 0xc0) !== 0x80) return false;
    multi = true;
    i += len;
  }
  return multi;
}

/**
 * Decode a .c file. 'auto' (default) uses UTF-8 when the file has a UTF-8 BOM or is valid multi-byte UTF-8,
 * otherwise Windows-1252 like MikroC. Line ends are kept as they are (the lexer accepts CRLF, LF and CR).
 */
export function decodeSource(bytes: Uint8Array, encoding: SourceEncoding = 'auto'): string {
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (encoding === 'utf-8' || (encoding === 'auto' && (hasBom || looksLikeUtf8(bytes)))) {
    return new TextDecoder('utf-8').decode(hasBom ? bytes.subarray(3) : bytes);
  }
  return decodeCp1252(bytes);
}

/** Encode text as Windows-1252 with CRLF line ends (MikroC-compatible). Unmappable characters become '?'. */
export function encodeSourceCp1252(text: string): Uint8Array {
  const normalized = text.replace(/\r\n|\r|\n/g, '\r\n');
  const out = new Uint8Array(normalized.length);
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized.charCodeAt(i);
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out[i] = c;
    else {
      const idx = CP1252_HIGH.indexOf(c);
      out[i] = idx >= 0 ? 0x80 + idx : 0x3f;
    }
  }
  return out;
}
