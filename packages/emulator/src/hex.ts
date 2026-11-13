// Intel HEX (INHX8M, as written by MPASM and MikroC) for 14-bit PIC16 words.
// Byte address = word address × 2, words little-endian. Configuration word 0x2007 → byte 0x400E,
// user IDs 0x2000–0x2003 → 0x4000, data EEPROM 0x2100 → 0x4200 (one byte per word, high byte 0).
import { CONFIG_ADDRESS, EEPROM_BYTES, EEPROM_HEX_ADDRESS, PROGRAM_WORDS, USER_ID_ADDRESS } from './sfr';

const BLANK_WORD = 0x3fff;
const BLANK_BYTE = 0xff;
const RECORD_BYTES = 16;

export interface HexImage {
  /** 1024 program words; 0x3FFF where the file has no data. */
  program: Uint16Array;
  /** Configuration word (0x2007), if present. */
  config?: number;
  /** 64-byte data EEPROM image (0xFF where blank), if the file has EEPROM data. */
  eeprom?: Uint8Array;
  /** User ID words 0x2000–0x2003, if present. */
  userId?: Uint16Array;
  /** Non-fatal problems, in French (e.g. data outside the PIC16F84A memory). */
  warnings: string[];
}

export class HexParseError extends Error {
  constructor(readonly line: number, message: string) {
    super(`Fichier HEX, ligne ${line} : ${message}`);
    this.name = 'HexParseError';
  }
}

function hexByte(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

function record(type: number, address: number, data: readonly number[]): string {
  let sum = data.length + (address >> 8) + (address & 0xff) + type;
  let text = `:${hexByte(data.length)}${hexByte(address >> 8)}${hexByte(address & 0xff)}${hexByte(type)}`;
  for (const b of data) {
    sum += b;
    text += hexByte(b);
  }
  return text + hexByte((0x100 - (sum & 0xff)) & 0xff);
}

/** Emit data records for a sparse byte map, split at 16-byte aligned boundaries like MPASM. */
function dataRecords(bytes: ReadonlyMap<number, number>): string[] {
  const addresses = [...bytes.keys()].sort((a, b) => a - b);
  const lines: string[] = [];
  let i = 0;
  while (i < addresses.length) {
    const start = addresses[i];
    const data = [bytes.get(start)!];
    i++;
    while (
      i < addresses.length &&
      addresses[i] === start + data.length &&
      addresses[i] % RECORD_BYTES !== 0
    ) {
      data.push(bytes.get(addresses[i])!);
      i++;
    }
    lines.push(record(0x00, start, data));
  }
  return lines;
}

export interface HexWriteInput {
  program: Uint16Array;
  config?: number;
  eeprom?: Uint8Array;
  userId?: Uint16Array;
}

export interface HexWriteOptions {
  /** Line ending; default CRLF like the Windows tools. */
  eol?: string;
  /** Also write program words equal to 0x3FFF (erased). Default false. */
  includeBlank?: boolean;
}

export function writeHex(image: HexWriteInput, opts: HexWriteOptions = {}): string {
  const bytes = new Map<number, number>();
  const putWord = (wordAddr: number, value: number): void => {
    bytes.set(wordAddr * 2, value & 0xff);
    bytes.set(wordAddr * 2 + 1, (value >> 8) & 0x3f);
  };
  const n = Math.min(image.program.length, PROGRAM_WORDS);
  for (let addr = 0; addr < n; addr++) {
    const word = image.program[addr] & 0x3fff;
    if (word !== BLANK_WORD || opts.includeBlank) putWord(addr, word);
  }
  image.userId?.forEach((word, i) => {
    if (i < 4) putWord(USER_ID_ADDRESS + i, word);
  });
  if (image.config !== undefined) putWord(CONFIG_ADDRESS, image.config);
  image.eeprom?.forEach((value, i) => {
    if (i < EEPROM_BYTES && value !== BLANK_BYTE) putWord(EEPROM_HEX_ADDRESS + i, value & 0xff);
  });
  const lines = [...dataRecords(bytes), record(0x01, 0, [])];
  const eol = opts.eol ?? '\r\n';
  return lines.join(eol) + eol;
}

export function parseHex(text: string): HexImage {
  const bytes = new Map<number, number>();
  const warnings: string[] = [];
  let base = 0;
  let sawEof = false;
  const lines = text.split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length && !sawEof; i++) {
    const lineNo = i + 1;
    const line = lines[i].trim();
    if (line === '') continue;
    if (!line.startsWith(':')) throw new HexParseError(lineNo, "un enregistrement doit commencer par ':'.");
    const body = line.slice(1);
    if (body.length % 2 !== 0 || !/^[0-9A-Fa-f]+$/.test(body)) {
      throw new HexParseError(lineNo, 'caractères hexadécimaux invalides.');
    }
    const raw: number[] = [];
    for (let j = 0; j < body.length; j += 2) raw.push(parseInt(body.slice(j, j + 2), 16));
    if (raw.length < 5) throw new HexParseError(lineNo, 'enregistrement trop court.');
    const count = raw[0];
    if (raw.length !== count + 5) throw new HexParseError(lineNo, 'longueur incohérente avec le nombre d’octets annoncé.');
    if ((raw.reduce((s, b) => s + b, 0) & 0xff) !== 0) throw new HexParseError(lineNo, 'somme de contrôle incorrecte.');
    const address = (raw[1] << 8) | raw[2];
    const type = raw[3];
    const data = raw.slice(4, 4 + count);
    switch (type) {
      case 0x00:
        data.forEach((b, k) => bytes.set(base + address + k, b));
        break;
      case 0x01:
        sawEof = true;
        break;
      case 0x02:
        base = ((data[0] << 8) | data[1]) << 4;
        break;
      case 0x04:
        base = ((data[0] << 8) | data[1]) * 0x10000;
        break;
      case 0x03:
      case 0x05:
        break; // start address: meaningless for a PIC
      default:
        throw new HexParseError(lineNo, `type d’enregistrement inconnu (${hexByte(type)}).`);
    }
  }
  if (!sawEof) warnings.push("Fin de fichier (enregistrement 01) absente.");
  return toImage(bytes, warnings);
}

