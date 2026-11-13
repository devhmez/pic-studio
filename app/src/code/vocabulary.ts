// MikroC vocabulary for the PIC16F84A (register names, bit selectors, built-ins, keywords) and the pure tokenizer
// used by the editor overlay and autocomplete. No CodeMirror imports: unit-tested in Node.
import { BIT_NAMES, SFRS } from '@pic/compiler';

// ---------------------------------------------------------------------------------------------------------------
// Vocabulary

/** Upper-case SFR names of the PIC16F84A plus the MikroC aliases. */
export const SFR_NAMES: ReadonlySet<string> = new Set([...SFRS.map((s) => s.name), 'OPTION', 'EEDAT']);

/** Predefined bit names (upper-case), e.g. RA0, RB3, Z, C, GIE, T0IF, NOT_PD. */
export const BIT_NAME_SET: ReadonlySet<string> = new Set(BIT_NAMES.keys());

export interface BuiltinInfo {
  name: string;
  signature: string;
  /** French one-line description. */
  doc: string;
  /** CodeMirror snippet template (`${}` fields). */
  snippet: string;
}

export const BUILTINS: readonly BuiltinInfo[] = [
  { name: 'Delay_ms', signature: 'void Delay_ms(const unsigned long ms)', doc: 'Attente de ms millisecondes (constante). Calibrée sur l’horloge du projet.', snippet: 'Delay_ms(${500});' },
  { name: 'Delay_us', signature: 'void Delay_us(const unsigned long us)', doc: 'Attente de us microsecondes (constante).', snippet: 'Delay_us(${100});' },
  { name: 'Vdelay_ms', signature: 'void Vdelay_ms(unsigned int ms)', doc: 'Attente de ms millisecondes, ms pouvant être une variable (moins précis).', snippet: 'Vdelay_ms(${duree});' },
  { name: 'Delay_Cyc', signature: 'void Delay_Cyc(char cycles_div_10)', doc: 'Attente de 10 × n cycles machine.', snippet: 'Delay_Cyc(${10});' },
  { name: 'Button', signature: 'unsigned short Button(unsigned short *port, unsigned short pin, unsigned short time, unsigned short active_state)', doc: 'Lit un bouton avec anti-rebond : renvoie 255 si la broche est à l’état actif pendant « time » ms.', snippet: 'Button(&${PORTB}, ${0}, ${10}, ${1})' },
  { name: 'EEPROM_Read', signature: 'unsigned short EEPROM_Read(unsigned short address)', doc: 'Lit un octet de l’EEPROM de données (adresse 0 à 63).', snippet: 'EEPROM_Read(${adresse})' },
  { name: 'EEPROM_Write', signature: 'void EEPROM_Write(unsigned short address, unsigned short data)', doc: 'Écrit un octet dans l’EEPROM de données (adresse 0 à 63, environ 4 ms).', snippet: 'EEPROM_Write(${adresse}, ${valeur});' },
  { name: 'Clock_kHz', signature: 'unsigned Clock_kHz()', doc: 'Fréquence d’horloge du projet en kHz.', snippet: 'Clock_kHz()' },
  { name: 'Clock_MHz', signature: 'unsigned short Clock_MHz()', doc: 'Fréquence d’horloge du projet en MHz.', snippet: 'Clock_MHz()' },
  { name: 'Lo', signature: 'Lo(nombre)', doc: 'Octet de poids faible (bits 0–7).', snippet: 'Lo(${x})' },
  { name: 'Hi', signature: 'Hi(nombre)', doc: 'Deuxième octet (bits 8–15).', snippet: 'Hi(${x})' },
  { name: 'swap', signature: 'unsigned short swap(unsigned short x)', doc: 'Échange les deux demi-octets (SWAPF).', snippet: 'swap(${x})' },
];

const BUILTIN_SET: ReadonlySet<string> = new Set(BUILTINS.map((b) => b.name.toUpperCase()));

/** MikroC keywords that plain C does not have. */
export const MIKROC_KEYWORDS: readonly string[] = ['sbit', 'absolute', 'interrupt', 'bit', 'sfr', 'at', 'code', 'org'];

// ---------------------------------------------------------------------------------------------------------------
// Token classification (pure, unit-tested)

export type PicTokenKind = 'sfr' | 'bit' | 'builtin' | 'keyword';

export interface PicToken {
  from: number;
  to: number;
  kind: PicTokenKind;
}

/** True when `sel` is a valid bit selector after a dot: F0–F31, B0–B31 or a predefined bit name. */
export function isBitSelector(sel: string): boolean {
  if (/^[FB][0-9]{1,2}$/i.test(sel)) return Number(sel.slice(1)) <= 31;
  return BIT_NAME_SET.has(sel.toUpperCase());
}

const WORD_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * MikroC-specific tokens of a text slice (offsets relative to `text`). Identifiers are case-insensitive in MikroC,
 * so `portb` is PORTB. `at` only counts inside an `sbit … at` declaration.
 */
export function scanPicTokens(text: string): PicToken[] {
  const out: PicToken[] = [];
  WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(text))) {
    const word = m[0];
    const from = m.index;
    const to = from + word.length;
    const upper = word.toUpperCase();
    let before = from - 1;
    while (before >= 0 && (text[before] === ' ' || text[before] === '\t')) before--;
    const afterDot = before >= 0 && text[before] === '.';
    const afterHash = before >= 0 && text[before] === '#';
    if (afterHash) continue;
    if (afterDot) {
      if (isBitSelector(word)) out.push({ from, to, kind: 'bit' });
      continue;
    }
    if (SFR_NAMES.has(upper) || (upper.endsWith('BITS') && SFR_NAMES.has(upper.slice(0, -4)))) {
      out.push({ from, to, kind: 'sfr' });
    } else if (upper.endsWith('_BIT') && BIT_NAME_SET.has(upper.slice(0, -4))) {
      out.push({ from, to, kind: 'bit' });
    } else if (BUILTIN_SET.has(upper)) {
      out.push({ from, to, kind: 'builtin' });
    } else if (word === 'at') {
      if (/\bsbit\s+[A-Za-z_]\w*\s*$/.test(text.slice(Math.max(0, from - 80), from))) out.push({ from, to, kind: 'keyword' });
    } else if (MIKROC_KEYWORDS.includes(word)) {
      out.push({ from, to, kind: 'keyword' });
    }
  }
  return out;
}
