// Hand-written C (the compiler's typed AST) → Program model, best effort and never throwing:
// - `#define NAME PORTx.Rxn` → signals, `#define NAME PORTx` → buses, `#define NAME 0xCA` → constants;
// - TRIS writes → signal directions and the TRIS style; INTCON / OPTION_REG set-up → interrupts;
// - statements before `while(1)` → init, the `while(1)` body → loop (none: main simply ends);
// - her section comments (« // Configuration… », « // Initialisation… », « // Traitement », « // Boucle principale »)
//   are recognised and dropped (the generator writes them back);
// - `STATUS.F2` / `STATUS.F0` tests → flag conditions (« ZERO==1 », « CARRY==1 »);
// - anything else is kept verbatim as a raw statement / expression / condition.
// generate(fromAst(compile(generate(p)).ast)) === generate(p) for every program the generator writes.
import {
  analyze, findSfr, resolveBitSelector,
  type Comment, type CompileOptions, type Diagnostic, type Expression, type FunctionDeclaration, type MacroDefinition,
  type Statement, type TranslationUnit, type TypeSpec,
} from '@pic/compiler';
import { defaultStyle, ensureIds } from './builders';
import { busPins, comparePins, pinBit, pinOf, pinPort } from './pins';
import { negateCond } from './walk';
import {
  PROGRAM_VERSION,
  type AssignStmt, type Bus, type CodeStyle, type Cond, type ElseBranch, type Expr, type FlagName, type FunctionDef,
  type IfBranch, type InterruptConfig, type Level, type LValue, type PinName, type Port, type Prescaler, type Program,
  type Radix, type Signal, type SignalDevice, type Stmt, type StmtBase, type VarType, type Variable,
} from './types';

export interface FromAstOptions {
  /** Title of the resulting program (default « Programme importé »). */
  title?: string;
  /** Clock of the project (the C text does not carry it). Default 1 MHz. */
  clockHz?: number;
}

export interface FromAstResult {
  program: Program;
  /** What could not be represented exactly (French, for the UI). */
  notes: string[];
}

/** Her section comments: dropped on import, written back by the generator. */
const SECTION_COMMENT = /^(configuration\b|initialisation\b|traitement$|boucle principale$|programme pri?n?cipal$|d[ée]finition des (entr[ée]es|sorties)$|macros pour commander|constantes$|variables globales$)/i;
const ECHO_COMMENT = /^PORT[AB]\.\w+\s*=\s*[01]\s*;?$/i;
const LAMP_NAME = /^(FEU_)?(ROUGE|ORANGE|VERT|VERTE|JAUNE)$/i;
const BCD_NAME = /AFF|SEG|BCD|DISP/i;

const isIntLiteral = (e: Expression | null | undefined): e is Extract<Expression, { kind: 'NumberLiteral' }> =>
  !!e && e.kind === 'NumberLiteral';
const isBit = (e: Expression | null | undefined): e is Extract<Expression, { kind: 'NumberLiteral' }> =>
  isIntLiteral(e) && (e.value === 0 || e.value === 1);

const radixOf = (r: number): Radix => (r === 16 ? 16 : r === 2 ? 2 : 10);

/** Upper-case register name of `REG` or `REG.bit` targets. */
function regName(e: Expression): string | undefined {
  if (e.kind === 'Identifier') return findSfr(e.name)?.name;
  return undefined;
}

/** (register, bit number) of `REG.bit`, when REG is a SFR. */
function regBit(e: Expression): { reg: string; bit: number; sel: string } | undefined {
  if (e.kind !== 'BitAccess') return undefined;
  const reg = regName(e.object);
  const bit = resolveBitSelector(e.bit);
  return reg && bit !== undefined ? { reg, bit, sel: e.bit } : undefined;
}

const FLAG_BITS: Readonly<Record<string, Partial<Record<number, FlagName>>>> = {
  STATUS: { 0: 'C', 1: 'DC', 2: 'Z' },
  INTCON: { 0: 'RBIF', 1: 'INTF', 2: 'T0IF' },
};

const VAR_TYPES: Readonly<Record<string, VarType>> = {
  'char/unsigned': 'unsigned char',
  'char/signed': 'signed char',
  'char/default': 'char',
  'short/unsigned': 'unsigned char',
  'int/unsigned': 'unsigned int',
  'int/signed': 'int',
  'int/default': 'int',
};

function varType(t: TypeSpec): VarType | undefined {
  if (t.isConst || t.storage !== 'none' || t.typedefName) return undefined;
  return VAR_TYPES[`${t.base}/${t.signedness}`];
}

interface AliasSignal { signal: Signal; usedWithMacro: boolean; written: boolean }

