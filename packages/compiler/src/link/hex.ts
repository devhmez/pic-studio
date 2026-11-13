// Intel HEX, INHX8M flavour (MPASM / MikroC): byte address = word address × 2, words little-endian,
// 16 data bytes per record, configuration word at word 0x2007 (byte 0x400E).

function record(type: number, addr: number, data: number[]): string {
  const bytes = [data.length, (addr >> 8) & 0xff, addr & 0xff, type, ...data];
  const sum = bytes.reduce((a, b) => a + b, 0);
  const checksum = (0x100 - (sum & 0xff)) & 0xff;
  return `:${bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('')}${checksum.toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * Build the HEX text. Only programmed words are written (`used` marks them); runs are split on 8-word boundaries
 * like MPASM does.
 */
export function toIntelHex(program: Uint16Array, used: (addr: number) => boolean, config: number, configAddr = 0x2007): string {
  const lines: string[] = [];
  let addr = 0;
  while (addr < program.length) {
    if (!used(addr)) {
      addr++;
      continue;
    }
    const data: number[] = [];
    const start = addr;
    while (addr < program.length && used(addr) && data.length < 16) {
      data.push(program[addr] & 0xff, (program[addr] >> 8) & 0xff);
      addr++;
      if ((addr & 7) === 0) break;
    }
    lines.push(record(0x00, start * 2, data));
  }
  const cfgByteAddr = configAddr * 2;
  if (cfgByteAddr > 0xffff) lines.push(record(0x04, 0, [(cfgByteAddr >> 24) & 0xff, (cfgByteAddr >> 16) & 0xff]));
  lines.push(record(0x00, cfgByteAddr & 0xffff, [config & 0xff, (config >> 8) & 0xff]));
  lines.push(':00000001FF');
  return `${lines.join('\n')}\n`;
}

/** Parse an INHX8M file back into program words and the config word (used by tests and for .hex import). */
export function parseIntelHex(text: string): { program: Uint16Array; config?: number } {
  const program = new Uint16Array(1024).fill(0x3fff);
  const bytes = new Map<number, number>();
  let base = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(':')) continue;
    const b = line.slice(1).match(/../g)!.map((x) => parseInt(x, 16));
    const [len, hi, lo, type] = b;
    if (type === 0x04) base = ((b[4] << 8) | b[5]) << 16;
    if (type !== 0x00) continue;
    const a = base + ((hi << 8) | lo);
    for (let i = 0; i < len; i++) bytes.set(a + i, b[4 + i]);
  }
  for (let w = 0; w < 1024; w++) {
    const l = bytes.get(w * 2);
    const h = bytes.get(w * 2 + 1);
    if (l !== undefined && h !== undefined) program[w] = ((h << 8) | l) & 0x3fff;
  }
  const cl = bytes.get(0x400e);
  const ch = bytes.get(0x400f);
  return { program, config: cl !== undefined && ch !== undefined ? ((ch << 8) | cl) & 0x3fff : undefined };
}
