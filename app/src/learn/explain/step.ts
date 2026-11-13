// One « pas » of the debugger explained: which instruction(s) ran between two paused snapshots, why each flag has
// its value, what changed, and which pins the C code wrote (for the « Pourquoi ? » helper).
import type { ComponentVisual } from '@pic/circuit';
import type { ListingLine } from '@pic/compiler';
import type { PinName } from '@pic/emulator';
import { describeChanges, eepromChanges, type ChangeItem } from './changes';
import { NO_NAMING, type Naming } from './cpu';
import { explainInstruction, explainInterruptEntry, wSourceAfter, type InstructionExplanation } from './instructions';
import { isSingleInstruction, replayBetween, type ReplaySnapshot, type TraceStep } from './replay';
import { groupThousands } from './text';

export type StepKind = 'instruction' | 'interruption' | 'trace' | 'avance' | 'entree' | 'reset';

export interface StepExplanation {
  kind: StepKind;
  /** Instruction cycles between the two snapshots. */
  cycles: number;
  /** C line of the first executed instruction (numbered like the build's source). */
  line: number | null;
  /** The single instruction, the interrupt entry, or the last instruction of a replayed trace. */
  instruction: InstructionExplanation | null;
  /** Replayed instructions (first ones, then the last ones) when several ran. */
  trace: { count: number; omitted: number; first: InstructionExplanation[]; last: InstructionExplanation[] } | null;
  changes: ChangeItem[];
  /** Output pins written by the C code during this step, with the line that wrote them. */
  pinWrites: { pin: PinName; value: 0 | 1; line: number }[];
  /** One-line summary (« 1 instruction : SUBWF x, W — 1 cycle »). */
  summary: string;
  /** What W holds after the step, for the next explanation (« y »). */
  wSource?: string;
}

export interface StepInput {
  prev: ReplaySnapshot & { eeprom?: readonly number[] };
  cur: ReplaySnapshot & { eeprom?: readonly number[] };
  /** Program words of the build being simulated. */
  program: Uint16Array;
  listing: readonly ListingLine[];
  addrToLine: ReadonlyMap<number, number>;
  clockHz: number;
  config?: number;
  naming?: Naming;
  pinLabel?: (pin: PinName) => string | undefined;
  inputSource?: (pin: PinName) => string | undefined;
  partsBefore?: Readonly<Record<string, ComponentVisual>>;
  partsAfter?: Readonly<Record<string, ComponentVisual>>;
  partName?: (componentId: string) => string;
  /** What W held before the step (from the previous explanation). */
  wSource?: string;
}

const PORT_WRITE = /^(BSF|BCF)\s+(PORTA|PORTB)\s*,\s*(\d)\b|^(MOVWF|CLRF)\s+(PORTA|PORTB)\b|^[A-Z]+\s+(PORTA|PORTB)\s*,\s*F\b/i;

/** Pins of a listing instruction that writes a port: 'BSF PORTB, 1' → RB1; 'MOVWF PORTB' → every RB pin. */
export function portWriteOf(text: string | undefined): { port: 'PORTA' | 'PORTB'; bit: number | null } | null {
  if (!text) return null;
  const m = PORT_WRITE.exec(text.trim());
  if (!m) return null;
  if (m[1]) return { port: m[2].toUpperCase() as 'PORTA' | 'PORTB', bit: Number(m[3]) };
  if (m[4]) return { port: m[5].toUpperCase() as 'PORTA' | 'PORTB', bit: null };
  return { port: m[6].toUpperCase() as 'PORTA' | 'PORTB', bit: null };
}

function listingIndex(listing: readonly ListingLine[]): Map<number, string> {
  const m = new Map<number, string>();
  for (const l of listing) if (l.addr !== undefined && !m.has(l.addr)) m.set(l.addr, l.text);
  return m;
}

function pinWritesAt(addrs: Iterable<number>, texts: Map<number, string>, addrToLine: ReadonlyMap<number, number>, cur: ReplaySnapshot): StepExplanation['pinWrites'] {
  const out = new Map<PinName, { pin: PinName; value: 0 | 1; line: number }>();
  for (const addr of addrs) {
    const w = portWriteOf(texts.get(addr));
    const line = addrToLine.get(addr);
    if (!w || line === undefined) continue;
    const portAddr = w.port === 'PORTA' ? 0x05 : 0x06;
    const trisAddr = w.port === 'PORTA' ? 0x85 : 0x86;
    const width = w.port === 'PORTA' ? 5 : 8;
    const bits = w.bit === null ? Array.from({ length: width }, (_, i) => i) : [w.bit];
    for (const b of bits) {
      if (((cur.file[trisAddr] ?? 0xff) >> b) & 1) continue; // input pin: the write does not reach the pin
      const pin = `${w.port === 'PORTA' ? 'RA' : 'RB'}${b}` as PinName;
      out.set(pin, { pin, value: (((cur.file[portAddr] ?? 0) >> b) & 1) as 0 | 1, line });
    }
  }
  return [...out.values()];
}

