// « Ce qui a changé » between two debugger snapshots, each change with the reason in French: registers, STATUS /
// INTCON / OPTION_REG / TRIS bits, pins, variables, the stack, and the parts drawn on the schematic (LEDs, display).
import type { ComponentVisual } from '@pic/circuit';
import type { PinName } from '@pic/emulator';
import {
  ADDR, bitName, GPR_FIRST, GPR_LAST, NO_NAMING, pinOfPortBit, registerName, type CpuState, type Naming,
} from './cpu';
import { addrH, bitOf, hex2 } from './text';

export type ChangeKind = 'w' | 'flag' | 'reg' | 'bit' | 'pin' | 'var' | 'stack' | 'eeprom' | 'part';

export interface ChangeItem {
  kind: ChangeKind;
  /** What changed: 'Z', 'RB1', 'x', 'W', 'LED EGALITE'. */
  label: string;
  from: string;
  to: string;
  /** Why it changed, in French. */
  why: string;
}

export interface ChangeContext {
  naming?: Naming;
  /** Teaching name of a pin ('LED_EGAL (LED EGALITE)'). */
  pinLabel?: (pin: PinName) => string | undefined;
  /** What drives an input pin from outside ('l’interrupteur LOGICSTATE L0'). */
  inputSource?: (pin: PinName) => string | undefined;
  /** Mnemonic of the single instruction that ran, when known. */
  mnemonic?: string;
  /** No instruction ran: the student changed an input while paused. */
  inputOnly?: boolean;
  /** The step was the interrupt entry. */
  interruptEntry?: boolean;
  /** Live visuals of the schematic parts before and after (SessionSnapshot.visuals). */
  partsBefore?: Readonly<Record<string, ComponentVisual>>;
  partsAfter?: Readonly<Record<string, ComponentVisual>>;
  /** Display name of a schematic part ('LED EGALITE'). */
  partName?: (componentId: string) => string;
}

const SUBTRACTIONS = new Set(['SUBWF', 'SUBLW']);
const ADDITIONS = new Set(['ADDWF', 'ADDLW']);

function flagWhy(flag: string, to: 0 | 1, ctx: ChangeContext): string {
  const m = ctx.mnemonic;
  switch (flag) {
    case 'C':
      if (m && SUBTRACTIONS.has(m)) return to ? 'pas d’emprunt dans la soustraction (C = 1 veut dire « pas d’emprunt »)' : 'la soustraction a demandé un emprunt (résultat négatif)';
      if (m && ADDITIONS.has(m)) return to ? 'dépassement : l’addition dépasse 255' : 'pas de dépassement dans l’addition';
      if (m === 'RLF' || m === 'RRF') return 'bit sorti par la rotation';
      if (m === 'BCF' || m === 'BSF' || m === 'CLRF' || m === 'MOVWF') return 'le programme écrit directement dans STATUS';
      return to ? 'retenue (addition) ou absence d’emprunt (soustraction) dans la dernière opération' : 'pas de retenue (addition) ou emprunt (soustraction) dans la dernière opération';
    case 'DC':
      if (m && SUBTRACTIONS.has(m)) return to ? 'pas d’emprunt sur le quartet bas' : 'emprunt sur le quartet bas (bits 0–3)';
      if (m && ADDITIONS.has(m)) return to ? 'retenue du bit 3 vers le bit 4' : 'pas de retenue entre les deux quartets';
      return 'retenue entre les quartets (bits 3 → 4) de la dernière opération';
    case 'Z':
      if (m === 'CLRF' || m === 'CLRW') return 'CLRF / CLRW donnent toujours zéro';
      return to ? 'le résultat de la dernière opération est nul' : 'le résultat de la dernière opération n’est pas nul';
    case 'RP0':
      return to ? 'banque 1 sélectionnée : accès à TRISA, TRISB, OPTION_REG' : 'retour en banque 0 : accès à PORTA, PORTB, aux variables';
    case 'TO':
      return to ? 'CLRWDT ou SLEEP remet /TO à 1' : 'le chien de garde (WDT) a débordé';
    case 'PD':
      return to ? 'CLRWDT remet /PD à 1' : 'l’instruction SLEEP a mis le PIC en veille';
    default:
      return 'modifié par le programme';
  }
}

function intconWhy(name: string, to: 0 | 1, prev: CpuState, ctx: ChangeContext): string {
  const option = prev.file[ADDR.OPTION_REG] ?? 0xff;
  switch (name) {
    case 'GIE':
      if (!to && ctx.interruptEntry) return 'en entrant dans l’interruption, le PIC interdit les autres interruptions';
      return to ? 'interruptions autorisées (RETFIE ou INTCON.GIE = 1)' : 'interruptions interdites';
    case 'INTF':
      return to ? `front ${bitOf(option, 6) ? 'montant' : 'descendant'} détecté sur RB0/INT` : 'drapeau effacé par le programme (INTCON.INTF = 0)';
    case 'RBIF':
      return to ? 'changement détecté sur une entrée RB4 à RB7' : 'drapeau effacé par le programme';
    case 'T0IF':
      return to ? 'TMR0 a débordé (255 → 0)' : 'drapeau effacé par le programme';
    case 'INTE': return to ? 'interruption RB0/INT autorisée' : 'interruption RB0/INT interdite';
    case 'RBIE': return to ? 'interruption sur changement de RB4–RB7 autorisée' : 'interruption RB4–RB7 interdite';
    case 'T0IE': return to ? 'interruption de TMR0 autorisée' : 'interruption de TMR0 interdite';
    case 'EEIE': return to ? 'interruption EEPROM autorisée' : 'interruption EEPROM interdite';
    default: return 'modifié par le programme';
  }
}