class Reader {
  readonly notes: string[] = [];
  private readonly style: CodeStyle = defaultStyle();
  private readonly signals = new Map<string, AliasSignal>(); // upper-case name → signal
  private readonly pinSignals = new Map<PinName, AliasSignal>();
  private readonly buses = new Map<string, Bus>();
  private readonly busWrites = new Map<string, number[]>(); // bus id → constant values written
  private readonly constants = new Map<string, Program['constants'][number]>();
  private readonly variables: Variable[] = [];
  private readonly rawDefines: string[] = [];
  private readonly rawGlobals: string[] = [];
  private readonly functions: FunctionDef[] = [];
  private readonly trisBits = new Map<PinName, 'in' | 'out'>();
  private readonly trisPort = new Map<Port, number>();
  private interrupts: Partial<InterruptConfig> & { edge?: 'rising' | 'falling'; inte?: boolean; t0ie?: boolean; psa?: number; ps?: number } = {};
  private readonly ids = new Set<string>();
  /** Every function the file defines (a user `delay_ms()` hides MikroC's built-in, names being case-insensitive). */
  private readonly userFunctions = new Set<string>();
  private macrosDefined = false;
  private sawIndexNotation = false;
  private sawPinNotation = false;
  private sawStatusSections = false;
  private sawEcho = false;
  private sawOneLine = false;
  /** Two simple statements written on one line (status.c `x = 6; y = 6;`). */
  private sawPacked = false;
  private sawSpacedAssign = false;
  private sawCompactAssign = false;

  constructor(private readonly unit: TranslationUnit, private readonly source: string) {}

  /** Signal / bus id from a C name: lower case, unique (`led`, `led_2`). */
  private newId(name: string): string {
    const base = name.toLowerCase();
    let id = base;
    for (let k = 2; this.ids.has(id); k++) id = `${base}_${k}`;
    this.ids.add(id);
    return id;
  }

  read(options: FromAstOptions): Program {
    this.readMacros();
    for (const item of this.unit.body) if (item.kind === 'FunctionDeclaration') this.userFunctions.add(item.name.toLowerCase());
    let main: FunctionDeclaration | undefined;
    for (const item of this.unit.body) {
      if (item.kind === 'FunctionDeclaration') {
        if (!item.body) continue; // prototypes are not needed: functions are written before main()
        if (item.name.toLowerCase() === 'main') { main = item; continue; }
        this.readFunction(item);
      } else if (item.kind === 'DeclarationStatement') {
        this.readDeclarations(item, 'global');
      } else {
        this.rawGlobals.push(this.slice(item));
      }
    }
    let init: Stmt[] = [];
    let loop: Stmt[] | null = null;
    if (main?.body) ({ init, loop } = this.readMain(main.body.body));
    else this.notes.push('Aucune fonction main() trouvée.');
    const program = this.finish(options, init, loop);
    return ensureIds(program);
  }

  // ------------------------------------------------------------------------------------------- preprocessor

  private readMacros(): void {
    const ledMacros = new Set<string>();
    for (const m of this.unit.macros) {
      if (m.undefinedAtLine !== undefined) continue;
      const body = m.body.trim();
      // A constant may carry its comment on the line above (`// Réponse correcte…` / `#define REPONSE 0xCA`).
      const lead = m.leadingComments.map((c) => c.text).filter((t) => !SECTION_COMMENT.test(t));
      const comment = m.trailingComment?.text ?? (m.params === null && /^(0x[0-9a-f]+|0b[01]+|\d+)$/i.test(body) && lead.length > 0 ? lead.join('\n') : undefined);
      if (m.params !== null) {
        const name = m.name.toUpperCase();
        if ((name === 'LED_ON' || name === 'LED_OFF') && m.params.length === 1
          && new RegExp(`^\\(\\s*${m.params[0]}\\s*=\\s*${name === 'LED_ON' ? 1 : 0}\\s*\\)$`).test(body)) {
          ledMacros.add(name);
          continue;
        }
        this.rawDefines.push(this.macroText(m));
        continue;
      }
      const bit = /^(PORT[AB])\s*\.\s*(\w+)$/i.exec(body);
      if (bit) {
        const port = bit[1].toUpperCase().slice(4) as Port;
        const n = resolveBitSelector(bit[2]);
        const pin = n === undefined ? undefined : pinOf(port, n);
        if (pin) {
          this.noteNotation(bit[2]);
          const signal: Signal = { id: this.newId(m.name), name: m.name, pin, dir: 'out', label: m.name, activeLevel: 1 };
          if (comment !== undefined) signal.comment = comment;
          const a: AliasSignal = { signal, usedWithMacro: false, written: false };
          this.signals.set(m.name.toUpperCase(), a);
          if (!this.pinSignals.has(pin)) this.pinSignals.set(pin, a);
          continue;
        }
      }
      const port = /^PORT([AB])$/i.exec(body);
      if (port) {
        const bus: Bus = {
          id: this.newId(m.name), name: m.name, port: port[1].toUpperCase() as Port, lsb: 0, width: 8, dir: 'out', label: m.name,
        };
        if (comment !== undefined) bus.comment = comment;
        this.buses.set(m.name.toUpperCase(), bus);
        continue;
      }
      const num = /^(0x[0-9a-f]+|0b[01]+|\d+)$/i.exec(body);
      if (num) {
        const t = num[1].toLowerCase();
        const value = t.startsWith('0x') ? parseInt(t.slice(2), 16) : t.startsWith('0b') ? parseInt(t.slice(2), 2) : parseInt(t, 10);
        const radix: Radix = t.startsWith('0x') ? 16 : t.startsWith('0b') ? 2 : 10;
        this.constants.set(m.name.toUpperCase(), { name: m.name, value, ...(radix !== 10 ? { radix } : {}), ...(comment !== undefined ? { comment } : {}) });
        continue;
      }
      this.rawDefines.push(this.macroText(m));
    }
    this.macrosDefined = ledMacros.has('LED_ON') && ledMacros.has('LED_OFF');
    if (ledMacros.size === 1) {
      // Only one of the pair: keep it verbatim so the code still compiles.
      for (const m of this.unit.macros) if (ledMacros.has(m.name.toUpperCase())) this.rawDefines.push(this.macroText(m));
    }
  }