function toImage(bytes: ReadonlyMap<number, number>, warnings: string[]): HexImage {
  const words = new Map<number, number>();
  for (const [byteAddr, value] of bytes) {
    const wordAddr = Math.floor(byteAddr / 2);
    const word = words.get(wordAddr) ?? BLANK_WORD;
    words.set(
      wordAddr,
      byteAddr % 2 === 0 ? (word & 0x3f00) | value : ((value & 0x3f) << 8) | (word & 0xff),
    );
  }
  const program = new Uint16Array(PROGRAM_WORDS).fill(BLANK_WORD);
  const image: HexImage = { program, warnings };
  let outside = 0;
  for (const [addr, word] of words) {
    if (addr < PROGRAM_WORDS) {
      program[addr] = word;
    } else if (addr === CONFIG_ADDRESS) {
      image.config = word;
    } else if (addr >= USER_ID_ADDRESS && addr < USER_ID_ADDRESS + 4) {
      image.userId ??= new Uint16Array(4).fill(BLANK_WORD);
      image.userId[addr - USER_ID_ADDRESS] = word;
    } else if (addr >= EEPROM_HEX_ADDRESS && addr < EEPROM_HEX_ADDRESS + EEPROM_BYTES) {
      image.eeprom ??= new Uint8Array(EEPROM_BYTES).fill(BLANK_BYTE);
      image.eeprom[addr - EEPROM_HEX_ADDRESS] = word & 0xff;
    } else {
      outside++;
    }
  }
  if (outside > 0) {
    warnings.push(`${outside} mot(s) hors de la mémoire du PIC16F84A ignoré(s) (programme limité à 0x000–0x3FF).`);
  }
  return image;
}
