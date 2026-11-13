// Special-function registers of the PIC16F84A (DS35007, Figure 2-2 and Table 2-1).
// Shared by the emulator, the disassembler, the compiler and the register view of the UI.

/** Bank-mapped 8-bit addresses (bank 1 = 0x80–0xFF, selected by STATUS.RP0). */
export const SFR = {
  INDF: 0x00,
  TMR0: 0x01,
  PCL: 0x02,
  STATUS: 0x03,
  FSR: 0x04,
  PORTA: 0x05,
  PORTB: 0x06,
  EEDATA: 0x08,
  EEADR: 0x09,
  PCLATH: 0x0a,
  INTCON: 0x0b,
  OPTION_REG: 0x81,
  TRISA: 0x85,
  TRISB: 0x86,
  EECON1: 0x88,
  EECON2: 0x89,
} as const;

export type SfrName = keyof typeof SFR;

/** First and last general-purpose RAM address (68 bytes); bank 1 0x8C–0xCF mirrors them. */
export const GPR_FIRST = 0x0c;
export const GPR_LAST = 0x4f;
export const GPR_COUNT = GPR_LAST - GPR_FIRST + 1;

export const STATUS_BITS = { C: 0, DC: 1, Z: 2, PD: 3, TO: 4, RP0: 5, RP1: 6, IRP: 7 } as const;
export const INTCON_BITS = { RBIF: 0, INTF: 1, T0IF: 2, RBIE: 3, INTE: 4, T0IE: 5, EEIE: 6, GIE: 7 } as const;
export const OPTION_BITS = { PS0: 0, PS1: 1, PS2: 2, PSA: 3, T0SE: 4, T0CS: 5, INTEDG: 6, RBPU: 7 } as const;
export const EECON1_BITS = { RD: 0, WR: 1, WREN: 2, WRERR: 3, EEIF: 4 } as const;
export const PORTA_BITS = { RA0: 0, RA1: 1, RA2: 2, RA3: 3, RA4: 4 } as const;
export const PORTB_BITS = { RB0: 0, RB1: 1, RB2: 2, RB3: 3, RB4: 4, RB5: 5, RB6: 6, RB7: 7 } as const;
export const TRISA_BITS = { TRISA0: 0, TRISA1: 1, TRISA2: 2, TRISA3: 3, TRISA4: 4 } as const;
export const TRISB_BITS = {
  TRISB0: 0, TRISB1: 1, TRISB2: 2, TRISB3: 3, TRISB4: 4, TRISB5: 5, TRISB6: 6, TRISB7: 7,
} as const;

/** Bit masks used by the core (same information as the *_BITS tables). */
export const STATUS_C = 0x01;
export const STATUS_DC = 0x02;
export const STATUS_Z = 0x04;
export const STATUS_PD = 0x08;
export const STATUS_TO = 0x10;
export const STATUS_RP0 = 0x20;

export const INTCON_RBIF = 0x01;
export const INTCON_INTF = 0x02;
export const INTCON_T0IF = 0x04;
export const INTCON_RBIE = 0x08;
export const INTCON_INTE = 0x10;
export const INTCON_T0IE = 0x20;
export const INTCON_EEIE = 0x40;
export const INTCON_GIE = 0x80;

export const OPTION_PS_MASK = 0x07;
export const OPTION_PSA = 0x08;
export const OPTION_T0SE = 0x10;
export const OPTION_T0CS = 0x20;
export const OPTION_INTEDG = 0x40;
export const OPTION_RBPU = 0x80;

export const EECON1_RD = 0x01;
export const EECON1_WR = 0x02;
export const EECON1_WREN = 0x04;
export const EECON1_WRERR = 0x08;
export const EECON1_EEIF = 0x10;

/** Configuration word (address 0x2007, Register 6-1). */
export const CONFIG_ADDRESS = 0x2007;
/** The prof's ISIS value: RC oscillator, WDT off, PWRT off, code protection off. */
export const DEFAULT_CONFIG = 0x3ffb;
export const CONFIG_FOSC_MASK = 0x0003;
export const CONFIG_WDTE = 0x0004;
export const CONFIG_PWRTE = 0x0008;

/** Program memory map. */
export const PROGRAM_WORDS = 1024;
export const RESET_VECTOR = 0x0000;
export const INTERRUPT_VECTOR = 0x0004;
export const EEPROM_BYTES = 64;
/** Data EEPROM as seen in a HEX file (word address). */
export const EEPROM_HEX_ADDRESS = 0x2100;
export const USER_ID_ADDRESS = 0x2000;

type BitNames = readonly [
  string | null, string | null, string | null, string | null,
  string | null, string | null, string | null, string | null,
];

export interface SfrInfo {
  name: SfrName;
  /** Canonical bank-mapped address. */
  addr: number;
  /** Every bank-mapped address where the register appears (canonical first). */
  addresses: readonly number[];
  /** Bit names, index = bit number; null = unimplemented or unnamed. */
  bits: BitNames;
  /** Bits that exist in silicon (unimplemented bits read 0). */
  implemented: number;
  /** Power-on reset value as printed in the datasheet (x = unknown, - = unimplemented). */
  por: string;
  /** Short description in French for the register view. */
  description: string;
}

const NO_BITS: BitNames = [null, null, null, null, null, null, null, null];

function bitsOf(table: Readonly<Record<string, number>>): BitNames {
  const out: (string | null)[] = [null, null, null, null, null, null, null, null];
  for (const [name, bit] of Object.entries(table)) out[bit] = name;
  return out as unknown as BitNames;
}

