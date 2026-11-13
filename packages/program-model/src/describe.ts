// French prose for the organigramme boxes, in the prof's own wording (research 06 §3–§4, 00 §4.3):
//   CONFIGURATION: « RB0,RB1 et RB2 sont des sorties », « Déclaration des variables »
//   INITIALISATION: « x=5 et y=6 », « Les Leds sont éteintes » (red)
//   loop boxes: « Les Leds sont éteintes », « z= x-y », « Led égalité allumée »
//   diamonds: C-style tests with == and symbolic names (« ZERO==1 », « CARRY==1 », « VOTE_A==1 »), never '?';
//   assignments use '=', never '←'.
// Constructs she never drew (delays, waits, counters, displays) follow research 00 §4.5.
import { busPins, comparePins, pinBit, pinPort } from './pins';
import { trisMode, trisValue } from './tris';
import { negateCond } from './walk';
import type {
  Bus, Cond, ElseBranch, Expr, FlagName, ForStmt, FunctionDef, IfBranch, Level, PinName, Port, Program, RepeatStmt, Signal,
  Stmt, WaitStmt, WhileStmt,
} from './types';

export interface ProseLine {
  text: string;
  /** 'off': « Les Leds sont éteintes », drawn in red (#FF0000) in the INITIALISATION box. */
  emphasis?: 'off';
}

export interface DescribeOptions {
  /** `&&` / `||` written « et » / « ou » (default, research 00 §4.5) or kept as in the C code. */
  logic?: 'words' | 'c';
  /**
   * 'tp' (default): her TP chart, naming the pins (« RB0,RB1 et RB2 sont des sorties », « Les Leds sont éteintes »).
   * 'generic': her « Organigramme général » (« Configurer les entrées. », « Configurer les sorties. »,
   * « Initialiser les sorties »).
   */
  wording?: 'tp' | 'generic';
  /**
   * Busy waits `while (X == 1);`: 'exit' (default) writes the condition that ends the wait in the diamond
   * (« X==0 »), so `oui` continues down and `non` loops back, as for every other diamond (research 06 §7:
   * `while(RA3==0);` → « RA3==1 »). 'loop' writes the C loop condition, `oui` looping back.
   */
  waits?: 'exit' | 'loop';
}

const line = (text: string, emphasis?: 'off'): ProseLine => (emphasis ? { text, emphasis } : { text });

// ---------------------------------------------------------------------------------------------------------------
// Lookups

export function signalById(program: Program, id: string): Signal | undefined {
  return program.signals.find((s) => s.id === id);
}

export function busById(program: Program, id: string): Bus | undefined {
  return program.buses.find((b) => b.id === id);
}

/** Name used in code and diamonds: the `#define` alias, or the pin itself when there is none. */
export function signalName(s: Signal): string {
  return s.useDefine === false ? s.pin : s.name;
}

const isLedLike = (s: Signal) => s.dir === 'out' && (s.device === 'led' || s.device === 'lamp');

// ---------------------------------------------------------------------------------------------------------------
// Numbers, durations, glyphs

/** 500 → « 0,5 s », 1000 → « 1 s », 20 → « 20 ms » (French decimal comma). */
export function formatDuration(amount: number, unit: 'ms' | 'us' = 'ms'): string {
  if (unit === 'us') return amount >= 1000 ? formatDuration(amount / 1000, 'ms') : `${amount} µs`;
  if (amount < 100) return `${trimNumber(amount)} ms`;
  return `${trimNumber(amount / 1000)} s`;
}

function trimNumber(n: number): string {
  return String(Math.round(n * 1000) / 1000).replace('.', ',');
}

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

/** What a 7SEG-BCD shows for a value: « le chiffre 5 », « la lettre 'A' » (letters as the énoncés write them). */
export function glyphName(value: number): string {
  const v = value & 0x0f;
  return v < 10 ? `le chiffre ${v}` : `la lettre '${LETTERS[v - 10]}'`;
}

