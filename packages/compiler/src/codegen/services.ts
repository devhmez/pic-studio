import type { DiagnosticBag } from '../diagnostics';
import type { Semantics } from '../sema/checker';
import type { FuncSymbol, VarSymbol } from '../sema/symbols';
import type { LabelFactory } from './emitter';
import type { FileRef } from './ir';
import type { ExecContext, Runtime } from './runtime';

/** What a function code generator needs from the program-level generator. */
export interface ProgramServices {
  sem: Semantics;
  diags: DiagnosticBag;
  labels: LabelFactory;
  clockHz: number;
  /** `_XTAL_FREQ` (HI-TECH `__delay_ms`), when defined. */
  xtalFreq?: number;
  runtime: Runtime;
  /** RAM location of an integer or array variable. */
  varRef(sym: VarSymbol): FileRef;
  /** Location of a `bit` variable. */
  bitRef(sym: VarSymbol): { f: FileRef; b: number };
  /** Label of the RETLW table holding byte `byte` of a const array. */
  romTable(sym: VarSymbol, byte: number): string;
  functionLabel(fn: FuncSymbol): string;
  /** Multi-byte return value slot of a function. */
  returnRef(fn: FuncSymbol): FileRef;
  contextOf(fn: FuncSymbol): ExecContext;
}
