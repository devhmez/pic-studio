// Engineering-notation values as typed in ISIS property fields ("220", "10k", "4k7", "1M", "8MHz", "0.1m").

/**
 * SI multipliers. Case matters like in Proteus: `M` is mega, `m` is milli
 * (the prof's files use `R(0)=1M` for 1 MΩ, `CLOCK=1MHz`, `WDT_PERIOD=18m` for 18 ms).
 */
const MULTIPLIERS: Readonly<Record<string, number>> = {
  T: 1e12, G: 1e9, M: 1e6, k: 1e3, K: 1e3,
  m: 1e-3, u: 1e-6, 'µ': 1e-6, n: 1e-9, p: 1e-12,
};

const VALUE_RE = /^([+-]?\d*(?:\.\d*)?)(?:([TGMkKmuµnp])(\d*))?(?:R|Ω|ohms?|Hz|F|H|V|A|s)?$/;
const RKM_RE = /^(\d+)R(\d*)$/; // "4R7" = 4.7 Ω

/** Parse an engineering value. Returns null when the text is not a number. */
export function parseValue(text: string): number | null {
  const s = text.trim().replace(/\s+/g, '');
  if (s === '') return null;
  const rkm = RKM_RE.exec(s);
  if (rkm) return Number(`${rkm[1]}.${rkm[2] || '0'}`);
  // "MEG" (SPICE spelling) is accepted as mega.
  const normalized = s.replace(/meg/i, 'M');
  const m = VALUE_RE.exec(normalized);
  if (!m) return null;
  const [, mantissa, prefix, fraction] = m;
  if (mantissa === '' || mantissa === '+' || mantissa === '-' || mantissa === '.') return null;
  if (fraction && mantissa.includes('.')) return null; // "4.7k7" is ambiguous
  const base = fraction ? Number(`${mantissa}.${fraction}`) : Number(mantissa);
  if (!Number.isFinite(base)) return null;
  const mult = prefix ? MULTIPLIERS[prefix] : 1;
  return base * mult;
}

/** Resistance in ohms, or null when the value cannot be read or is not positive. */
export function parseResistance(text: string | number | undefined): number | null {
  if (text === undefined) return null;
  const v = typeof text === 'number' ? text : parseValue(text);
  return v !== null && v > 0 ? v : null;
}

/** Frequency in hertz ("1MHz", "8MHz", "20MHz", "32768"). */
export function parseFrequency(text: string | number | undefined): number | null {
  if (text === undefined) return null;
  const v = typeof text === 'number' ? text : parseValue(text);
  return v !== null && v > 0 ? v : null;
}

/** Format a value the way ISIS shows it: 220, 1k, 10k, 4k7, 1M, 8MHz. */
export function formatValue(value: number, unit = ''): string {
  const steps: [number, string][] = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, '']];
  for (const [mult, prefix] of steps) {
    if (Math.abs(value) >= mult) {
      const scaled = Math.round((value / mult) * 1000) / 1000;
      return `${scaled}${prefix}${unit}`;
    }
  }
  return `${value}${unit}`;
}
