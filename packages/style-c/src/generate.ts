// Program model → C source in the prof's exact style (research 00 §3, 02 §8, Critic corrections C1.5–C1.9):
//   // Définition des entrées / des sorties  (#define aliases, aligned)
//   // Macros pour commander les sorties     (LED_ON / LED_OFF, or empty as in demux.c)
//   void main() { locals; // Configuration des entrées … TRIS lines with `// RA0 : entrée L0`;
//   // Initialisation … ; // Boucle principale while(1) { … } }
// 4-space indentation, K&R opening braces, `}` alone then `else if (…) {` on the next line, `//` comments only.
import {
  busById, negateCond, pinBit, pinOf, pinUses, signalById, stmtVariables, trisMode, trisValue, walkStmts,
  type CodeStyle, type FunctionDef, type IfStmt, type Level, type PinName, type Port, type Program,
  type Signal, type Stmt, type Variable,
} from '@pic/program-model';
import { condC, exprC, portBit, signalRef, trisBit } from './format';

export interface GenerateOptions {
  /** Line terminator of the returned text (default '\n'; toMikroCFile converts to CRLF). */
  eol?: '\n' | '\r\n';
}

/** Lines of the C text produced by each statement, branch and function (1-based, inclusive). */
export type SourceMap = Record<string, { line: number; endLine: number }>;

export interface GenerateResult {
  source: string;
  map: SourceMap;
}

const INDENT = '    ';
/** Gap between a statement and its trailing comment (demux.c / status.c configuration lines). */
const COMMENT_GAP = 7;

interface Line {
  indent: number;
  code: string;
  /** Trailing comment text (without `//`). */
  comment?: string;
  /** Configuration-style comment: fixed 7-space gap instead of column alignment. */
  fixedGap?: boolean;
  /** Text appended verbatim (the demux.c register echo ` //PORTB.RB0=0;`). */
  suffix?: string;
  /** Lines sharing a key align their comments on one column (the `if` / `else if` / `else` lines of a chain). */
  align?: string;
  owners: string[];
}

/** A block whose trailing comments share one column (see Generator.block). */
interface AlignScope { key: string; indents: ReadonlySet<number> }

class Out {
  readonly lines: Line[] = [];
  private owners: string[] = [];
  private readonly scopes: AlignScope[] = [];
  /** Gap before the comment column of an alignment group (default COMMENT_GAP). */
  private readonly gaps = new Map<string, number>();

  /** Align the trailing comments of the lines pushed by `fn` at `indents` on one column (key `key`). */
  aligned(scope: AlignScope, gap: number, fn: () => void): void {
    this.scopes.push(scope);
    if (gap !== COMMENT_GAP) this.gaps.set(scope.key, gap);
    try { fn(); } finally { this.scopes.pop(); }
  }

  blank(): void {
    if (this.lines.length > 0 && this.lines[this.lines.length - 1].code !== '') this.lines.push({ indent: 0, code: '', owners: [] });
  }

  push(indent: number, code: string, extra: Partial<Pick<Line, 'comment' | 'fixedGap' | 'suffix' | 'align'>> = {}): void {
    const scope = this.scopes[this.scopes.length - 1];
    const align = extra.align ?? (extra.comment !== undefined && !extra.fixedGap && scope?.indents.has(indent) ? scope.key : undefined);
    this.lines.push({ indent, code, ...extra, ...(align !== undefined ? { align } : {}), owners: [...this.owners] });
  }

  comments(indent: number, text: string | undefined): void {
    if (text === undefined) return;
    for (const t of text.split('\n')) this.push(indent, t.trim() === '' ? '//' : `// ${t.trim()}`);
  }

  /** Attribute the lines emitted by `fn` to `id` (for the source map). */
  own(id: string, fn: () => void): void {
    this.owners.push(id);
    try { fn(); } finally { this.owners.pop(); }
  }

