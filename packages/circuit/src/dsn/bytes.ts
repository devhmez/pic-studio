// Little-endian readers and byte-pattern search over a DSN buffer.

export class ByteReader {
  readonly view: DataView;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length(): number { return this.bytes.length; }
  u8(o: number): number { return this.bytes[o]; }
  u16(o: number): number { return this.view.getUint16(o, true); }
  i16(o: number): number { return this.view.getInt16(o, true); }
  u32(o: number): number { return this.view.getUint32(o, true); }
  i32(o: number): number { return this.view.getInt32(o, true); }

  /** First index of `needle` in [from, to) such that the whole match fits before `to`, or -1. */
  indexOf(needle: Uint8Array, from = 0, to = this.bytes.length): number {
    const h = this.bytes;
    const last = Math.min(to, h.length) - needle.length;
    outer: for (let i = Math.max(0, from); i <= last; i++) {
      for (let j = 0; j < needle.length; j++) if (h[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  }

  /** All non-overlapping occurrences of `needle` in [from, to). */
  findAll(needle: Uint8Array, from = 0, to = this.bytes.length): number[] {
    const out: number[] = [];
    let i = this.indexOf(needle, from, to);
    while (i >= 0) {
      out.push(i);
      i = this.indexOf(needle, i + needle.length, to);
    }
    return out;
  }

  /** Index of the next NUL at or after `from`. */
  nul(from: number): number {
    const i = this.bytes.indexOf(0, from);
    return i < 0 ? this.bytes.length : i;
  }

  text(from: number, to: number): string {
    return decodeText(this.bytes.subarray(from, Math.min(to, this.bytes.length)));
  }
}

export function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** `[u8 length][name]` as ISIS stores library and device names. */
export function lengthPrefixed(name: string): Uint8Array {
  const out = new Uint8Array(name.length + 1);
  out[0] = name.length;
  out.set(ascii(name), 1);
  return out;
}

let cp1252: TextDecoder | null | undefined;

/** ISIS runs on Windows: text is CP1252 (falls back to Latin-1 when the decoder is unavailable). */
export function decodeText(bytes: Uint8Array): string {
  if (cp1252 === undefined) {
    try { cp1252 = new TextDecoder('windows-1252'); } catch { cp1252 = null; }
  }
  if (cp1252) return cp1252.decode(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

export const isUpper = (b: number): boolean => b >= 0x41 && b <= 0x5a;
export const isDigit = (b: number): boolean => b >= 0x30 && b <= 0x39;