/** Hex as the prof writes it: 0x0A, 0xCA. */
export function hexLiteral(value: number): string {
  const digits = (value >>> 0).toString(16).toUpperCase();
  return `0x${digits.length % 2 === 1 ? `0${digits}` : digits}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Expressions and conditions

const FLAG_PROSE: Readonly<Record<FlagName, string>> = {
  Z: 'ZERO', C: 'CARRY', DC: 'DC', INTF: 'INTF', RBIF: 'RBIF', T0IF: 'T0IF',
};

const PRECEDENCE: Record<string, number> = {
  '*': 10, '/': 10, '%': 10, '+': 9, '-': 9, '<<': 8, '>>': 8, '&': 6, '^': 5, '|': 4,
};

function numText(value: number, radix: number | undefined): string {
  if (radix === 16) return hexLiteral(value);
  if (radix === 2) return `0b${(value >>> 0).toString(2).padStart(8, '0')}`;
  return String(value);
}

/** Compact expression text for the boxes: `x-y`, `9-compte`, `0x0A`. */
export function describeExpr(program: Program, e: Expr): string {
  switch (e.kind) {
    case 'num': return numText(e.value, e.radix);
    case 'var': return e.name;
    case 'signal': {
      const s = signalById(program, e.id);
      return s ? signalName(s) : e.id;
    }
    case 'bus': return busById(program, e.id)?.name ?? e.id;
    case 'reg': return e.bit ? `${e.name}.${e.bit}` : e.name;
    case 'bin': {
      const p = PRECEDENCE[e.op];
      const side = (x: Expr, right: boolean) => {
        const t = describeExpr(program, x);
        if (x.kind !== 'bin') return t;
        const q = PRECEDENCE[x.op];
        // Parentheses when C needs them, and for clarity when arithmetic meets bitwise operators: (k - 1) & 0x0F.
        const mixed = p <= 8 && q !== p;
        return q < p || (right && q === p) || mixed ? `(${t})` : t;
      };
      return `${side(e.left, false)}${e.op}${side(e.right, true)}`;
    }
    case 'unary': {
      const t = describeExpr(program, e.arg);
      return e.arg.kind === 'bin' ? `${e.op}(${t})` : `${e.op}${t}`;
    }
    case 'raw': return e.text;
  }
}

/** Diamond text: `ZERO==1`, `L1==0 et L0==0`, `REPONSES==REPONSE_CORRECTE`. No question mark. */
export function describeCond(program: Program, c: Cond, opts: DescribeOptions = {}): string {
  const words = (opts.logic ?? 'words') === 'words';
  switch (c.kind) {
    case 'pin': {
      const s = signalById(program, c.signal);
      return `${s ? signalName(s) : c.signal}==${c.value}`;
    }
    case 'flag': return `${FLAG_PROSE[c.flag]}==${c.value}`;
    case 'compare': return `${describeExpr(program, c.left)}${c.op}${describeExpr(program, c.right)}`;
    case 'and':
    case 'or': {
      const joiner = c.kind === 'and' ? (words ? ' et ' : ' && ') : (words ? ' ou ' : ' || ');
      return c.items
        .map((x) => {
          const t = describeCond(program, x, opts);
          return c.kind === 'and' && x.kind === 'or' ? `(${t})` : t;
        })
        .join(joiner);
    }
    case 'not': return `!(${describeCond(program, c.cond, opts)})`;
    case 'raw': return c.text;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Signals

/** « Led égalité allumée » / « Feu rouge éteint » / « D0=1 » for a write of `level` to `s`. */
export function signalStateText(s: Signal, level: Level): string {
  const active = level === s.activeLevel;
  if (active && s.onText) return s.onText;
  if (!active && s.offText) return s.offText;
  if (s.device === 'led') return `${s.label} ${active ? 'allumée' : 'éteinte'}`;
  if (s.device === 'lamp') return `${s.label} ${active ? 'allumé' : 'éteint'}`;
  return `${signalName(s)}=${level}`;
}

function toggleText(s: Signal): string {
  if (s.device === 'led') return `${s.label} inversée`;
  if (s.device === 'lamp') return `${s.label} inversé`;
  return `${signalName(s)} inversé`;
}

/** Plural for a set of LED-like signals: « Les Leds sont éteintes », « Les feux sont éteints ». */
function groupText(signals: Signal[], active: boolean, others = false): string {
  const allLamps = signals.every((s) => s.device === 'lamp');
  const allLeds = signals.every((s) => s.device === 'led');
  const autres = others ? 'autres ' : '';
  if (allLamps) return `Les ${autres}feux sont ${active ? 'allumés' : 'éteints'}`;
  if (allLeds) return `Les ${autres}Leds sont ${active ? 'allumées' : 'éteintes'}`;
  return `Les ${autres}sorties sont ${active ? 'actives' : 'à 0'}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Pin lists (CONFIGURATION)

/** « RB0,RB1 et RB2 » (her spelling: no space after the comma); runs of 4+ pins become « RB0 à RB3 ». */
export function pinListText(pins: readonly PinName[]): string {
  const sorted = [...new Set(pins)].sort(comparePins);
  const items: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (
      j + 1 < sorted.length
      && pinPort(sorted[j + 1]) === pinPort(sorted[i])
      && pinBit(sorted[j + 1]) === pinBit(sorted[j]) + 1
    ) j++;
    if (j - i + 1 >= 4) items.push(`${sorted[i]} à ${sorted[j]}`);
    else for (let k = i; k <= j; k++) items.push(sorted[k]);
    i = j + 1;
  }
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(',')} et ${items[items.length - 1]}`;
}

function directionLine(pins: PinName[], dir: 'in' | 'out'): string | null {
  if (pins.length === 0) return null;
  const list = pinListText(pins);
  const plural = pins.length > 1;
  if (dir === 'in') return plural ? `${list} sont des entrées` : `${list} est une entrée`;
  return plural ? `${list} sont des sorties` : `${list} est une sortie`;
}

/** Pins used in a direction (signals and bus bits). */
export function usedPins(program: Program, dir: 'in' | 'out'): PinName[] {
  const pins: PinName[] = program.signals.filter((s) => s.dir === dir).map((s) => s.pin);
  for (const b of program.buses) if (b.dir === dir) pins.push(...busPins(b));
  return pins.sort(comparePins);
}

/**
 * Ports named as a whole in the CONFIGURATION box: the code writes the whole register in one direction
 * (`TRISB = 0x00;` → 'out', all ones → 'in') AND the program uses every pin of the port in that direction.
 */
function wholePortDirection(program: Program, port: Port): 'in' | 'out' | null {
  if (trisMode(program, port) !== 'port') return null;
  const value = trisValue(program, port);
  const dir = value === 0 ? 'out' : value === (1 << PORT_BITS[port]) - 1 ? 'in' : null;
  if (!dir) return null;
  const used = new Set(usedPins(program, dir).filter((p) => pinPort(p) === port));
  return used.size === PORT_BITS[port] ? dir : null;
}

const PORT_BITS: Readonly<Record<Port, number>> = { A: 5, B: 8 };

/**
 * Lines of the CONFIGURATION box, in the prof's wording: the pins the program actually uses are listed
 * (« RB0,RB1 et RB2 sont des sorties », her slide 6, although status.c writes `TRISB = 0x00;`), whether the code
 * configures them one by one or with a whole-register write. A port is named as a whole (« PORTB est en sortie »)
 * only when the code writes the whole register and the program uses all of its pins (pupitre: « PORTB est en
 * entrée »).
 */
export function describeConfiguration(program: Program, opts: DescribeOptions = {}): ProseLine[] {
  const out: ProseLine[] = [];
  const generic = opts.wording === 'generic';
  const whole = new Map<Port, 'in' | 'out'>();
  for (const port of ['A', 'B'] as const) {
    const dir = wholePortDirection(program, port);
    if (dir) whole.set(port, dir);
  }
  const listed = (dir: 'in' | 'out') => usedPins(program, dir).filter((p) => !whole.has(pinPort(p)));
  const portLines = (dir: 'in' | 'out') => [...whole].filter(([, d]) => d === dir)
    .map(([port]) => `PORT${port} est en ${dir === 'in' ? 'entrée' : 'sortie'}`);
  for (const dir of ['in', 'out'] as const) {
    if (generic) {
      if (usedPins(program, dir).length) out.push(line(dir === 'in' ? 'Configurer les entrées.' : 'Configurer les sorties.'));
      continue;
    }
    const pins = directionLine(listed(dir), dir);
    if (pins) out.push(line(pins));
    for (const t of portLines(dir)) out.push(line(t));
  }
  const it = program.interrupts;
  if (it) {
    if (it.int) out.push(line(`Interruption RB0/INT sur front ${it.int.edge === 'rising' ? 'montant' : 'descendant'}`));
    if (it.rbChange) out.push(line('Interruption sur changement de RB4 à RB7'));
    if (it.tmr0) out.push(line(`Interruption TMR0 (prédiviseur 1:${it.tmr0.prescaler})`));
    if (it.gie) out.push(line('Les interruptions sont autorisées'));
  }
  if (program.variables.length > 0) out.push(line('Déclaration des variables'));
  return out;
}

/** Lines of the INITIALISATION box (« x=5 et y=6 », « Les Leds sont éteintes » in red). */
export function describeInitialisation(program: Program, opts: DescribeOptions = {}): ProseLine[] {
  const lines = describeActions(program, program.init, opts);
  if (opts.wording !== 'generic') return lines;
  return lines.map((l) => (l.emphasis === 'off' ? { text: 'Initialiser les sorties', emphasis: 'off' } : l));
}

// ---------------------------------------------------------------------------------------------------------------
// Statements

/** Statements drawn as (part of) a rectangle; the others (if, loops, waits) are drawn with diamonds. */
export function isSimpleStmt(s: Stmt): boolean {
  return !(s.kind === 'if' || s.kind === 'while' || s.kind === 'repeat' || s.kind === 'for' || s.kind === 'waitFor');
}

/** Prose of one simple statement, without grouping with its neighbours. */
export function describeStmt(program: Program, s: Stmt, opts: DescribeOptions = {}): ProseLine[] {
  if (s.text !== undefined) return s.text.split('\n').map((t) => line(t));
  switch (s.kind) {
    case 'set': {
      const sig = signalById(program, s.signal);
      return [line(sig ? signalStateText(sig, s.value) : `${s.signal}=${s.value}`)];
    }
    case 'setAll': return describeWrites(program, s.signals.map((id) => [id, s.value] as const));
    case 'toggle': {
      const sig = signalById(program, s.signal);
      return [line(sig ? toggleText(sig) : `${s.signal} inversé`)];
    }
    case 'display': return [line(displayText(program, s.bus, s.value))];
    case 'assign': return [line(assignText(program, s.target, s.value))];
    case 'incr': return [line(`${s.variable}=${s.variable}+1`)];
    case 'decr': return [line(`${s.variable}=${s.variable}-1`)];
    case 'delay': return [line(`Temporisation ${formatDuration(s.ms, s.unit)}`)];
    case 'call': return [line(`Appeler ${s.name}()`)];
    case 'clearFlag': return [line(`Effacer le drapeau ${s.flag}`)];
    case 'comment': return [line(s.text)];
    case 'raw': return s.code.split('\n').map((t) => line(t.trim())).filter((l) => l.text !== '');
    case 'if': return [line(describeCond(program, s.branches[0]?.cond ?? { kind: 'raw', text: '' }, opts))];
    case 'while': return [line(describeCond(program, s.cond, opts))];
    case 'waitFor': return [line(describeWait(program, s, opts).text)];
    case 'repeat': return describeRepeat(program, s, opts).box.map((t) => line(t));
    case 'for': return [line(describeFor(program, s, opts).test)];
  }
}

function displayText(program: Program, busId: string, value: Expr): string {
  const b = busById(program, busId);
  if (b?.device === 'bcd') {
    if (value.kind === 'num') return `Afficher ${glyphName(value.value)}`;
    return `Afficher ${describeExpr(program, value)}`;
  }
  return assignText(program, { kind: 'bus', id: busId }, value);
}

function assignText(program: Program, target: Expr, value: Expr): string {
  const lhs = describeExpr(program, target);
  const rhs = describeExpr(program, value);
  return value.kind === 'num' ? `${lhs}=${rhs}` : `${lhs}= ${rhs}`;
}

/** Prose for a run of pin writes (later writes to the same signal win). */
function describeWrites(program: Program, writes: readonly (readonly [string, Level])[]): ProseLine[] {
  const finalLevel = new Map<string, Level>();
  for (const [id, level] of writes) {
    finalLevel.delete(id); // keep the order of the last write
    finalLevel.set(id, level);
  }
  const entries = [...finalLevel].map(([id, level]) => ({ sig: signalById(program, id), id, level }));
  if (entries.some((e) => !e.sig)) return entries.map((e) => line(e.sig ? signalStateText(e.sig, e.level) : `${e.id}=${e.level}`));
  const all = program.signals.filter(isLedLike);
  const touched = entries.map((e) => e.sig!);
  const allTouched = all.length > 0 && all.every((s) => finalLevel.has(s.id));
  if (allTouched && touched.every(isLedLike)) {
    const active = entries.filter((e) => e.level === e.sig!.activeLevel);
    if (active.length === 0) return [all.length > 1 ? line(groupText(all, false), 'off') : line(signalStateText(all[0], entries[0].level), 'off')];
    if (all.length === 1) return [line(signalStateText(all[0], entries[0].level))];
    if (active.length === entries.length) return [line(groupText(all, true))];
    if (active.length === 1) {
      const rest = all.filter((s) => s.id !== active[0].id);
      return [line(signalStateText(active[0].sig!, active[0].level)), line(groupText(rest, false, true))];
    }
  }
  return entries.map((e) => line(signalStateText(e.sig!, e.level)));
}

const isPinWrite = (s: Stmt) => (s.kind === 'set' || s.kind === 'setAll') && s.text === undefined;
const writesOf = (s: Stmt): [string, Level][] =>
  s.kind === 'set' ? [[s.signal, s.value]] : s.kind === 'setAll' ? s.signals.map((id) => [id, s.value]) : [];

function isActiveWrite(program: Program, s: Stmt): s is Extract<Stmt, { kind: 'set' }> {
  if (s.kind !== 'set' || s.text !== undefined) return false;
  const sig = signalById(program, s.signal);
  return !!sig && s.value === sig.activeLevel;
}

function isOffWrite(program: Program, s: Stmt | undefined, signal: string): boolean {
  if (!s || s.kind !== 'set' || s.text !== undefined || s.signal !== signal) return false;
  const sig = signalById(program, signal);
  return !!sig && s.value !== sig.activeLevel;
}

const isPlainDelay = (s: Stmt | undefined): s is Extract<Stmt, { kind: 'delay' }> => s?.kind === 'delay' && s.text === undefined;

/**
 * Prose for a run of simple statements, grouped the way she writes a box:
 * - all LEDs written off → « Les Leds sont éteintes » (one LED on, the others off → « Led D0 allumée » + « Les autres Leds sont éteintes »);
 * - LED on, delay a, LED off, delay b → « Led … clignote (0,5 s / 0,5 s) »;
 * - LED on, delay, LED off → « Led … allumée pendant 3 s »; display then delay → « Afficher la lettre 'F' pendant 0,5 s »;
 * - consecutive constant assignments → « x=5 et y=6 ».
 * Control statements in `stmts` are summarised on one line each (use the dedicated describe* helpers to draw them).
 */
export function describeActions(program: Program, stmts: readonly Stmt[], opts: DescribeOptions = {}): ProseLine[] {
  const out: ProseLine[] = [];
  for (let i = 0; i < stmts.length; ) {
    const s = stmts[i];
    // Blink: on, delay, off, delay (same signal).
    if (isActiveWrite(program, s) && isPlainDelay(stmts[i + 1]) && isOffWrite(program, stmts[i + 2], s.signal)) {
      const sig = signalById(program, s.signal)!;
      const onDelay = stmts[i + 1] as Extract<Stmt, { kind: 'delay' }>;
      const offDelay = stmts[i + 3];
      if (isPlainDelay(offDelay)) {
        const verb = sig.device === 'led' || sig.device === 'lamp' ? `${sig.label} clignote` : `${signalName(sig)} clignote`;
        out.push(line(`${verb} (${formatDuration(onDelay.ms, onDelay.unit)} / ${formatDuration(offDelay.ms, offDelay.unit)})`));
        i += 4;
      } else {
        out.push(line(`${signalStateText(sig, s.value)} pendant ${formatDuration(onDelay.ms, onDelay.unit)}`));
        i += 3;
      }
      continue;
    }
    if (isPinWrite(s)) {
      const writes: [string, Level][] = [];
      let j = i;
      while (j < stmts.length && isPinWrite(stmts[j])) {
        // Stop before a write that starts a blink / timed pattern so it gets its own line.
        if (j > i && isActiveWrite(program, stmts[j]) && isPlainDelay(stmts[j + 1])) break;
        writes.push(...writesOf(stmts[j]));
        j++;
      }
      out.push(...describeWrites(program, writes));
      i = j;
      continue;
    }
    if (s.kind === 'display' && s.text === undefined && isPlainDelay(stmts[i + 1])) {
      const d = stmts[i + 1] as Extract<Stmt, { kind: 'delay' }>;
      out.push(line(`${displayText(program, s.bus, s.value)} pendant ${formatDuration(d.ms, d.unit)}`));
      i += 2;
      continue;
    }
    // Input pins copied to output pins (« LED0 = INTER4; … »): one line « Recopier RB4 à RB7 sur RA0 à RA3 ».
    const copies = copyRun(program, stmts, i);
    if (copies.length >= 2) {
      out.push(line(`Recopier ${pinListText(copies.map((c) => c.from))} sur ${pinListText(copies.map((c) => c.to))}`));
      i += copies.length;
      continue;
    }
    if (s.kind === 'assign' && s.text === undefined && s.value.kind === 'num' && s.target.kind === 'var') {
      const parts: string[] = [];
      let j = i;
      while (j < stmts.length) {
        const x = stmts[j];
        if (x.kind !== 'assign' || x.text !== undefined || x.value.kind !== 'num' || x.target.kind !== 'var') break;
        parts.push(assignText(program, x.target, x.value));
        j++;
      }
      out.push(line(parts.join(' et ')));
      i = j;
      continue;
    }
    out.push(...describeStmt(program, s, opts));
    i++;
  }
  return out;
}

/** Consecutive `OUT = IN;` pin copies starting at `i` (signal ← signal, no prose override). */
function copyRun(program: Program, stmts: readonly Stmt[], i: number): { from: PinName; to: PinName }[] {
  const out: { from: PinName; to: PinName }[] = [];
  for (let j = i; j < stmts.length; j++) {
    const s = stmts[j];
    if (s.kind !== 'assign' || s.text !== undefined || s.target.kind !== 'signal' || s.value.kind !== 'signal') break;
    const to = signalById(program, s.target.id);
    const from = signalById(program, s.value.id);
    if (!to || !from) break;
    out.push({ from: from.pin, to: to.pin });
  }
  return out;
}

/** First line of a branch box, as on her slide 6: `// x= y`. */
export function branchNote(branch: IfBranch | ElseBranch): string | undefined {
  return branch.note ? `// ${branch.note}` : undefined;
}