  render(eol: string): GenerateResult {
    const texts: string[] = this.lines.map((l) => INDENT.repeat(l.indent) + l.code);
    // Trailing comments: a fixed gap on configuration lines, one column per if/else chain, and a common column within
    // a run of consecutive commented lines at the same indentation (research C1.5).
    const groups = new Map<string, number>();
    this.lines.forEach((l, i) => {
      if (l.align !== undefined && l.comment !== undefined) {
        groups.set(l.align, Math.max(groups.get(l.align) ?? 0, texts[i].length + (this.gaps.get(l.align) ?? COMMENT_GAP)));
      }
    });
    for (let i = 0; i < this.lines.length; ) {
      const l = this.lines[i];
      if (l.comment === undefined) {
        if (l.suffix) texts[i] += l.suffix;
        i++;
        continue;
      }
      if (l.align !== undefined) {
        texts[i] = `${texts[i].padEnd(groups.get(l.align)!)}// ${l.comment}`;
        i++;
        continue;
      }
      if (l.fixedGap) {
        texts[i] += `${' '.repeat(COMMENT_GAP)}// ${l.comment}`;
        i++;
        continue;
      }
      let j = i;
      while (
        j < this.lines.length && this.lines[j].comment !== undefined && !this.lines[j].fixedGap
        && this.lines[j].align === undefined && this.lines[j].indent === l.indent
      ) j++;
      const col = Math.max(...texts.slice(i, j).map((t) => t.length)) + COMMENT_GAP;
      for (let k = i; k < j; k++) texts[k] = `${texts[k].padEnd(col)}// ${this.lines[k].comment}`;
      i = j;
    }
    const map: SourceMap = {};
    this.lines.forEach((l, i) => {
      for (const id of l.owners) {
        const m = map[id];
        if (m) m.endLine = i + 1;
        else map[id] = { line: i + 1, endLine: i + 1 };
      }
    });
    return { source: texts.map((t) => t.replace(/\s+$/, '')).join(eol) + eol, map };
  }
}

// ---------------------------------------------------------------------------------------------------------------

const isLedLike = (s: Signal) => s.dir === 'out' && (s.device === 'led' || s.device === 'lamp');

/** True when the LED_ON / LED_OFF macros are written (and used for LEDs and lamps). */
export function usesLedMacros(program: Program): boolean {
  return program.style.macros && program.signals.some((s) => isLedLike(s) && s.activeLevel === 1);
}

function macroFor(program: Program, s: Signal): boolean {
  return usesLedMacros(program) && isLedLike(s) && s.activeLevel === 1;
}

// trisMode / trisValue / pinUses live in @pic/program-model (the organigramme prose needs them too).
export { trisMode, trisValue };

interface TrisLine { key: number; dir: 'in' | 'out'; code: string; comment: string }

function trisLines(program: Program): TrisLine[] {
  const out: TrisLine[] = [];
  for (const port of ['A', 'B'] as const) {
    const uses = pinUses(program, port);
    if (uses.length === 0) continue;
    if (trisMode(program, port) === 'port') {
      const value = trisValue(program, port);
      const width = port === 'A' ? 5 : 8;
      const all = (1 << width) - 1;
      const inputs = uses.filter((u) => u.dir === 'in');
      let comment: string;
      let dir: 'in' | 'out';
      if (value === 0) { comment = `PORT${port} en sortie`; dir = 'out'; }
      else if (value === all) { comment = `PORT${port} en entrée`; dir = 'in'; }
      else {
        const ins: string[] = [];
        for (let bit = 0; bit < width; bit++) if ((value >> bit) & 1) ins.push(pinOf(port, bit)!);
        comment = `${ins.join(', ')} en entrée, les autres en sortie`;
        dir = inputs.length === uses.length ? 'in' : 'out';
      }
      out.push({ key: port === 'A' ? 0 : 100, dir, code: `TRIS${port} = ${hex(value)};`, comment });
    } else {
      for (const u of uses) {
        out.push({
          key: (port === 'A' ? 0 : 100) + pinBit(u.pin) + 1,
          dir: u.dir,
          code: `${trisBit(u.pin, program.style)} = ${u.dir === 'in' ? 1 : 0};`,
          comment: `${u.pin} : ${u.dir === 'in' ? 'entrée' : 'sortie'}${u.name ? ` ${u.name}` : ''}`,
        });
      }
    }
  }
  return out.sort((a, b) => a.key - b.key);
}

