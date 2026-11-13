// French explanation of one C source line, from the AST statements that start on it: TRIS configuration, writes to
// port bits through #define aliases and LED_ON / LED_OFF macros, flag tests after `z = x - y`, waits, delays,
// loops, the interrupt routine… When values are available (paused simulation, or the switches of the schematic),
// the outcome of each test is shown with the reason.
import type { Expression, FunctionDeclaration, Statement, SymbolInfo, TranslationUnit } from '@pic/compiler';
import type { PinName, Program } from '@pic/program-model';
import {
  allVisits, callOf, evaluate, exprText, flagSourceFor, flagsRead, isAlwaysTrue, lineText, statementWrites, targetOf,
  targetText, truth, visitsAtLine, type EvalEnv, type FlagSource, type FlagValues, type StmtVisit, type Target, type Write,
} from './ast';
import { ADDR, pinOfPortBit, pinWithNumber, portOfTris } from './cpu';
import { bin8, bitOf, decHex, formatHz, formatSeconds, frenchList, groupThousands, hex2 } from './text';
import { bitWriteMeaning, flagTestMeaning } from './vocab';

/** What is wired to a pin, for the wording (« Led égalité allumée »). */
export interface PinInfo {
  /** Noun phrase: 'Led égalité', 'LED verte EGALITE', 'Feu rouge'. */
  label: string;
  kind: 'led' | 'lamp' | 'display' | 'input' | 'other';
  /** Pin level that lights it / that means « pressed » (default 1). */
  activeLevel?: 0 | 1;
}

export interface LineContext {
  unit: TranslationUnit;
  /** Decoded source text the AST spans refer to (CompileResult.source). */
  source: string;
  line: number;
  clockHz: number;
  symbols?: readonly SymbolInfo[];
  /** Program model (signal labels, display buses), when known. */
  program?: Program | null;
  /** Values for the outcome of tests and calculations (live registers, or the schematic's switches). */
  env?: EvalEnv;
  /** Where `env` comes from, for the wording: 'live' (paused simulation) or 'static' (starting values). */
  envKind?: 'live' | 'static';
  /** What is wired to a pin (defaults to the program model's signal). */
  pinInfo?: (pin: PinName) => PinInfo | undefined;
}

export interface LineExplanation {
  line: number;
  /** The line as written (trimmed). */
  code: string;
  /** Part of the program: 'Configuration', 'Initialisation', 'Boucle principale', 'Programme d’interruption'… */
  section: string | null;
  /** Explanation sentences, in reading order. */
  points: string[];
  /** Pitfalls worth flagging on this line. */
  warnings: string[];
  /** Glossary ids worth opening. */
  terms: string[];
}

// ---------------------------------------------------------------------------------------------------------------
// Accumulator: groups the pin writes of a line and states each macro / alias once.

class Acc {
  readonly points: string[] = [];
  readonly warnings: string[] = [];
  readonly terms = new Set<string>();
  private readonly macros = new Map<string, string>();
  private readonly aliases = new Map<string, string>();
  private run: { pin: PinName; value: 0 | 1; op: string }[] = [];

  constructor(private readonly ctx: LineContext) {}

  push(text: string): void {
    this.flush();
    this.points.push(text);
  }

  warn(text: string): void {
    if (!this.warnings.includes(text)) this.warnings.push(text);
  }

  term(...ids: string[]): void {
    for (const id of ids) this.terms.add(id);
  }

  macro(name: string, example: string): void {
    if (!this.macros.has(name)) this.macros.set(name, example);
  }

  alias(name: string, desc: string): void {
    if (!this.aliases.has(name)) this.aliases.set(name, desc);
  }

  pinWrite(pin: PinName, value: 0 | 1, op: string): void {
    if (this.run.length && this.run[0].value !== value) this.flush();
    this.run.push({ pin, value, op });
  }

  flush(): void {
    if (!this.run.length) return;
    const run = this.run;
    this.run = [];
    const value = run[0].value;
    const infos = run.map((r) => ({ pin: r.pin, info: pinInfoOf(this.ctx, r.pin) }));
    const where = infos.map(({ pin }) => pinPhrase(this.ctx, pin));
    const head = run.length === 1
      ? `Met la broche ${where[0]} à ${value} (${value ? '5 V' : '0 V'})`
      : `Met à ${value} (${value ? '5 V' : '0 V'}) les broches ${frenchList(where)}`;
    const effects = infos.filter(({ info }) => info && (info.kind === 'led' || info.kind === 'lamp'));
    let effect = '';
    if (effects.length === infos.length && effects.length) {
      const lit = effects.every(({ info }) => value === (info!.activeLevel ?? 1));
      const unlit = effects.every(({ info }) => value !== (info!.activeLevel ?? 1));
      const fem = effects.every(({ info }) => info!.kind === 'led');
      const word = lit ? (fem ? 'allumée' : 'allumé') : unlit ? (fem ? 'éteinte' : 'éteint') : null;
      if (word) effect = ` → ${frenchList(effects.map(({ info }) => info!.label))} ${effects.length > 1 ? `${word}s` : word}`;
    }
    const instr = value ? 'BSF' : 'BCF';
    this.points.push(`${head}${effect}. Le compilateur écrit ${run.length > 1 ? `une instruction ${instr} par broche` : `${instr} ${run[0].pin.startsWith('RA') ? 'PORTA' : 'PORTB'}, ${run[0].pin.slice(2)}`}.`);
  }

