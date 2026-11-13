// Checks one copilot answer the way the student would in MikroC + ISIS, before showing it:
//   circuit  → autolayout (unknown parts / pins, wiring problems);
//   code     → compile (French MikroC errors), then rewrite it in the prof's style through the program model
//              (fromAst → generate), keeping the copilot's own text when the model cannot represent it exactly;
//   together → validate(program, schematic) (pins used by the code but not wired, outputs on a LOGICSTATE...);
//   tests    → simulated on the compiled program inside the laid-out schematic.
import type { Schematic } from '@pic/circuit';
import { compile, type CompileResultEx, type Diagnostic } from '@pic/compiler';
import {
  deriveSignals, forEachStmt, fromAstDetailed, stmtConds, stmtExprs, validate, walkCond, walkExpr,
  type Program,
} from '@pic/program-model';
import { generate } from '@pic/style-c';
import { componentIdOf, isEmptySchematic, layoutCircuit } from './circuit';
import type { CorrectionReport } from './prompt';
import type { CopilotAnswer } from './schema';
import { runTests, type TestResult } from './simtests';

/** The project the answer applies to (what is currently open). */
export interface ProjectState {
  name: string;
  schematic: Schematic;
  source: string;
  clockHz: number;
  config?: number;
}

export type CodeStyle = 'prof' | 'copilote' | 'actuel';

export interface VerifyReport {
  /** Schematic to apply (laid out from the answer, or the current one). */
  schematic: Schematic;
  schematicFromAnswer: boolean;
  /** Answer ref (upper case) → component id. */
  ids: Record<string, string>;
  clockHz: number;
  /** Code to apply. */
  source: string;
  sourceFromAnswer: boolean;
  /** Program model when `source` is the prof-style rewrite (applied with setProgram); null otherwise. */
  program: Program | null;
  style: CodeStyle;
  compiled: boolean;
  problems: CorrectionReport;
  /** Shown to the student, not sent back for correction. */
  warnings: string[];
  tests: TestResult[];
  /** Lower is better (used to keep the best of several attempts). */
  score: number;
  ok: boolean;
}

export type VerifyStep = 'compile' | 'tests';

export interface VerifyOptions {
  onStep?(step: VerifyStep): void;
  yieldToUi?(): Promise<void>;
  /** Problems found while reading the answer (malformed parts / links / tests). */
  answerProblems?: string[];
}

const emptyReport = (): CorrectionReport => ({ answer: [], circuit: [], compile: [], consistency: [], tests: [], missing: [] });

const diagLine = (d: Diagnostic) => `ligne ${d.line} : ${d.message}`;

/** True when the program model holds C it could not interpret (raw statements, conditions or expressions). */
export function hasRawParts(p: Program): boolean {
  let raw = false;
  forEachStmt(p, ({ stmt }) => {
    if (stmt.kind === 'raw') raw = true;
    for (const c of stmtConds(stmt)) walkCond(c, (x) => { if (x.kind === 'raw') raw = true; }, (e) => walkExpr(e, (x) => { if (x.kind === 'raw') raw = true; }));
    for (const e of stmtExprs(stmt)) walkExpr(e, (x) => { if (x.kind === 'raw') raw = true; });
  });
  return raw;
}

const normalize = (s: string) => s.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();

/**
 * The prof-style rewrite of compiled code: program model + generated C, or null when it would lose something
 * (raw blocks, a partial import, or generated C that no longer compiles).
 */
export function restyle(result: CompileResultEx, clockHz: number, title: string): { program: Program; source: string } | null {
  if (!result.ok || !result.ast) return null;
  try {
    const { program, notes } = fromAstDetailed(result.ast, result.source, { title, clockHz });
    if (notes.some((n) => /partiel/i.test(n)) || hasRawParts(program)) return null;
    const source = generate(program);
    const again = compile(source, { clockHz });
    if (!again.ok) return null;
    return { program, source };
  } catch {
    return null;
  }
}

/** Validation issues (French) of `source` against `schematic`, split into blocking problems and warnings. */
function consistency(result: CompileResultEx, schematic: Schematic, clockHz: number, title: string): { problems: string[]; warnings: string[]; program: Program | null } {
  if (!result.ast) return { problems: [], warnings: [], program: null };
  let program: Program;
  try {
    program = fromAstDetailed(result.ast, result.source, { title, clockHz }).program;
  } catch {
    return { problems: [], warnings: [], program: null };
  }
  const problems: string[] = [];
  const warnings: string[] = [];
  let issues: ReturnType<typeof validate> = [];
  try {
    issues = validate(program, schematic);
  } catch {
    issues = [];
  }
  const BLOCKING_WARNINGS = new Set(['W_PIN_UNCONNECTED', 'W_INPUT_ON_LOAD', 'W_CLOCK_MISMATCH']);
  for (const i of issues) {
    if (i.severity === 'error' || BLOCKING_WARNINGS.has(i.code)) problems.push(i.message);
    else if (i.severity === 'warning') warnings.push(i.message);
  }
  // Parts wired to the PIC that the code never touches (often a forgotten TRIS or output).
  try {
    const used = new Set<string>();
    for (const s of program.signals) used.add(s.pin);
    for (const b of program.buses) for (let k = 0; k < b.width; k++) used.add(`R${b.port}${b.lsb + k}`);
    const raw = result.source;
    for (const s of deriveSignals(schematic).signals) {
      const pin: string = s.pin;
      const port = pin.slice(0, 2); const bit = pin.slice(2);
      const mentioned = used.has(pin) || new RegExp(`\\b${pin}\\b|PORT${port.slice(1)}\\s*\\.\\s*(F|B)?${bit}\\b|PORT${port.slice(1)}\\s*=`, 'i').test(raw);
      if (!mentioned) warnings.push(`${s.label} (${pin}) est branché(e) mais le code ne s'en sert pas.`);
    }
  } catch {
    // derived signals are only a hint
  }
  return { problems, warnings, program };
}