const hex = (v: number) => `0x${v.toString(16).toUpperCase().padStart(2, '0')}`;

const PRESCALER_BITS: Readonly<Record<number, number>> = { 2: 0, 4: 1, 8: 2, 16: 3, 32: 4, 64: 5, 128: 6, 256: 7 };

/** The INTCON / OPTION_REG lines of the configuration (fixed order, see fromAst). */
export function interruptLines(program: Program): { code: string; comment?: string }[] {
  const it = program.interrupts;
  if (!it) return [];
  const out: { code: string; comment?: string }[] = [];
  if (it.int) {
    out.push({ code: `OPTION_REG.INTEDG = ${it.int.edge === 'rising' ? 1 : 0};`, comment: `Front ${it.int.edge === 'rising' ? 'montant' : 'descendant'} sur RB0/INT` });
    out.push({ code: 'INTCON.INTE = 1;', comment: "Autoriser l'interruption RB0/INT" });
  }
  if (it.rbChange) out.push({ code: 'INTCON.RBIE = 1;', comment: "Autoriser l'interruption sur changement de RB4 à RB7" });
  if (it.tmr0) {
    out.push({ code: 'OPTION_REG.T0CS = 0;', comment: "TMR0 compte les cycles d'instruction" });
    if (it.tmr0.prescaler === 1) out.push({ code: 'OPTION_REG.PSA = 1;', comment: 'Pas de prédiviseur pour TMR0' });
    else {
      const ps = PRESCALER_BITS[it.tmr0.prescaler];
      out.push({ code: 'OPTION_REG.PSA = 0;', comment: `Prédiviseur 1:${it.tmr0.prescaler} affecté à TMR0` });
      out.push({ code: `OPTION_REG.PS2 = ${(ps >> 2) & 1};` });
      out.push({ code: `OPTION_REG.PS1 = ${(ps >> 1) & 1};` });
      out.push({ code: `OPTION_REG.PS0 = ${ps & 1};` });
    }
    out.push({ code: 'INTCON.T0IE = 1;', comment: "Autoriser l'interruption TMR0" });
  }
  if (it.gie) out.push({ code: 'INTCON.GIE = 1;', comment: 'Autoriser les interruptions' });
  return out;
}

/** Variables declared globally: explicitly, or because a function other than main uses them. */
export function globalVariables(program: Program): Set<string> {
  const used = new Set<string>();
  for (const f of program.functions) {
    walkStmts(f.body, (s) => { for (const v of stmtVariables(s)) used.add(v.toLowerCase()); });
  }
  return new Set(
    program.variables
      .filter((v) => v.scope === 'global' || (v.scope === undefined && used.has(v.name.toLowerCase())))
      .map((v) => v.name),
  );
}

/** True when the initialisation only switches outputs to 0 (« // Initialisation : toutes les sorties à 0 »). */
function initAllOutputsOff(program: Program): boolean {
  if (program.init.length === 0) return false;
  const off = new Set<string>();
  const busesOff = new Set<string>();
  for (const s of program.init) {
    if (s.kind === 'set' && s.value === 0) off.add(s.signal);
    else if (s.kind === 'setAll' && s.value === 0) s.signals.forEach((x) => off.add(x));
    else if (s.kind === 'display' && s.value.kind === 'num' && s.value.value === 0) busesOff.add(s.bus);
    else return false;
  }
  return program.signals.filter((x) => x.dir === 'out').every((x) => off.has(x.id))
    && program.buses.filter((b) => b.dir === 'out').every((b) => busesOff.has(b.id));
}

// ---------------------------------------------------------------------------------------------------------------

class Generator {
  private readonly out = new Out();
  private readonly style: CodeStyle;

  constructor(private readonly program: Program) {
    this.style = program.style;
  }

  run(eol: string): GenerateResult {
    this.header();
    this.globals();
    for (const f of this.program.functions) this.func(f);
    this.main();
    return this.out.render(eol);
  }

  // ------------------------------------------------------------------------------------------------- header

