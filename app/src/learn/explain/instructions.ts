// French explanation of one executed PIC16F84A instruction, from its decoded word and the register values before
// (and, when known, after) it ran. Values are recomputed from the datasheet semantics (DS35007, Table 7-2), so the
// wording states WHY each flag has its value: for SUBWF / SUBLW, C and DC are NOT borrow (C = 1: no borrow).
import { decode, instructionInfo, type DecodedInstruction } from '@pic/emulator';
import type { PinName } from '@pic/emulator';
import {
  ADDR, bitName, fullAddress, INTERRUPT_SOURCE_TEXT, isGpr, NO_NAMING, pendingInterrupts, pinOfPortBit, portOfTris,
  readRegister, registerName, type CpuState, type Naming,
} from './cpu';
import { addrH, bin8, bitOf, hex2, plural } from './text';

export type FlagName = 'C' | 'DC' | 'Z' | 'TO' | 'PD';

export interface FlagNote {
  flag: FlagName;
  value: 0 | 1;
  /** Why the flag has this value (« C = 0 car il y a eu un emprunt (x < y) »). */
  why: string;
}

export interface InstructionExplanation {
  addr: number;
  /** Assembly text as the listing shows it ('SUBWF x, W'). */
  asm: string;
  mnemonic: string;
  /** What the instruction does in one line, with the values (« W ← x − W = 0x05 − 0x06 = 0xFF »). */
  summary: string;
  /** Further sentences (special registers, pins, jumps, pitfalls). */
  details: string[];
  flags: FlagNote[];
  /** Instruction cycles actually used (2 for jumps, calls, returns and taken skips). */
  cycles: number;
  /** For DECFSZ / INCFSZ / BTFSC / BTFSS: whether the next instruction is skipped. */
  skipped?: boolean;
  /** Glossary entries worth opening (ids of glossary.ts). */
  terms: string[];
}

export interface ExplainInstructionInput {
  addr: number;
  /** 14-bit program word executed. */
  word: number;
  /** Listing text of that address ('SUBWF x, W'); gives the compiler's names for operands and labels. */
  text?: string;
  before: CpuState;
  /** State after the instruction (used for the stack and the jump target of returns). */
  after?: CpuState | null;
  naming?: Naming;
  /** What W holds when the previous instruction loaded it from a register (« y » after MOVF y, W). */
  wSource?: string;
  /** Teaching names of the pins: 'RB1' → 'LED_EGAL (LED EGALITE)'. */
  pinLabel?: (pin: PinName) => string | undefined;
}