/** Diamond text of an if / else-if branch (its `text` override, or the condition). */
export function describeBranchCond(program: Program, branch: IfBranch, opts: DescribeOptions = {}): string {
  return branch.text ?? describeCond(program, branch.cond, opts);
}

/**
 * A busy wait `while (VOTE_A == 1);` is a diamond that loops back onto itself (research 00 C1.11). By default it
 * holds the condition that ends the wait (« VOTE_A==0 »): `oui` continues down, `non` loops back on the right, the
 * same exits as every other diamond (research 06 §7). `waits: 'loop'` writes the C loop condition instead
 * (« VOTE_A==1 », `oui` loops back).
 */
export function describeWait(program: Program, s: WaitStmt, opts: DescribeOptions = {}): { text: string; loopOn: 'oui' | 'non' } {
  if (opts.waits === 'loop') return { text: s.text ?? describeCond(program, negateCond(s.cond), opts), loopOn: 'oui' };
  return { text: s.text ?? describeCond(program, s.cond, opts), loopOn: 'non' };
}

/** `while (cond) { … }`: diamond text, `oui` enters the body. */
export function describeWhile(program: Program, s: WhileStmt, opts: DescribeOptions = {}): { text: string } {
  return { text: s.text ?? describeCond(program, s.cond, opts) };
}