  private macroText(m: MacroDefinition): string {
    const text = this.source.slice(m.span.start, m.span.end).trim();
    return m.trailingComment ? `${text}       ${m.trailingComment.raw}` : text;
  }

  private noteNotation(sel: string): void {
    if (/^[FB]\d+$/i.test(sel)) this.sawIndexNotation = true;
    else if (/^R[AB]\d$/i.test(sel)) this.sawPinNotation = true;
  }

  // ------------------------------------------------------------------------------------------- top level

  private slice(node: { span: { start: number; end: number } }): string {
    return this.source.slice(node.span.start, node.span.end);
  }

  private readFunction(f: FunctionDeclaration): void {
    const simple = f.isInterrupt || (f.params.length === 0 && f.returnType.base === 'void');
    if (!simple || !f.body) {
      this.rawGlobals.push(this.slice(f));
      this.notes.push(`La fonction ${f.name}() est conservée telle quelle (paramètres ou valeur de retour).`);
      return;
    }
    const lead = this.leadText(f.leadingComments, false);
    this.functions.push({
      id: '',
      name: f.isInterrupt ? 'interrupt' : f.name,
      kind: f.isInterrupt ? 'interrupt' : 'function',
      body: this.block(f.body),
      ...(lead !== undefined ? { lead } : {}),
    });
  }

