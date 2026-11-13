import type { FileRef, Instr, Lit, Target } from '../codegen/ir';
import { sfrAt } from '../device';

/** Registers whose bits are shown by name in the listing (MPASM style: `BTFSC STATUS, Z`). */
const NAMED_BIT_REGS = new Set(['STATUS', 'INTCON', 'OPTION_REG', 'EECON1']);

const hex2 = (v: number) => `0x${(v & 0xff).toString(16).toUpperCase().padStart(2, '0')}`;

export function fileName(f: FileRef): string {
  if (f.kind === 'sfr') return sfrAt(f.addr)?.name ?? hex2(f.addr);
  return f.offset ? `${f.slot.name}+${f.offset}` : f.slot.name;
}

function bitName(f: FileRef, b: number): string {
  if (f.kind === 'slot' && f.offset === 0 && f.slot.bitNames?.[b]) return f.slot.bitNames[b];
  if (f.kind === 'sfr') {
    const s = sfrAt(f.addr);
    if (s && NAMED_BIT_REGS.has(s.name)) {
      const n = s.bits[b];
      if (n) return n;
    }
  }
  return String(b);
}

function litText(k: Lit, addrOf: (f: FileRef) => number): string {
  if (typeof k === 'number') return hex2(k);
  if (k.kind === 'label') return `${k.part === 'lo' ? 'LOW' : 'HIGH'}(${k.label})`;
  return `${hex2(addrOf(k.ref))}`;
}

function targetText(t: Target): string {
  if (typeof t === 'string') return t;
  return t.rel === 0 ? '$' : `$${t.rel > 0 ? '+' : ''}${t.rel}`;
}

/** MPASM-style text of an instruction, e.g. 'MOVLW 0x06', 'SUBWF x, W', 'BTFSC STATUS, Z'. */
export function instrText(i: Exclude<Instr, { t: 'label' }>, addrOf: (f: FileRef) => number): string {
  switch (i.t) {
    case 'file':
      if (i.op === 'MOVWF' || i.op === 'CLRF') return `${i.op} ${fileName(i.f)}`;
      return `${i.op} ${fileName(i.f)}, ${i.d ? 'F' : 'W'}`;
    case 'bit':
      return `${i.op} ${fileName(i.f)}, ${bitName(i.f, i.b)}`;
    case 'lit':
      return `${i.op} ${litText(i.k, addrOf)}`;
    case 'jump':
      return `${i.op} ${targetText(i.target)}`;
    case 'none':
      return i.op;
  }
}