  private header(): void {
    const p = this.program;
    const o = this.out;
    const defined = p.signals.filter((s) => s.useDefine !== false);
    const inputs: { name: string; target: string; comment?: string }[] = [];
    const outputs: { name: string; target: string; comment?: string }[] = [];
    for (const s of defined) (s.dir === 'in' ? inputs : outputs).push({ name: s.name, target: portBit(s.pin, this.style), comment: s.comment });
    for (const b of p.buses) (b.dir === 'in' ? inputs : outputs).push({ name: b.name, target: `PORT${b.port}`, comment: b.comment });
    const width = Math.max(0, ...[...inputs, ...outputs].map((d) => d.name.length));
    // Comments of the #define lines (rare: she never comments them) share one column over the whole header.
    const define = (d: { name: string; target: string; comment?: string }) =>
      o.push(0, `#define ${d.name.padEnd(width)} ${d.target}`, d.comment !== undefined ? { comment: d.comment, align: 'defines' } : {});
    if (inputs.length > 0) {
      o.push(0, '// Définition des entrées');
      inputs.forEach(define);
      o.blank();
    }
    if (outputs.length > 0) {
      o.push(0, '// Définition des sorties');
      outputs.forEach(define);
      o.blank();
    }
    o.push(0, '// Macros pour commander les sorties');
    if (usesLedMacros(p)) {
      o.push(0, '#define LED_ON(pin)  (pin = 1)');
      o.push(0, '#define LED_OFF(pin) (pin = 0)');
    }
    for (const d of p.rawDefines ?? []) o.push(0, d);
    o.blank();
    // Constants after the macros, each led by its comment line (her only constant, Memoire's `#define MAX 10`, has no
    // section header of its own).
    if (p.constants.length > 0) {
      const cw = Math.max(...p.constants.map((c) => c.name.length));
      for (const c of p.constants) {
        o.comments(0, c.comment);
        o.push(0, `#define ${c.name.padEnd(cw)} ${exprC(p, { kind: 'num', value: c.value, radix: c.radix })}`);
      }
      o.blank();
    }
  }

  private globals(): void {
    const p = this.program;
    const globals = globalVariables(p);
    const vars = p.variables.filter((v) => globals.has(v.name));
    if (vars.length > 0) {
      this.out.push(0, '// Variables globales');
      this.declarations(0, vars);
      this.out.blank();
    }
    if (p.rawGlobals && p.rawGlobals.length > 0) {
      for (const g of p.rawGlobals) for (const l of g.split('\n')) this.out.push(0, l);
      this.out.blank();
    }
  }

  /** status.c: `unsigned char x; unsigned char y; unsigned char z;` on one line (one per line when commented). */
  private declarations(indent: number, vars: Variable[]): void {
    if (vars.some((v) => v.comment !== undefined)) {
      for (const v of vars) this.out.push(indent, `${v.type} ${v.name};`, v.comment !== undefined ? { comment: v.comment } : {});
    } else {
      this.out.push(indent, vars.map((v) => `${v.type} ${v.name};`).join(' '));
    }
  }

  private func(f: FunctionDef): void {
    this.out.own(f.id, () => {
      this.out.comments(0, f.lead);
      this.out.push(0, `void ${f.kind === 'interrupt' ? 'interrupt' : f.name}() {`);
      this.block(1, f.body, false);
      this.out.push(0, '}');
    });
    this.out.blank();
  }

  // ------------------------------------------------------------------------------------------------- main