const SCORE = { compile: 100, circuit: 20, consistency: 10, tests: 5, answer: 2, missing: 50 } as const;

export function scoreOf(p: CorrectionReport): number {
  return p.compile.length * SCORE.compile + p.circuit.length * SCORE.circuit + p.consistency.length * SCORE.consistency
    + p.tests.length * SCORE.tests + p.answer.length * SCORE.answer + p.missing.length * SCORE.missing;
}

/** Verify an answer against the current project. Never throws. */
export async function verifyAnswer(answer: CopilotAnswer, current: ProjectState, options: VerifyOptions = {}): Promise<VerifyReport> {
  const problems = emptyReport();
  const warnings: string[] = [];
  problems.answer.push(...(options.answerProblems ?? []));
  const yieldToUi = options.yieldToUi ?? (() => Promise.resolve());

  // ------------------------------------------------------------ circuit
  let schematic = current.schematic;
  let ids: Record<string, string> = {};
  let clockHz = current.clockHz;
  if (answer.circuit) {
    const layout = layoutCircuit(answer.circuit);
    schematic = layout.schematic;
    ids = layout.ids;
    clockHz = schematic.clockHz;
    for (const p of layout.problems) {
      if (p.code === 'UNCONNECTED') warnings.push(p.message);
      else problems.circuit.push(p.message);
    }
    if (answer.circuit.composants.length === 0) problems.circuit.push('le circuit ne contient aucun composant.');
  } else if (answer.code && isEmptySchematic(current.schematic)) {
    problems.missing.push('il manque le circuit ("circuit") : le schéma actuel est vide.');
  }

  // ------------------------------------------------------------ code
  options.onStep?.('compile');
  await yieldToUi();
  const aiSource = answer.code ?? null;
  const source0 = aiSource ?? current.source;
  if (!aiSource && answer.circuit && /void\s+main\s*\(\s*\)\s*\{\s*\}/.test(current.source)) {
    problems.missing.push('il manque le programme ("code") complet.');
  }
  const result = compile(source0, { clockHz, ...(current.config !== undefined ? { config: current.config } : {}) });
  for (const d of result.diagnostics) {
    if (d.severity === 'error') problems.compile.push(diagLine(d));
    else if (d.severity === 'warning') warnings.push(diagLine(d));
  }

  let source = source0;
  let program: Program | null = null;
  let style: CodeStyle = aiSource ? 'copilote' : 'actuel';
  const prof = aiSource && result.ok ? restyle(result, clockHz, current.name) : null;
  if (prof) {
    source = prof.source;
    program = prof.program;
    style = 'prof';
  }

  // ------------------------------------------------------------ code ↔ circuit
  if (result.ast) {
    const c = consistency(result, schematic, clockHz, current.name);
    problems.consistency.push(...c.problems);
    warnings.push(...c.warnings);
  }

  // ------------------------------------------------------------ tests
  let tests: TestResult[] = [];
  const idOf = (ref: string) => componentIdOf({ ids }, ref);
  if (result.ok && result.program && answer.tests?.length) {
    options.onStep?.('tests');
    await yieldToUi();
    const config = current.config;
    let compiledProf: CompileResultEx | null = null;
    if (prof) {
      compiledProf = compile(prof.source, { clockHz, ...(config !== undefined ? { config } : {}) });
      if (!compiledProf.ok || !compiledProf.program) compiledProf = null;
    }
    const target = (words: Uint16Array) => ({ schematic, program: words, clockHz, ...(config !== undefined ? { config } : {}) });
    tests = await runTests(answer.tests, target(compiledProf?.program ?? result.program), idOf, yieldToUi);
    const failed = tests.filter((t) => !t.passed).length;
    if (failed > 0 && compiledProf) {
      // The rewrite must behave like the copilot's code: if the original does better, keep the original.
      const original = await runTests(answer.tests, target(result.program), idOf, yieldToUi);
      if (original.filter((t) => !t.passed).length < failed) {
        tests = original;
        source = source0;
        program = null;
        style = 'copilote';
      }
    }
    for (const t of tests) if (!t.passed) problems.tests.push(`« ${t.description} » : ${t.details.join(' ; ') || 'échec'}`);
  } else if (aiSource && result.ok && !answer.tests?.length) {
    // Untested code must not look « vérifiée »: one correction turn asks for the tests.
    problems.missing.push('il manque les tests ("tests", 2 à 5) : le comportement du code n’a pas pu être vérifié en simulation.');
  }

  const score = scoreOf(problems);
  return {
    schematic,
    schematicFromAnswer: !!answer.circuit,
    ids,
    clockHz,
    source,
    sourceFromAnswer: !!aiSource,
    program,
    style,
    compiled: result.ok,
    problems,
    warnings: [...new Set(warnings)],
    tests,
    score,
    ok: problems.compile.length + problems.circuit.length + problems.consistency.length + problems.tests.length + problems.missing.length === 0,
  };
}
