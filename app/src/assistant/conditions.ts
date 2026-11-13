// Condition builder: the assistant edits a condition as a flat list of simple tests joined by « et » or « ou »
// (that covers every TP: `L1 == 0 && L0 == 1`, `ZERO==1`, `var1 < var2`). Anything deeper is kept as C text.
import { negateCond, signalById, type CompareOp, type Cond, type FlagName, type Level, type Program } from '@pic/program-model';
import { condC } from '@pic/style-c';

/** One test of the builder. */
export type CondTerm = Extract<Cond, { kind: 'pin' | 'flag' | 'compare' | 'raw' }>;

export interface CondDraft {
  join: 'and' | 'or';
  terms: CondTerm[];
}

const isTerm = (c: Cond): c is CondTerm => c.kind === 'pin' || c.kind === 'flag' || c.kind === 'compare' || c.kind === 'raw';

function safeC(program: Program, c: Cond): string {
  try {
    return condC(program, c);
  } catch {
    return '';
  }
}

/** A test the builder can show: simple tests as they are, `!(simple)` negated, the rest as C text. */
function toTerm(program: Program, c: Cond): CondTerm {
  if (isTerm(c)) return c;
  if (c.kind === 'not') {
    const inner = c.cond;
    if (inner.kind === 'pin' || inner.kind === 'flag' || inner.kind === 'compare') return negateCond(inner) as CondTerm;
  }
  return { kind: 'raw', text: safeC(program, c) };
}

/** Condition → builder rows. A single and/or level becomes rows; nested mixes become one C-text row. */
export function condToDraft(program: Program, c: Cond): CondDraft {
  if (c.kind === 'and' || c.kind === 'or') {
    return { join: c.kind, terms: c.items.length ? c.items.map((x) => toTerm(program, x)) : [{ kind: 'raw', text: '1' }] };
  }
  return { join: 'and', terms: [toTerm(program, c)] };
}

/** Builder rows → condition (one row: the row itself). */
export function draftToCond(d: CondDraft): Cond {
  if (d.terms.length === 1) return d.terms[0];
  return { kind: d.join, items: d.terms };
}

// ------------------------------------------------------------------------------------------------ term subjects

/** What a row tests, as a <select> value: 'pin:<signalId>', 'flag:Z', 'compare', 'raw'. */
export type SubjectKey = string;

export function subjectOf(term: CondTerm): SubjectKey {
  switch (term.kind) {
    case 'pin': return `pin:${term.signal}`;
    case 'flag': return `flag:${term.flag}`;
    case 'compare': return 'compare';
    case 'raw': return 'raw';
  }
}

/** New row for a subject chosen in the select; keeps what still makes sense from the previous row. */
export function termForSubject(program: Program, key: SubjectKey, previous?: CondTerm): CondTerm {
  if (key.startsWith('pin:')) {
    const id = key.slice(4);
    const sig = signalById(program, id);
    const value: Level = previous && (previous.kind === 'pin' || previous.kind === 'flag') ? previous.value : sig?.activeLevel ?? 1;
    return { kind: 'pin', signal: id, value };
  }
  if (key.startsWith('flag:')) {
    const value: Level = previous && (previous.kind === 'pin' || previous.kind === 'flag') ? previous.value : 1;
    return { kind: 'flag', flag: key.slice(5) as FlagName, value };
  }
  if (key === 'compare') {
    if (previous?.kind === 'compare') return previous;
    const a = program.variables[0]?.name ?? 'x';
    const b = program.variables[1]?.name ?? program.constants[0]?.name;
    return { kind: 'compare', left: { kind: 'var', name: a }, op: '==', right: b ? { kind: 'var', name: b } : { kind: 'num', value: 0 } };
  }
  return { kind: 'raw', text: previous ? safeC(program, previous) : '' };
}

/** A sensible next row for « + condition »: the next input not yet tested. */
export function nextTerm(program: Program, draft: CondDraft): CondTerm {
  const tested = new Set(draft.terms.filter((t) => t.kind === 'pin').map((t) => (t as Extract<CondTerm, { kind: 'pin' }>).signal));
  const input = program.signals.find((s) => s.dir === 'in' && !tested.has(s.id)) ?? program.signals.find((s) => s.dir === 'in');
  if (input) return { kind: 'pin', signal: input.id, value: input.activeLevel };
  return termForSubject(program, 'compare');
}

export const COMPARE_OPS: readonly { op: CompareOp; label: string }[] = [
  { op: '==', label: '==' },
  { op: '!=', label: '!=' },
  { op: '<', label: '<' },
  { op: '<=', label: '<=' },
  { op: '>', label: '>' },
  { op: '>=', label: '>=' },
];

/** Status flags offered everywhere; interrupt flags only inside the interrupt routine. */
export function flagOptions(inInterrupt: boolean): { flag: FlagName; label: string }[] {
  const base: { flag: FlagName; label: string }[] = [
    { flag: 'Z', label: 'ZERO (Z) — résultat nul, égalité' },
    { flag: 'C', label: 'CARRY (C) — pas d’emprunt, x ≥ y' },
    { flag: 'DC', label: 'DC — retenue entre quartets' },
  ];
  if (!inInterrupt) return base;
  return [
    ...base,
    { flag: 'INTF', label: 'INTF — interruption RB0/INT' },
    { flag: 'RBIF', label: 'RBIF — changement sur RB4 à RB7' },
    { flag: 'T0IF', label: 'T0IF — débordement du TMR0' },
  ];
}

/** « appuyé » / « relâché » hints for the 0 / 1 choice of a pin test. */
export function levelHint(program: Program, signalId: string, level: Level): string {
  const sig = signalById(program, signalId);
  if (!sig) return '';
  const active = level === sig.activeLevel;
  switch (sig.device) {
    case 'button': return active ? 'appuyé' : 'relâché';
    case 'sensor': return active ? 'lumière' : 'obscurité';
    case 'led': return active ? 'allumée' : 'éteinte';
    case 'lamp': return active ? 'allumé' : 'éteint';
    default: return '';
  }
}