  finish(): void {
    this.flush();
    if (this.macros.size) {
      const names = [...this.macros.keys()];
      const examples = [...this.macros.values()];
      this.points.push(`${frenchList(names.map((n) => `${n}(…)`))} ${names.length > 1 ? 'sont des macros (#define) : le compilateur recopie leur texte' : 'est une macro (#define) : le compilateur recopie son texte'}, par exemple ${frenchList(examples)}.`);
      this.term('macro');
    }
    if (this.aliases.size) {
      const items = [...this.aliases].map(([n, d]) => `${n} = ${d}`);
      this.points.push(`Nom${items.length > 1 ? 's' : ''} défini${items.length > 1 ? 's' : ''} par #define : ${frenchList(items)}.`);
      this.term('define');
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Sections

function mainLoop(fn: FunctionDeclaration): Statement | null {
  for (const s of fn.body?.body ?? []) if (s.kind === 'WhileStatement' && isAlwaysTrue(s.test)) return s;
  return null;
}

const CONFIG_REGS = new Set<number>([ADDR.TRISA, ADDR.TRISB, ADDR.OPTION_REG]);

function isConfigWrite(w: Write): boolean {
  if (w.target.kind !== 'reg') return false;
  if (CONFIG_REGS.has(w.target.addr)) return true;
  // INTCON enable bits (GIE, EEIE, T0IE, INTE, RBIE) are configuration; the flags are not.
  return w.target.addr === ADDR.INTCON && (w.target.bit === undefined || w.target.bit >= 3);
}

/** Part of the program a statement belongs to, in the organigramme's vocabulary. */
export function sectionOf(unit: TranslationUnit, v: StmtVisit): string {
  const fn = v.fn;
  if (fn.isInterrupt) return 'Programme d’interruption';
  if (fn.name.toLowerCase() !== 'main') return `Sous-programme ${fn.name}()`;
  if (v.inMainLoop) return 'Boucle principale';
  const loop = mainLoop(fn);
  if (loop && v.stmt === loop) return 'Boucle principale';
  if (loop && v.stmt.span.line > loop.span.endLine) return 'Après la boucle (jamais atteint)';
  if (v.stmt.kind === 'DeclarationStatement') return 'Configuration (déclaration des variables)';
  const writes = statementWrites(v.stmt, unit);
  if (writes.length && writes.every(isConfigWrite)) return 'Configuration';
  return 'Initialisation';
}

// ---------------------------------------------------------------------------------------------------------------
// Names

function signalOnPin(ctx: LineContext, pin: PinName) {
  return ctx.program?.signals.find((s) => s.pin === pin);
}

function pinInfoOf(ctx: LineContext, pin: PinName): PinInfo | undefined {
  const custom = ctx.pinInfo?.(pin);
  if (custom) return custom;
  const s = signalOnPin(ctx, pin);
  if (!s) return undefined;
  const kind = s.device === 'led' ? 'led' : s.device === 'lamp' ? 'lamp' : s.dir === 'in' ? 'input' : 'other';
  return { label: s.label, kind, activeLevel: s.activeLevel };
}

/** « RB1 (broche 7, Led égalité) ». */
function pinPhrase(ctx: LineContext, pin: PinName): string {
  const info = pinInfoOf(ctx, pin);
  return info ? `${pinWithNumber(pin).replace(/\)$/, `, ${info.label})`)}` : pinWithNumber(pin);
}

function pinOfTarget(t: Target): PinName | null {
  if (t.kind !== 'reg' || t.bit === undefined) return null;
  if (t.addr === ADDR.PORTA) return pinOfPortBit('PORTA', t.bit);
  if (t.addr === ADDR.PORTB) return pinOfPortBit('PORTB', t.bit);
  return null;
}

function realName(t: Target): string {
  return t.bit === undefined ? t.name : `${t.name}.F${t.bit}`;
}

function recordAlias(acc: Acc, t: Target, unit?: TranslationUnit): void {
  if (!t.alias || t.kind !== 'reg') return;
  const pin = pinOfTarget(t);
  const def = unit?.macros.find((m) => m.params === null && m.name.toLowerCase() === t.alias!.toLowerCase());
  acc.alias(t.alias, `${def?.body.trim() || realName(t)}${pin ? ` (broche ${pin})` : ''}`);
}

function ramAddress(ctx: LineContext, name: string): string | null {
  const s = ctx.symbols?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return s ? hex2(s.addr) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Values

function valueNow(ctx: LineContext, e: Expression, flags?: FlagValues): number | undefined {
  return ctx.env ? evaluate(e, ctx.env, ctx.unit, flags) : undefined;
}

function nowWord(ctx: LineContext): string {
  return ctx.envKind === 'static' ? 'Avec les valeurs de départ' : 'En ce moment';
}

/** Targets read by an expression, with their value when known: « L1 = 1, L0 = 0 ». */
function readsText(ctx: LineContext, e: Expression, flags?: FlagValues): string | null {
  if (!ctx.env) return null;
  const seen = new Map<string, string>();
  const rec = (x: Expression) => {
    if (x.kind === 'BitAccess' || x.kind === 'Identifier') {
      const t = targetOf(x, ctx.unit);
      if (!t) return;
      const v = evaluate(x, ctx.env!, ctx.unit, flags);
      const label = t.kind === 'reg' && t.addr === ADDR.STATUS && t.bit !== undefined && t.bit <= 2 ? ['C', 'DC', 'Z'][t.bit] : targetText(t);
      if (v !== undefined && !seen.has(label)) seen.set(label, `${label} = ${t.bit === undefined && t.kind === 'reg' ? decHex(v) : v}`);
      return;
    }
    switch (x.kind) {
      case 'UnaryExpression': rec(x.argument); break;
      case 'BinaryExpression': case 'LogicalExpression': rec(x.left); rec(x.right); break;
      default: break;
    }
  };
  rec(e);
  return seen.size ? [...seen.values()].join(', ') : null;
}

/** « 5 − 6 = −1 : sur 8 bits on obtient 255 (0xFF) » / « 2 + 3 = 5 (0x05) ». */
function arithmeticText(op: '+' | '-', a: number, b: number): string {
  const raw = op === '-' ? a - b : a + b;
  const r = raw & 0xff;
  const sym = op === '-' ? '−' : '+';
  if (raw === r) return `${a} ${sym} ${b} = ${r} (${hex2(r)})`;
  const rawText = raw < 0 ? `−${-raw}` : String(raw);
  return `${a} ${sym} ${b} = ${rawText}, qui ne tient pas sur 8 bits : le PIC garde ${r} (${hex2(r)})`;
}

// ---------------------------------------------------------------------------------------------------------------
// Conditions in words

interface CondCtx {
  /** Computation that set the STATUS flags (`z = x - y` right before the if chain). */
  source?: FlagSource | null;
  /** An earlier branch of the chain tested Z and was false (so the operands differ). */
  zFalseBefore?: boolean;
}

function condProse(ctx: LineContext, e: Expression, cc: CondCtx = {}): string {
  if (e.kind === 'LogicalExpression') {
    return `${condProse(ctx, e.left, cc)} ${e.operator === '&&' ? 'et' : 'ou'} ${condProse(ctx, e.right, cc)}`;
  }
  if (e.kind === 'UnaryExpression' && e.operator === '!') return `non (${condProse(ctx, e.argument, cc)})`;
  if (e.kind === 'BinaryExpression' && (e.operator === '==' || e.operator === '!=')) {
    const t = targetOf(e.left, ctx.unit);
    const lit = e.right.kind === 'NumberLiteral' ? e.right.value : undefined;
    if (t && lit !== undefined && t.bit !== undefined && (lit === 0 || lit === 1)) {
      const value = (e.operator === '==' ? lit : 1 - lit) as 0 | 1;
      return bitIsProse(ctx, t, value, cc);
    }
  }
  if (e.kind === 'BitAccess' || e.kind === 'Identifier') {
    const t = targetOf(e, ctx.unit);
    if (t && t.bit !== undefined) return bitIsProse(ctx, t, 1, cc);
  }
  if (e.kind === 'BinaryExpression' && ['==', '!=', '<', '>', '<=', '>='].includes(e.operator)) {
    return `${operandText(ctx, e.left)} ${e.operator} ${operandText(ctx, e.right)}`;
  }
  return `« ${exprText(e)} » est vrai`;
}

/** An operand with what a name stands for: `REPONSES (PORTB)`, `REPONSE_CORRECTE (0xCA)`. */
function operandText(ctx: LineContext, e: Expression): string {
  const text = exprText(e);
  if ((e.kind === 'NumberLiteral' || e.kind === 'CharLiteral') && e.macro && /^[A-Za-z_]\w*$/.test(text)) return `${text} (${hex2(e.value)})`;
  const t = targetOf(e, ctx.unit);
  if (t?.kind === 'reg' && t.alias && t.bit === undefined) return `${t.alias} (tout le ${t.name})`;
  return text;
}

function flagFromSource(name: string, value: 0 | 1, cc: CondCtx): string | null {
  const s = cc.source;
  if (!s) return null;
  const L = exprText(s.left);
  const R = exprText(s.right);
  if (s.op === '-') {
    if (name === 'Z') return value ? `${L} − ${R} est nul, donc ${L} = ${R}` : `${L} − ${R} n’est pas nul, donc ${L} ≠ ${R}`;
    if (name === 'C') {
      if (!value) return `il y a eu un emprunt dans ${L} − ${R}, donc ${L} < ${R}`;
      return cc.zFalseBefore
        ? `pas d’emprunt dans ${L} − ${R}, donc ${L} ≥ ${R} ; et comme le test de Z a échoué (${L} ≠ ${R}), ${L} > ${R}`
        : `pas d’emprunt dans ${L} − ${R}, donc ${L} ≥ ${R}`;
    }
  } else {
    if (name === 'Z') return value ? `${L} + ${R} vaut 0 sur 8 bits` : `${L} + ${R} ne vaut pas 0`;
    if (name === 'C') return value ? `${L} + ${R} dépasse 255` : `${L} + ${R} ne dépasse pas 255`;
  }
  return null;
}

function bitIsProse(ctx: LineContext, t: Target, value: 0 | 1, cc: CondCtx = {}): string {
  if (t.kind === 'reg' && t.addr === ADDR.STATUS && t.bit !== undefined && t.bit <= 2) {
    const name = ['C', 'DC', 'Z'][t.bit];
    return `le bit ${name} de STATUS vaut ${value} (${flagFromSource(name, value, cc) ?? flagTestMeaning(name, value)})`;
  }
  if (t.kind === 'reg' && t.addr === ADDR.INTCON && t.bit !== undefined && t.bit <= 2) {
    const name = ['RBIF', 'INTF', 'T0IF'][t.bit];
    return `le drapeau ${name} vaut ${value} (${flagTestMeaning(name, value)})`;
  }
  const pin = pinOfTarget(t);
  if (pin) {
    const sig = signalOnPin(ctx, pin);
    const who = t.alias ? `${t.alias} (${pin})` : pin;
    let meaning = '';
    if (sig && (sig.device === 'button' || sig.device === 'sensor')) {
      const active = value === sig.activeLevel;
      if (sig.device === 'button') meaning = active ? ' (bouton appuyé)' : ' (bouton relâché)';
      else meaning = active ? ' (il y a de la lumière)' : ' (il fait sombre)';
    }
    return `${who} vaut ${value}${meaning}`;
  }
  return `${targetText(t)} vaut ${value}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Statements

function declarationText(ctx: LineContext, s: Extract<Statement, { kind: 'DeclarationStatement' }>): string[] {
  return s.declarations.map((d) => {
    const t = d.type;
    let range = '';
    if (t.kind === 'int') {
      if (t.size === 1) range = t.signed ? 'un octet signé, de −128 à 127' : 'un octet, de 0 à 255';
      else if (t.size === 2) range = t.signed ? '2 octets, de −32 768 à 32 767' : '2 octets, de 0 à 65 535';
      else range = '4 octets';
    } else if (t.kind === 'bit') range = 'un seul bit (0 ou 1)';
    else if (t.kind === 'array') range = `un tableau de ${t.length} cases`;
    const addr = ramAddress(ctx, d.name);
    const where = d.absolute ? `à l’adresse fixe ${exprText(d.absolute)} (mot-clé absolute)` : addr ? `adresse ${addr}` : '';
    const init = d.init && d.init.kind !== 'InitializerList' ? `, valeur de départ ${exprText(d.init)}` : '';
    return `${d.name} (${range}${where ? `, ${where}` : ''}${init})`;
  });
}

function delayCycles(ctx: LineContext, amount: number, unit: 'ms' | 'us'): number {
  const seconds = unit === 'ms' ? amount / 1000 : amount / 1e6;
  return Math.round((seconds * ctx.clockHz) / 4);
}

function explainCall(ctx: LineContext, call: Extract<Expression, { kind: 'CallExpression' }>, acc: Acc): void {
  const name = call.callee.name;
  const lower = name.toLowerCase();
  if (lower === 'delay_ms' || lower === 'delay_us' || lower === 'vdelay_ms') {
    const unit = lower === 'delay_us' ? 'us' : 'ms';
    const arg = call.args[0];
    const amount = arg && (arg.kind === 'NumberLiteral' || arg.kind === 'CharLiteral') ? arg.value : undefined;
    if (amount !== undefined) {
      const cycles = delayCycles(ctx, amount, unit);
      acc.push(`Attendre ${formatSeconds(unit === 'ms' ? amount / 1000 : amount / 1e6)} : ${name} fait tourner le PIC dans une boucle vide d’environ ${groupThousands(cycles)} cycles d’instruction (à ${formatHz(ctx.clockHz)}, 1 cycle = 4 périodes d’horloge = ${formatSeconds(4 / ctx.clockHz)}).`);
      acc.push('Pendant l’attente, le PIC ne fait rien d’autre : il ne lit pas les entrées (seule une interruption peut le déranger) et les sorties gardent leur état.');
    } else {
      acc.push(`${name} attend un temps donné par une variable.`);
      if (lower === 'delay_ms') acc.warn('MikroC exige une constante dans Delay_ms (ex. Delay_ms(500)) ; pour une durée variable, utilisez VDelay_ms.');
    }
    acc.term('delay_ms', 'cycle');
    return;
  }
  if (lower === 'button') {
    acc.push('Button() lit une broche en filtrant les rebonds (anti-rebond logiciel) : elle renvoie vrai si l’appui dure assez longtemps.');
    acc.term('rebond');
    return;
  }
  if (lower === 'eeprom_write' || lower === 'eeprom_read') {
    acc.push(lower === 'eeprom_write'
      ? 'Écrit un octet dans l’EEPROM de données (64 octets) : la valeur est conservée même sans alimentation. L’écriture dure environ 10 ms.'
      : 'Lit un octet de l’EEPROM de données (64 octets, conservée sans alimentation).');
    acc.term('eeprom');
    return;
  }
  acc.push(`Appel de la fonction ${name}() : le PIC exécute CALL, qui range l’adresse de retour dans la pile (8 niveaux au maximum), puis saute dans la fonction. Son RETURN final ramène le programme juste après cette ligne.`);
  acc.term('pile');
}

function sameTarget(ctx: LineContext, e: Expression, t: Target): boolean {
  const o = targetOf(e, ctx.unit);
  return !!o && o.kind === t.kind && o.name.toLowerCase() === t.name.toLowerCase() && o.bit === t.bit;
}

function explainWrite(ctx: LineContext, w: Write, acc: Acc): void {
  const t = w.target;
  const lit = w.value && (w.value.kind === 'NumberLiteral' || w.value.kind === 'CharLiteral') ? w.value.value : undefined;
  // A statement written with a function-like macro: `LED_ON(LED_EGAL)` → `(PORTB.F1 = 1)`.
  if (w.expr.macro && w.op === '=' && /\(/.test(w.expr.text)) {
    acc.macro(w.expr.macro, `${w.expr.text.replace(/\s+/g, ' ').trim()} devient (${realName(t)} = ${lit ?? exprText(w.value!)})`);
  }
  recordAlias(acc, t, ctx.unit);

  if (t.kind === 'reg') {
    const pin = pinOfTarget(t);
    // ---- one bit of a port: a pin
    if (pin) {
      acc.term(pin.startsWith('RA') ? 'porta' : 'portb');
      if (w.op === '=' && (lit === 0 || lit === 1)) {
        acc.pinWrite(pin, lit, w.op);
        if (pin === 'RA4' && lit === 1) {
          acc.warn('RA4 est à drain ouvert : écrire 1 ne fournit pas 5 V, la broche est seulement relâchée. Une LED reliée de RA4 vers la masse ne s’allumera pas sans résistance de pull-up.');
          acc.term('open-drain');
        }
      } else if (w.op === '=' && w.value && w.value.kind === 'UnaryExpression' && w.value.operator === '!' && sameTarget(ctx, w.value.argument, t)) {
        acc.push(`Inverse la broche ${pinPhrase(ctx, pin)} : si elle valait 1 elle passe à 0, et inversement. Répété, cela fait clignoter ce qui est branché dessus.`);
      } else if (w.op === '=' && w.value) {
        const src = targetOf(w.value, ctx.unit);
        const srcPin = src ? pinOfTarget(src) : null;
        if (src && srcPin) {
          recordAlias(acc, src, ctx.unit);
          acc.push(`Recopie l’état de l’entrée ${src.alias ? `${src.alias} (${srcPin})` : srcPin} sur la sortie ${pinPhrase(ctx, pin)}.`);
        } else {
          acc.push(`Écrit le résultat de « ${exprText(w.value)} » (0 ou 1) sur la broche ${pinPhrase(ctx, pin)}.`);
        }
        const v = valueNow(ctx, w.value);
        if (v !== undefined) acc.push(`${nowWord(ctx)}, cette valeur vaut ${v & 1}.`);
      } else {
        acc.push(`Modifie la broche ${pinPhrase(ctx, pin)} (${exprText(w.expr)}).`);
      }
      return;
    }
    // ---- one bit of TRIS: a direction
    const trisPort = portOfTris(t.addr);
    if (trisPort && t.bit !== undefined) {
      const p = pinOfPortBit(trisPort, t.bit);
      acc.term(trisPort === 'PORTA' ? 'trisa' : 'trisb', 'banque');
      if (p && (lit === 0 || lit === 1)) {
        acc.push(`${p} devient ${lit ? 'une entrée' : 'une sortie'} : bit ${t.bit} de ${t.name} à ${lit}. Règle du cours : 1 = entrée (Input), 0 = sortie (Output).`);
        acc.push(`${t.name} est dans la banque 1 de la RAM : le compilateur met d’abord RP0 à 1 (BSF STATUS, RP0) pour y accéder, puis revient en banque 0 pour les PORT.`);
      }
      return;
    }
    // ---- whole TRIS register
    if (trisPort && t.bit === undefined) {
      acc.term(trisPort === 'PORTA' ? 'trisa' : 'trisb', 'banque');
      const v = lit ?? (w.value ? valueNow(ctx, w.value) : undefined);
      if (v !== undefined && w.op === '=') {
        const width = trisPort === 'PORTA' ? 5 : 8;
        const ins: string[] = [];
        const outs: string[] = [];
        for (let b = 0; b < width; b++) (bitOf(v, b) ? ins : outs).push(pinOfPortBit(trisPort, b)!);
        const all = outs.length === width ? `toutes les broches de ${trisPort} sont des sorties` : ins.length === width ? `toutes les broches de ${trisPort} sont des entrées` : null;
        const detail = all ?? [outs.length ? `sorties ${frenchList(outs)}` : '', ins.length ? `entrées ${frenchList(ins)}` : ''].filter(Boolean).join(' ; ');
        acc.push(`${t.name} = ${hex2(v)} = ${bin8(v)} : ${detail}. Chaque bit règle une broche : 1 = entrée, 0 = sortie.`);
      } else {
        acc.push(`Règle la direction des broches de ${trisPort} (1 = entrée, 0 = sortie).`);
      }
      return;
    }
    // ---- whole port register
    if ((t.addr === ADDR.PORTA || t.addr === ADDR.PORTB) && t.bit === undefined) {
      const portName = t.addr === ADDR.PORTA ? 'PORTA' : 'PORTB';
      acc.term(portName.toLowerCase());
      const bus = ctx.program?.buses.find((b) => b.port === portName[4] && !!t.alias && b.name.toLowerCase() === t.alias.toLowerCase());
      const v = lit ?? (w.value ? valueNow(ctx, w.value) : undefined);
      if (w.op === '=' && v !== undefined) {
        acc.push(`Écrit ${decHex(v)} = ${bin8(v)} dans tout le ${portName} : chaque bit va sur sa broche (bit 0 → R${portName[4]}0, bit 1 → R${portName[4]}1…).`);
      } else if (w.op === '=' && w.value) {
        acc.push(`Écrit la valeur de « ${exprText(w.value)} » dans tout le ${portName}.`);
      } else {
        acc.push(`Modifie tout le ${portName} (${exprText(w.expr)}).`);
      }
      const isDisplay = bus?.device === 'bcd' || (!bus && !!t.alias && /^AFF/i.test(t.alias));
      if (isDisplay) {
        acc.term('7seg-bcd');
        if (v !== undefined) {
          const digit = v & 0x0f;
          acc.push(`Les 4 bits de poids faible (${digit.toString(2).padStart(4, '0')} = ${digit}) arrivent sur E3..E0 de l’afficheur BCD : il affiche « ${digit < 10 ? digit : 'AbCdEF'[digit - 10]} ».`);
        } else {
          acc.push('Les 4 bits de poids faible arrivent sur E3..E0 de l’afficheur BCD, qui affiche le chiffre (0–9) ou la lettre (A b C d E F) correspondante.');
        }
        const others = ctx.program?.signals.filter((s) => s.dir === 'out' && s.pin.startsWith(`R${portName[4]}`) && Number(s.pin.slice(2)) >= 4) ?? [];
        if (others.length) {
          acc.warn(`Écrire tout ${portName} change aussi ${frenchList(others.map((s) => `${s.pin} (${s.name})`))}${v !== undefined ? ` : ici ${frenchList(others.map((s) => `${s.pin} = ${bitOf(v, Number(s.pin.slice(2)))}`))}` : ''}. Pour ne toucher qu’une broche, écrivez son bit.`);
        }
      }
      return;
    }
    // ---- STATUS
    if (t.addr === ADDR.STATUS) {
      acc.term('status');
      if (t.bit === undefined && w.op === '=' && lit === 0) {
        acc.push('STATUS = 0 se compile en CLRF STATUS. Piège : CLRF met toujours Z à 1, donc après cette ligne Z = 1 et RP0 = 0 (banque 0) ; C et DC gardent leur valeur (la fiche technique donne STATUS = 000u u1uu, u = inchangé). /TO et /PD sont en lecture seule et ne changent pas.');
      } else if (t.bit !== undefined && (lit === 0 || lit === 1)) {
        const name = ['C', 'DC', 'Z', 'PD', 'TO', 'RP0', 'RP1', 'IRP'][t.bit];
        acc.push(`STATUS.${name} = ${lit} : ${bitWriteMeaning('STATUS', name, lit) ?? `met le bit ${name} à ${lit}`}.`);
      } else {
        acc.push(`Écrit dans le registre d’état STATUS (${exprText(w.expr)}). Les bits /TO et /PD sont en lecture seule.`);
      }
      return;
    }
    // ---- INTCON / OPTION_REG
    if (t.addr === ADDR.INTCON || t.addr === ADDR.OPTION_REG) {
      acc.term(t.addr === ADDR.INTCON ? 'intcon' : 'option_reg');
      const names = t.addr === ADDR.INTCON
        ? ['RBIF', 'INTF', 'T0IF', 'RBIE', 'INTE', 'T0IE', 'EEIE', 'GIE']
        : ['PS0', 'PS1', 'PS2', 'PSA', 'T0SE', 'T0CS', 'INTEDG', 'RBPU'];
      if (t.bit !== undefined && (lit === 0 || lit === 1)) {
        const name = names[t.bit];
        acc.push(`${t.name}.${name} = ${lit} : ${bitWriteMeaning(t.name, name, lit) ?? 'bit de contrôle'}.`);
        if (name === 'GIE') acc.term('gie', 'interruption');
        if (name === 'INTE' || name === 'RBIE' || name === 'T0IE') acc.term('interruption');
        if (name === 'INTEDG') acc.term('front');
        if (name.endsWith('IF')) acc.term('drapeau');
        if (name === 'RBPU') acc.term('pull-up');
        if (name.startsWith('PS')) acc.term('prediviseur');
        if (t.addr === ADDR.OPTION_REG) acc.push('OPTION_REG est dans la banque 1 : le compilateur passe en banque 1 (RP0 = 1) pour l’écrire.');
      } else {
        const v = lit ?? (w.value ? valueNow(ctx, w.value) : undefined);
        if (v !== undefined) {
          const ones = names.filter((_, b) => bitOf(v, b));
          acc.push(`${t.name} = ${bin8(v)} : ${ones.length ? `bits à 1 : ${frenchList([...ones].reverse())}` : 'tous les bits à 0'}.`);
        } else {
          acc.push(`Écrit dans ${t.name} (${exprText(w.expr)}).`);
        }
      }
      return;
    }
    if (t.addr === ADDR.TMR0) {
      acc.push(`TMR0 repart de ${lit !== undefined ? lit : exprText(w.value ?? w.expr)} et continue à compter tout seul (il déborde après 255).`);
      acc.term('tmr0');
      return;
    }
    acc.push(`Écrit dans le registre ${t.name} (${exprText(w.expr)}).`);
    return;
  }

  // ---- C variable
  const addr = ramAddress(ctx, t.name);
  if (w.op === '++' || w.op === '--') {
    acc.push(`${t.name} ${w.op === '++' ? 'augmente' : 'diminue'} de 1 (${w.op === '++' ? 'INCF' : 'DECF'}). Sur 8 bits, ${w.op === '++' ? '255 + 1 revient à 0' : '0 − 1 donne 255'}. Seul le bit Z de STATUS est modifié, pas C.`);
    const v = ctx.env?.variable(t.name);
    if (v !== undefined) acc.push(`${nowWord(ctx)}, ${t.name} vaut ${v}.`);
    return;
  }
  if (!w.value) return;
  if (w.op === '=' && lit !== undefined) {
    // The compiler clears with CLRF (one instruction, and it sets Z = 1); other constants go through W.
    acc.push(lit === 0
      ? `La variable ${t.name}${addr ? ` (case RAM ${addr})` : ''} reçoit 0 : CLRF ${t.name} met la case à 0 en une instruction (et met Z à 1).`
      : `La variable ${t.name}${addr ? ` (case RAM ${addr})` : ''} reçoit ${lit} : MOVLW ${hex2(lit)} met la valeur dans W, puis MOVWF la range dans ${t.name}.`);
    return;
  }
  const value = w.value;
  if (w.op === '=' && value.kind === 'BinaryExpression' && (value.operator === '-' || value.operator === '+')) {
    const isSub = value.operator === '-';
    const L = exprText(value.left);
    const R = exprText(value.right);
    acc.push(isSub
      ? `Soustraction sur 8 bits : ${t.name} = ${L} − ${R}. Le PIC la calcule avec SUBWF, qui met à jour STATUS : Z = 1 si le résultat est nul (${L} = ${R}) ; C = 1 s’il n’y a pas d’emprunt (${L} ≥ ${R}), C = 0 s’il y en a un (${L} < ${R}).`
      : `Addition sur 8 bits : ${t.name} = ${L} + ${R}. Le PIC la calcule avec ADDWF, qui met à jour STATUS : C = 1 si le résultat dépasse 255, Z = 1 s’il est nul.`);
    acc.term('status', 'carry');
    const a = valueNow(ctx, value.left);
    const b = valueNow(ctx, value.right);
    if (a !== undefined && b !== undefined) {
      const raw = isSub ? a - b : a + b;
      const r = raw & 0xff;
      const c = isSub ? (a >= b ? 1 : 0) : (raw > 0xff ? 1 : 0);
      acc.push(`${nowWord(ctx)} : ${arithmeticText(isSub ? '-' : '+', a, b)} → Z = ${r === 0 ? 1 : 0}, C = ${c}${isSub ? (c ? ' (pas d’emprunt)' : ' (emprunt)') : ''}.`);
    }
    return;
  }
  if (w.op !== '=') {
    acc.push(`${exprText(w.expr)} : ${t.name} est modifiée à partir de sa propre valeur.`);
    return;
  }
  const src = targetOf(value, ctx.unit);
  const srcPin = src ? pinOfTarget(src) : null;
  if (src && srcPin) {
    recordAlias(acc, src, ctx.unit);
    acc.push(`${t.name} reçoit l’état de la broche ${src.alias ? `${src.alias} (${srcPin})` : srcPin} (lecture de l’entrée).`);
  } else {
    acc.push(`La variable ${t.name} reçoit la valeur de « ${exprText(value)} ».`);
  }
  const v = valueNow(ctx, value);
  if (v !== undefined) acc.push(`${nowWord(ctx)}, cette valeur vaut ${decHex(v)}.`);
}

function isEmptyBody(s: Statement): boolean {
  return s.kind === 'EmptyStatement' || (s.kind === 'Block' && s.body.length === 0);
}

function condContext(ctx: LineContext, v: StmtVisit, test: Expression): CondCtx {
  if (!flagsRead(test, ctx.unit).size) return {};
  const source = flagSourceFor(ctx.unit, v.chainHead ?? v.stmt, ctx.env);
  const zFalseBefore = v.path.some((p) => !p.value && p.kind === 'if' && flagsRead(p.test, ctx.unit).has('Z'));
  return { source, zFalseBefore };
}

function explainCondition(ctx: LineContext, test: Expression, cc: CondCtx, acc: Acc, kind: 'test' | 'wait' = 'test'): void {
  let flags: FlagValues | undefined;
  if (flagsRead(test, ctx.unit).size) {
    acc.term('status');
    const src = cc.source;
    if (src) {
      acc.push(`Les drapeaux testés viennent du calcul de la ligne ${src.stmt.span.line} (${src.stmt.text.replace(/\s+/g, ' ').trim()}) : le if ne refait pas le calcul, il lit STATUS juste après.`);
      if (src.flags && src.a !== undefined && src.b !== undefined) flags = src.flags;
    }
  }
  if (!ctx.env) return;
  const t = truth(test, ctx.env, ctx.unit, flags);
  const reads = readsText(ctx, test, flags);
  const calc = cc.source && flags && cc.source.a !== undefined && cc.source.b !== undefined
    ? `${arithmeticText(cc.source.op, cc.source.a, cc.source.b)}, donc `
    : '';
  if (t === undefined) {
    if (reads) acc.push(`${nowWord(ctx)} : ${calc}${reads}.`);
    return;
  }
  const outcome = kind === 'wait' ? (t ? ' : le PIC reste bloqué ici' : ' : le PIC passe à la suite') : '';
  acc.push(`${nowWord(ctx)} : ${calc}${reads ? `${reads} → ` : ''}la condition est ${t ? 'VRAIE' : 'FAUSSE'}${outcome}.`);
}

function explainStatement(ctx: LineContext, v: StmtVisit, acc: Acc): void {
  const s = v.stmt;
  switch (s.kind) {
    case 'DeclarationStatement':
      return; // grouped by explainLine
    case 'SbitDeclaration':
      acc.push(`sbit ${s.name} : donne le nom ${s.name} à ${s.target ? exprText(s.target) : 'un bit'} (comme un #define pour un seul bit).`);
      return;
    case 'ExpressionStatement': {
      const call = callOf(s);
      if (call) { explainCall(ctx, call, acc); return; }
      const writes = statementWrites(s, ctx.unit);
      if (writes.length === 0) { acc.push(`Évalue « ${exprText(s.expression)} » (aucun registre n’est modifié).`); return; }
      for (const w of writes) explainWrite(ctx, w, acc);
      return;
    }
    case 'IfStatement': {
      const elseIf = v.chainHead !== null;
      const cc = condContext(ctx, v, s.test);
      acc.push(`${elseIf ? 'Sinon, si' : 'Si'} ${condProse(ctx, s.test, cc)} : le programme exécute le bloc qui suit${s.alternate ? ' ; sinon il passe au « else »' : ' ; sinon il saute ce bloc'}.`);
      if (elseIf) acc.push('Comme c’est un « else if », ce test n’est fait que si tous les tests du dessus étaient faux : une seule branche s’exécute.');
      explainCondition(ctx, s.test, cc, acc);
      if (cc.source !== undefined && !elseIf && !s.alternate && v.list && v.index + 1 < v.list.length) {
        const next = v.list[v.index + 1];
        if (next.kind === 'IfStatement' && flagsRead(next.test, ctx.unit).size) {
          acc.warn('Ce if est suivi d’un deuxième if séparé qui teste aussi STATUS : les deux peuvent s’exécuter. Quand x = y, Z = 1 et C = 1 (pas d’emprunt) en même temps : deux LEDs s’allument. Il faut écrire « else if ».');
        }
      }
      acc.term('if');
      return;
    }
    case 'WhileStatement': {
      if (isAlwaysTrue(s.test)) {
        acc.push('while(1) : boucle infinie. Le PIC répète sans fin les instructions entre les accolades ; c’est la « Boucle infinie » de l’organigramme. En assembleur, un GOTO à la fin remonte au début.');
        acc.term('boucle');
        return;
      }
      const cc = condContext(ctx, v, s.test);
      if (isEmptyBody(s.body)) {
        acc.push(`Attente : tant que ${condProse(ctx, s.test, cc)}, le programme reste bloqué sur cette ligne (la boucle est vide).`);
        const t = targetOf(s.test.kind === 'BinaryExpression' ? s.test.left : s.test, ctx.unit);
        const pin = t ? pinOfTarget(t) : null;
        const sig = pin ? signalOnPin(ctx, pin) : undefined;
        const waitsWhileActive = s.test.kind === 'BinaryExpression' && s.test.operator === '==' && s.test.right.kind === 'NumberLiteral' && s.test.right.value === sig?.activeLevel;
        if (sig?.device === 'button' && waitsWhileActive) {
          acc.push('C’est l’attente du relâchement : sans elle, un seul appui serait compté plusieurs fois, car le PIC refait le tour de la boucle des milliers de fois pendant que le doigt reste sur le bouton.');
          acc.term('rebond');
        } else if (sig?.device === 'logicstate' && waitsWhileActive) {
          acc.push('Un LOGICSTATE reste à 1 tant qu’on ne le rebascule pas : sans cette attente, le programme repartirait aussitôt pour un nouveau tour.');
        }
        explainCondition(ctx, s.test, cc, acc, 'wait');
        return;
      }
      acc.push(`Tant que ${condProse(ctx, s.test, cc)}, le programme répète le bloc qui suit. Le test est refait avant chaque tour.`);
      explainCondition(ctx, s.test, cc, acc);
      acc.term('boucle');
      return;
    }
    case 'DoWhileStatement':
      acc.push(`Boucle do … while : le bloc s’exécute une première fois, puis recommence tant que ${condProse(ctx, s.test)}.`);
      return;
    case 'ForStatement': {
      const init = s.init && s.init.kind !== 'DeclarationStatement' ? exprText(s.init) : null;
      const test = s.test ? exprText(s.test) : null;
      const update = s.update ? exprText(s.update) : null;
      let times: string | null = null;
      if (s.init && s.init.kind === 'AssignmentExpression' && s.init.right.kind === 'NumberLiteral' && s.test?.kind === 'BinaryExpression' && s.test.right.kind === 'NumberLiteral' && s.update?.kind === 'UpdateExpression' && s.update.operator === '++') {
        const from = s.init.right.value;
        const to = s.test.right.value;
        if (s.test.operator === '<') times = `${to - from} tours (de ${from} à ${to - 1})`;
        else if (s.test.operator === '<=') times = `${to - from + 1} tours (de ${from} à ${to})`;
      }
      acc.push(`Boucle for : ${init ? `départ ${init}` : 'sans départ'} ; on continue tant que ${test ?? 'toujours'} ; après chaque tour, ${update ?? 'rien'}.${times ? ` Ici : ${times}.` : ''}`);
      acc.term('boucle');
      return;
    }
    case 'SwitchStatement':
      acc.push(`switch : selon la valeur de « ${exprText(s.discriminant)} », le programme saute au « case » correspondant.`);
      return;
    case 'BreakStatement': acc.push('break : sort de la boucle (ou du switch) en cours.'); return;
    case 'ContinueStatement': acc.push('continue : passe directement au tour suivant de la boucle.'); return;
    case 'ReturnStatement':
      acc.push(v.fn.isInterrupt ? 'return : fin de l’interruption (RETFIE).' : 'return : fin de la fonction, retour à l’appelant (RETURN dépile l’adresse de retour).');
      return;
    case 'EmptyStatement': acc.push('Instruction vide (« ; » seul).'); return;
    default: return;
  }
}

/** Explanation of a line that holds no statement start: function header, `}`, `else`, #define, comment. */
function explainOtherLine(ctx: LineContext, code: string, acc: Acc): string | null {
  const unit = ctx.unit;
  const globalDecl = unit.body.find((t): t is Extract<Statement, { kind: 'DeclarationStatement' }> =>
    t.kind === 'DeclarationStatement' && t.span.line === ctx.line);
  if (globalDecl) {
    const items = declarationText(ctx, globalDecl);
    acc.push(`Déclaration de ${items.length > 1 ? 'variables globales' : 'variable globale'} : ${frenchList(items)}. Elle est rangée dans la RAM (registres GPR, à partir de 0x0C).`);
    acc.push(unit.body.some((t) => t.kind === 'FunctionDeclaration' && t.isInterrupt)
      ? 'Globale = déclarée hors de toute fonction : main() ET la routine d’interruption peuvent l’utiliser. Une variable déclarée dans main() ne serait pas visible dans interrupt().'
      : 'Globale = déclarée hors de toute fonction : toutes les fonctions du programme peuvent l’utiliser.');
    acc.term('variable');
    return 'Variables globales';
  }
  const fn = unit.body.find((t): t is FunctionDeclaration => t.kind === 'FunctionDeclaration' && t.span.line === ctx.line);
  if (fn) {
    if (fn.isInterrupt) {
      acc.push('Début du programme d’interruption. Il n’est jamais appelé par le code : le PIC y saute tout seul (vecteur 0004h) quand une interruption autorisée arrive (GIE = 1, et un drapeau avec son autorisation à 1).');
      acc.push('Le compilateur ajoute au début la sauvegarde de W et de STATUS, et à la fin leur restauration puis RETFIE.');
      acc.term('interruption', 'vecteur');
      return 'Programme d’interruption';
    }
    if (fn.name.toLowerCase() === 'main') {
      acc.push('Début du programme principal. Après un reset, le PIC part de l’adresse 0000h (vecteur de reset), qui saute ici.');
      acc.term('vecteur');
      return 'Programme principal';
    }
    acc.push(`Définition de la fonction ${fn.name}() : elle ne s’exécute que lorsqu’on l’appelle (CALL).`);
    return `Sous-programme ${fn.name}()`;
  }
  if (/^}/.test(code)) {
    const ends = allVisits(unit).filter((v) => v.stmt.span.endLine === ctx.line && v.stmt.span.line !== ctx.line);
    const fnEnd = unit.body.find((t): t is FunctionDeclaration => t.kind === 'FunctionDeclaration' && t.span.endLine === ctx.line && t.span.line !== ctx.line);
    const loop = ends.find((v) => v.stmt.kind === 'WhileStatement' || v.stmt.kind === 'ForStatement' || v.stmt.kind === 'DoWhileStatement');
    if (loop && loop.stmt.kind === 'WhileStatement' && isAlwaysTrue(loop.stmt.test)) {
      acc.push('Fin de la boucle infinie : un GOTO renvoie au début de while(1).');
      return 'Boucle principale';
    }
    if (loop) {
      acc.push('Fin du corps de la boucle : retour au test.');
      return null;
    }
    if (fnEnd) {
      if (fnEnd.isInterrupt) {
        acc.push('Fin de l’interruption : le compilateur restaure W et STATUS, puis RETFIE dépile l’adresse de retour et remet GIE à 1.');
        acc.term('interruption');
        return 'Programme d’interruption';
      }
      if (fnEnd.name.toLowerCase() === 'main') {
        acc.push(mainLoop(fnEnd)
          ? 'Fin de main(). Elle n’est jamais atteinte : la boucle while(1) ne se termine pas. (MikroC place quand même ici un « GOTO $ ».)'
          : 'Fin de main(). Sans boucle infinie, le programme s’arrête ici : MikroC ajoute « GOTO $ », le PIC saute sur place indéfiniment et les sorties gardent leur état.');
        return 'Fin du programme';
      }
      acc.push('Fin de la fonction : RETURN ramène le programme juste après l’appel.');
      return null;
    }
    acc.push('Fin du bloc.');
    return null;
  }
  if (/^else\b/.test(code)) {
    acc.push('Sinon : ce bloc s’exécute seulement si tous les tests au-dessus étaient faux.');
    return null;
  }
  if (/^#\s*define\b/.test(code)) {
    const m = /^#\s*define\s+(\w+)(\([^)]*\))?\s*(.*)$/.exec(code);
    if (m) {
      const [, name, params, body] = m;
      const clean = body.replace(/\/\/.*$/, '').trim();
      if (params) {
        acc.push(`Macro ${name}${params} : partout où le code écrit ${name}(…), le compilateur recopie « ${clean} » en remplaçant le paramètre. Ce n’est pas une fonction : rien n’est appelé.`);
        acc.term('macro');
      } else if (/^PORT[AB]\.(R[AB]\d|F\d|B\d)$/i.test(clean)) {
        acc.push(`${name} devient un autre nom pour ${clean} : le code est plus lisible (on écrit ${name} = 1 au lieu de ${clean} = 1). Le PIC n’exécute rien ici.`);
        acc.term('define');
      } else {
        acc.push(`#define ${name} : partout où le code écrit ${name}, le compilateur le remplace par « ${clean} » avant de compiler. Le PIC n’exécute rien ici.`);
        acc.term('define');
      }
    }
    return 'Définitions';
  }
  if (/^\/\//.test(code) || /^\/\*/.test(code)) {
    acc.push('Commentaire : ignoré par le compilateur, il sert à expliquer le code.');
    return null;
  }
  if (/^#\s*include\b/.test(code)) {
    acc.push('#include : ajoute un fichier d’en-tête (noms de registres, fonctions de bibliothèque).');
    return null;
  }
  if (code === '') acc.push('Ligne vide.');
  return null;
}

/** Explanation of the C line `ctx.line`. */
export function explainLine(ctx: LineContext): LineExplanation {
  const code = lineText(ctx.source, ctx.line);
  const visits = visitsAtLine(ctx.unit, ctx.line);
  const acc = new Acc(ctx);
  let section: string | null;
  if (visits.length === 0) {
    section = explainOtherLine(ctx, code, acc);
  } else {
    section = sectionOf(ctx.unit, visits[0]);
    const decls = visits.filter((v) => v.stmt.kind === 'DeclarationStatement');
    if (decls.length) {
      const items = decls.flatMap((v) => declarationText(ctx, v.stmt as Extract<Statement, { kind: 'DeclarationStatement' }>));
      acc.push(`Déclaration de ${items.length > 1 ? 'variables' : 'variable'} : ${frenchList(items)}. Les variables sont rangées dans la RAM, dans les registres GPR (à partir de l’adresse 0x0C).`);
      acc.term('variable');
    }
    const startsWithElse = /^}?\s*else\b/.test(code);
    let markedElse = false;
    for (const v of visits) {
      // `while (X == 1);`: the empty body is part of the wait, not a statement of its own.
      if (v.stmt.kind === 'EmptyStatement' && visits.length > 1) continue;
      // A one-line branch `if (…) { LED_ON(X); }` or `else { … }`: say which branch the statement belongs to.
      const last = v.path[v.path.length - 1];
      if (last && last.owner.span.line === ctx.line && last.kind === 'if' && last.value && v.stmt.kind !== 'IfStatement') acc.push('Si oui :');
      else if (startsWithElse && !markedElse && !v.chainHead && v.stmt.kind !== 'IfStatement') {
        acc.push('Sinon (tous les tests au-dessus étaient faux) :');
        markedElse = true;
      }
      explainStatement(ctx, v, acc);
    }
  }
  acc.finish();
  return { line: ctx.line, code, section, points: acc.points, warnings: acc.warnings, terms: [...acc.terms] };
}

// ---------------------------------------------------------------------------------------------------------------
// Shared with the « Pourquoi ? » tracer

export interface ConditionInsight {
  /** The condition as written (`STATUS.F2 == 1`). */
  code: string;
  /** In words (« le bit Z de STATUS vaut 1 (x − y est nul, donc x = y) »). */
  prose: string;
  /** Required value of the condition for the statement to run. */
  required: boolean;
  /** Current value of the condition (undefined: unknown). */
  value: boolean | undefined;
  /** « 5 − 6 = −1 … donc Z = 0 » / « L1 = 1, L0 = 0 ». */
  because: string | null;
  /** The arithmetic behind the flags (« 5 − 6 = −1 … »), when the condition tests STATUS. */
  calc: string | null;
  /** Values read by the condition (« Z = 0 »). */
  reads: string | null;
  line: number;
}

/** The conditions that must hold for the statement of `v` to run, each evaluated with `ctx.env`. */
export function pathInsights(ctx: LineContext, v: StmtVisit): ConditionInsight[] {
  const visits = allVisits(ctx.unit);
  return v.path.map((p) => {
    const ownerVisit = visits.find((x) => x.stmt === p.owner);
    const cc = ownerVisit ? condContext(ctx, ownerVisit, p.test) : {};
    let flags: FlagValues | undefined;
    let calc: string | null = null;
    if (cc.source?.flags && cc.source.a !== undefined && cc.source.b !== undefined) {
      flags = cc.source.flags;
      calc = arithmeticText(cc.source.op, cc.source.a, cc.source.b);
    }
    const value = ctx.env ? truth(p.test, ctx.env, ctx.unit, flags) : undefined;
    const reads = readsText(ctx, p.test, flags);
    const because = calc ? `${calc}, donc ${reads ?? ''}`.replace(/, donc $/, '') : reads;
    const prose = p.value ? condProse(ctx, p.test, cc) : negatedProse(ctx, p.test, cc);
    return { code: exprText(p.test), prose, required: p.value, value, because, calc, reads, line: p.owner.span.line };
  });
}

/** Words for « this condition is false »: a bit test is flipped (Z vaut 0), anything else is « … » est faux. */
function negatedProse(ctx: LineContext, e: Expression, cc: CondCtx): string {
  if (e.kind === 'BinaryExpression' && (e.operator === '==' || e.operator === '!=')) {
    const t = targetOf(e.left, ctx.unit);
    const lit = e.right.kind === 'NumberLiteral' ? e.right.value : undefined;
    if (t && lit !== undefined && t.bit !== undefined && (lit === 0 || lit === 1)) {
      const value = (e.operator === '==' ? 1 - lit : lit) as 0 | 1;
      return bitIsProse(ctx, t, value, { ...cc, zFalseBefore: false });
    }
  }
  if (e.kind === 'BitAccess' || e.kind === 'Identifier') {
    const t = targetOf(e, ctx.unit);
    if (t && t.bit !== undefined) return bitIsProse(ctx, t, 0, cc);
  }
  return `« ${exprText(e)} » est faux`;
}
