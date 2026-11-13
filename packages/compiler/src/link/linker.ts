import type { ListingLine, SymbolInfo } from '../api';
import type { FileRef, Instr, Lit } from '../codegen/ir';
import { encodeBit, encodeFile, encodeJump, encodeLit, encodeNoArg, SKIP_OPS } from '../codegen/isa';
import type { GeneratedProgram } from '../codegen/program';
import type { CodeUnit } from '../codegen/units';
import { PROGRAM_WORDS, STACK_LEVELS } from '../device';
import { Codes, type DiagnosticBag } from '../diagnostics';
import { CallGraph } from './callgraph';
import { instrText } from './format';
import { allocateRam } from './ram';

type RealInstr = Exclude<Instr, { t: 'label' }>;

export interface LinkResult {
  ok: boolean;
  program: Uint16Array;
  /** Which program words are used. */
  used: boolean[];
  listing: ListingLine[];
  addrToLine: Map<number, number>;
  lineToAddr: Map<number, number>;
  symbols: SymbolInfo[];
  romWords: number;
  ramBytes: number;
  /** Worst-case hardware stack levels (main path + interrupt). */
  stackDepth: number;
}

interface Placed {
  addr: number;
  instr: RealInstr;
  labels: string[];
}

/**
 * Flag-neutral clean-ups only (GOTO never touches STATUS):
 * - `GOTO L` where L holds `GOTO M` becomes `GOTO M` (jump threading);
 * - `GOTO L` immediately followed by `L:` is removed (never right after a skip, which would change its meaning).
 */
