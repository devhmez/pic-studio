import type { CompileOptions, CompileResult, Diagnostic } from './api';
import type { TranslationUnit } from './ast';
import { generate } from './codegen/program';
import { CONFIG_ADDR, DEFAULT_CONFIG } from './device';
import { Codes, DiagnosticBag } from './diagnostics';
import { lex, type LexResult } from './lexer';
import { toIntelHex } from './link/hex';
import { link } from './link/linker';
import { lint } from './lint';
import { parse } from './parser';
import { preprocess } from './preprocessor';
import { check, type Semantics } from './sema/checker';
import { decodeSource } from './source';

export const DEFAULT_CLOCK_HZ = 1_000_000;

/** CompileResult plus a few extra facts for the debugger panels. */
export interface CompileResultEx extends CompileResult {
  /** Worst-case hardware stack levels used (main line + interrupt), when code was generated. */
  stackDepth?: number;
  /** Decoded source text (CP1252 → string) the spans refer to. */
  source: string;
}

/** Result of the front end alone. */
export interface AnalysisResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  /** Present unless the source could not be parsed at all. */
  ast?: TranslationUnit;
  source: string;
}

interface FrontEnd {
  text: string;
  lexed?: LexResult;
  ast?: TranslationUnit;
  sem?: Semantics;
  xtalFreq?: number;
}

/** Lex, preprocess, parse, then (only without syntax errors) check and lint. */
function frontEnd(text: string, clockHz: number, diags: DiagnosticBag): FrontEnd {
  const lexed = lex(text, diags);
  const pp = preprocess(lexed, { clockHz }, diags);
  const ast = parse(lexed, pp, diags);
  if (diags.hasErrors()) return { text, lexed, ast };
  const sem = check(ast, { clockHz }, diags);
  lint(ast, sem, { clockHz, xtalFreq: pp.xtalFreq }, diags);
  return { text, lexed, ast, sem, xtalFreq: pp.xtalFreq };
}

const toText = (source: string | Uint8Array) => (typeof source === 'string' ? source : decodeSource(source));

/**
 * Check a program without generating code (fast enough for every keystroke): syntax, types, MikroC rules and the
 * teaching warnings, plus the AST for the organigramme.
 */
export function analyze(source: string | Uint8Array, opts: CompileOptions = {}): AnalysisResult {
  const text = toText(source);
  const diags = new DiagnosticBag();
  let fe: FrontEnd = { text };
  try {
    fe = frontEnd(text, opts.clockHz ?? DEFAULT_CLOCK_HZ, diags);
  } catch (e) {
    diags.error(Codes.INTERNAL, `Erreur interne du compilateur : ${e instanceof Error ? e.message : String(e)}`);
  }
  return { ok: !diags.hasErrors(), diagnostics: diags.sorted(), ast: fe.ast, source: text };
}

/**
 * Compile MikroC PRO for PIC source (PIC16F84A). `source` may be the raw .c bytes (Windows-1252, as saved by MikroC)
 * or an already decoded string.
 */
export function compile(source: string | Uint8Array, opts: CompileOptions = {}): CompileResultEx {
  const clockHz = opts.clockHz ?? DEFAULT_CLOCK_HZ;
  const config = (opts.config ?? DEFAULT_CONFIG) & 0x3fff;
  const text = toText(source);
  const diags = new DiagnosticBag();
  let ast: TranslationUnit | undefined;

  const failed = (): CompileResultEx => ({
    ok: false,
    diagnostics: diags.sorted(),
    config,
    listing: [],
    symbols: [],
    addrToLine: new Map(),
    lineToAddr: new Map(),
    usage: { rom: 0, ram: 0 },
    ast,
    source: text,
  });

  try {
    const fe = frontEnd(text, clockHz, diags);
    ast = fe.ast;
    if (diags.hasErrors() || !fe.sem || !fe.lexed) return failed();

    const gp = generate(fe.sem, { clockHz, xtalFreq: fe.xtalFreq }, diags);
    if (diags.hasErrors()) return failed();

    const lines = fe.lexed.lines;
    const linked = link(gp, (l) => lines.lineText(l), diags);
    if (!linked.ok || diags.hasErrors()) return { ...failed(), listing: linked.listing, stackDepth: linked.stackDepth };

    return {
      ok: true,
      diagnostics: diags.sorted(),
      program: linked.program,
      config,
      hex: toIntelHex(linked.program, (a) => linked.used[a], config, CONFIG_ADDR),
      listing: linked.listing,
      symbols: linked.symbols,
      addrToLine: linked.addrToLine,
      lineToAddr: linked.lineToAddr,
      usage: { rom: linked.romWords, ram: linked.ramBytes },
      ast,
      stackDepth: linked.stackDepth,
      source: text,
    };
  } catch (e) {
    diags.error(Codes.INTERNAL, `Erreur interne du compilateur : ${e instanceof Error ? e.message : String(e)}`);
    return failed();
  }
}
