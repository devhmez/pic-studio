// « Pourquoi ? » for the part selected on the schematic: why this LED is lit or not, what the display shows, what
// an input reads. The trace goes net → PIC pin → port bit → the C line that wrote it last → the condition that let
// that line run, with the current values (paused simulation) or the starting ones (switch positions, constants).
import type { ComponentInstance, ComponentVisual, Netlist, Schematic } from '@pic/circuit';
import type { SymbolInfo, TranslationUnit } from '@pic/compiler';
import type { PinName, Program } from '@pic/program-model';
import {
  allVisits, evaluate, exprText, statementWrites, targetOf, type EvalEnv, type StmtVisit, type Write,
} from './ast';
import { pathInsights, type ConditionInsight, type LineContext, type PinInfo } from './cline';
import { rbPullupsEnabled } from './env';
import {
  buttonWiring, inputSourceOf, ldrLevels, ledWiring, ohmsOf, partName, partTitle, Topology,
} from './circuit';
import { ADDR, pinWithNumber, portOfPin, readRegister, type CpuState } from './cpu';
import { bitOf, decHex, formatOhms, frenchList, frenchNumber } from './text';

export interface WhyInput {
  schematic: Schematic;
  netlist?: Netlist;
  componentId: string;
  clockHz: number;
  /** AST of the program (CompileResult.ast) and its decoded source. */
  unit?: TranslationUnit | null;
  source?: string;
  symbols?: readonly SymbolInfo[];
  program?: Program | null;
  /** Paused / running simulation: registers, part visuals and the C line being executed. */
  live?: {
    cpu: CpuState;
    visuals?: Readonly<Record<string, ComponentVisual>>;
    /** C line of the instruction at PC (numbered like `source`). */
    line?: number | null;
  } | null;
  /** Values to use without a simulation (switch positions, constants of the initialisation). */
  staticEnv?: EvalEnv;
  /** Last line that wrote each pin during the step-by-step history. */
  lastWrites?: ReadonlyMap<PinName, { line: number; value: 0 | 1 }>;
  /** Value lookup for a running simulation (registers + variables of `live.cpu`). */
  liveEnv?: EvalEnv;
  pinInfo?: (pin: PinName) => PinInfo | undefined;
}

export interface WhyStep {
  title: string;
  text: string;
  /** C line the step is about (clickable in the UI). */
  line?: number;
  tone?: 'ok' | 'off' | 'warn' | 'info';
}

export interface WhyAnswer {
  /** « Pourquoi la LED verte EGALITE est éteinte ? » */
  question: string;
  state: 'on' | 'off' | 'unknown' | 'na';
  /** One-sentence answer. */
  summary: string;
  steps: WhyStep[];
}

// ---------------------------------------------------------------------------------------------------------------
// Writes and reads of a pin in the program

export interface PinWriteSite {
  visit: StmtVisit;
  write: Write;
  /** Level written to the pin: 0, 1, an inversion, or an expression. */
  value: 0 | 1 | 'toggle' | 'expr';
  /** Whole-register write (`AFFICHEUR = 0x0E`, `PORTB = …`). */
  whole: boolean;
}

/** Every statement that writes the pin (bit writes, whole-port writes), in source order. */
export function writesToPin(unit: TranslationUnit, pin: PinName): PinWriteSite[] {
  const { portAddr, bit } = portOfPin(pin);
  const out: PinWriteSite[] = [];
  for (const v of allVisits(unit)) {
    for (const w of statementWrites(v.stmt, unit)) {
      const t = w.target;
      if (t.kind !== 'reg' || t.addr !== portAddr) continue;
      if (t.bit !== undefined && t.bit !== bit) continue;
      const lit = w.value && (w.value.kind === 'NumberLiteral' || w.value.kind === 'CharLiteral') ? w.value.value : undefined;
      let value: PinWriteSite['value'] = 'expr';
      if (w.op === '=' && lit !== undefined) value = t.bit === undefined ? bitOf(lit, bit) : (lit ? 1 : 0);
      else if (w.op === '=' && t.bit !== undefined && w.value?.kind === 'UnaryExpression' && w.value.operator === '!') {
        const inner = targetOf(w.value.argument, unit);
        if (inner?.kind === 'reg' && inner.addr === portAddr && inner.bit === bit) value = 'toggle';
      }
      out.push({ visit: v, write: w, value, whole: t.bit === undefined });
    }
  }
  return out;
}