function explainTraceStep(s: TraceStep, input: StepInput, texts: Map<number, string>, wSource: string | undefined): InstructionExplanation {
  if (s.interruptEntry) return explainInterruptEntry(s.before, s.after);
  return explainInstruction({ addr: s.addr, word: s.word, text: texts.get(s.addr), before: s.before, after: s.after, naming: input.naming, wSource, pinLabel: input.pinLabel });
}

/** Explain what happened between `input.prev` and `input.cur`. */
export function explainStep(input: StepInput): StepExplanation {
  const { prev, cur } = input;
  const naming = input.naming ?? NO_NAMING;
  const texts = listingIndex(input.listing);
  const cycles = cur.cycles - prev.cycles;
  const line = input.addrToLine.get(prev.pc) ?? null;
  const base = {
    naming, pinLabel: input.pinLabel, inputSource: input.inputSource,
    partsBefore: input.partsBefore, partsAfter: input.partsAfter, partName: input.partName,
  };

  if (cycles < 0 || (cur.cycles === 0 && cur.pc === 0 && prev.cycles > 0)) {
    return { kind: 'reset', cycles: 0, line: null, instruction: null, trace: null, changes: [], pinWrites: [], summary: 'Remise à zéro (reset) : le programme repart de l’adresse 0000h.' };
  }
  if (cycles === 0) {
    const changes = describeChanges(prev, cur, { ...base, inputOnly: true });
    return { kind: 'entree', cycles: 0, line: null, instruction: null, trace: null, changes, pinWrites: [], summary: 'Aucune instruction exécutée : une entrée a changé sur le schéma.', wSource: input.wSource };
  }
  if (cur.interruptEntry && cycles <= 4) {
    const instruction = { ...explainInterruptEntry(prev, cur), cycles };
    const changes = describeChanges(prev, cur, { ...base, interruptEntry: true });
    return { kind: 'interruption', cycles, line, instruction, trace: null, changes, pinWrites: [], summary: 'Entrée en interruption : saut au vecteur 0004h.' };
  }
  if (isSingleInstruction(input.program, prev, cur)) {
    const word = input.program[prev.pc & 0x3ff] & 0x3fff;
    const text = texts.get(prev.pc);
    const instruction = explainInstruction({ addr: prev.pc, word, text, before: prev, after: cur, naming, wSource: input.wSource, pinLabel: input.pinLabel });
    const changes = [...describeChanges(prev, cur, { ...base, mnemonic: instruction.mnemonic }), ...eepromChanges(prev.eeprom, cur.eeprom)];
    return {
      kind: 'instruction', cycles, line, instruction, trace: null, changes,
      pinWrites: pinWritesAt([prev.pc], texts, input.addrToLine, cur),
      summary: `1 instruction : ${instruction.asm} — ${cycles} cycle${cycles > 1 ? 's' : ''}`,
      wSource: wSourceAfter(word, prev, naming, text, input.wSource),
    };
  }
  const trace = replayBetween(input.program, prev, cur, { clockHz: input.clockHz, config: input.config });
  const changes = [...describeChanges(prev, cur, base), ...eepromChanges(prev.eeprom, cur.eeprom)];
  if (!trace) {
    return { kind: 'avance', cycles, line, instruction: null, trace: null, changes, pinWrites: [], summary: `${groupThousands(cycles)} cycles exécutés.` };
  }
  let w = input.wSource;
  const first = trace.first.map((s) => {
    const ex = explainTraceStep(s, input, texts, w);
    w = s.interruptEntry ? w : wSourceAfter(s.word, s.before, naming, texts.get(s.addr), w);
    return ex;
  });
  const complete = trace.omitted === 0;
  let wl = complete ? w : undefined;
  const last = trace.last.map((s) => {
    const ex = explainTraceStep(s, input, texts, wl);
    wl = s.interruptEntry ? wl : wSourceAfter(s.word, s.before, naming, texts.get(s.addr), wl);
    return ex;
  });
  const lastOne = last[last.length - 1] ?? first[first.length - 1] ?? null;
  return {
    kind: 'trace', cycles, line, instruction: lastOne,
    trace: { count: trace.count, omitted: trace.omitted, first, last },
    changes,
    pinWrites: pinWritesAt(trace.hits.keys(), texts, input.addrToLine, cur),
    summary: `${groupThousands(trace.count)} instruction${trace.count > 1 ? 's' : ''} — ${groupThousands(cycles)} cycle${cycles > 1 ? 's' : ''}`,
    wSource: trace.last.length ? wl : w,
  };
}
