// MikroC-compatible file bytes: Windows-1252 with CRLF line ends, like the prof's demux.c.
import { encodeSourceCp1252 } from '@pic/compiler';

/** `.c` file content for MikroC PRO for PIC (CP1252 + CRLF). */
export function toMikroCFile(source: string): Uint8Array {
  return encodeSourceCp1252(source);
}