/** Lines that read the pin (tests and copies), in source order. */
export function readsOfPin(unit: TranslationUnit, pin: PinName): { line: number; code: string }[] {
  const { portAddr, bit } = portOfPin(pin);
  const out: { line: number; code: string }[] = [];
  const mentions = (e: import('@pic/compiler').Expression | null | undefined): boolean => {
    if (!e) return false;
    if (e.kind === 'BitAccess' || e.kind === 'Identifier') {
      const t = targetOf(e, unit);
      return !!t && t.kind === 'reg' && t.addr === portAddr && (t.bit === undefined || t.bit === bit);
    }
    switch (e.kind) {
      case 'UnaryExpression': return mentions(e.argument);
      case 'BinaryExpression': case 'LogicalExpression': return mentions(e.left) || mentions(e.right);
      case 'ConditionalExpression': return mentions(e.test) || mentions(e.consequent) || mentions(e.alternate);
      case 'CallExpression': return e.args.some(mentions);
      case 'CastExpression': return mentions(e.argument);
      default: return false;
    }
  };
  for (const v of allVisits(unit)) {
    const s = v.stmt;
    let hit = false;
    if (s.kind === 'IfStatement' || s.kind === 'WhileStatement' || s.kind === 'DoWhileStatement') hit = mentions(s.test);
    else if (s.kind === 'ForStatement') hit = mentions(s.test);
    else if (s.kind === 'ExpressionStatement') hit = statementWrites(s, unit).some((w) => mentions(w.value)) || (s.expression.kind === 'CallExpression' && mentions(s.expression));
    if (hit) out.push({ line: s.span.line, code: s.text.split('\n')[0].trim() });
  }
  return out;
}