  /** Declarations → variables; returns initialiser assignments (to keep in the program flow). */
  private readDeclarations(d: Extract<Statement, { kind: 'DeclarationStatement' }>, scope: 'global' | 'main'): Stmt[] {
    const out: Stmt[] = [];
    const t = d.declarations[0] ? varType(d.declarations[0].typeSpec) : undefined;
    const plain = t && d.declarations.every((x) => !x.isArray && !x.absolute && (x.init === null || x.init.kind !== 'InitializerList'));
    if (!plain) {
      if (scope === 'global') this.rawGlobals.push(this.slice(d));
      else out.push(this.raw(d));
      return out;
    }
    for (const x of d.declarations) {
      const v: Variable = { name: x.name, type: t, scope };
      if (d.trailingComment && d.declarations.length === 1) v.comment = d.trailingComment.text;
      this.variables.push(v);
      if (x.init && x.init.kind !== 'InitializerList') {
        if (scope === 'global') {
          this.notes.push(`La valeur initiale de ${x.name} est déplacée dans l'initialisation.`);
        }
        out.push({ ...this.base(d, false), kind: 'assign', target: { kind: 'var', name: x.name }, value: this.expr(x.init) } as AssignStmt);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------- main

  private readMain(body: Statement[]): { init: Stmt[]; loop: Stmt[] | null } {
    const init: Stmt[] = [];
    // Set-up writes that only belong to the interrupt configuration if the matching enable bit is written too.
    const pending: { index: number; node: Statement; needs: 'int' | 'tmr0' }[] = [];
    let loop: Stmt[] | null = null;
    this.notePacking(body);
    for (let i = 0; i < body.length; i++) {
      const s = body[i];
      this.checkSectionComments(s);
      if (s.kind === 'WhileStatement' && isIntLiteral(s.test) && s.test.value !== 0 && loop === null) {
        loop = this.block(s.body);
        if (i < body.length - 1) this.notes.push('Les instructions après while(1) ne sont jamais exécutées : elles sont ignorées.');
        break;
      }
      if (s.kind === 'DeclarationStatement') {
        init.push(...this.readDeclarations(s, 'main'));
        continue;
      }
      const cfg = this.configWrite(s);
      if (cfg === 'consumed') continue;
      if (cfg === 'tmr0' || cfg === 'int') {
        pending.push({ index: init.length, node: s, needs: cfg });
        continue;
      }
      init.push(...this.stmt(s, true));
    }
    for (const p of [...pending].reverse()) {
      const kept = p.needs === 'int' ? this.interrupts.inte : this.interrupts.t0ie;
      if (!kept) init.splice(p.index, 0, ...this.stmt(p.node, true));
    }
    if (!this.interrupts.inte) delete this.interrupts.edge;
    return { init, loop };
  }

  private checkSectionComments(s: Statement): void {
    for (const c of s.leadingComments) {
      if (/^traitement$/i.test(c.text) || /^configuration\s+i\/o$/i.test(c.text)) this.sawStatusSections = true;
    }
  }

  /** TRIS / INTCON / OPTION_REG writes of the configuration section. */
  private configWrite(s: Statement): 'consumed' | 'tmr0' | 'int' | null {
    if (s.kind !== 'ExpressionStatement') return null;
    const e = s.expression;
    if (e.kind !== 'AssignmentExpression' || e.operator !== '=' || !isIntLiteral(e.right)) return null;
    const value = e.right.value;
    // TRISx = value
    const whole = regName(e.left);
    if (whole === 'TRISA' || whole === 'TRISB') {
      this.trisPort.set(whole === 'TRISA' ? 'A' : 'B', value);
      return 'consumed';
    }
    const rb = regBit(e.left);
    if (!rb) return null;
    if ((rb.reg === 'TRISA' || rb.reg === 'TRISB') && (value === 0 || value === 1)) {
      const pin = pinOf(rb.reg === 'TRISA' ? 'A' : 'B', rb.bit);
      if (!pin) return null;
      this.noteNotation(rb.sel);
      this.trisBits.set(pin, value === 1 ? 'in' : 'out');
      return 'consumed';
    }
    const it = this.interrupts;
    if (rb.reg === 'OPTION_REG') {
      if (rb.bit === 6 && (value === 0 || value === 1)) { it.edge = value === 1 ? 'rising' : 'falling'; return 'int'; }
      if (rb.bit === 5 && value === 0) return 'tmr0';
      if (rb.bit === 3 && (value === 0 || value === 1)) { it.psa = value; return 'tmr0'; }
      if (rb.bit <= 2 && (value === 0 || value === 1)) { it.ps = (it.ps ?? 0) | (value << rb.bit); return 'tmr0'; }
      return null;
    }
    if (rb.reg === 'INTCON' && value === 1) {
      if (rb.bit === 4) { it.inte = true; return 'consumed'; }
      if (rb.bit === 3) { it.rbChange = true; return 'consumed'; }
      if (rb.bit === 5) { it.t0ie = true; return 'consumed'; }
      if (rb.bit === 7) { it.gie = true; return 'consumed'; }
    }
    return null;
  }

  // ------------------------------------------------------------------------------------------- statements

  private leadText(comments: Comment[], dropSections: boolean): string | undefined {
    const lines = comments.map((c) => c.text).filter((t) => !(dropSections && SECTION_COMMENT.test(t)));
    return lines.length > 0 ? lines.join('\n') : undefined;
  }

  private base(s: Statement, init: boolean): StmtBase {
    const out: StmtBase = { id: '' };
    const lead = this.leadText(s.leadingComments, true);
    if (lead !== undefined) out.lead = lead;
    const c = s.trailingComment?.text;
    if (c !== undefined) {
      if (init && ECHO_COMMENT.test(c)) this.sawEcho = true;
      else out.comment = c;
    }
    return out;
  }

  private raw(s: Statement): Stmt {
    const b = this.base(s, false);
    // A multi-line statement's first-line comment is inside its span: it is already part of the verbatim text.
    const c = s.trailingComment;
    if (c && c.span.start >= s.span.start && c.span.end <= s.span.end) delete b.comment;
    return { ...b, kind: 'raw', code: this.slice(s).replace(/\r\n?/g, '\n') };
  }

  /** Notice simple statements sharing a line (style.packLines). */
  private notePacking(list: readonly Statement[]): void {
    for (let i = 1; i < list.length && !this.sawPacked; i++) {
      const a = list[i - 1];
      const b = list[i];
      if (a.kind === 'ExpressionStatement' && b.kind === 'ExpressionStatement' && a.span.line === b.span.line) this.sawPacked = true;
    }
  }

  private block(s: Statement): Stmt[] {
    if (s.kind === 'Block') {
      this.notePacking(s.body);
      const out = s.body.flatMap((x) => this.stmt(x, false));
      for (const c of s.danglingComments) out.push({ id: '', kind: 'comment', text: c.text });
      return out;
    }
    return this.stmt(s, false);
  }

  private stmt(s: Statement, init: boolean): Stmt[] {
    switch (s.kind) {
      case 'ExpressionStatement': return [this.expressionStatement(s, init)];
      case 'IfStatement': return [this.ifStatement(s)];
      case 'WhileStatement': {
        const base = this.base(s, init);
        if (s.body.kind === 'EmptyStatement') return [{ ...base, kind: 'waitFor', cond: negateCond(this.cond(s.test)) }];
        return [{ ...base, kind: 'while', cond: this.cond(s.test), body: this.block(s.body) }];
      }
      case 'ForStatement': return [this.forStatement(s, init)];
      case 'DeclarationStatement': return this.readDeclarations(s, 'main');
      case 'EmptyStatement': return [];
      default: return [this.raw(s)];
    }
  }

  private expressionStatement(s: Extract<Statement, { kind: 'ExpressionStatement' }>, init: boolean): Stmt {
    const e = s.expression;
    const base = this.base(s, init);
    const macro = e.macro?.toUpperCase();
    // `LED_ON(PORTA.RA1)`: the argument does not come from the macro, so the node may carry no macro name.
    const ledMacro = macro === 'LED_ON' || macro === 'LED_OFF' || (this.macrosDefined && /^LED_O(N|FF)\s*\(/i.test(s.text));
    if (macro && !ledMacro && !this.signals.has(macro) && !this.buses.has(macro)) return this.raw(s);
    if (e.kind === 'AssignmentExpression' && e.operator === '=') {
      const sig = this.signalOf(e.left);
      if (sig) {
        // `LED = HIGH;` with `#define HIGH 1` keeps its constant (assign), `LED_ON(LED)` and `LED = 1` are pin writes.
        if (isBit(e.right) && (!e.right.macro || ledMacro)) {
          if (ledMacro) sig.usedWithMacro = true;
          else this.noteAssignSpacing(s.text);
          sig.written = true;
          return { ...base, kind: 'set', signal: sig.signal.id, value: e.right.value as Level };
        }
        if (e.right.kind === 'UnaryExpression' && e.right.operator === '!' && this.signalOf(e.right.argument) === sig) {
          sig.written = true;
          return { ...base, kind: 'toggle', signal: sig.signal.id };
        }
        sig.written = true;
        return { ...base, kind: 'assign', target: { kind: 'signal', id: sig.signal.id }, value: this.expr(e.right) };
      }
      const bus = this.busOf(e.left);
      if (bus) {
        const value = this.expr(e.right);
        this.busWrites.set(bus.id, [...(this.busWrites.get(bus.id) ?? []), upperBound(value)]);
        return { ...base, kind: 'display', bus: bus.id, value };
      }
      const rb = regBit(e.left);
      if (rb?.reg === 'INTCON' && isIntLiteral(e.right) && e.right.value === 0) {
        const f = FLAG_BITS.INTCON[rb.bit];
        if (f === 'INTF' || f === 'RBIF' || f === 'T0IF') return { ...base, kind: 'clearFlag', flag: f };
      }
      const target = this.lvalue(e.left);
      if (target) return { ...base, kind: 'assign', target, value: this.expr(e.right) };
      return this.raw(s);
    }
    if (e.kind === 'UpdateExpression' && e.argument.kind === 'Identifier' && !e.argument.macro && this.isVariable(e.argument.name)) {
      return { ...base, kind: e.operator === '++' ? 'incr' : 'decr', variable: this.variableName(e.argument.name) };
    }
    if (e.kind === 'CallExpression') {
      const name = e.callee.name;
      if (/^delay_(ms|us)$/i.test(name) && !this.userFunctions.has(name.toLowerCase()) && e.args.length === 1 && isIntLiteral(e.args[0]) && !e.args[0].macro) {
        const unit = name.toLowerCase().endsWith('us') ? 'us' : 'ms';
        return { ...base, kind: 'delay', ms: e.args[0].value, ...(unit === 'us' ? { unit } : {}) };
      }
      if (e.args.length === 0 && this.functions.some((f) => f.kind === 'function' && f.name.toLowerCase() === name.toLowerCase())) {
        return { ...base, kind: 'call', name: this.functions.find((f) => f.name.toLowerCase() === name.toLowerCase())!.name };
      }
    }
    return this.raw(s);
  }

  private noteAssignSpacing(text: string): void {
    const m = /^[^=]*?(\s*)=(\s*)/.exec(text);
    if (!m) return;
    if (m[1] === '' && m[2] === '') this.sawCompactAssign = true;
    else this.sawSpacedAssign = true;
  }

  private ifStatement(s: Extract<Statement, { kind: 'IfStatement' }>): Stmt {
    const base = this.base(s, false);
    const branches: IfBranch[] = [];
    let otherwise: ElseBranch | null = null;
    let cur: Statement | null = s;
    let first = true;
    while (cur && cur.kind === 'IfStatement') {
      const b: IfBranch = { id: '', cond: this.cond(cur.test), body: this.block(cur.consequent) };
      // The `if` line's comment belongs to the branch (base.comment would print it after the closing brace).
      const c = first ? base.comment : cur.trailingComment?.text;
      if (c !== undefined) b.comment = c;
      if (cur.consequent.kind === 'Block' && cur.consequent.span.line === cur.consequent.span.endLine) this.sawOneLine = true;
      branches.push(b);
      first = false;
      cur = cur.alternate;
    }
    if (cur) {
      otherwise = { id: '', body: this.block(cur) };
      const c = cur.trailingComment?.text;
      if (c !== undefined) otherwise.comment = c;
    }
    const out: Stmt = { ...base, kind: 'if', branches, otherwise };
    delete out.comment;
    return out;
  }

  private forStatement(s: Extract<Statement, { kind: 'ForStatement' }>, init: boolean): Stmt {
    const base = this.base(s, init);
    const { init: i, test, update } = s;
    // for (v = 0; v < N; v++) → repeat N times
    if (
      i && i.kind === 'AssignmentExpression' && i.operator === '=' && i.left.kind === 'Identifier' && this.isVariable(i.left.name)
      && isIntLiteral(i.right) && i.right.value === 0 && !i.right.macro
      && test && test.kind === 'BinaryExpression' && test.operator === '<' && test.left.kind === 'Identifier'
      && test.left.name.toLowerCase() === i.left.name.toLowerCase() && isIntLiteral(test.right) && !test.right.macro
      && update && update.kind === 'UpdateExpression' && update.operator === '++' && !update.prefix
      && update.argument.kind === 'Identifier' && update.argument.name.toLowerCase() === i.left.name.toLowerCase()
    ) {
      return { ...base, kind: 'repeat', times: test.right.value, counter: this.variableName(i.left.name), body: this.block(s.body) };
    }
    const initStmt = i && i.kind !== 'DeclarationStatement' ? this.simpleAssign(i) : undefined;
    const updStmt = update ? this.simpleUpdate(update) : undefined;
    if (initStmt && test && updStmt) {
      return { ...base, kind: 'for', init: initStmt, cond: this.cond(test), update: updStmt, body: this.block(s.body) };
    }
    return this.raw(s);
  }

  private simpleAssign(e: Expression): AssignStmt | undefined {
    if (e.kind !== 'AssignmentExpression' || e.operator !== '=') return undefined;
    const target = this.lvalue(e.left);
    return target ? { id: '', kind: 'assign', target, value: this.expr(e.right) } : undefined;
  }

  private simpleUpdate(e: Expression): Extract<Stmt, { kind: 'assign' | 'incr' | 'decr' }> | undefined {
    if (e.kind === 'UpdateExpression' && !e.prefix && e.argument.kind === 'Identifier' && this.isVariable(e.argument.name)) {
      return { id: '', kind: e.operator === '++' ? 'incr' : 'decr', variable: this.variableName(e.argument.name) };
    }
    return this.simpleAssign(e);
  }

  // ------------------------------------------------------------------------------------------- expressions

  private isVariable(name: string): boolean {
    return this.variables.some((v) => v.name.toLowerCase() === name.toLowerCase());
  }

  private variableName(name: string): string {
    return this.variables.find((v) => v.name.toLowerCase() === name.toLowerCase())?.name ?? name;
  }

  /** The signal an expression designates: a `#define` alias, or a PORTA/PORTB bit (auto-created). */
  private signalOf(e: Expression): AliasSignal | undefined {
    if (e.macro) {
      const a = this.signals.get(e.macro.toUpperCase());
      if (a) return a;
    }
    if (e.kind !== 'BitAccess') return undefined;
    const rb = regBit(e);
    if (!rb || (rb.reg !== 'PORTA' && rb.reg !== 'PORTB')) return undefined;
    const pin = pinOf(rb.reg === 'PORTA' ? 'A' : 'B', rb.bit);
    if (!pin) return undefined;
    this.noteNotation(rb.sel);
    const existing = this.pinSignals.get(pin);
    if (existing) return existing;
    const a: AliasSignal = {
      signal: { id: this.newId(pin), name: pin, pin, dir: 'out', label: pin, activeLevel: 1, useDefine: false },
      usedWithMacro: false,
      written: false,
    };
    this.pinSignals.set(pin, a);
    return a;
  }

  private busOf(e: Expression): Bus | undefined {
    return e.macro && e.kind === 'Identifier' ? this.buses.get(e.macro.toUpperCase()) : undefined;
  }

  private lvalue(e: Expression): LValue | undefined {
    const sig = this.signalOf(e);
    if (sig) return { kind: 'signal', id: sig.signal.id };
    const bus = this.busOf(e);
    if (bus) return { kind: 'bus', id: bus.id };
    if (e.kind === 'Identifier' && !e.macro) {
      if (this.isVariable(e.name)) return { kind: 'var', name: this.variableName(e.name) };
      const sfr = findSfr(e.name);
      if (sfr) return { kind: 'reg', name: sfr.name };
    }
    if (e.kind === 'BitAccess' && !e.macro) {
      const rb = regBit(e);
      if (rb) return { kind: 'reg', name: rb.reg, bit: e.bit };
    }
    return undefined;
  }

  private expr(e: Expression): Expr {
    if (e.macro) {
      const key = e.macro.toUpperCase();
      const c = this.constants.get(key);
      if (c && e.kind === 'NumberLiteral') return { kind: 'var', name: c.name };
      const a = this.signals.get(key);
      if (a) return { kind: 'signal', id: a.signal.id };
      const b = this.buses.get(key);
      if (b && e.kind === 'Identifier') return { kind: 'bus', id: b.id };
      if (!c && !a && !b) return { kind: 'raw', text: e.text };
    }
    switch (e.kind) {
      case 'NumberLiteral': return e.radix === 10 ? { kind: 'num', value: e.value } : { kind: 'num', value: e.value, radix: radixOf(e.radix) };
      case 'Identifier': {
        if (this.isVariable(e.name)) return { kind: 'var', name: this.variableName(e.name) };
        const sfr = findSfr(e.name);
        if (sfr) return { kind: 'reg', name: sfr.name };
        return { kind: 'raw', text: e.text };
      }
      case 'BitAccess': {
        const sig = this.signalOf(e);
        if (sig) return { kind: 'signal', id: sig.signal.id };
        const rb = regBit(e);
        if (rb) return { kind: 'reg', name: rb.reg, bit: e.bit };
        return { kind: 'raw', text: e.text };
      }
      case 'BinaryExpression': {
        if (['==', '!=', '<', '>', '<=', '>='].includes(e.operator)) return { kind: 'raw', text: e.text };
        return { kind: 'bin', op: e.operator as Extract<Expr, { kind: 'bin' }>['op'], left: this.expr(e.left), right: this.expr(e.right) };
      }
      case 'UnaryExpression':
        if (e.operator === '~' || e.operator === '-' || e.operator === '!') return { kind: 'unary', op: e.operator, arg: this.expr(e.argument) };
        return { kind: 'raw', text: e.text };
      default:
        return { kind: 'raw', text: e.text };
    }
  }

  private cond(e: Expression): Cond {
    if (e.kind === 'LogicalExpression') {
      const kind = e.operator === '&&' ? 'and' : 'or';
      const items: Cond[] = [];
      for (const side of [e.left, e.right]) {
        const c = this.cond(side);
        if (c.kind === kind) items.push(...c.items);
        else items.push(c);
      }
      return { kind, items };
    }
    if (e.kind === 'UnaryExpression' && e.operator === '!') return { kind: 'not', cond: this.cond(e.argument) };
    if (e.kind === 'BinaryExpression' && ['==', '!=', '<', '>', '<=', '>='].includes(e.operator)) {
      if (e.operator === '==' && isBit(e.right) && !e.right.macro) {
        const sig = this.signalOf(e.left);
        if (sig) return { kind: 'pin', signal: sig.signal.id, value: e.right.value as Level };
        const rb = regBit(e.left);
        const f = rb ? FLAG_BITS[rb.reg]?.[rb.bit] : undefined;
        if (f && !e.left.macro) return { kind: 'flag', flag: f, value: e.right.value as Level };
      }
      return { kind: 'compare', left: this.expr(e.left), op: e.operator as Extract<Cond, { kind: 'compare' }>['op'], right: this.expr(e.right) };
    }
    return { kind: 'raw', text: e.text };
  }

  // ------------------------------------------------------------------------------------------- assembly

  private finish(options: FromAstOptions, init: Stmt[], loop: Stmt[] | null): Program {
    const style = this.style;
    style.bitNotation = this.sawIndexNotation && !this.sawPinNotation ? 'index' : 'pin';
    style.macros = this.macrosDefined;
    style.sections = this.sawStatusSections ? 'status' : 'demux';
    style.compactAssign = this.sawCompactAssign && !this.sawSpacedAssign;
    style.echoRegister = this.sawEcho;
    style.oneLineBranches = this.sawOneLine;
    style.packLines = this.sawPacked;

    // Signals: aliases in definition order, then pins used directly, then TRIS-only pins.
    const aliasList = [...new Set(this.signals.values())];
    const rawList = [...this.pinSignals.values()].filter((a) => a.signal.useDefine === false);
    const all = [...aliasList, ...rawList];
    for (const a of all) this.resolveSignal(a);

    // Buses: width and direction from TRIS and from the values written.
    const owned = new Set<PinName>(all.map((a) => a.signal.pin));
    const buses = [...this.buses.values()];
    for (const b of buses) this.resolveBus(b, owned);

    // Bits configured by TRIS but used by nothing: keep them as signals so the configuration is preserved.
    const busOwned = new Set<PinName>(buses.flatMap((b) => busPins(b)));
    const trisOnly: Signal[] = [];
    for (const [pin, dir] of [...this.trisBits].sort((a, b) => comparePins(a[0], b[0]))) {
      if (owned.has(pin) || busOwned.has(pin)) continue;
      trisOnly.push({ id: this.newId(pin), name: pin, pin, dir, label: pin, activeLevel: 1, useDefine: false });
    }

    // TRIS style per port: as written.
    for (const port of ['A', 'B'] as const) {
      const bits = [...this.trisBits.keys()].some((p) => pinPort(p) === port);
      if (this.trisPort.has(port)) style.tris[port] = 'port';
      else if (bits) style.tris[port] = 'bits';
    }

    const program: Program = {
      version: PROGRAM_VERSION,
      title: options.title ?? 'Programme importé',
      clockHz: options.clockHz ?? 1_000_000,
      style,
      signals: [...all.map((a) => a.signal), ...trisOnly],
      buses,
      constants: [...this.constants.values()],
      variables: this.variables,
      init,
      loop,
      functions: this.functions,
    };
    const it = this.interruptConfig();
    if (it) program.interrupts = it;
    if (this.rawDefines.length) program.rawDefines = this.rawDefines;
    if (this.rawGlobals.length) program.rawGlobals = this.rawGlobals;
    return program;
  }

  private resolveSignal(a: AliasSignal): void {
    const s = a.signal;
    const port = pinPort(s.pin);
    const trisBit = this.trisBits.get(s.pin);
    const trisPort = this.trisPort.get(port);
    if (trisBit) s.dir = trisBit;
    else if (trisPort !== undefined) s.dir = (trisPort >> pinBit(s.pin)) & 1 ? 'in' : 'out';
    else s.dir = a.written ? 'out' : 'in';
    let device: SignalDevice;
    if (s.dir === 'in') device = /^CAPTEUR/i.test(s.name) ? 'sensor' : /^(BOUTON|BTN|VALIDER|VOTE|RESULTAT)/i.test(s.name) ? 'button' : 'input';
    else if (a.usedWithMacro) device = LAMP_NAME.test(s.name) ? 'lamp' : 'led';
    else if (!this.macrosDefined && /^(LED|D\d+$)/i.test(s.name)) device = 'led';
    else device = 'output';
    s.device = device;
    s.label = defaultLabel(s);
  }

  private resolveBus(b: Bus, owned: Set<PinName>): void {
    const port = b.port;
    const width = port === 'A' ? 5 : 8;
    const trisPort = this.trisPort.get(port);
    const free: number[] = [];
    for (let bit = 0; bit < width; bit++) {
      const pin = pinOf(port, bit)!;
      if (owned.has(pin)) continue;
      if (trisPort === undefined && this.trisBits.size > 0 && [...this.trisBits.keys()].some((p) => pinPort(p) === port) && !this.trisBits.has(pin)) continue;
      free.push(bit);
    }
    const lsb = free[0] ?? 0;
    let run = 0;
    while (free.includes(lsb + run)) run++;
    const writes = this.busWrites.get(b.id) ?? [];
    // A 7SEG-BCD only needs 4 bits: every value written fits (`9 - compte` is at most 9).
    const nibble = writes.length > 0 && writes.every((v) => v <= 15);
    b.lsb = lsb;
    b.width = Math.max(1, nibble && run >= 4 ? 4 : run || 1);
    const trisBit = this.trisBits.get(pinOf(port, lsb)!);
    if (trisPort !== undefined) b.dir = (trisPort >> lsb) & 1 ? 'in' : 'out';
    else if (trisBit) b.dir = trisBit;
    else b.dir = writes.length > 0 ? 'out' : 'in';
    b.device = b.dir === 'out' && BCD_NAME.test(b.name) ? 'bcd' : 'generic';
    b.label = b.device === 'bcd' ? 'Afficheur 7 segments BCD' : b.dir === 'in' ? `Entrées ${b.name}` : `Sorties ${b.name}`;
  }

  private interruptConfig(): InterruptConfig | undefined {
    const it = this.interrupts;
    if (!it.inte && !it.rbChange && !it.t0ie && !it.gie) return undefined;
    const out: InterruptConfig = { gie: !!it.gie };
    if (it.inte) out.int = { edge: it.edge ?? 'rising' };
    if (it.rbChange) out.rbChange = true;
    if (it.t0ie) {
      const prescaler = (it.psa === 0 ? 2 ** ((it.ps ?? 0) + 1) : 1) as Prescaler;
      out.tmr0 = { prescaler };
    }
    return out;
  }
}

/** Largest value an expression can take, as far as a constant bound is visible (Infinity otherwise). */
function upperBound(e: Expr): number {
  switch (e.kind) {
    case 'num': return e.value;
    case 'bin':
      if (e.op === '-' || e.op === '>>' || e.op === '/') return upperBound(e.left);
      if (e.op === '&') return Math.min(upperBound(e.left), upperBound(e.right));
      if (e.op === '%') return upperBound(e.right) - 1;
      if (e.op === '+' || e.op === '|' || e.op === '^') return upperBound(e.left) + upperBound(e.right);
      return Infinity;
    default:
      return Infinity;
  }
}

/** « Led égal », « Feu rouge », « Entrée VOTE_A »: a readable label from a C name. */
function defaultLabel(s: Signal): string {
  const words = s.name.replace(/_+/g, ' ').trim().toLowerCase();
  switch (s.device) {
    case 'led': return /^led\b/.test(words) ? `Led${words.slice(3)}` : `Led ${s.name}`;
    case 'lamp': return `Feu ${words.replace(/^feu /, '')}`;
    case 'sensor': return 'Capteur de luminosité';
    case 'button': return `Bouton ${s.name}`;
    case 'input': case 'logicstate': return `Entrée ${s.name}`;
    default: return `Sortie ${s.name}`;
  }
}

/** Program model of a parsed translation unit (best effort; unknown constructs become raw statements). */
export function fromAstDetailed(unit: TranslationUnit, source: string = unit.source, options: FromAstOptions = {}): FromAstResult {
  const reader = new Reader(unit, source);
  try {
    const program = reader.read(options);
    return { program, notes: reader.notes };
  } catch (e) {
    // Never throw: an unexpected AST shape degrades to a program holding the whole main body verbatim.
    const program = ensureIds({
      version: PROGRAM_VERSION,
      title: options.title ?? 'Programme importé',
      clockHz: options.clockHz ?? 1_000_000,
      style: defaultStyle(),
      signals: [], buses: [], constants: [], variables: [], functions: [],
      init: [{ id: '', kind: 'raw', code: source }],
      loop: null,
    });
    return { program, notes: [`Import partiel : ${e instanceof Error ? e.message : String(e)}`] };
  }
}

/** Program model of a parsed translation unit (best effort; never throws). */
export function fromAst(unit: TranslationUnit, source: string = unit.source, options: FromAstOptions = {}): Program {
  return fromAstDetailed(unit, source, options).program;
}

export interface ParsedProgram {
  /** null when the C cannot be parsed at all. */
  program: Program | null;
  diagnostics: Diagnostic[];
  notes: string[];
}

/** Hand-written C text → Program (front end of @pic/compiler + fromAst). */
export function programFromSource(source: string | Uint8Array, options: FromAstOptions & Pick<CompileOptions, 'fileName'> = {}): ParsedProgram {
  const r = analyze(source, { clockHz: options.clockHz, fileName: options.fileName });
  if (!r.ast) return { program: null, diagnostics: r.diagnostics, notes: [] };
  const { program, notes } = fromAstDetailed(r.ast, r.source, options);
  return { program, diagnostics: r.diagnostics, notes };
}
