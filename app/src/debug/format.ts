// Number and time formatting shared by the Assembleur / registres panel (and reusable by other panels).
// Everything here is pure so it can be unit-tested without a DOM.

/** Upper-case hexadecimal, zero-padded, without prefix: hex(0x4, 3) → '004'. */
export function hex(value: number, digits: number): string {
  const v = Math.max(0, Math.trunc(value));
  return v.toString(16).toUpperCase().padStart(digits, '0');
}

/** C-style hex as the prof writes it: hex0x(6) → '0x06' (lower-case x, upper-case digits). */
export function hex0x(value: number, digits = 2): string {
  return `0x${hex(value, digits)}`;
}

/** Course / datasheet address notation: hexH(4) → '0004h'. */
export function hexH(value: number, digits = 4): string {
  return `${hex(value, digits)}h`;
}

/** Binary digits, MSB first: bin(6) → '00000110'. */
export function bin(value: number, width = 8): string {
  const mask = width >= 32 ? 0xffffffff : (1 << width) - 1;
  return ((value & mask) >>> 0).toString(2).padStart(width, '0');
}

/** Binary grouped by nibbles for readability: binGrouped(6) → '0000 0110'. */
export function binGrouped(value: number, width = 8): string {
  const s = bin(value, width);
  const out: string[] = [];
  for (let end = s.length; end > 0; end -= 4) out.unshift(s.slice(Math.max(0, end - 4), end));
  return out.join(' ');
}

/** Value of bit `bit` (0 or 1). */
export function bitOf(value: number, bit: number): 0 | 1 {
  return ((value >> bit) & 1) as 0 | 1;
}

/** Narrow no-break space, the French thousands separator. */
const THIN = ' ';

/** Integer with French digit grouping: groupThousands(1234567) → '1 234 567' (narrow no-break spaces). */
export function groupThousands(n: number): string {
  const neg = n < 0;
  const digits = Math.abs(Math.trunc(n)).toString();
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += THIN;
    out += digits[i];
  }
  return neg ? `-${out}` : out;
}

/** Decimal with a French comma and at most `decimals` digits, trailing zeros trimmed: 1.50 → '1,5'. */
export function frenchDecimal(x: number, decimals: number): string {
  const fixed = Math.abs(x).toFixed(decimals);
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  const [int, frac] = trimmed.split('.');
  const sign = x < 0 && trimmed !== '0' ? '-' : '';
  const grouped = groupThousands(Number(int));
  return frac ? `${sign}${grouped},${frac}` : `${sign}${grouped}`;
}

/** Simulated time in the most readable unit: 0 → '0 s', 4e-6 → '4 µs', 0.0125 → '12,5 ms', 2.5 → '2,5 s'. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 s';
  if (seconds < 1e-3) return `${frenchDecimal(seconds * 1e6, 1)} µs`;
  if (seconds < 1) return `${frenchDecimal(seconds * 1e3, 3)} ms`;
  return `${frenchDecimal(seconds, 3)} s`;
}

/** Clock frequency: 1_000_000 → '1 MHz', 32768 → '32,768 kHz'. */
export function formatClock(hz: number): string {
  if (hz >= 1e6) return `${frenchDecimal(hz / 1e6, 3)} MHz`;
  if (hz >= 1e3) return `${frenchDecimal(hz / 1e3, 3)} kHz`;
  return `${frenchDecimal(hz, 0)} Hz`;
}

/** Instruction cycle time (4 oscillator periods) for a clock: 1 MHz → '4 µs'. */
export function formatCycleTime(clockHz: number): string {
  return formatTime(4 / clockHz);
}

/** French plural helper: plural(2, 'erreur') → '2 erreurs'. */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${Math.abs(n) >= 2 ? pluralForm : singular}`;
}