export interface CounterLoopProse {
  /**
   * One-line summary: what the repetition does when it can be said in one line (« Led verte clignote 3 fois
   * (0,5 s / 0,5 s) », « Décompte de 9 à 0 sur l'afficheur (1 s par chiffre) »), else « Répéter 3 fois ».
   */
  summary: string;
  /** The whole loop as one action box: the summary, or « Répéter 3 fois : » followed by the body's lines. */
  box: string[];
  /** Box before the loop (« i=0 »). */
  init: string;
  /** Diamond (« i<3 »), `oui` enters the body. */
  test: string;
  /** Box at the end of the body (« i=i+1 »). */
  update: string;
}

/**
 * `for (i = 0; i < 3; i++)`: one action box by default (research 00 §4.5 « Led RB5 clignote 3 fois (0,5 s / 0,5 s) »),
 * or an explicit counter loop (init « i=0 », test « i<3 », update « i=i+1 »).
 */
export function describeRepeat(program: Program, s: RepeatStmt, opts: DescribeOptions = {}): CounterLoopProse {
  const counter = { init: `${s.counter}=0`, test: `${s.counter}<${s.times}`, update: `${s.counter}=${s.counter}+1` };
  const generic = `Répéter ${s.times} fois`;
  if (s.text !== undefined) return { summary: s.text, box: s.text.split('\n'), ...counter };
  const smart = repeatSummary(program, s, opts);
  if (smart) return { summary: smart, box: [smart], ...counter };
  const body = describeActions(program, s.body, opts).map((l) => l.text);
  return { summary: generic, box: body.length > 0 ? [`${generic} :`, ...body] : [generic], ...counter };
}