export const SFR_TABLE: readonly SfrInfo[] = [
  { name: 'INDF', addr: 0x00, addresses: [0x00, 0x80], bits: NO_BITS, implemented: 0xff, por: '---- ----',
    description: 'Adressage indirect (contenu de la case pointée par FSR)' },
  { name: 'TMR0', addr: 0x01, addresses: [0x01], bits: NO_BITS, implemented: 0xff, por: 'xxxx xxxx',
    description: 'Timer 0 (compteur 8 bits)' },
  { name: 'PCL', addr: 0x02, addresses: [0x02, 0x82], bits: NO_BITS, implemented: 0xff, por: '0000 0000',
    description: 'Octet bas du compteur ordinal (PC)' },
  { name: 'STATUS', addr: 0x03, addresses: [0x03, 0x83], bits: bitsOf(STATUS_BITS), implemented: 0xff, por: '0001 1xxx',
    description: "Registre d'état (C, DC, Z, PD, TO, RP0)" },
  { name: 'FSR', addr: 0x04, addresses: [0x04, 0x84], bits: NO_BITS, implemented: 0xff, por: 'xxxx xxxx',
    description: "Pointeur d'adressage indirect" },
  { name: 'PORTA', addr: 0x05, addresses: [0x05], bits: bitsOf(PORTA_BITS), implemented: 0x1f, por: '---x xxxx',
    description: 'Port A (RA0–RA4)' },
  { name: 'PORTB', addr: 0x06, addresses: [0x06], bits: bitsOf(PORTB_BITS), implemented: 0xff, por: 'xxxx xxxx',
    description: 'Port B (RB0–RB7)' },
  { name: 'EEDATA', addr: 0x08, addresses: [0x08], bits: NO_BITS, implemented: 0xff, por: 'xxxx xxxx',
    description: 'Donnée EEPROM' },
  { name: 'EEADR', addr: 0x09, addresses: [0x09], bits: NO_BITS, implemented: 0xff, por: 'xxxx xxxx',
    description: 'Adresse EEPROM' },
  { name: 'PCLATH', addr: 0x0a, addresses: [0x0a, 0x8a], bits: NO_BITS, implemented: 0x1f, por: '---0 0000',
    description: 'Bits hauts du PC (PC<12:8>) pour les écritures dans PCL, GOTO et CALL' },
  { name: 'INTCON', addr: 0x0b, addresses: [0x0b, 0x8b], bits: bitsOf(INTCON_BITS), implemented: 0xff, por: '0000 000x',
    description: 'Contrôle des interruptions' },
  { name: 'OPTION_REG', addr: 0x81, addresses: [0x81], bits: bitsOf(OPTION_BITS), implemented: 0xff, por: '1111 1111',
    description: 'Options : pull-up PORTB, front INT, Timer 0, prédiviseur' },
  { name: 'TRISA', addr: 0x85, addresses: [0x85], bits: bitsOf(TRISA_BITS), implemented: 0x1f, por: '---1 1111',
    description: 'Direction du port A (1 = entrée, 0 = sortie)' },
  { name: 'TRISB', addr: 0x86, addresses: [0x86], bits: bitsOf(TRISB_BITS), implemented: 0xff, por: '1111 1111',
    description: 'Direction du port B (1 = entrée, 0 = sortie)' },
  { name: 'EECON1', addr: 0x88, addresses: [0x88], bits: bitsOf(EECON1_BITS), implemented: 0x1f, por: '---0 x000',
    description: "Contrôle de l'EEPROM" },
  { name: 'EECON2', addr: 0x89, addresses: [0x89], bits: NO_BITS, implemented: 0x00, por: '---- ----',
    description: "Séquence de déverrouillage de l'écriture EEPROM (pas un registre physique)" },
];

const BY_ADDRESS: ReadonlyMap<number, SfrInfo> = new Map(
  SFR_TABLE.flatMap((info) => info.addresses.map((a) => [a, info] as const)),
);
const BY_NAME: ReadonlyMap<string, SfrInfo> = new Map(SFR_TABLE.map((info) => [info.name, info]));

/** Registers whose bits the disassembler names (flag registers); port bits stay numeric. */
export const NAMED_BIT_REGISTERS: ReadonlySet<SfrName> = new Set<SfrName>(['STATUS', 'INTCON', 'OPTION_REG', 'EECON1']);

/** SFR at a bank-mapped address (0x00–0xFF), including the bank-1 mirrors. */
export function sfrAt(addr: number): SfrInfo | undefined {
  return BY_ADDRESS.get(addr & 0xff);
}

export function sfrByName(name: string): SfrInfo | undefined {
  return BY_NAME.get(name.toUpperCase());
}

/** True for general-purpose RAM (0x0C–0x4F and its bank-1 mirror 0x8C–0xCF). */
export function isGpr(addr: number): boolean {
  const f = addr & 0x7f;
  return f >= GPR_FIRST && f <= GPR_LAST;
}

/** True for addresses that hold a register (SFR or GPR); everything else reads as 0. */
export function isImplemented(addr: number): boolean {
  const a = addr & 0xff;
  return isGpr(a) || (BY_ADDRESS.has(a) && a !== SFR.EECON2);
}

/** Name of bit `bit` of the register at `addr`, if the datasheet names it. */
export function bitName(addr: number, bit: number): string | undefined {
  return sfrAt(addr)?.bits[bit & 7] ?? undefined;
}

/** All named bits as `name → { register, bit }` (names are unique on the PIC16F84A). */
export const BIT_SYMBOLS: ReadonlyMap<string, { register: SfrName; bit: number }> = new Map(
  SFR_TABLE.flatMap((info) =>
    info.bits.flatMap((name, bit) => (name === null ? [] : [[name, { register: info.name, bit }] as const])),
  ),
);