function lineCode(site: PinWriteSite): string {
  return site.visit.stmt.text.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------------------------------------------
// Which write decides the pin

interface Evaluated { site: PinWriteSite; conds: ConditionInsight[]; runs: boolean | undefined }

function evaluateSites(ctx: LineContext, sites: readonly PinWriteSite[]): Evaluated[] {
  return sites.map((site) => {
    const conds = pathInsights(ctx, site.visit);
    let runs: boolean | undefined = true;
    for (const c of conds) {
      if (c.value === undefined) { runs = undefined; continue; }
      if (c.value !== c.required) { runs = false; break; }
    }
    return { site, conds, runs };
  });
}

/** Lines spanned by main()'s `while(1)`, when there is one. */
function mainLoopSpan(unit: TranslationUnit): { line: number; endLine: number } | null {
  for (const top of unit.body) {
    if (top.kind !== 'FunctionDeclaration' || top.name.toLowerCase() !== 'main' || !top.body) continue;
    for (const s of top.body.body) {
      if (s.kind === 'WhileStatement' && s.test.kind === 'NumberLiteral' && s.test.value !== 0) return { line: s.span.line, endLine: s.span.endLine };
    }
  }
  return null;
}

/** How well a write site matches what is observed now (pin level, value on the display). */
type Fit = 'exact' | 'maybe' | 'no';

/** Values of constants only (no register, no variable): tells a constant write from an expression. */
const CONSTANTS_ONLY: EvalEnv = { reg: () => undefined, variable: () => undefined };

/**
 * The write that explains what is observed now.
 *
 * Live: a write that gives the current level / value — a constant equal to it first, then an expression or an
 * inversion (the interrupt routine included). A write is never discarded because its conditions are false NOW: the
 * values may have changed after it ran (counters reset, a switch moved, the torch turned on); those conditions are
 * only used to prefer, among equal candidates, a write whose conditions still hold. Among the candidates: the last one
 * before the current line in this loop turn, else one later in the loop (previous turn), else the interrupt routine,
 * else the initialisation.
 *
 * Without a simulation: the last write of a loop turn whose conditions hold with the starting values.
 */
function decisiveWrite(unit: TranslationUnit, evaluated: readonly Evaluated[], live: boolean, currentLine: number | null | undefined, fit: (e: Evaluated) => Fit): Evaluated | undefined {
  const lineOfE = (e: Evaluated) => e.site.visit.stmt.span.line;
  const pick = (list: readonly Evaluated[]) => (list.length ? list.reduce((a, b) => (lineOfE(b) >= lineOfE(a) ? b : a)) : undefined);
  if (!live) {
    const main = evaluated.filter((e) => !e.site.visit.fn.isInterrupt);
    return pick(main.filter((e) => e.site.visit.inMainLoop && e.runs === true)) ?? pick(main.filter((e) => !e.site.visit.inMainLoop && e.runs === true));
  }
  const span = mainLoopSpan(unit);
  const order = (cands: readonly Evaluated[]): Evaluated | undefined => {
    const main = cands.filter((e) => !e.site.visit.fn.isInterrupt);
    const isr = cands.filter((e) => e.site.visit.fn.isInterrupt);
    const loopW = main.filter((e) => e.site.visit.inMainLoop);
    const initW = main.filter((e) => !e.site.visit.inMainLoop);
    if (currentLine && span && span.line <= currentLine && currentLine <= span.endLine) {
      return pick(loopW.filter((e) => lineOfE(e) < currentLine)) ?? pick(loopW) ?? pick(isr) ?? pick(initW);
    }
    if (currentLine) return pick(main.filter((e) => lineOfE(e) < currentLine)) ?? pick(isr) ?? pick(main);
    return pick(loopW) ?? pick(isr) ?? pick(initW);
  };
  for (const level of ['exact', 'maybe'] as const) {
    const cands = evaluated.filter((e) => fit(e) === level);
    const best = order(cands.filter((e) => e.runs !== false)) ?? order(cands);
    if (best) return best;
  }
  return undefined;
}

/** Fit of a pin write with the level read now (live). */
function pinFit(ctx: LineContext, pin: PinName, level: 0 | 1 | undefined): (e: Evaluated) => Fit {
  const { bit } = portOfPin(pin);
  return (e) => {
    if (level === undefined) return 'maybe';
    const v = e.site.value;
    if (v === 0 || v === 1) return v === level ? 'exact' : 'no';
    if (v === 'expr' && e.site.write.value && ctx.env) {
      // Evaluated with today's values: equal is a strong hint, different does not exclude it (values changed since).
      const x = evaluate(e.site.write.value, ctx.env, ctx.unit);
      if (x !== undefined) return (e.site.whole ? bitOf(x, bit) : x ? 1 : 0) === level ? 'exact' : 'maybe';
    }
    return 'maybe';
  };
}

function condSentence(c: ConditionInsight, calcShown: boolean): string {
  const now = c.value === undefined ? '' : c.value === c.required ? ' → c’est le cas' : ' → ce n’est pas le cas';
  const because = calcShown && c.calc ? c.reads : c.because;
  return `${c.prose} (ligne ${c.line} : « ${c.code} » ${c.required ? 'vrai' : 'faux'})${because ? `. Ici : ${because}` : ''}${now}`;
}

function siteDescription(e: Evaluated, live = false): string {
  const where = `Ligne ${e.site.visit.stmt.span.line} : « ${lineCode(e.site)} »`;
  const v = e.site.visit;
  const when = v.fn.isInterrupt ? 'exécutée à chaque interruption'
    : v.inMainLoop ? 'exécutée à chaque tour de la boucle'
      : v.fn.name.toLowerCase() === 'main' ? 'exécutée une fois au démarrage' : `exécutée à chaque appel de ${v.fn.name}()`;
  if (!e.conds.length) return `${where}, ${when}${v.fn.isInterrupt || v.inMainLoop ? ' (sans condition)' : ''}.`;
  // The subtraction behind several flag tests is stated once.
  const shown = new Set<string>();
  const parts = e.conds.map((c) => {
    const sentence = condSentence(c, !!c.calc && shown.has(c.calc));
    if (c.calc) shown.add(c.calc);
    return sentence;
  });
  // Live, a decisive write whose conditions are false now: they held when it ran, the values changed since.
  const since = live && e.runs === false ? ' Au moment de l’écriture, toutes ces conditions étaient vraies ; certaines ne le sont plus en ce moment, car les valeurs ont changé depuis.' : '';
  return `${where}${v.fn.isInterrupt ? ' (programme d’interruption)' : ''}. Elle n’est exécutée que si ${parts.join(' ; et si ')}.${since}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Answers

function lineContext(input: WhyInput, env: EvalEnv | undefined, envKind: 'live' | 'static'): LineContext | null {
  if (!input.unit) return null;
  return {
    unit: input.unit, source: input.source ?? input.unit.source, line: 0, clockHz: input.clockHz, symbols: input.symbols,
    program: input.program, env, envKind, pinInfo: input.pinInfo,
  };
}

function signalName(input: WhyInput, pin: PinName): string | undefined {
  return input.program?.signals.find((s) => s.pin === pin)?.name;
}

/** Steps about the code that writes `pin`, and the line that decided its current level. */
function codeSteps(input: WhyInput, pin: PinName, level: 0 | 1 | undefined, activeLevel: 0 | 1, steps: WhyStep[]): void {
  if (!input.unit) {
    steps.push({ title: 'Code', text: 'Le programme ne compile pas encore : impossible de retrouver les lignes qui écrivent cette broche.', tone: 'warn' });
    return;
  }
  const live = !!input.live;
  const ctx = lineContext(input, live ? input.liveEnv : input.staticEnv, live ? 'live' : 'static')!;
  const sites = writesToPin(input.unit, pin);
  if (!sites.length) {
    steps.push({ title: 'Code', text: `Aucune ligne du programme n’écrit ${pin} : la broche garde sa valeur de départ (0 après la mise sous tension).`, tone: 'warn' });
    return;
  }
  const evaluated = evaluateSites(ctx, sites);
  const onSites = evaluated.filter((e) => e.site.value === activeLevel || e.site.value === 'toggle' || e.site.value === 'expr');
  const offSites = evaluated.filter((e) => e.site.value === (1 - activeLevel));
  const isr = evaluated.filter((e) => e.site.visit.fn.isInterrupt);
  const name = signalName(input, pin);
  steps.push({
    title: 'Code',
    text: `${sites.length} ligne${sites.length > 1 ? 's écrivent' : ' écrit'} ${pin}${name ? ` (${name})` : ''} : ${sites.map((s) => `ligne ${s.visit.stmt.span.line}`).join(', ')}.`,
    tone: 'info',
  });

  const recorded = input.lastWrites?.get(pin);
  if (recorded) {
    const site = evaluated.find((e) => e.site.visit.stmt.span.line === recorded.line);
    steps.push({
      title: 'Dernière écriture (pas à pas)',
      text: `Pendant le pas à pas, la dernière ligne qui a écrit ${pin} est la ligne ${recorded.line}${site ? ` : « ${lineCode(site.site)} »` : ''} → ${pin} = ${recorded.value}.`,
      line: recorded.line, tone: recorded.value === activeLevel ? 'ok' : 'off',
    });
  } else {
    const decisive = decisiveWrite(input.unit, evaluated, live, input.live?.line, pinFit(ctx, pin, level));
    if (decisive) {
      steps.push({
        title: live ? 'Ligne qui a fixé l’état' : 'Ligne qui fixera l’état',
        text: siteDescription(decisive, live),
        line: decisive.site.visit.stmt.span.line,
        tone: decisive.site.value === activeLevel ? 'ok' : decisive.site.value === 1 - activeLevel ? 'off' : 'info',
      });
    }
  }

  // The lines that would change the state, with their conditions.
  const opposite = level === activeLevel ? offSites : onSites;
  const decided = steps[steps.length - 1]?.line;
  const shown = opposite.filter((e) => e.conds.length > 0 && !e.site.visit.fn.isInterrupt && e.site.visit.stmt.span.line !== decided).slice(0, 3);
  for (const e of shown) {
    const verb = level === activeLevel ? 'l’éteindre' : 'l’allumer';
    steps.push({
      title: level === undefined ? 'Condition' : `Pour ${verb}`,
      text: siteDescription(e),
      line: e.site.visit.stmt.span.line,
      tone: e.runs === true ? 'ok' : e.runs === false ? 'off' : 'info',
    });
  }
  if (isr.length) {
    steps.push({
      title: 'Interruption',
      text: `${pin} est aussi écrite dans le programme d’interruption (${isr.map((e) => `ligne ${e.site.visit.stmt.span.line} : ${lineCode(e.site)}`).join(' ; ')}) : elle change à chaque interruption, même pendant un Delay_ms de la boucle.`,
      line: isr[0].site.visit.stmt.span.line, tone: 'info',
    });
  }
  const blink = evaluated.filter((e) => e.site.visit.inMainLoop && e.runs === true && !e.site.visit.fn.isInterrupt);
  if (blink.some((e) => e.site.value === 1) && blink.some((e) => e.site.value === 0)) {
    const hasDelay = input.unit && allVisits(input.unit).some((v) => v.inMainLoop && v.stmt.kind === 'ExpressionStatement' && v.stmt.expression.kind === 'CallExpression' && /delay/i.test(v.stmt.expression.callee.name));
    if (hasDelay) steps.push({ title: 'Clignotement', text: `Dans la boucle, ${pin} est mise à 1 puis à 0 avec une attente (Delay_ms) entre les deux : ce qui est branché dessus clignote.`, tone: 'info' });
    else steps.push({ title: 'Remarque', text: `Dans la boucle, ${pin} est mise à 0 puis à 1 (ou l’inverse) à chaque tour, sans attente : dans le schéma on voit surtout le dernier état écrit, l’autre ne dure que quelques microsecondes.`, tone: 'info' });
  }
}

function pinLevelNow(input: WhyInput, pin: PinName): { level: 0 | 1; isInput: boolean } | undefined {
  if (!input.live) return undefined;
  const { portAddr, trisAddr, bit } = portOfPin(pin);
  const cpu = input.live.cpu;
  return { level: bitOf(readRegister(cpu, portAddr), bit), isInput: bitOf(readRegister(cpu, trisAddr), bit) === 1 };
}

function ledAnswer(input: WhyInput, topo: Topology, c: ComponentInstance): WhyAnswer {
  const name = partName(c);
  const w = ledWiring(topo, c.id);
  const steps: WhyStep[] = [];
  const visual = input.live?.visuals?.[c.id];
  const lit = visual?.kind === 'LED' ? visual.lit : undefined;
  if (!w.pin || w.activeLevel === undefined) {
    return { question: `Pourquoi la ${name} ne s’allume pas ?`, state: 'off', summary: `Câblage : ${w.problem ?? 'la LED n’est pas reliée au PIC.'}`, steps: [{ title: 'Câblage', text: w.problem ?? 'Reliez l’anode à une broche du PIC et la cathode à la masse.', tone: 'warn' }] };
  }
  const pin = w.pin;
  steps.push({
    title: 'Câblage',
    text: w.activeLevel === 1
      ? `La ${name} est reliée à ${pinWithNumber(pin)}${w.series ? ` à travers ${partName(w.series)}` : ''}, sa cathode à la masse : elle s’allume quand ${pin} = 1 (5 V).`
      : `La ${name} va du +5 V à ${pinWithNumber(pin)}${w.series ? ` à travers ${partName(w.series)}` : ''} : elle s’allume quand ${pin} = 0.`,
    tone: w.problem ? 'warn' : 'info',
  });
  if (w.problem) steps.push({ title: 'Attention', text: w.problem, tone: 'warn' });
  const sigName = signalName(input, pin);
  if (sigName) {
    const def = input.unit?.macros.find((m) => m.params === null && m.name.toLowerCase() === sigName.toLowerCase());
    const ref = c.ref?.trim();
    const offset = ref && /^D\d+$/i.test(ref) && /^D\d+$/i.test(sigName) && ref.toUpperCase() !== sigName.toUpperCase();
    steps.push({
      title: 'Nom dans le code',
      text: offset
        ? `Dans le code, ${pin} s’appelle ${sigName}. Attention : le schéma la nomme ${ref}, le code ${sigName} (la numérotation du schéma est décalée d’un rang, comme dans le fichier ISIS du cours).`
        : `Dans le code, ${pin} s’appelle ${sigName}${def ? ` (#define ${sigName} ${def.body.trim()})` : ''}.`,
      tone: offset ? 'warn' : 'info',
    });
  }
  const now = pinLevelNow(input, pin);
  if (now) {
    if (now.isInput) {
      steps.push({ title: 'Broche', text: `${pin} est configurée en ENTRÉE (bit ${pin.slice(2)} de TRIS${pin[1]} = 1) : le PIC ne la pilote pas, la LED ne peut pas s’allumer. Il faut TRIS${pin[1]}.${pin} = 0 dans la configuration.`, tone: 'warn' });
    } else {
      steps.push({ title: 'Broche', text: `${pin} est une sortie et vaut ${now.level} en ce moment → la LED est ${now.level === w.activeLevel && !w.problem ? 'allumée' : 'éteinte'}.`, tone: now.level === w.activeLevel ? 'ok' : 'off' });
    }
  } else {
    steps.push({ title: 'Simulation', text: 'La simulation est arrêtée : lancez-la (ou avancez pas à pas) pour voir la LED réagir. Ci-dessous, ce que le programme fera avec les valeurs de départ.', tone: 'info' });
  }
  if (now && !now.isInput && lit !== undefined && lit !== (now.level === w.activeLevel)) {
    steps.push({
      title: 'Remarque',
      text: lit
        ? `La LED paraît allumée alors que ${pin} vaut ${now.level} à cet instant : le programme la rallume à chaque tour de boucle, elle n’est éteinte que quelques microsecondes. L’œil (et ISIS) voit la moyenne.`
        : `La LED paraît éteinte alors que ${pin} vaut ${now.level} à cet instant : elle n’est allumée qu’un très court moment à chaque tour de boucle.`,
      tone: 'info',
    });
  }
  codeSteps(input, pin, now?.level, w.activeLevel, steps);
  const state: WhyAnswer['state'] = lit === undefined ? (now ? (now.level === w.activeLevel && !now.isInput && !w.problem ? 'on' : 'off') : 'unknown') : lit ? 'on' : 'off';
  const question = state === 'on' ? `Pourquoi la ${name} est allumée ?` : state === 'off' ? `Pourquoi la ${name} est éteinte ?` : `Quand la ${name} s’allume-t-elle ?`;
  const decisive = steps.find((s) => s.title.startsWith('Ligne qui') || s.title.startsWith('Dernière écriture'));
  const summary = state === 'unknown'
    ? `Elle s’allume quand le programme met ${pin} à ${w.activeLevel}.`
    : `${pin} = ${now?.level ?? (state === 'on' ? w.activeLevel : 1 - w.activeLevel)}${decisive?.line ? `, écrit par la ligne ${decisive.line}` : ''}.`;
  return { question, state, summary, steps };
}

function displayAnswer(input: WhyInput, topo: Topology, c: ComponentInstance): WhyAnswer {
  const steps: WhyStep[] = [];
  const pins = (['E0', 'E1', 'E2', 'E3'] as const).map((e) => ({ e, pin: topo.picPinOn(c.id, e) }));
  const wired = pins.filter((p) => p.pin);
  steps.push({ title: 'Câblage', text: wired.length ? `${wired.map((p) => `${p.e} ← ${p.pin}`).join(', ')} : l’afficheur montre le nombre E3 E2 E1 E0 (0–9, puis A b C d E F).` : 'Aucune entrée n’est reliée au PIC.', tone: wired.length === 4 ? 'info' : 'warn' });
  const visual = input.live?.visuals?.[c.id];
  const value = visual?.kind === '7SEG-BCD' ? visual.value : null;
  const glyph = (v: number) => (v < 10 ? String(v) : 'AbCdEF'[v - 10]);
  if (input.unit && wired[0]?.pin) {
    const port = wired[0].pin.startsWith('RA') ? ADDR.PORTA : ADDR.PORTB;
    const ctx = lineContext(input, input.live ? input.liveEnv : input.staticEnv, input.live ? 'live' : 'static')!;
    const sites: PinWriteSite[] = allVisits(input.unit).flatMap((v) => statementWrites(v.stmt, input.unit!)
      .filter((w) => w.target.kind === 'reg' && w.target.addr === port && w.target.bit === undefined)
      .map((w) => ({ visit: v, write: w, value: 'expr' as const, whole: true })));
    const evaluated = evaluateSites(ctx, sites);
    steps.push({ title: 'Code', text: sites.length ? `Lignes qui écrivent l’afficheur : ${sites.map((s) => `${s.visit.stmt.span.line} (${s.write.value ? exprText(s.write.value) : '?'})`).join(', ')}.` : 'Aucune ligne n’écrit le port de l’afficheur.', tone: 'info' });
    // What a port value shows on the display, through the wiring (E0..E3 ← their pins).
    const shown = (portValue: number): number | null => {
      let n = 0;
      for (const [i, p] of pins.entries()) {
        if (!p.pin) return null;
        const { portAddr, bit } = portOfPin(p.pin);
        if (portAddr !== port) return null;
        n |= bitOf(portValue, bit) << i;
      }
      return n;
    };
    const fit = (e: Evaluated): Fit => {
      if (value === null || !e.site.write.value) return 'maybe';
      const constant = evaluate(e.site.write.value, CONSTANTS_ONLY, input.unit ?? undefined);
      const now = constant ?? (ctx.env ? evaluate(e.site.write.value, ctx.env, input.unit ?? undefined) : undefined);
      if (now === undefined) return 'maybe';
      const d = shown(now);
      if (d === null) return 'maybe';
      // A constant that shows something else cannot be the write; an expression may have had another value then.
      return d === value ? 'exact' : constant !== undefined ? 'no' : 'maybe';
    };
    // Step by step: the line recorded for all the display's pins, when they agree.
    const recordedLines = new Set(wired.map((p) => input.lastWrites?.get(p.pin!)?.line));
    const recorded = input.live && recordedLines.size === 1 ? [...recordedLines][0] : undefined;
    const decisive = (recorded !== undefined ? evaluated.find((e) => e.site.visit.stmt.span.line === recorded) : undefined)
      ?? decisiveWrite(input.unit!, evaluated, !!input.live, input.live?.line, fit);
    if (decisive) {
      const constant = decisive.site.write.value ? evaluate(decisive.site.write.value, CONSTANTS_ONLY, input.unit) : undefined;
      const v = constant ?? (decisive.site.write.value && ctx.env && decisive.runs !== false ? evaluate(decisive.site.write.value, ctx.env, input.unit) : undefined);
      steps.push({ title: input.live ? 'Ligne qui a fixé l’affichage' : 'Ligne qui fixera l’affichage', text: `${siteDescription(decisive, !!input.live)}${v !== undefined ? ` Valeur écrite : ${decHex(v)} → 4 bits de poids faible ${(v & 15).toString(2).padStart(4, '0')} → « ${glyph(v & 15)} ».` : ''}`, line: decisive.site.visit.stmt.span.line, tone: 'info' });
    }
  }
  const state: WhyAnswer['state'] = value === null ? 'unknown' : 'on';
  return {
    question: value === null ? 'Que va afficher l’afficheur ?' : `Pourquoi l’afficheur montre « ${glyph(value)} » ?`,
    state,
    summary: value === null ? 'Il affiche les 4 bits que le programme écrit sur ses entrées.' : `Il reçoit ${value.toString(2).padStart(4, '0')} = ${value} sur E3..E0.`,
    steps,
  };
}

function lampsAnswer(input: WhyInput, topo: Topology, c: ComponentInstance): WhyAnswer {
  const steps: WhyStep[] = [];
  const visual = input.live?.visuals?.[c.id];
  for (const [p, fr, key] of [['R', 'rouge', 'red'], ['A', 'orange', 'amber'], ['G', 'vert', 'green']] as const) {
    const pin = topo.picPinOn(c.id, p);
    if (!pin) { steps.push({ title: `Feu ${fr}`, text: 'Lampe non reliée au PIC.', tone: 'warn' }); continue; }
    const on = visual?.kind === 'TRAFFIC_LIGHTS' ? visual[key] : undefined;
    const sub: WhyStep[] = [];
    codeSteps(input, pin, pinLevelNow(input, pin)?.level, 1, sub);
    const decisive = sub.find((s) => s.title.startsWith('Ligne qui') || s.title.startsWith('Dernière écriture'));
    steps.push({ title: `Feu ${fr} (${pin})`, text: `${on === undefined ? '' : on ? 'Allumé. ' : 'Éteint. '}${decisive ? decisive.text : 'S’allume quand le programme met cette broche à 1.'}`, line: decisive?.line, tone: on ? 'ok' : on === false ? 'off' : 'info' });
  }
  return { question: 'Pourquoi le feu est dans cet état ?', state: visual ? 'on' : 'unknown', summary: 'Chaque lampe s’allume quand sa broche est à 1.', steps };
}

function inputAnswer(input: WhyInput, topo: Topology, c: ComponentInstance): WhyAnswer {
  const steps: WhyStep[] = [];
  let pin: PinName | undefined;
  let level: 0 | 1 | undefined;
  if (c.kind === 'LOGICSTATE') {
    pin = topo.picPinOn(c.id, 'Q0');
    const visual = input.live?.visuals?.[c.id];
    level = visual?.kind === 'LOGICSTATE' ? visual.state : (Number(c.props.state ?? 0) ? 1 : 0);
    steps.push({ title: 'Composant', text: `Le LOGICSTATE impose ${level} sur ${pin ?? 'sa sortie'} : cliquez dessus pendant la simulation pour le basculer. Il reste dans sa position (contrairement à un bouton poussoir).`, tone: 'info' });
  } else if (c.kind === 'BUTTON') {
    // PORTB's pull-ups are on only when the program cleared OPTION_REG.RBPU (live: the register itself).
    const rbPullups = input.live ? bitOf(readRegister(input.live.cpu, ADDR.OPTION_REG), 7) === 0 : rbPullupsEnabled(input.unit);
    const w = buttonWiring(topo, c.id, { rbPullups });
    pin = w.pin;
    const visual = input.live?.visuals?.[c.id];
    const pressed = visual?.kind === 'BUTTON' ? visual.pressed : false;
    // Released with nothing pulling the input: no defined level.
    const floating = !pressed && !!w.problem;
    if (w.activeLevel !== undefined && !floating) level = (pressed ? w.activeLevel : 1 - w.activeLevel) as 0 | 1;
    const pull = w.pull ? ` ; ${partName(w.pull.res)} tire ${w.pin} vers ${w.pull.rail === 'GND' ? 'la masse (pull-down)' : '+5 V (pull-up)'}` : '';
    steps.push({
      title: 'Composant',
      text: floating
        ? `Bouton relâché : rien ne tire ${w.pin ?? 'l’entrée'} vers un niveau fixe, l’entrée est « en l’air » (flottante) et sa valeur n’est pas garantie.`
        : `Bouton ${pressed ? 'appuyé' : 'relâché'}${pull} → ${w.pin ?? 'l’entrée'} = ${level ?? '?'}.`,
      tone: w.problem ? 'warn' : 'info',
    });
    if (w.problem) steps.push({ title: 'Attention', text: w.problem.charAt(0).toUpperCase() + w.problem.slice(1), tone: 'warn' });
  } else {
    // TORCH_LDR
    for (const side of ['1', '2']) pin = pin ?? topo.picPinOn(c.id, side);
    const lvl = Math.max(0, Math.min(9, Math.round(Number(input.live?.visuals?.[c.id]?.kind === 'TORCH_LDR' ? (input.live.visuals[c.id] as { level: number }).level : c.props.level ?? 0))));
    const node = topo.picPinOn(c.id, '1') ? '1' : '2';
    const fixed = topo.railResistors(c.id, node)[0];
    if (pin && fixed) {
      const onTop = topo.rail(c.id, node === '1' ? '2' : '1') === 'VDD';
      const l = ldrLevels(ohmsOf(fixed.res), onTop)[lvl];
      level = l.reads === '1' ? 1 : l.reads === '0' ? 0 : undefined;
      steps.push({ title: 'Lumière', text: `Niveau ${lvl} : la LDR vaut ${formatOhms(l.ohms)}, donc V(${pin}) = 5 × ${formatOhms(ohmsOf(fixed.res))} / (${formatOhms(l.ohms)} + ${formatOhms(ohmsOf(fixed.res))}) ≈ ${frenchNumber(l.volts, 2)} V → ${l.reads === 'garde' ? 'entre 0,8 V et 2 V : l’entrée garde son état précédent' : `le PIC lit ${l.reads}`}.`, tone: 'info' });
    }
  }
  if (pin) {
    const now = pinLevelNow(input, pin);
    if (now) {
      level = now.level;
      if (!now.isInput) steps.push({ title: 'Broche', text: `${pin} est configurée en SORTIE (TRIS${pin[1]}.${pin} = 0) : le PIC ne lit pas cet élément. Il faut mettre ce bit TRIS à 1.`, tone: 'warn' });
      else steps.push({ title: 'Broche', text: `${pin} est une entrée et le PIC lit ${now.level}.`, tone: 'info' });
    }
    if (input.unit) {
      const reads = readsOfPin(input.unit, pin);
      steps.push({ title: 'Code', text: reads.length ? `Le programme lit ${pin} ${reads.length > 1 ? 'aux lignes' : 'à la ligne'} ${frenchList(reads.map((r) => `${r.line} (${r.code})`))}.` : `Aucune ligne du programme ne lit ${pin}.`, line: reads[0]?.line, tone: reads.length ? 'info' : 'warn' });
    }
  }
  const title = partTitle(c, topo);
  return {
    question: `Que lit le PIC sur ${pin ?? 'cette entrée'} ?`,
    state: level === undefined ? 'unknown' : level ? 'on' : 'off',
    summary: pin ? `${title} → ${pin} = ${level ?? '?'}${input.unit ? '' : ''}.` : `${title} n’est relié à aucune broche du PIC.`,
    steps,
  };
}

/** « Pourquoi ? » for a selected part, or null for parts without a useful answer (terminals, wires). */
export function explainWhy(input: WhyInput): WhyAnswer | null {
  const topo = new Topology(input.schematic, input.netlist);
  const c = topo.byId.get(input.componentId);
  if (!c) return null;
  switch (c.kind) {
    case 'LED': return ledAnswer(input, topo, c);
    case '7SEG-BCD': return displayAnswer(input, topo, c);
    case 'TRAFFIC_LIGHTS': return lampsAnswer(input, topo, c);
    case 'LOGICSTATE': case 'BUTTON': case 'TORCH_LDR': return inputAnswer(input, topo, c);
    case 'RES': {
      const pin = topo.picPinOn(c.id, '1') ?? topo.picPinOn(c.id, '2');
      const src = pin ? inputSourceOf(topo, pin) : undefined;
      return {
        question: `À quoi sert ${partName(c)} ?`, state: 'na',
        summary: pin ? `Elle est reliée à ${pin}.` : 'Elle n’est pas reliée directement au PIC.',
        steps: [{ title: 'Rôle', text: pin ? `Elle relie ${pin}${src ? ` (${src})` : ''} au reste du montage : en série avec une LED elle limite le courant ; vers la masse ou le +5 V elle fixe le niveau d’une entrée au repos (pull-down / pull-up).` : 'Résistance du montage (en série avec une LED, ou dans un pont diviseur).', tone: 'info' }],
      };
    }
    case 'PIC16F84A':
      return {
        question: 'Que fait le PIC en ce moment ?', state: 'na',
        summary: input.live?.line ? `Il exécute la ligne ${input.live.line} du programme.` : 'Lancez la simulation pour le voir exécuter le programme.',
        steps: [{ title: 'Astuce', text: 'Cliquez sur une LED, un afficheur ou un interrupteur du schéma : cette fiche expliquera son état et la ligne de code responsable.', tone: 'info' }],
      };
    default:
      return null;
  }
}

