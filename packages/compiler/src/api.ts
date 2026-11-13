// Public contract of the MikroC-subset compiler (MikroC PRO for PIC dialect, PIC16F84A target).

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  /** Stable machine code, e.g. 'E_UNDECLARED', 'W_SEPARATE_IF_AFTER_FLAG', 'W_DELAY_NOT_CONST'. */
  code: string;
  /** Message in French, MikroC-like wording. */
  message: string;
  line: number;   // 1-based
  col: number;    // 1-based
  endLine?: number;
  endCol?: number;
}

export interface CompileOptions {
  /** Oscillator frequency in Hz; drives Delay_ms/Delay_us code generation. Default 1_000_000. */
  clockHz?: number;
  /** Configuration word placed at 0x2007. Default 0x3FFB (RC osc, WDT off, PWRT off, CP off) like the prof's ISIS files. */
  config?: number;
  /** Source file name for messages. */
  fileName?: string;
}

/** One line of the generated listing (what the "Assembleur" panel shows). */
export interface ListingLine {
  /** Program-memory address, or undefined for label/comment-only lines. */
  addr?: number;
  /** 14-bit opcode at addr. */
  word?: number;
  /** Label defined at this address, if any. */
  label?: string;
  /** Mnemonic text, MPASM style, e.g. 'MOVLW 0x06', 'SUBWF y, W', 'BTFSC STATUS, Z'. */
  text: string;
  /** C source line this instruction comes from (1-based). */
  srcLine?: number;
  /** Optional comment (e.g. the C source text for the first instruction of a line). */
  comment?: string;
}

export interface SymbolInfo {
  name: string;
  /** 'global' | function name for locals. */
  scope: string;
  /** RAM address (GPR 0x0C–0x4F) or SFR address for absolute/sbit. */
  addr: number;
  size: number;
  type: string;
}

export interface CompileResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  /** 1024 program words (unused = 0x3FFF). Present when ok. */
  program?: Uint16Array;
  config: number;
  /** Intel HEX (INHX8M, like MPASM/MikroC output) including config at 0x2007. Present when ok. */
  hex?: string;
  listing: ListingLine[];
  symbols: SymbolInfo[];
  /** addr → C source line, for stepping by line. */
  addrToLine: Map<number, number>;
  /** C source line → first addr. */
  lineToAddr: Map<number, number>;
  /** Number of program words used / RAM bytes used. */
  usage: { rom: number; ram: number };
  /** Typed AST of the translation unit (after preprocessing), consumed by @pic/program-model. */
  ast?: import('./ast').TranslationUnit;
}