  private main(): void {
    const p = this.program;
    const o = this.out;
    o.push(0, 'void main() {');
    const globals = globalVariables(p);
    const locals = p.variables.filter((v) => !globals.has(v.name));
    if (locals.length > 0) this.declarations(1, locals);
    o.blank();

    const tris = trisLines(p);
    const config = (l: TrisLine) => o.push(1, l.code, { comment: l.comment, fixedGap: true });
    if (this.style.sections === 'status') {
      if (tris.length > 0) {
        o.push(1, '// Configuration  i/o');
        tris.forEach(config);
        o.blank();
      }
    } else {
      const ins = tris.filter((l) => l.dir === 'in');
      const outs = tris.filter((l) => l.dir === 'out');
      if (ins.length > 0) {
        o.push(1, '// Configuration des entrées');
        ins.forEach(config);
        o.blank();
      }
      if (outs.length > 0) {
        o.push(1, '// Configuration des sorties');
        outs.forEach(config);
        o.blank();
      }
    }
    const it = interruptLines(p);
    if (it.length > 0) {
      o.push(1, '// Configuration des interruptions');
      for (const l of it) o.push(1, l.code, l.comment !== undefined ? { comment: l.comment, fixedGap: true } : {});
      o.blank();
    }

    if (p.init.length > 0) {
      const title = this.style.sections === 'demux' && initAllOutputsOff(p) ? '// Initialisation : toutes les sorties à 0' : '// Initialisation';
      o.push(1, title);
      this.block(1, p.init, true);
      o.blank();
    }

    if (p.loop) {
      o.push(1, this.style.sections === 'status' ? '// Traitement' : '// Boucle principale');
      o.push(1, 'while(1) {');
      this.block(2, p.loop, false);
      o.push(1, '}');
    } else {
      // No loop: main() ends; MikroC parks the CPU on a GOTO $ (EXEMPLE1).
      this.trimBlank();
    }
    o.push(0, '}');
  }

  private trimBlank(): void {
    const lines = this.out.lines;
    while (lines.length > 0 && lines[lines.length - 1].code === '') lines.pop();
  }

  // ------------------------------------------------------------------------------------------------- statements

  /**
   * A statement list at `indent`. When it holds an if / else-if chain with comments on its heads, every trailing
   * comment of the list and of the chain's first-level bodies shares one column (research C1.5: one column per group
   * of related statements; the `z = x - y;` before the chain belongs to it). One-line chains (status.c) use her
   * 3–4-space gap, others the usual 7.
   */
  private block(indent: number, list: readonly Stmt[], init: boolean): void {
    const chains = list.filter((s): s is IfStmt => s.kind === 'if' && hasHeadComments(s));
    const emit = () => {
      for (let i = 0; i < list.length;) {
        const n = this.packRun(list, i, init);
        if (n > 1) this.packed(indent, list.slice(i, i + n));
        else this.stmt(indent, list[i], init);
        i += Math.max(1, n);
      }
    };
    if (chains.length === 0) {
      emit();
      return;
    }
    const gap = chains.every((c) => this.oneLineChain(c)) ? ONE_LINE_CHAIN_GAP : COMMENT_GAP;
    this.out.aligned({ key: `blk:${chains[0].id || `${indent}:${this.out.lines.length}`}`, indents: new Set([indent, indent + 1]) }, gap, emit);
  }

  /**
   * status.c packs runs of similar simple statements on one line (`x = 6; y = 6;`, `LED_OFF(…); LED_OFF(…);`):
   * with style.packLines, the length of such a run starting at `i` (constant assignments to variables, or writes of
   * one level to signals). Only the first statement may have a comment line above, only the last a trailing comment.
   */
  private packRun(list: readonly Stmt[], i: number, init: boolean): number {
    if (!this.style.packLines) return 1;
    const kindOf = (s: Stmt): string | null => {
      if (s.kind === 'assign' && s.target.kind === 'var' && s.value.kind === 'num') return 'const';
      if (s.kind === 'set') {
        const sig = signalById(this.program, s.signal);
        // demux.c's echo comment (`D0=0; //PORTB.RB0=0;`) needs one write per line.
        if (init && this.style.echoRegister && sig && sig.useDefine !== false && !macroFor(this.program, sig)) return null;
        return `set:${s.value}`;
      }
      return null;
    };
    const kind = kindOf(list[i]);
    if (kind === null) return 1;
    let j = i;
    while (j < list.length && kindOf(list[j]) === kind && (j === i || list[j].lead === undefined)) {
      j++;
      if (list[j - 1].comment !== undefined) break;
    }
    return j - i;
  }