/** One-line wording of the usual repetitions: a blink N times, a countdown on a display. */
function repeatSummary(program: Program, s: RepeatStmt, opts: DescribeOptions): string | null {
  const body = s.body.filter((x) => x.kind !== 'comment');
  // Blink: « Led verte clignote (0,5 s / 0,5 s) » → « Led verte clignote 3 fois (0,5 s / 0,5 s) ».
  const prose = describeActions(program, body, opts);
  const blink = prose.length === 1 ? / clignote \(/.exec(prose[0].text) : null;
  if (blink) return prose[0].text.replace(' clignote (', ` clignote ${s.times} fois (`);
  // Countdown / count-up on a display: AFFICHEUR = 9 - compte; Delay_ms(1000);
  const [show, wait] = body;
  if (body.length === 2 && show.kind === 'display' && show.text === undefined && isPlainDelay(wait)) {
    const bus = busById(program, show.bus);
    const where = bus?.device === 'bcd' ? "l'afficheur" : (bus?.name ?? show.bus);
    const step = formatDuration(wait.ms, wait.unit);
    const v = show.value;
    const isCounter = (e: Expr) => e.kind === 'var' && e.name.toLowerCase() === s.counter.toLowerCase();
    if (v.kind === 'bin' && v.op === '-' && v.left.kind === 'num' && isCounter(v.right)) {
      const from = v.left.value;
      return `Décompte de ${from} à ${from - (s.times - 1)} sur ${where} (${step} par chiffre)`;
    }
    if (isCounter(v)) return `Compter de 0 à ${s.times - 1} sur ${where} (${step} par chiffre)`;
  }
  return null;
}

export function describeFor(program: Program, s: ForStmt, opts: DescribeOptions = {}): CounterLoopProse {
  const init = describeStmt(program, s.init).map((l) => l.text).join(' et ');
  const test = describeCond(program, s.cond, opts);
  const update = describeStmt(program, s.update).map((l) => l.text).join(' et ');
  const summary = s.text ?? `Tant que ${test}`;
  return { summary, box: [summary], init, test, update };
}

/** A statement list cut the way the organigramme draws it: runs of simple statements (one box) and control shapes. */
export type StmtSegment =
  | { kind: 'actions'; stmts: Stmt[] }
  | { kind: 'control'; stmt: Extract<Stmt, { kind: 'if' | 'while' | 'repeat' | 'for' | 'waitFor' }> };

/** Consecutive simple statements are grouped (one green box, see describeActions); each control statement stands alone. */
export function segmentStmts(stmts: readonly Stmt[]): StmtSegment[] {
  const out: StmtSegment[] = [];
  for (const s of stmts) {
    if (isSimpleStmt(s)) {
      const last = out[out.length - 1];
      if (last?.kind === 'actions') last.stmts.push(s);
      else out.push({ kind: 'actions', stmts: [s] });
    } else {
      out.push({ kind: 'control', stmt: s as Extract<Stmt, { kind: 'if' | 'while' | 'repeat' | 'for' | 'waitFor' }> });
    }
  }
  return out;
}

/** Title of a function's own chart: « Programme d'interruption » (Ch5–Ch6) or « Sous-programme clignoter() ». */
export function functionTitle(f: FunctionDef): string {
  return f.kind === 'interrupt' ? "Programme d'interruption" : `Sous-programme ${f.name}()`;
}