/** Operands of a listing line: 'SUBWF x, W' → ['x', 'W']; 'GOTO L_main_1' → ['L_main_1']. */
function listingOperands(text: string | undefined): string[] {
  if (!text) return [];
  const m = /^\s*[A-Za-z]+\s+(.*)$/.exec(text.split(';')[0]);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

const W_NAME = 'W';

const isStatusAddr = (addr: number) => addr === ADDR.STATUS || addr === 0x83;

interface Ctx {
  input: ExplainInstructionInput;
  ins: DecodedInstruction;
  naming: Naming;
  before: CpuState;
  /** Bank-mapped address of the register operand. */
  addr: number;
  /** Name of the register operand ('x', 'PORTB', 'INDF (…)'). */
  fname: string;
  /** Value of the register operand before the instruction. */
  fv: number;
  w: number;
  wLabel: string;
}

function makeContext(input: ExplainInstructionInput, ins: DecodedInstruction): Ctx {
  const naming = input.naming ?? NO_NAMING;
  const before = input.before;
  let addr = fullAddress(ins.f, before.status);
  let fname = registerName(addr, naming);
  const listed = listingOperands(input.text)[0];
  if (ins.f === 0 && (ins.form === 'f' || ins.form === 'fd' || ins.form === 'fb')) {
    // Indirect addressing: INDF is the register FSR points to.
    const fsr = readRegister(before, ADDR.FSR);
    addr = fsr;
    fname = `INDF (la case ${registerName(fsr, naming)} pointée par FSR = ${hex2(fsr)})`;
  } else if (listed && isGpr(addr) && /^[A-Za-z_]/.test(listed)) {
    fname = listed; // the compiler's own name ('_main.tmp+1', '__w_save')
  }
  const fv = ins.f === 0 && addr === 0 ? 0 : readRegister(before, addr);
  const wLabel = input.wSource ? `W (= ${input.wSource})` : W_NAME;
  return { input, ins, naming, before, addr, fname, fv, w: before.w & 0xff, wLabel };
}

const zNote = (r: number, extra = ''): FlagNote => ({
  flag: 'Z',
  value: r === 0 ? 1 : 0,
  why: r === 0 ? `Z = 1 car le résultat est nul${extra}.` : 'Z = 0 car le résultat n’est pas nul.',
});

function addFlags(a: number, b: number): FlagNote[] {
  const sum = a + b;
  const low = (a & 0xf) + (b & 0xf);
  return [
    {
      flag: 'C', value: sum > 0xff ? 1 : 0,
      why: sum > 0xff
        ? `C = 1 : dépassement, ${a} + ${b} = ${sum} ne tient pas sur 8 bits (> 255).`
        : `C = 0 : pas de dépassement (${a} + ${b} = ${sum} ≤ 255).`,
    },
    {
      flag: 'DC', value: low > 0xf ? 1 : 0,
      why: low > 0xf
        ? `DC = 1 : retenue du bit 3 vers le bit 4 (quartets bas ${a & 0xf} + ${b & 0xf} = ${low} > 15).`
        : `DC = 0 : pas de retenue entre les deux quartets (${a & 0xf} + ${b & 0xf} = ${low} ≤ 15).`,
    },
    zNote(sum & 0xff),
  ];
}

/** Flags of `minuend − subtrahend` (SUBWF: f − W, SUBLW: k − W). C and DC are NOT borrow. */
function subFlags(minuend: number, subtrahend: number, mName: string, sName: string): FlagNote[] {
  const r = (minuend - subtrahend) & 0xff;
  const noBorrow = minuend >= subtrahend;
  return [
    {
      flag: 'C', value: noBorrow ? 1 : 0,
      why: noBorrow
        ? `C = 1 car il n’y a pas eu d’emprunt (${mName} ≥ ${sName}). Attention : après une soustraction, C = 1 veut dire « pas d’emprunt ».`
        : `C = 0 car il y a eu un emprunt (${mName} < ${sName}).`,
    },
    {
      flag: 'DC', value: (minuend & 0xf) >= (subtrahend & 0xf) ? 1 : 0,
      why: (minuend & 0xf) >= (subtrahend & 0xf)
        ? `DC = 1 : pas d’emprunt sur le quartet bas (${minuend & 0xf} ≥ ${subtrahend & 0xf}).`
        : `DC = 0 : emprunt sur le quartet bas (${minuend & 0xf} < ${subtrahend & 0xf}).`,
    },
    zNote(r, r === 0 ? ` (donc ${mName} = ${sName})` : ''),
  ];
}

/** « 0x05 − 0x06 = 0xFF » plus the 8-bit wrap explanation when the true result is negative or above 255. */
function wrapDetail(op: '+' | '−', a: number, b: number): string | null {
  if (op === '+') {
    const sum = a + b;
    return sum > 0xff ? `${a} + ${b} = ${sum} ne tient pas sur 8 bits : le PIC garde ${sum} − 256 = ${sum & 0xff}.` : null;
  }
  const diff = a - b;
  return diff < 0 ? `${a} − ${b} = −${-diff} est négatif : sur 8 bits on obtient −${-diff} + 256 = ${diff & 0xff} (${hex2(diff)}).` : null;
}

function pinLabelText(input: ExplainInstructionInput, pin: PinName): string {
  const label = input.pinLabel?.(pin);
  return label ? `${pin} (${label})` : pin;
}

/** What a write of `value` to a special register means (PORT, TRIS, STATUS, INTCON, OPTION_REG, PCL, TMR0). */
function specialWriteDetails(c: Ctx, value: number): string[] {
  const out: string[] = [];
  const { addr, before, input } = c;
  if (addr === ADDR.PORTA || addr === ADDR.PORTB) {
    const port = addr === ADDR.PORTA ? 'PORTA' : 'PORTB';
    const tris = readRegister(before, addr === ADDR.PORTA ? ADDR.TRISA : ADDR.TRISB);
    const width = port === 'PORTA' ? 5 : 8;
    const outs: string[] = [];
    const ins: string[] = [];
    for (let b = 0; b < width; b++) {
      const pin = pinOfPortBit(port, b)!;
      if (bitOf(tris, b)) ins.push(pin);
      else outs.push(`${pinLabelText(input, pin)} = ${bitOf(value, b)}`);
    }
    out.push(`Écrire dans ${port} = ${bin8(value)} : chaque bit va sur une broche.`);
    if (outs.length) out.push(`Broches en sortie : ${outs.join(', ')}.`);
    if (ins.length) out.push(`${ins.join(', ')} ${ins.length > 1 ? 'sont des entrées' : 'est une entrée'} : le bit est mémorisé mais la broche n’est pas pilotée.`);
    if (port === 'PORTA' && !bitOf(tris, 4) && bitOf(value, 4)) out.push('RA4 est à drain ouvert : un 1 relâche la broche (elle ne fournit pas 5 V). Sans résistance de pull-up, une LED sur RA4 reste éteinte.');
  } else if (addr === ADDR.TRISA || addr === ADDR.TRISB) {
    const port = portOfTris(addr)!;
    const width = port === 'PORTA' ? 5 : 8;
    const ins: string[] = [];
    const outs: string[] = [];
    for (let b = 0; b < width; b++) (bitOf(value, b) ? ins : outs).push(pinOfPortBit(port, b)!);
    out.push(`${registerName(addr)} = ${bin8(value)} règle la direction des broches : bit à 1 = entrée (Input), bit à 0 = sortie (Output).`);
    if (outs.length) out.push(`Sorties : ${outs.join(', ')}.`);
    if (ins.length) out.push(`Entrées : ${ins.join(', ')}.`);
  } else if (isStatusAddr(addr)) {
    out.push(`STATUS reçoit ${bin8(value)} : RP0 = ${bitOf(value, 5)} (banque ${bitOf(value, 5)}). Les bits /TO et /PD sont en lecture seule et ne changent pas.`);
  } else if (addr === ADDR.INTCON || addr === 0x8b) {
    out.push(`INTCON = ${bin8(value)} : GIE = ${bitOf(value, 7)}, T0IE = ${bitOf(value, 5)}, INTE = ${bitOf(value, 4)}, RBIE = ${bitOf(value, 3)}.`);
  } else if (addr === ADDR.OPTION_REG) {
    out.push(`OPTION_REG = ${bin8(value)} : /RBPU = ${bitOf(value, 7)}, INTEDG = ${bitOf(value, 6)}, T0CS = ${bitOf(value, 5)}, PSA = ${bitOf(value, 3)}, PS2:PS0 = ${(value & 7).toString(2).padStart(3, '0')}.`);
  } else if (addr === ADDR.PCL || addr === 0x82) {
    out.push('Écrire dans PCL change le compteur ordinal (PC) : c’est un saut, il prend 2 cycles.');
  } else if (addr === ADDR.TMR0) {
    out.push('Écrire dans TMR0 relance le comptage à cette valeur (et remet le prédiviseur à zéro s’il est affecté à TMR0).');
  }
  return out;
}

/** BCF / BSF on a named bit: what that bit does. */
function bitWriteDetails(c: Ctx, bit: number, value: 0 | 1): { summary: string; details: string[]; terms: string[] } {
  const { addr, input, before } = c;
  const name = bitName(addr, bit);
  const reg = registerName(addr, c.naming);
  const details: string[] = [];
  const terms: string[] = [];
  let summary = `${reg}.${bit}${name ? ` (${name})` : ''} ← ${value}`;
  if (isStatusAddr(addr)) {
    terms.push('status');
    if (bit === 5) {
      terms.push('banque');
      summary = value
        ? 'RP0 ← 1 : passage en banque 1'
        : 'RP0 ← 0 : retour en banque 0';
      details.push(value
        ? 'En banque 1, les adresses 80h–FFh sont accessibles : TRISA (85h), TRISB (86h), OPTION_REG (81h). Le compilateur change de banque avant d’écrire dans un registre TRIS.'
        : 'En banque 0, on accède à PORTA (05h), PORTB (06h), TMR0, INTCON… et aux variables.');
    } else if (name) {
      details.push(`Le programme force le bit ${name} de STATUS à ${value}.`);
    }
  } else if (addr === ADDR.PORTA || addr === ADDR.PORTB) {
    const port = addr === ADDR.PORTA ? 'PORTA' : 'PORTB';
    const pin = pinOfPortBit(port, bit);
    if (pin) {
      terms.push(port === 'PORTA' ? 'porta' : 'portb');
      summary = `${pinLabelText(input, pin)} ← ${value}`;
      const tris = readRegister(before, port === 'PORTA' ? ADDR.TRISA : ADDR.TRISB);
      if (bitOf(tris, bit)) {
        details.push(`Mais ${pin} est une entrée (bit ${bit} de TRIS${port.slice(4)} = 1) : seul le registre de sortie change, la broche n’est pas pilotée.`);
      } else if (pin === 'RA4' && value === 1) {
        terms.push('open-drain');
        details.push('RA4 est à drain ouvert : écrire 1 relâche la broche (haute impédance), elle ne fournit pas 5 V. Il faut une résistance de pull-up pour obtenir un 1.');
      } else {
        details.push(value
          ? `La broche ${pin} passe à 1 (5 V) : ce qui y est branché reçoit du courant (une LED anode sur ${pin}, cathode à la masse, s’allume).`
          : `La broche ${pin} passe à 0 (0 V) : une LED anode sur ${pin}, cathode à la masse, s’éteint.`);
      }
      details.push(`${value ? 'BSF' : 'BCF'} relit tout le port puis le réécrit (lecture-modification-écriture) : les autres bits sont relus sur les broches puis réécrits. D’habitude ils ne changent pas, sauf une broche dont le niveau lu diffère de ce que le PIC lui a écrit (par exemple RA4 relâchée sans pull-up, qui se lit 0 et se retrouve forcée à 0).`);
      terms.push('lecture-modif');
    }
  } else if (addr === ADDR.TRISA || addr === ADDR.TRISB) {
    const port = portOfTris(addr)!;
    const pin = pinOfPortBit(port, bit);
    if (pin) {
      terms.push(port === 'PORTA' ? 'trisa' : 'trisb');
      summary = `${reg}.${bit} ← ${value} : ${pin} devient ${value ? 'une entrée' : 'une sortie'}`;
      details.push(`Règle du cours : bit TRIS à 1 = entrée (Input), à 0 = sortie (Output).${value ? '' : ` Le PIC pilote maintenant ${pin}.`}`);
    }
  } else if (addr === ADDR.INTCON || addr === 0x8b) {
    terms.push('intcon');
    const texts: Record<string, [string, string]> = {
      GIE: ['GIE ← 1 : les interruptions sont autorisées (interrupteur général).', 'GIE ← 0 : toutes les interruptions sont interdites.'],
      EEIE: ['EEIE ← 1 : interruption de fin d’écriture EEPROM autorisée.', 'EEIE ← 0 : interruption EEPROM interdite.'],
      T0IE: ['T0IE ← 1 : interruption de débordement de TMR0 autorisée.', 'T0IE ← 0 : interruption TMR0 interdite.'],
      INTE: ['INTE ← 1 : interruption externe RB0/INT autorisée.', 'INTE ← 0 : interruption RB0/INT interdite.'],
      RBIE: ['RBIE ← 1 : interruption sur changement de RB4 à RB7 autorisée.', 'RBIE ← 0 : interruption sur changement de RB4–RB7 interdite.'],
      T0IF: ['T0IF ← 1 : drapeau de débordement de TMR0 forcé.', 'T0IF ← 0 : on efface le drapeau de TMR0 (sinon l’interruption recommencerait tout de suite).'],
      INTF: ['INTF ← 1 : drapeau RB0/INT forcé.', 'INTF ← 0 : on efface le drapeau INTF (sinon l’interruption recommencerait dès le RETFIE).'],
      RBIF: ['RBIF ← 1 : drapeau de changement RB4–RB7 forcé.', 'RBIF ← 0 : on efface le drapeau RBIF (il faut avoir lu PORTB avant, sinon il revient aussitôt).'],
    };
    if (name && texts[name]) {
      summary = texts[name][value ? 0 : 1];
      if (name === 'GIE') terms.push('gie', 'interruption');
      if (name.endsWith('IF')) terms.push('drapeau');
    }
  } else if (addr === ADDR.OPTION_REG) {
    terms.push('option_reg');
    const texts: Record<string, [string, string]> = {
      RBPU: ['/RBPU ← 1 : résistances de pull-up internes de PORTB désactivées.', '/RBPU ← 0 : résistances de pull-up internes de PORTB activées (actif à 0).'],
      INTEDG: ['INTEDG ← 1 : l’interruption RB0/INT se déclenche sur un front montant (0 → 1).', 'INTEDG ← 0 : l’interruption RB0/INT se déclenche sur un front descendant (1 → 0).'],
      T0CS: ['T0CS ← 1 : TMR0 compte les fronts reçus sur RA4/T0CKI (mode compteur).', 'T0CS ← 0 : TMR0 compte les cycles d’instruction (mode temporisateur).'],
      T0SE: ['T0SE ← 1 : en mode compteur, TMR0 compte les fronts descendants de RA4.', 'T0SE ← 0 : en mode compteur, TMR0 compte les fronts montants de RA4.'],
      PSA: ['PSA ← 1 : le prédiviseur est affecté au chien de garde (TMR0 compte sans division).', 'PSA ← 0 : le prédiviseur est affecté à TMR0.'],
    };
    if (name && texts[name]) summary = texts[name][value ? 0 : 1];
    else if (name?.startsWith('PS')) summary = `${name} ← ${value} : choix du rapport du prédiviseur (PS2:PS0).`;
    if (name === 'INTEDG') terms.push('front');
    if (name === 'RBPU') terms.push('pull-up');
    if (name?.startsWith('PS') || name === 'PSA') terms.push('prediviseur');
  } else if (isGpr(addr)) {
    summary = `bit ${bit} de ${c.fname} ← ${value}`;
  }
  return { summary, details, terms };
}

/** Explanation of the forced interrupt entry (no instruction runs: PC pushed, GIE cleared, PC ← 0004h). */
export function explainInterruptEntry(before: CpuState, after?: CpuState | null): InstructionExplanation {
  const intcon = readRegister(before, ADDR.INTCON);
  const sources = pendingInterrupts(intcon, readRegister(before, ADDR.EECON1));
  const returnAddr = after?.stack.length ? after.stack[after.stack.length - 1] : before.pc;
  const why = sources.length
    ? `Cause : ${sources.map((s) => INTERRUPT_SOURCE_TEXT[s]).join(' ; ')}, avec GIE = 1.`
    : 'Un drapeau d’interruption et son autorisation sont à 1, avec GIE = 1.';
  return {
    addr: before.pc,
    asm: '(entrée en interruption)',
    mnemonic: 'INTERRUPTION',
    summary: `Interruption acceptée : adresse de retour ${addrH(returnAddr)} empilée, GIE ← 0, PC ← 0004h`,
    details: [
      why,
      `1) Le PIC empile l’adresse de la prochaine instruction (${addrH(returnAddr)}) pour pouvoir revenir.`,
      '2) Il met GIE à 0 : pas de nouvelle interruption pendant qu’on traite celle-ci.',
      '3) Il saute au vecteur d’interruption 0004h, où commence la fonction interrupt().',
      'Le PIC ne sauvegarde ni W ni STATUS : ce sont les premières instructions de interrupt() qui le font. RETFIE, à la fin, dépilera l’adresse et remettra GIE à 1.',
    ],
    flags: [],
    cycles: 2,
    terms: ['interruption', 'vecteur', 'pile', 'gie'],
  };
}

/** Explanation of the instruction at `input.addr` executed from `input.before`. */
export function explainInstruction(input: ExplainInstructionInput): InstructionExplanation {
  const word = input.word & 0x3fff;
  const ins = decode(word);
  const c = makeContext(input, ins);
  const m = ins.mnemonic ?? 'INVALID';
  const asm = input.text?.trim() || fallbackAsm(ins, c);
  const info = ins.mnemonic ? instructionInfo(ins.mnemonic) : undefined;
  const base = { addr: input.addr, asm, mnemonic: m, cycles: info?.cycles ?? 1 };
  const dest = ins.d ? c.fname : W_NAME;
  const destNote = ins.d ? `le résultat va dans ${c.fname} (d = F)` : `le résultat va dans W (d = W), ${c.fname} ne change pas`;
  const { fv, w, wLabel, fname } = c;
  const out = (summary: string, details: string[], flags: FlagNote[], terms: string[], extra: Partial<InstructionExplanation> = {}): InstructionExplanation =>
    ({ ...base, summary, details: details.filter(Boolean), flags, terms, ...extra });
  const writeDetails = (value: number) => (ins.d ? specialWriteDetails(c, value) : []);

  switch (m) {
    case 'ADDWF': {
      const r = (fv + w) & 0xff;
      return out(`${dest} ← ${fname} + ${wLabel} = ${hex2(fv)} + ${hex2(w)} = ${hex2(r)}`,
        [`Addition 8 bits : ${destNote}.`, wrapDetail('+', fv, w) ?? '', ...writeDetails(r)],
        addFlags(fv, w), ['w', 'status', 'carry']);
    }
    case 'SUBWF': {
      const r = (fv - w) & 0xff;
      return out(`${dest} ← ${fname} − ${wLabel} = ${hex2(fv)} − ${hex2(w)} = ${hex2(r)}`,
        [`Soustraction 8 bits (f − W) : ${destNote}.`, wrapDetail('−', fv, w) ?? '', ...writeDetails(r)],
        subFlags(fv, w, fname, input.wSource ?? W_NAME), ['w', 'status', 'carry']);
    }
    case 'ANDWF': case 'IORWF': case 'XORWF': {
      const r = m === 'ANDWF' ? fv & w : m === 'IORWF' ? fv | w : fv ^ w;
      const opName = m === 'ANDWF' ? 'ET' : m === 'IORWF' ? 'OU' : 'OU exclusif';
      return out(`${dest} ← ${fname} ${opName} ${wLabel} = ${hex2(r)}`,
        [`${opName} logique bit à bit : ${bin8(fv)} ${opName} ${bin8(w)} = ${bin8(r)} ; ${destNote}.`, ...writeDetails(r)],
        [zNote(r)], ['w', 'status']);
    }
    case 'CLRF': {
      if (isStatusAddr(c.addr)) {
        return out('IRP, RP1, RP0 ← 0 et Z ← 1 (C et DC inchangés)',
          ['CLRF met toujours Z à 1 : même en effaçant STATUS, on obtient Z = 1 à la fin. La fiche technique donne STATUS = 000u u1uu (u = inchangé).',
            'IRP, RP1 et RP0 passent à 0 (banque 0) ; C et DC gardent leur valeur (CLRF STATUS ne les efface pas) ; /TO et /PD sont en lecture seule et ne changent pas.'],
          [{ flag: 'Z', value: 1, why: 'Z = 1 : CLRF donne toujours un résultat nul.' }], ['status', 'banque']);
      }
      return out(`${fname} ← 0`, ['Met le registre à zéro.', ...specialWriteDetails(c, 0)],
        [{ flag: 'Z', value: 1, why: 'Z = 1 : CLRF donne toujours un résultat nul.' }], ['status']);
    }
    case 'CLRW':
      return out('W ← 0', ['Met W à zéro.'], [{ flag: 'Z', value: 1, why: 'Z = 1 : le résultat est nul.' }], ['w']);
    case 'COMF': {
      const r = ~fv & 0xff;
      return out(`${dest} ← complément de ${fname} = ${hex2(r)}`,
        [`Chaque bit est inversé : ${bin8(fv)} → ${bin8(r)} ; ${destNote}.`, ...writeDetails(r)], [zNote(r)], ['status']);
    }
    case 'DECF': case 'INCF': {
      const r = (fv + (m === 'INCF' ? 1 : -1)) & 0xff;
      const sign = m === 'INCF' ? '+' : '−';
      return out(`${dest} ← ${fname} ${sign} 1 = ${hex2(fv)} ${sign} 1 = ${hex2(r)}`,
        [`${m === 'INCF' ? 'Incrémente' : 'Décrémente'} de 1 ; ${destNote}.`,
          m === 'INCF' && fv === 0xff ? '255 + 1 donne 0 sur 8 bits. INCF ne modifie pas C, seulement Z.' : '',
          m === 'DECF' && fv === 0 ? '0 − 1 donne 255 (0xFF) sur 8 bits. DECF ne modifie pas C, seulement Z.' : '',
          ...writeDetails(r)],
        [zNote(r)], ['status']);
    }
    case 'DECFSZ': case 'INCFSZ': {
      const r = (fv + (m === 'INCFSZ' ? 1 : -1)) & 0xff;
      const sign = m === 'INCFSZ' ? '+' : '−';
      const skip = r === 0;
      return out(`${dest} ← ${fname} ${sign} 1 = ${hex2(r)} ; ${skip ? 'résultat nul → saute l’instruction suivante' : 'résultat non nul → continue'}`,
        [skip
          ? 'Le résultat vaut 0 : l’instruction suivante est sautée (remplacée par un NOP), donc 2 cycles. C’est la sortie de la boucle.'
          : 'Le résultat n’est pas 0 : on exécute l’instruction suivante (souvent un GOTO qui reboucle). C’est ainsi que Delay_ms fait attendre le PIC.',
          'Aucun drapeau n’est modifié.'],
        [], ['cycle'], { cycles: skip ? 2 : 1, skipped: skip });
    }
    case 'MOVF': {
      if (ins.d) {
        return out(`${fname} ← ${fname} (test : ${hex2(fv)})`,
          ['MOVF f, F recopie le registre sur lui-même : il ne change pas, mais Z indique s’il vaut zéro.'], [zNote(fv)], ['status']);
      }
      return out(`W ← ${fname} = ${hex2(fv)}`,
        [`Copie ${fname} dans W (l’accumulateur).`, fname === 'PORTA' || fname === 'PORTB' ? `Lire ${fname} donne le niveau des broches : ${bin8(fv)}.` : ''],
        [zNote(fv, ` (${fname} vaut 0)`)], ['w']);
    }
    case 'MOVWF':
      return out(`${fname} ← ${wLabel} = ${hex2(w)}`,
        [`Copie W dans ${fname}. Aucun drapeau n’est modifié.`, ...specialWriteDetails(c, w)], [], ['w']);
    case 'NOP':
      return out('Aucune opération', ['Ne fait rien pendant 1 cycle d’instruction.'], [], ['cycle']);
    case 'RLF': case 'RRF': {
      const carryIn = bitOf(c.before.status, 0);
      const r = m === 'RLF' ? ((fv << 1) | carryIn) & 0xff : (fv >> 1) | (carryIn << 7);
      const carryOut = m === 'RLF' ? bitOf(fv, 7) : bitOf(fv, 0);
      return out(`${dest} ← rotation ${m === 'RLF' ? 'à gauche' : 'à droite'} de ${fname} à travers C = ${hex2(r)}`,
        [`${bin8(fv)} avec C = ${carryIn} → ${bin8(r)} ; ${destNote}.`, ...writeDetails(r)],
        [{ flag: 'C', value: carryOut, why: `C = ${carryOut} : c’est le bit ${m === 'RLF' ? '7' : '0'} sorti de ${fname}.` }], ['carry']);
    }
    case 'SWAPF': {
      const r = ((fv << 4) | (fv >> 4)) & 0xff;
      return out(`${dest} ← quartets de ${fname} échangés = ${hex2(r)}`,
        [`${hex2(fv)} → ${hex2(r)} ; ${destNote}.`, 'SWAPF ne modifie aucun drapeau : c’est pour ça que la routine d’interruption l’utilise pour sauvegarder et restaurer STATUS.'],
        [], []);
    }
    case 'BCF': case 'BSF': {
      const value: 0 | 1 = m === 'BSF' ? 1 : 0;
      const b = bitWriteDetails(c, ins.b, value);
      // On a port the other bits are re-read from the pins (read-modify-write): « sans toucher » is only true elsewhere.
      const port = c.addr === ADDR.PORTA || c.addr === ADDR.PORTB;
      return out(b.summary, [`${m === 'BSF' ? 'Met à 1' : 'Met à 0'} le bit ${ins.b} de ${fname}${port ? '' : ', sans toucher aux autres bits'}. Aucun drapeau n’est modifié.`, ...b.details], [], b.terms);
    }
    case 'BTFSC': case 'BTFSS': {
      const bit = bitOf(fv, ins.b);
      const name = bitName(c.addr, ins.b);
      const label = name ? `${name} (bit ${ins.b} de ${fname})` : `le bit ${ins.b} de ${fname}`;
      const skip = m === 'BTFSC' ? bit === 0 : bit === 1;
      const meaning = m === 'BTFSC' ? 'saute l’instruction suivante si le bit vaut 0' : 'saute l’instruction suivante si le bit vaut 1';
      return out(`Teste ${label} = ${bit} → ${skip ? 'l’instruction suivante est sautée' : 'l’instruction suivante s’exécute'}`,
        [`${m} (« Bit Test f, Skip if ${m === 'BTFSC' ? 'Clear' : 'Set'} ») ${meaning}.`,
          skip ? 'Le saut coûte 2 cycles (un NOP remplace l’instruction sautée).' : '',
          'C’est ainsi que le compilateur traduit un if : le test choisit entre l’instruction suivante (souvent un GOTO vers le « sinon ») et celle d’après.'],
        [], isStatusAddr(c.addr) ? ['status'] : [], { cycles: skip ? 2 : 1, skipped: skip });
    }
    case 'ADDLW': {
      const k = ins.k;
      const r = (k + w) & 0xff;
      return out(`W ← ${hex2(k)} + ${wLabel} = ${hex2(k)} + ${hex2(w)} = ${hex2(r)}`,
        ['Addition du littéral k et de W.', wrapDetail('+', k, w) ?? ''], addFlags(k, w), ['w', 'carry']);
    }
    case 'SUBLW': {
      const k = ins.k;
      const r = (k - w) & 0xff;
      return out(`W ← ${hex2(k)} − ${wLabel} = ${hex2(k)} − ${hex2(w)} = ${hex2(r)}`,
        ['Attention à l’ordre : SUBLW calcule k − W (et non W − k).', wrapDetail('−', k, w) ?? ''],
        subFlags(k, w, String(k), input.wSource ?? W_NAME), ['w', 'carry']);
    }
    case 'ANDLW': case 'IORLW': case 'XORLW': {
      const k = ins.k;
      const r = m === 'ANDLW' ? k & w : m === 'IORLW' ? k | w : k ^ w;
      const opName = m === 'ANDLW' ? 'ET' : m === 'IORLW' ? 'OU' : 'OU exclusif';
      return out(`W ← ${wLabel} ${opName} ${hex2(k)} = ${hex2(r)}`,
        [`${opName} logique bit à bit : ${bin8(w)} ${opName} ${bin8(k)} = ${bin8(r)}.`], [zNote(r)], ['w']);
    }
    case 'MOVLW':
      return out(`W ← ${hex2(ins.k)} (${ins.k})`, ['Charge une valeur constante (un littéral) dans W. Aucun drapeau n’est modifié.'], [], ['w']);
    case 'CALL': {
      const label = listingOperands(input.text)[0];
      const ret = (input.addr + 1) & 0x1fff;
      const depth = (input.after?.stack.length ?? c.before.stack.length + 1);
      return out(`Appel du sous-programme ${label ?? addrH(ins.k)} : empile ${addrH(ret)}, PC ← ${addrH(ins.k)}`,
        [`L’adresse de retour ${addrH(ret)} est rangée dans la pile (${depth} niveau${depth > 1 ? 'x' : ''} occupé${depth > 1 ? 's' : ''} sur 8). RETURN la reprendra.`,
          'CALL prend 2 cycles. Au-delà de 8 appels imbriqués, la première adresse de retour serait perdue.'],
        [], ['pile', 'pc'], { cycles: 2 });
    }
    case 'GOTO': {
      const label = listingOperands(input.text)[0];
      if (ins.k === (input.addr & 0x7ff)) {
        return out('GOTO $ : le PIC saute sur lui-même',
          ['C’est la fin de main() : MikroC termine le programme par une boucle sur place. Le PIC « tourne » ici indéfiniment (seules les interruptions peuvent encore s’exécuter).'],
          [], ['pc'], { cycles: 2 });
      }
      return out(`Saut à ${label && label !== '$' ? `${label} (${addrH(ins.k)})` : addrH(ins.k)}`,
        ['GOTO charge l’adresse dans le compteur ordinal (PC) : l’exécution continue là-bas. 2 cycles. Rien n’est empilé (contrairement à CALL).'],
        [], ['pc'], { cycles: 2 });
    }
    case 'RETURN': case 'RETLW': case 'RETFIE': {
      const top = c.before.stack[c.before.stack.length - 1];
      const target = input.after?.pc ?? top;
      const where = target !== undefined ? addrH(target) : 'l’adresse en haut de la pile';
      if (m === 'RETLW') {
        return out(`W ← ${hex2(ins.k)} puis retour à ${where}`,
          ['RETLW renvoie une constante dans W en revenant du sous-programme (utile pour les tableaux en mémoire programme).'],
          [], ['pile', 'w'], { cycles: 2 });
      }
      if (m === 'RETFIE') {
        return out(`Retour d’interruption à ${where}, GIE ← 1`,
          [`Dépile l’adresse de retour ${where} : le programme reprend exactement où il avait été interrompu.`,
            'GIE repasse à 1 : les interruptions sont de nouveau autorisées.'],
          [], ['interruption', 'pile', 'gie'], { cycles: 2 });
      }
      return out(`Retour du sous-programme à ${where}`,
        [`Dépile l’adresse de retour ${where} (rangée par le CALL) : le programme reprend juste après l’appel.`], [], ['pile'], { cycles: 2 });
    }
    case 'SLEEP':
      return out('Mise en veille (SLEEP)',
        ['Le PIC s’arrête jusqu’à une interruption autorisée, un reset ou le chien de garde. Le chien de garde est remis à zéro.'],
        [{ flag: 'PD', value: 0, why: '/PD = 0 : le PIC est entré en veille.' }, { flag: 'TO', value: 1, why: '/TO = 1 : le chien de garde a été remis à zéro.' }],
        ['status']);
    case 'CLRWDT':
      return out('Remise à zéro du chien de garde (WDT)',
        ['Le programme prouve qu’il tourne normalement : le chien de garde repart de zéro et ne provoquera pas de reset.'],
        [{ flag: 'TO', value: 1, why: '/TO = 1 après CLRWDT.' }, { flag: 'PD', value: 1, why: '/PD = 1 après CLRWDT.' }], ['status']);
    case 'OPTION':
      return out(`OPTION_REG ← W = ${hex2(w)}`, ['Ancienne instruction (hors des 35 du PIC16F84A) : copie W dans OPTION_REG.'], [], ['option_reg']);
    case 'TRIS': {
      const target = ins.f === 6 ? 'TRISB' : 'TRISA';
      return out(`${target} ← W = ${hex2(w)}`, ['Ancienne instruction (hors des 35 du PIC16F84A) : copie W dans un registre TRIS.'], [], [target.toLowerCase()]);
    }
    default:
      return out('Code inconnu : exécuté comme un NOP', ['Ce mot de 14 bits ne correspond à aucune instruction : le PIC ne fait rien pendant 1 cycle.'], [], []);
  }
}

function fallbackAsm(ins: DecodedInstruction, c: Ctx): string {
  const m = ins.mnemonic ?? 'DW';
  switch (ins.form) {
    case 'none': return m;
    case 'f': return `${m} ${c.fname}`;
    case 'fd': return `${m} ${c.fname}, ${ins.d ? 'F' : 'W'}`;
    case 'fb': return `${m} ${c.fname}, ${bitName(c.addr, ins.b) ?? ins.b}`;
    case 'k8': return `${m} ${hex2(ins.k)}`;
    case 'k11': return `${m} ${addrH(ins.k)}`;
    case 'tris': return `${m} ${ins.f === 6 ? 'PORTB' : 'PORTA'}`;
  }
}

/**
 * Register whose value W holds after this instruction, for the « W (= y) » wording of the next one:
 * MOVF y, W → 'y'; MOVLW k → the literal; an instruction that changes W otherwise → undefined.
 */
export function wSourceAfter(word: number, before: CpuState, naming: Naming = NO_NAMING, text?: string, previous?: string): string | undefined {
  const ins = decode(word & 0x3fff);
  switch (ins.mnemonic) {
    case 'MOVF':
      if (ins.d) return previous;
      return listingOperands(text)[0] ?? registerName(fullAddress(ins.f, before.status), naming);
    case 'MOVLW':
      return String(ins.k);
    case 'MOVWF': case 'BCF': case 'BSF': case 'BTFSC': case 'BTFSS': case 'NOP': case 'GOTO': case 'CALL': case 'CLRWDT':
      return previous;
    case 'CLRF': case 'INCF': case 'DECF': case 'COMF': case 'RLF': case 'RRF': case 'SWAPF': case 'INCFSZ': case 'DECFSZ':
    case 'ADDWF': case 'SUBWF': case 'ANDWF': case 'IORWF': case 'XORWF':
      return ins.d ? previous : undefined;
    default:
      return undefined;
  }
}

/** Cycles text: « 1 cycle » / « 2 cycles ». */
export function cyclesText(n: number): string {
  return plural(n, 'cycle');
}