  /** One line for a packed run (see packRun). */
  private packed(indent: number, run: readonly Stmt[]): void {
    const last = run[run.length - 1];
    const emit = (k: number): void => {
      if (k < run.length) {
        this.out.own(run[k].id, () => emit(k + 1));
        return;
      }
      this.out.comments(indent, run[0].lead);
      this.out.push(indent, run.map((s) => this.simple(s)).join(' '), this.trailing(last));
    };
    emit(0);
  }

  private stmt(indent: number, s: Stmt, init: boolean): void {
    this.out.own(s.id, () => {
      this.out.comments(indent, s.lead);
      this.stmtBody(indent, s, init);
    });
  }

  private trailing(s: Stmt): Partial<Pick<Line, 'comment'>> {
    return s.comment !== undefined ? { comment: s.comment } : {};
  }

  private stmtBody(indent: number, s: Stmt, init: boolean): void {
    const p = this.program;
    const o = this.out;
    switch (s.kind) {
      case 'set':
        this.write(indent, s.signal, s.value, init, s.comment);
        return;
      case 'setAll':
        s.signals.forEach((id, k) => this.write(indent, id, s.value, init, k === 0 ? s.comment : undefined));
        return;
      case 'if':
        this.ifStmt(indent, s);
        return;
      case 'while':
        o.push(indent, `while (${condC(p, s.cond)}) {`, this.trailing(s));
        this.block(indent + 1, s.body, false);
        o.push(indent, '}');
        return;
      case 'waitFor':
        o.push(indent, `while (${condC(p, negateCond(s.cond))});`, this.trailing(s));
        return;
      case 'repeat':
        o.push(indent, `for (${s.counter} = 0; ${s.counter} < ${s.times}; ${s.counter}++) {`, this.trailing(s));
        this.block(indent + 1, s.body, false);
        o.push(indent, '}');
        return;
      case 'for':
        o.push(indent, `for (${this.simple(s.init).slice(0, -1)}; ${condC(p, s.cond)}; ${this.simple(s.update).slice(0, -1)}) {`, this.trailing(s));
        this.block(indent + 1, s.body, false);
        o.push(indent, '}');
        return;
      case 'comment':
        o.comments(indent, s.text);
        return;
      case 'raw':
        // The trailing comment of a statement sits at the end of its first line.
        dedent(s.code).forEach((l, k) => o.push(indent, l, k === 0 ? this.trailing(s) : {}));
        return;
      default:
        o.push(indent, this.simple(s), this.trailing(s));
    }
  }

  /** One-line C of a simple statement (with its `;`). */
  private simple(s: Stmt): string {
    const p = this.program;
    switch (s.kind) {
      case 'set': return this.writeCode(s.signal, s.value);
      case 'toggle': {
        const sig = signalById(p, s.signal);
        const ref = sig ? signalRef(sig, this.style) : s.signal;
        return `${ref} = !${ref};`;
      }
      case 'display': return `${busById(p, s.bus)?.name ?? s.bus} = ${exprC(p, s.value)};`;
      case 'assign':
        // status.c writes the whole STATUS register without spaces: `STATUS=0;`.
        if (s.target.kind === 'reg' && !s.target.bit && s.target.name.toUpperCase() === 'STATUS') return `${exprC(p, s.target)}=${exprC(p, s.value)};`;
        return `${exprC(p, s.target)} = ${exprC(p, s.value)};`;
      case 'incr': return `${s.variable}++;`;
      case 'decr': return `${s.variable}--;`;
      case 'delay': return `Delay_${s.unit === 'us' ? 'us' : 'ms'}(${s.ms});`;
      case 'call': return `${s.name}();`;
      case 'clearFlag': return `INTCON.${s.flag} = 0;`;
      default: return '';
    }
  }

  private writeCode(signalId: string, value: Level): string {
    const sig = signalById(this.program, signalId);
    if (!sig) return `${signalId} = ${value};`;
    const ref = signalRef(sig, this.style);
    if (macroFor(this.program, sig)) return `${value === 1 ? 'LED_ON' : 'LED_OFF'}(${ref});`;
    return this.style.compactAssign ? `${ref}=${value};` : `${ref} = ${value};`;
  }