function peephole(code: Instr[]): Instr[] {
  const out = [...code];
  const firstInstrAt = new Map<string, RealInstr>();
  for (let i = 0; i < out.length; i++) {
    const ins = out[i];
    if (ins.t !== 'label') continue;
    let j = i + 1;
    while (j < out.length && out[j].t === 'label') j++;
    if (j < out.length) firstInstrAt.set(ins.name, out[j] as RealInstr);
  }
  for (let i = 0; i < out.length; i++) {
    const ins = out[i];
    if (ins.t !== 'jump' || ins.op !== 'GOTO' || typeof ins.target !== 'string') continue;
    let target: string = ins.target;
    const seen = new Set<string>([target]);
    for (;;) {
      const at = firstInstrAt.get(target);
      if (!at || at.t !== 'jump' || at.op !== 'GOTO' || typeof at.target !== 'string' || seen.has(at.target)) break;
      target = at.target;
      seen.add(target);
    }
    if (target !== ins.target) out[i] = { ...ins, target };
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const ins = out[i];
      if (ins.t !== 'jump' || ins.op !== 'GOTO' || typeof ins.target !== 'string') continue;
      let prev = i - 1;
      while (prev >= 0 && out[prev].t === 'label') prev--;
      const p = out[prev];
      if (p && p.t !== 'label' && SKIP_OPS.has(p.op)) continue;
      let j = i + 1;
      let hit = false;
      while (j < out.length && out[j].t === 'label') {
        if ((out[j] as { name: string }).name === ins.target) hit = true;
        j++;
      }
      if (hit) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

export function link(gp: GeneratedProgram, lineText: (line: number) => string, diags: DiagnosticBag): LinkResult {
  const graph = new CallGraph(gp.units, gp.resetUnit, gp.isrUnit);

  // Hardware stack: 8 levels shared by the main line and the interrupt (which itself pushes one return address).
  const mainDepth = graph.depth(gp.resetUnit);
  const isrDepth = gp.isrUnit ? 1 + graph.depth(gp.isrUnit) : 0;
  const stackDepth = mainDepth + isrDepth;
  if (stackDepth > STACK_LEVELS) {
    diags.error(
      Codes.STACK_OVERFLOW,
      `Débordement de la pile matérielle : ${stackDepth} niveaux nécessaires (${STACK_LEVELS} disponibles${gp.isrUnit ? `, dont ${isrDepth} pour l'interruption` : ''})`,
    );
  }

  const ram = allocateRam(gp.globals, graph);
  if (!ram.ok) {
    diags.error(Codes.RAM_FULL, `Mémoire RAM insuffisante : il manque ${ram.missing} octet(s) (68 octets de 0x0C à 0x4F)`);
  }

  // Layout: reset vector at 0x0000, then everything else from 0x0004 (interrupt routine first, if any).
  const byName = new Map(gp.units.map((u) => [u.name, u]));
  const reset = byName.get(gp.resetUnit)!;
  const rest: CodeUnit[] = gp.units.filter((u) => u !== reset);
  const isr = gp.isrUnit ? byName.get(gp.isrUnit) : undefined;
  const ordered = isr ? [isr, ...rest.filter((u) => u !== isr)] : rest;
  const segments: { start: number; code: Instr[] }[] = [
    { start: 0, code: reset.code },
    { start: 4, code: peephole(ordered.flatMap((u) => u.code)) },
  ];

  const placed: Placed[] = [];
  const labels = new Map<string, number>();
  for (const seg of segments) {
    let addr = seg.start;
    let pending: string[] = [];
    for (const ins of seg.code) {
      if (ins.t === 'label') {
        labels.set(ins.name, addr);
        pending.push(ins.name);
        continue;
      }
      placed.push({ addr, instr: ins, labels: pending });
      pending = [];
      addr++;
    }
  }

  const romWords = placed.length;
  const lastAddr = placed.length ? placed[placed.length - 1].addr : 0;
  if (lastAddr >= PROGRAM_WORDS) {
    diags.error(Codes.ROM_FULL, `Mémoire programme insuffisante : ${lastAddr + 1} mots utilisés (${PROGRAM_WORDS} disponibles)`);
  }

  const addrOf = (f: FileRef): number => (f.kind === 'sfr' ? f.addr : (f.slot.addr ?? f.slot.fixed ?? 0) + f.offset);
  const litValue = (k: Lit): number => {
    if (typeof k === 'number') return k & 0xff;
    if (k.kind === 'label') {
      const a = labels.get(k.label) ?? 0;
      return k.part === 'lo' ? a & 0xff : (a >> 8) & 0xff;
    }
    return addrOf(k.ref) & 0xff;
  };

  const program = new Uint16Array(PROGRAM_WORDS).fill(0x3fff);
  const used = new Array<boolean>(PROGRAM_WORDS).fill(false);
  const listing: ListingLine[] = [];
  const addrToLine = new Map<number, number>();
  const lineToAddr = new Map<number, number>();
  let prevLine: number | undefined;

  for (const p of placed) {
    const i = p.instr;
    let word: number;
    switch (i.t) {
      case 'file':
        word = encodeFile(i.op, addrOf(i.f), i.d);
        break;
      case 'bit':
        word = encodeBit(i.op, addrOf(i.f), i.b);
        break;
      case 'lit':
        word = encodeLit(i.op, litValue(i.k));
        break;
      case 'jump': {
        const target = typeof i.target === 'string' ? labels.get(i.target) : p.addr + i.target.rel;
        if (target === undefined) diags.error(Codes.INTERNAL, `Étiquette inconnue '${String(i.target)}'`);
        word = encodeJump(i.op, target ?? 0);
        break;
      }
      case 'none':
        word = encodeNoArg(i.op);
        break;
    }
    if (p.addr < PROGRAM_WORDS) {
      program[p.addr] = word;
      used[p.addr] = true;
    }
    for (const extra of p.labels.slice(1)) listing.push({ label: extra, text: '' });
    const line: ListingLine = { addr: p.addr, word, text: instrText(i, addrOf) };
    if (p.labels.length) line.label = p.labels[0];
    if (i.line !== undefined) {
      line.srcLine = i.line;
      addrToLine.set(p.addr, i.line);
      if (!lineToAddr.has(i.line) || lineToAddr.get(i.line)! > p.addr) lineToAddr.set(i.line, p.addr);
      if (i.line !== prevLine) line.comment = lineText(i.line).trim();
    }
    prevLine = i.line;
    listing.push(line);
  }

  return {
    ok: ram.ok && stackDepth <= STACK_LEVELS && lastAddr < PROGRAM_WORDS,
    program,
    used,
    listing,
    addrToLine,
    lineToAddr,
    symbols: collectSymbols(gp, addrOf),
    romWords,
    ramBytes: ram.used,
    stackDepth,
  };
}

function collectSymbols(gp: GeneratedProgram, addrOf: (f: FileRef) => number): SymbolInfo[] {
  const out: SymbolInfo[] = gp.sbits.map((s) => ({ name: s.name, scope: s.scope, addr: addrOf(s.ref), size: 1, type: `sbit (bit ${s.bit})` }));
  const frames = [gp.globals, ...gp.units.map((u) => u.frame)];
  for (const f of frames) {
    for (const s of f.slots) {
      s.bitNames?.forEach((name, bit) => out.push({ name, scope: 'global', addr: s.addr ?? 0, size: 1, type: `bit (bit ${bit})` }));
      if (s.scope === undefined) continue;
      out.push({
        name: s.name,
        scope: s.scope,
        addr: s.addr ?? s.fixed ?? addrOf({ kind: 'slot', slot: s, offset: 0 }),
        size: s.size || 1,
        type: s.typeText ?? '',
      });
    }
  }
  return out.sort((a, b) => a.addr - b.addr); // stable: declaration order at equal addresses
}
