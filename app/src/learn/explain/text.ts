// Number and wording helpers for the « Comprendre » explanations. Pure functions (no DOM, no store).

/** C-style hex as the prof writes it: hex2(6) → '0x06' (lower-case x, upper-case digits). */
export function hex2(value: number): string {
  return `0x${(value & 0xff).toString(16).toUpperCase().padStart(2, '0')}`;
}

/** Program address in the course notation: addrH(4) → '0004h'. */
export function addrH(value: number): string {
  return `${(value & 0x1fff).toString(16).toUpperCase().padStart(4, '0')}h`;
}

/** 8 binary digits grouped by nibbles: bin8(6) → '0000 0110'. */
export function bin8(value: number): string {
  const s = (value & 0xff).toString(2).padStart(8, '0');
  return `${s.slice(0, 4)} ${s.slice(4)}`;
}

/** Value of bit `bit` (0 or 1). */
export function bitOf(value: number, bit: number): 0 | 1 {
  return ((value >> bit) & 1) as 0 | 1;
}

/** Narrow no-break space, the French thousands separator. */
export const THIN_SPACE = ' ';

/** Integer with French digit grouping: groupThousands(125000) → '125 000'. */
export function groupThousands(n: number): string {
  const neg = n < 0;
  const digits = Math.abs(Math.round(n)).toString();
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += THIN_SPACE;
    out += digits[i];
  }
  return neg ? `-${out}` : out;
}

/** Decimal with a French comma, trailing zeros trimmed: frenchNumber(2.5) → '2,5'. */
export function frenchNumber(x: number, decimals = 2): string {
  const fixed = x.toFixed(decimals);
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  const [int, frac] = trimmed.split('.');
  const grouped = groupThousands(Number(int));
  const sign = x < 0 && !grouped.startsWith('-') && trimmed !== '0' ? '-' : '';
  return frac ? `${sign}${grouped},${frac}` : `${sign}${grouped}`;
}

/** « 5 (0x05) » for small values, as the explanations show both forms. */
export function decHex(value: number): string {
  return `${value & 0xff} (${hex2(value)})`;
}

/** Duration for humans: 0.0005 → '0,5 ms', 2 → '2 s', 0.000004 → '4 µs'. */
export function formatSeconds(s: number): string {
  if (s >= 1) return `${frenchNumber(s, 3)} s`;
  if (s >= 1e-3) return `${frenchNumber(s * 1e3, 3)} ms`;
  return `${frenchNumber(s * 1e6, 3)} µs`;
}

/** Clock frequency: 1_000_000 → '1 MHz', 32_768 → '32,768 kHz'. */
export function formatHz(hz: number): string {
  if (hz >= 1e6) return `${frenchNumber(hz / 1e6, 3)} MHz`;
  if (hz >= 1e3) return `${frenchNumber(hz / 1e3, 3)} kHz`;
  return `${frenchNumber(hz, 0)} Hz`;
}

/** Resistance as written on a schematic: 220 → '220 Ω', 10_000 → '10 kΩ', 1e6 → '1 MΩ'. */
export function formatOhms(ohms: number): string {
  if (ohms >= 1e6) return `${frenchNumber(ohms / 1e6, 2)} MΩ`;
  if (ohms >= 1e3) return `${frenchNumber(ohms / 1e3, 2)} kΩ`;
  return `${frenchNumber(ohms, 1)} Ω`;
}

/** « 1 cycle » / « 3 cycles ». */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${groupThousands(n)} ${n > 1 || n < -1 ? pluralForm : singular}`;
}

/** French list: ['a'] → 'a', ['a', 'b', 'c'] → 'a, b et c'. */
export function frenchList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} et ${items[items.length - 1]}`;
}

/** Lower-case, accents removed: for accent-insensitive search. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Instruction cycle time (one instruction cycle = 4 oscillator periods). */
export function cycleSeconds(clockHz: number): number {
  return 4 / clockHz;
}

/** « 1 cycle d’instruction = 4 µs à 1 MHz ». */
export function cycleSentence(clockHz: number): string {
  return `1 cycle d’instruction = 4 périodes d’horloge = ${formatSeconds(cycleSeconds(clockHz))} à ${formatHz(clockHz)}`;
}