function optionWhy(name: string, to: 0 | 1): string {
  switch (name) {
    case 'RBPU': return to ? 'pull-up internes de PORTB désactivées' : 'pull-up internes de PORTB activées (actif à 0)';
    case 'INTEDG': return to ? 'RB0/INT réagit aux fronts montants' : 'RB0/INT réagit aux fronts descendants';
    case 'T0CS': return to ? 'TMR0 compte les fronts de RA4/T0CKI' : 'TMR0 compte les cycles d’instruction';
    case 'T0SE': return to ? 'comptage sur front descendant de RA4' : 'comptage sur front montant de RA4';
    case 'PSA': return to ? 'prédiviseur affecté au chien de garde' : 'prédiviseur affecté à TMR0';
    default: return 'rapport du prédiviseur (PS2:PS0)';
  }
}

const isInternal = (name: string) => name.startsWith('_') || name.includes('.');

/** Every difference between `prev` and `cur`, most meaningful first (parts, pins, variables, W, flags, others). */
export function describeChanges(prev: CpuState, cur: CpuState, ctx: ChangeContext = {}): ChangeItem[] {
  const naming = ctx.naming ?? NO_NAMING;
  const parts: ChangeItem[] = [];
  const pins: ChangeItem[] = [];
  const vars: ChangeItem[] = [];
  const core: ChangeItem[] = [];
  const others: ChangeItem[] = [];
  const at = (s: CpuState, a: number) => (s.file[a] ?? 0) & 0xff;

  // Parts of the schematic.
  if (ctx.partsBefore && ctx.partsAfter) {
    for (const [id, after] of Object.entries(ctx.partsAfter)) {
      const before = ctx.partsBefore[id];
      if (!before || before.kind !== after.kind) continue;
      const name = ctx.partName?.(id) ?? id;
      if (after.kind === 'LED' && before.kind === 'LED' && before.lit !== after.lit) {
        parts.push({ kind: 'part', label: name, from: before.lit ? 'allumée' : 'éteinte', to: after.lit ? 'allumée' : 'éteinte',
          why: after.lit ? 'sa broche lui envoie du courant' : 'sa broche ne lui envoie plus de courant' });
      } else if (after.kind === '7SEG-BCD' && before.kind === '7SEG-BCD' && before.value !== after.value) {
        // What the display shows: 0–9 then A b C d E F (lower-case b and d, as on the segments).
        const glyph = (v: number | null) => (v === null ? '?' : v < 10 ? String(v) : 'AbCdEF'[v - 10] ?? '?');
        parts.push({ kind: 'part', label: name, from: glyph(before.value), to: glyph(after.value), why: 'les 4 bits E3..E0 reçus du PIC ont changé' });
      } else if (after.kind === 'TRAFFIC_LIGHTS' && before.kind === 'TRAFFIC_LIGHTS') {
        for (const [key, fr] of [['red', 'rouge'], ['amber', 'orange'], ['green', 'vert']] as const) {
          if (before[key] !== after[key]) parts.push({ kind: 'part', label: `${name} : feu ${fr}`, from: before[key] ? 'allumé' : 'éteint', to: after[key] ? 'allumé' : 'éteint', why: 'sa broche a changé de niveau' });
        }
      }
    }
  }

  // Ports and TRIS.
  for (const [port, tris] of [[ADDR.PORTA, ADDR.TRISA], [ADDR.PORTB, ADDR.TRISB]] as const) {
    const portName = port === ADDR.PORTA ? 'PORTA' : 'PORTB';
    const width = port === ADDR.PORTA ? 5 : 8;
    for (let b = 0; b < width; b++) {
      const pin = pinOfPortBit(portName, b)!;
      const tb = bitOf(at(prev, tris), b);
      const ta = bitOf(at(cur, tris), b);
      if (tb !== ta) {
        others.push({ kind: 'bit', label: `${registerName(tris)}.${b}`, from: String(tb), to: String(ta), why: `${pin} devient ${ta ? 'une entrée' : 'une sortie'} (1 = entrée, 0 = sortie)` });
      }
      const vb = bitOf(at(prev, port), b);
      const va = bitOf(at(cur, port), b);
      if (vb === va) continue;
      const label = ctx.pinLabel?.(pin);
      const source = ctx.inputSource?.(pin);
      let why: string;
      if (ta) {
        why = ctx.inputOnly
          ? `entrée : vous avez changé ${source ?? 'ce qui est branché dessus'}`
          : `entrée : niveau imposé par l’extérieur${source ? ` (${source})` : ''}`;
      } else {
        why = `sortie écrite par le programme${label ? ` → ${label}` : ''}`;
        if (pin === 'RA4' && va === 1) why += ' (RA4 à drain ouvert : le 1 vient de l’extérieur)';
      }
      pins.push({ kind: 'pin', label: pin, from: String(vb), to: String(va), why });
    }
  }

  // Variables (GPR).
  for (let a = GPR_FIRST; a <= GPR_LAST; a++) {
    const vb = at(prev, a);
    const va = at(cur, a);
    if (vb === va) continue;
    const name = naming.variable(a) ?? hex2(a);
    const internal = isInternal(name);
    (internal ? others : vars).push({
      kind: 'var', label: name, from: `${vb} (${hex2(vb)})`, to: `${va} (${hex2(va)})`,
      why: internal ? 'variable interne du compilateur (compteur de temporisation, sauvegarde…)' : `la variable ${name} a reçu une nouvelle valeur`,
    });
  }

  // W and STATUS.
  if ((prev.w & 0xff) !== (cur.w & 0xff)) {
    core.push({ kind: 'w', label: 'W', from: hex2(prev.w), to: hex2(cur.w), why: ctx.mnemonic ? `résultat de ${ctx.mnemonic} rangé dans l’accumulateur W` : 'l’accumulateur W a été utilisé par les calculs' });
  }
  const statusDiff = (prev.status ^ cur.status) & 0xff;
  for (let b = 7; b >= 0; b--) {
    if (!bitOf(statusDiff, b)) continue;
    const name = bitName(ADDR.STATUS, b) ?? String(b);
    const to = bitOf(cur.status, b);
    const label = name === 'TO' || name === 'PD' ? `/${name}` : name;
    core.push({ kind: 'flag', label, from: String(bitOf(prev.status, b)), to: String(to), why: flagWhy(name, to, ctx) });
  }

  // INTCON and OPTION_REG bits.
  for (const [addr, why] of [[ADDR.INTCON, intconWhy], [ADDR.OPTION_REG, null]] as const) {
    const diff = at(prev, addr) ^ at(cur, addr);
    for (let b = 7; b >= 0; b--) {
      if (!bitOf(diff, b)) continue;
      const name = bitName(addr, b) ?? String(b);
      const to = bitOf(at(cur, addr), b);
      others.push({
        kind: 'bit', label: `${registerName(addr)}.${name === 'RBPU' ? '/RBPU' : name}`, from: String(bitOf(at(prev, addr), b)), to: String(to),
        why: why ? why(name, to, prev, ctx) : optionWhy(name, to),
      });
    }
  }

  // Other special registers, whole.
  for (const addr of [ADDR.TMR0, ADDR.FSR, ADDR.PCLATH, ADDR.EEDATA, ADDR.EEADR, ADDR.EECON1]) {
    const vb = at(prev, addr);
    const va = at(cur, addr);
    if (vb === va) continue;
    const why = addr === ADDR.TMR0 ? 'TMR0 compte tout seul (temporisateur / compteur)' : addr === ADDR.FSR ? 'pointeur d’adressage indirect modifié' : 'modifié par le programme';
    others.push({ kind: 'reg', label: registerName(addr), from: hex2(vb), to: hex2(va), why });
  }

  // Stack.
  if (cur.stack.length > prev.stack.length) {
    const pushed = cur.stack[cur.stack.length - 1];
    core.push({ kind: 'stack', label: 'Pile', from: `${prev.stack.length} niveau(x)`, to: `${cur.stack.length} niveau(x)`,
      why: `${ctx.interruptEntry ? 'entrée en interruption' : 'appel (CALL)'} : l’adresse de retour ${addrH(pushed)} est empilée` });
  } else if (cur.stack.length < prev.stack.length) {
    const popped = prev.stack[prev.stack.length - 1];
    core.push({ kind: 'stack', label: 'Pile', from: `${prev.stack.length} niveau(x)`, to: `${cur.stack.length} niveau(x)`,
      why: `retour (RETURN / RETFIE) : l’adresse ${addrH(popped)} est dépilée` });
  }

  return [...parts, ...pins, ...vars, ...core, ...others];
}

/** EEPROM bytes that changed (index, before, after). */
export function eepromChanges(prev: readonly number[] | undefined, cur: readonly number[] | undefined): ChangeItem[] {
  if (!prev || !cur) return [];
  const out: ChangeItem[] = [];
  for (let i = 0; i < Math.min(prev.length, cur.length); i++) {
    if (prev[i] !== cur[i]) out.push({ kind: 'eeprom', label: `EEPROM[${i}]`, from: hex2(prev[i]), to: hex2(cur[i]), why: 'écriture en EEPROM terminée (la valeur reste même sans alimentation)' });
  }
  return out;
}
