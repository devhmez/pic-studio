import type { Diagnostic, Severity } from './api';
import type { Span } from './ast';

/** Stable diagnostic codes. Messages are French and MikroC-like. */
export const Codes = {
  // Lexer / preprocessor
  INVALID_CHAR: 'E_INVALID_CHAR',
  UNTERMINATED: 'E_UNTERMINATED',
  BAD_NUMBER: 'E_BAD_NUMBER',
  PREPROCESSOR: 'E_PREPROCESSOR',
  PP_ERROR_DIRECTIVE: 'E_PP_ERROR',
  PP_WARNING_DIRECTIVE: 'W_PP_WARNING',
  INCLUDE_IGNORED: 'W_INCLUDE_IGNORED',
  PRAGMA_IGNORED: 'I_PRAGMA_IGNORED',
  CONFIG_IGNORED: 'I_CONFIG_IGNORED',
  MACRO_REDEFINED: 'W_MACRO_REDEFINED',
  // Parser
  SYNTAX: 'E_SYNTAX',
  EXPECTED_SEMICOLON: 'E_EXPECTED_SEMICOLON',
  UNSUPPORTED: 'E_UNSUPPORTED',
  // Semantic
  UNDECLARED: 'E_UNDECLARED',
  REDECLARED: 'E_REDECLARED',
  NOT_LVALUE: 'E_NOT_LVALUE',
  CONST_ASSIGN: 'E_CONST_ASSIGN',
  TYPE: 'E_TYPE',
  CONST_EXPECTED: 'E_CONST_EXPECTED',
  /** MikroC refuses Delay_ms/Delay_us with a non-constant argument; the message suggests Vdelay_ms. */
  DELAY_NOT_CONST: 'E_DELAY_NOT_CONST',
  ARG_COUNT: 'E_ARG_COUNT',
  BIT_SELECTOR: 'E_BIT_SELECTOR',
  NO_MAIN: 'E_NO_MAIN',
  RECURSION: 'E_RECURSION',
  STACK_OVERFLOW: 'E_STACK_OVERFLOW',
  RAM_FULL: 'E_RAM_FULL',
  ROM_FULL: 'E_ROM_FULL',
  BREAK_OUTSIDE: 'E_BREAK_OUTSIDE',
  DIV_BY_ZERO: 'E_DIV_BY_ZERO',
  UNDEFINED_FUNCTION: 'E_UNDEFINED_FUNCTION',
  RETURN_VALUE: 'E_RETURN_VALUE',
  INTERNAL: 'E_INTERNAL',
  // Warnings / lint
  SEPARATE_IF_AFTER_FLAG: 'W_SEPARATE_IF_AFTER_FLAG',
  PORTA_BIT_UNIMPLEMENTED: 'W_PORTA_BIT_UNIMPLEMENTED',
  RA4_OPEN_DRAIN: 'W_RA4_OPEN_DRAIN',
  PORT_WRITE_CLEARS_BITS: 'W_PORT_WRITE_CLEARS_BITS',
  UNUSED_VARIABLE: 'W_UNUSED_VARIABLE',
  CLOCK_MISMATCH: 'W_CLOCK_MISMATCH',
  REENTRANT: 'W_REENTRANT',
  NO_EFFECT: 'W_NO_EFFECT',
  TRUNCATED_CONSTANT: 'W_TRUNCATED_CONSTANT',
  /** `case 300:` on an unsigned char: the case can never be taken. */
  CASE_OUT_OF_RANGE: 'W_CASE_OUT_OF_RANGE',
  MISSING_RETURN: 'W_MISSING_RETURN',
  ABSOLUTE_OVERLAP: 'W_ABSOLUTE_OVERLAP',
  UNIMPLEMENTED_RAM: 'W_UNIMPLEMENTED_RAM',
  SHADOWS_PREDEFINED: 'W_SHADOWS_PREDEFINED',
  BUILTIN_OVERRIDDEN: 'W_BUILTIN_OVERRIDDEN',
  STATUS_CLEAR_SETS_Z: 'I_STATUS_CLEAR_SETS_Z',
} as const;

export type DiagnosticCode = (typeof Codes)[keyof typeof Codes];

export class DiagnosticBag {
  readonly items: Diagnostic[] = [];
  private readonly seen = new Set<string>();

  add(severity: Severity, code: string, message: string, span: Span | undefined): void {
    const line = span?.line ?? 1;
    const col = span?.col ?? 1;
    const key = `${severity}|${code}|${message}|${line}|${col}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const d: Diagnostic = { severity, code, message, line, col };
    if (span) {
      d.endLine = span.endLine;
      d.endCol = span.endCol;
    }
    this.items.push(d);
  }

  error(code: string, message: string, span?: Span): void {
    this.add('error', code, message, span);
  }

  warning(code: string, message: string, span?: Span): void {
    this.add('warning', code, message, span);
  }

  info(code: string, message: string, span?: Span): void {
    this.add('info', code, message, span);
  }

  get errorCount(): number {
    return this.items.filter((d) => d.severity === 'error').length;
  }

  hasErrors(): boolean {
    return this.items.some((d) => d.severity === 'error');
  }

  /** Diagnostics sorted by position, errors first on equal position. */
  sorted(): Diagnostic[] {
    const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
    return [...this.items].sort((a, b) => a.line - b.line || a.col - b.col || rank[a.severity] - rank[b.severity]);
  }
}

/** Thrown for compiler bugs; reported as E_INTERNAL rather than crashing the caller. */
export class InternalError extends Error {}