  private write(indent: number, signalId: string, value: Level, init: boolean, comment: string | undefined): void {
    const code = this.writeCode(signalId, value);
    const sig = signalById(this.program, signalId);
    if (comment !== undefined) {
      this.out.push(indent, code, { comment });
      return;
    }
    // demux.c echoes the register after each initialisation write: `D0=0; //PORTB.RB0=0;`.
    if (init && this.style.echoRegister && sig && sig.useDefine !== false && !macroFor(this.program, sig)) {
      this.out.push(indent, code, { suffix: ` //${portBit(sig.pin, this.style)}=${value};` });
      return;
    }
    this.out.push(indent, code);
  }

  /** Comment of an `if` / `else if` / `else` line; all lines of one chain share a column (see block()). */
  private headComment(_s: IfStmt, comment: string | undefined): Partial<Pick<Line, 'comment' | 'align'>> {
    return comment !== undefined ? { comment } : {};
  }

  private oneLineChain(s: IfStmt): boolean {
    if (!this.style.oneLineBranches) return false;
    const bodies = [...s.branches.map((b) => b.body), ...(s.otherwise ? [s.otherwise.body] : [])];
    return bodies.every((body) => body.length === 1 && isOneLiner(body[0]));
  }

  private ifStmt(indent: number, s: IfStmt): void {
    const p = this.program;
    const o = this.out;
    if (this.oneLineChain(s)) {
      s.branches.forEach((b, k) => o.own(b.id, () => {
        const head = k === 0 ? 'if' : 'else if';
        o.own(b.body[0].id, () => o.push(indent, `${head} (${condC(p, b.cond)}) { ${this.simple(b.body[0])} }`, this.headComment(s, b.comment)));
      }));
      if (s.otherwise) {
        const e = s.otherwise;
        o.own(e.id, () => o.own(e.body[0].id, () => o.push(indent, `else { ${this.simple(e.body[0])} }`, this.headComment(s, e.comment))));
      }
      return;
    }
    s.branches.forEach((b, k) => o.own(b.id, () => {
      o.push(indent, `${k === 0 ? 'if' : 'else if'} (${condC(p, b.cond)}) {`, this.headComment(s, b.comment));
      this.block(indent + 1, b.body, false);
      o.push(indent, '}');
    }));
    if (s.otherwise) {
      const e = s.otherwise;
      o.own(e.id, () => {
        o.push(indent, 'else {', this.headComment(s, e.comment));
        this.block(indent + 1, e.body, false);
        o.push(indent, '}');
      });
    }
  }
}

/** Gap before the comments of a one-line if / else chain (status.c: 3–4 spaces after the longest line). */
const ONE_LINE_CHAIN_GAP = 4;

const hasHeadComments = (s: IfStmt): boolean =>
  s.branches.some((b) => b.comment !== undefined) || s.otherwise?.comment !== undefined;

/** Statements printed on one line without comments of their own (candidates for `if (…) { stmt }`). */
function isOneLiner(s: Stmt): boolean {
  if (s.comment !== undefined || s.lead !== undefined) return false;
  return s.kind === 'set' || s.kind === 'toggle' || s.kind === 'display' || s.kind === 'assign' || s.kind === 'incr'
    || s.kind === 'decr' || s.kind === 'delay' || s.kind === 'call' || s.kind === 'clearFlag';
}

/** Lines of a raw statement with their common indentation removed. */
function dedent(code: string): string[] {
  const lines = code.replace(/\r\n?/g, '\n').split('\n');
  const rest = lines.slice(1).filter((l) => l.trim() !== '');
  const min = rest.length ? Math.min(...rest.map((l) => l.length - l.trimStart().length)) : 0;
  return lines.map((l, i) => (i === 0 ? l.trim() : l.slice(Math.min(min, l.length - l.trimStart().length)).trimEnd()));
}

/** C source of a program in the prof's style. */
export function generate(program: Program, options: GenerateOptions = {}): string {
  return generateWithMap(program, options).source;
}

/** C source plus, for every statement / branch / function id, the lines it produced. */
export function generateWithMap(program: Program, options: GenerateOptions = {}): GenerateResult {
  return new Generator(program).run(options.eol ?? '\n');
}

