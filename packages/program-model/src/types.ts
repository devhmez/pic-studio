// The structured Program model: the single source of truth from which BOTH the prof-style C (@pic/style-c) and
// the organigramme (@pic/organigramme) are generated, and into which hand-written C is parsed back (fromAst).
//
// Everything here is plain JSON (no Map, no class, no undefined-only semantics): templates/*.program.json and the
// project file store it as-is. Statements, branches and functions carry stable string ids so the UI can select,
// highlight and edit them across regenerations.

/** Version of the JSON shape. Bump on breaking changes and migrate in parseProgramJson. */
export const PROGRAM_VERSION = 1;

export type Port = 'A' | 'B';
export type Level = 0 | 1;
export type Direction = 'in' | 'out';

/** General-purpose I/O pins of the PIC16F84A (RA0–RA4, RB0–RB7). */
export type PinName =
  | 'RA0' | 'RA1' | 'RA2' | 'RA3' | 'RA4'
  | 'RB0' | 'RB1' | 'RB2' | 'RB3' | 'RB4' | 'RB5' | 'RB6' | 'RB7';

// ---------------------------------------------------------------------------------------------------------------
// I/O: signals (one pin) and buses (several adjacent pins of one port)

/**
 * What a signal drives or reads, used for the French prose (« Led rouge allumée », « Feu vert allumé ») and to
 * decide whether the LED_ON / LED_OFF macros apply.
 */
export type SignalDevice =
  | 'led'         // LED-RED/GREEN/BLUE/YELLOW
  | 'lamp'        // one lamp of TRAFFIC LIGHTS
  | 'output'      // any other output
  | 'logicstate'  // latched LOGICSTATE switch
  | 'button'      // momentary BUTTON
  | 'sensor'      // TORCH_LDR divider (« capteur »)
  | 'input';      // any other input

/** One pin with a symbolic name: `#define NAME PORTx.Rxn`. */
export interface Signal {
  /** Stable id (never shown, survives renames). */
  id: string;
  /** C identifier used in the `#define` (upper case by convention: L0, LED_EGAL, VOTE_A). */
  name: string;
  pin: PinName;
  dir: Direction;
  /** French noun phrase for the organigramme and the UI: 'Led égalité', 'Bouton Vote A', 'Feu rouge'. */
  label: string;
  /** Pin level meaning "on" (LED lit, button pressed, light detected). */
  activeLevel: Level;
  device?: SignalDevice;
  /** Schematic component this signal belongs to (LED, LOGICSTATE, BUTTON…), when known. */
  componentId?: string;
  /** Trailing comment of the `#define` line. */
  comment?: string;
  /** false: no `#define`; the code uses the register bit (`PORTA.RA0`) directly. Default true. */
  useDefine?: boolean;
  /** Prose overrides for the organigramme (default « <label> allumée » / « <label> éteinte » for a LED). */
  onText?: string;
  offText?: string;
}

/** Several adjacent pins of one port used as a number: `#define AFFICHEUR PORTB` (7SEG-BCD on RB0..RB3). */
export interface Bus {
  id: string;
  name: string;
  port: Port;
  /** Lowest bit used (0..7). */
  lsb: number;
  /** Number of bits (1..8; at most 5 on PORTA). */
  width: number;
  dir: Direction;
  label: string;
  /** 'bcd': a 7SEG-BCD display (writes are described as « Afficher la lettre 'A' »). */
  device?: 'bcd' | 'generic';
  componentId?: string;
  comment?: string;
}

/** `#define NAME value` (e.g. `#define REPONSE_CORRECTE 0xCA`). */
export interface Constant {
  name: string;
  value: number;
  radix?: Radix;
  comment?: string;
}

export type VarType = 'unsigned char' | 'signed char' | 'char' | 'unsigned int' | 'int';

export interface Variable {
  name: string;
  type: VarType;
  /**
   * Where it is declared. Omitted: at the top of main(), or global when a function other than main uses it
   * (an interrupt routine cannot see main's locals).
   */
  scope?: 'main' | 'global';
  comment?: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Expressions and conditions

export type Radix = 2 | 10 | 16;
export type ArithOp = '+' | '-' | '*' | '/' | '%' | '&' | '|' | '^' | '<<' | '>>';
export type CompareOp = '==' | '!=' | '<' | '<=' | '>' | '>=';

/** Status and interrupt flags a condition can test. Z/C/DC live in STATUS, the others in INTCON. */
export type FlagName = 'Z' | 'C' | 'DC' | 'INTF' | 'RBIF' | 'T0IF';

export type Expr =
  | { kind: 'num'; value: number; /** Printing preference (default 10). */ radix?: Radix }
  /** A variable or a `#define` constant. */
  | { kind: 'var'; name: string }
  | { kind: 'signal'; id: string }
  | { kind: 'bus'; id: string }
  /** Raw register or register bit: `PORTB`, `STATUS`, `INTCON.INTF`. */
  | { kind: 'reg'; name: string; bit?: string }
  | { kind: 'bin'; op: ArithOp; left: Expr; right: Expr }
  | { kind: 'unary'; op: '~' | '-' | '!'; arg: Expr }
  /** Escape hatch: C text printed as-is. */
  | { kind: 'raw'; text: string };

export type Cond =
  /** `L0 == 1` (signal level). */
  | { kind: 'pin'; signal: string; value: Level }
  /** `STATUS.F2 == 1`, drawn « ZERO==1 »; `INTCON.INTF == 1`, drawn « INTF==1 ». */
  | { kind: 'flag'; flag: FlagName; value: Level }
  | { kind: 'compare'; left: Expr; op: CompareOp; right: Expr }
  | { kind: 'and'; items: Cond[] }
  | { kind: 'or'; items: Cond[] }
  | { kind: 'not'; cond: Cond }
  | { kind: 'raw'; text: string };

// ---------------------------------------------------------------------------------------------------------------
// Statements

export interface StmtBase {
  /** Stable id ('s12'). Unique within the program. */
  id: string;
  /** Trailing C comment (without `//`): `z = x - y;       // Soustraction`. */
  comment?: string;
  /** Comment line(s) written above the statement (without `//`, lines separated by '\n'). */
  lead?: string;
  /** Organigramme prose override (lines separated by '\n'); replaces the generated wording of this statement. */
  text?: string;
}

/** Write one signal: `LED_ON(LED_EGAL);` or `D0=1;`. `value` is the PIN LEVEL written (not "on/off"). */
export interface SetStmt extends StmtBase { kind: 'set'; signal: string; value: Level }
/** Write several signals to the same level, one C line each (« Les Leds sont éteintes »). */
export interface SetAllStmt extends StmtBase { kind: 'setAll'; signals: string[]; value: Level }
/** `LED = !LED;` */
export interface ToggleStmt extends StmtBase { kind: 'toggle'; signal: string }
/** Write a number to a bus: `AFFICHEUR = 0x0A;` (« Afficher la lettre 'A' » on a 7SEG-BCD). */
export interface DisplayStmt extends StmtBase { kind: 'display'; bus: string; value: Expr }
/** `target = value;` where target is a variable, a bus, a signal or a register. */
export interface AssignStmt extends StmtBase { kind: 'assign'; target: LValue; value: Expr }
export interface IncrStmt extends StmtBase { kind: 'incr'; variable: string }
export interface DecrStmt extends StmtBase { kind: 'decr'; variable: string }
/** `Delay_ms(500);` (constant only, as MikroC requires). */
export interface DelayStmt extends StmtBase { kind: 'delay'; ms: number; /** 'us' → Delay_us. Default 'ms'. */ unit?: 'ms' | 'us' }
/** Busy wait until `cond` is true: written `while (<not cond>);` (e.g. wait for release → `while (VOTE_A == 1);`). */
export interface WaitStmt extends StmtBase { kind: 'waitFor'; cond: Cond }

export interface IfBranch {
  id: string;
  cond: Cond;
  body: Stmt[];
  /** Trailing comment on the `if (...)` / `else if (...)` line: `// Test du bit Zero, x = y`. */
  comment?: string;
  /** First line of the branch's organigramme box, drawn as `// <note>` (e.g. 'x= y'). */
  note?: string;
  /** Organigramme diamond text override. */
  text?: string;
}

export interface ElseBranch {
  id: string;
  body: Stmt[];
  comment?: string;
  note?: string;
}

/** if / else if … / else. Every branch is tested in order; `otherwise` is the final `else`. */
export interface IfStmt extends StmtBase { kind: 'if'; branches: IfBranch[]; otherwise: ElseBranch | null }
export interface WhileStmt extends StmtBase { kind: 'while'; cond: Cond; body: Stmt[] }
/** `for (counter = 0; counter < times; counter++) { body }`. */
export interface RepeatStmt extends StmtBase { kind: 'repeat'; times: number; counter: string; body: Stmt[] }
/** Any other `for (init; cond; update)`. */
export interface ForStmt extends StmtBase {
  kind: 'for';
  init: AssignStmt;
  cond: Cond;
  update: AssignStmt | IncrStmt | DecrStmt;
  body: Stmt[];
}
/** `name();` (user function without parameters). */
export interface CallStmt extends StmtBase { kind: 'call'; name: string }
/** `INTCON.INTF = 0;`: acknowledge an interrupt inside the interrupt routine. */
export interface ClearFlagStmt extends StmtBase { kind: 'clearFlag'; flag: 'INTF' | 'RBIF' | 'T0IF' }
/** A comment line on its own (e.g. the only content of an otherwise empty loop). */
export interface CommentStmt extends StmtBase { kind: 'comment'; text: string }
/** Escape hatch: C statement(s) kept verbatim (constructs the model does not know). */
export interface RawStmt extends StmtBase { kind: 'raw'; code: string }

export type Stmt =
  | SetStmt | SetAllStmt | ToggleStmt | DisplayStmt | AssignStmt | IncrStmt | DecrStmt | DelayStmt | WaitStmt
  | IfStmt | WhileStmt | RepeatStmt | ForStmt | CallStmt | ClearFlagStmt | CommentStmt | RawStmt;

export type StmtKind = Stmt['kind'];

/** Assignable expressions. */
export type LValue = Extract<Expr, { kind: 'var' | 'signal' | 'bus' | 'reg' }>;

// ---------------------------------------------------------------------------------------------------------------
// Functions and interrupts (Ch5–Ch6)

export interface FunctionDef {
  id: string;
  /** 'interrupt' for the interrupt routine (MikroC `void interrupt()`). */
  name: string;
  kind: 'interrupt' | 'function';
  body: Stmt[];
  /** Comment line(s) above the function. */
  lead?: string;
}

export type Prescaler = 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256;

/** INTCON / OPTION_REG set-up written in the configuration section. */
export interface InterruptConfig {
  /** RB0/INT external interrupt (INTE) and its edge (OPTION_REG.INTEDG). */
  int?: { edge: 'rising' | 'falling' };
  /** RB4–RB7 change interrupt (RBIE). */
  rbChange?: boolean;
  /** TMR0 on the internal clock, overflow interrupt (T0IE), prescaler 1 = PSA to the watchdog. */
  tmr0?: { prescaler: Prescaler };
  /** Global enable (GIE). */
  gie: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Code style

export type TrisMode = 'auto' | 'bits' | 'port';

/** How the C is written. Every option reproduces one of the prof's own habits (research §3). */
export interface CodeStyle {
  /** `PORTA.RA0` (demux.c) or `PORTB.F0` (status.c). */
  bitNotation: 'pin' | 'index';
  /**
   * Per port: 'bits' = one `TRISA.RA0 = 1;` per used pin (demux.c), 'port' = `TRISB = 0x00;` (status.c),
   * 'auto' = whole port when a bus lives on it and every used pin of the port has the bus's direction.
   */
  tris: Record<Port, TrisMode>;
  /** `#define LED_ON(pin)  (pin = 1)` / `LED_OFF` and their use on LEDs and lamps (status.c). */
  macros: boolean;
  /**
   * Section comments: 'demux' = `// Configuration des entrées` / `… des sorties` / `// Initialisation…` /
   * `// Boucle principale`; 'status' = `// Configuration  i/o` / `// Initialisation` / `// Traitement`.
   */
  sections: 'demux' | 'status';
  /** `D0=1;` (demux.c) instead of `D0 = 1;` for signal writes. */
  compactAssign: boolean;
  /** Echo the register after initialisation writes: `D0=0; //PORTB.RB0=0;` (demux.c). */
  echoRegister: boolean;
  /** `if (STATUS.F2 == 1) { LED_ON(LED_EGAL); }` on one line when every branch is a single statement (status.c). */
  oneLineBranches: boolean;
  /**
   * Runs of similar simple statements on one line (status.c): `x = 6; y = 6;`,
   * `LED_OFF(LED_SUP); LED_OFF(LED_EGAL); LED_OFF(LED_INF);`.
   */
  packLines: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Program

export interface Program {
  version: typeof PROGRAM_VERSION;
  /** French title shown to the student ('TP — Manipulation du registre STATUS'). */
  title: string;
  description?: string;
  /** Oscillator (Hz). Shared by Delay_ms code generation and the simulation. */
  clockHz: number;
  style: CodeStyle;
  signals: Signal[];
  buses: Bus[];
  constants: Constant[];
  variables: Variable[];
  /** Interrupt set-up, or absent when the program uses none. */
  interrupts?: InterruptConfig;
  /** Statements between the configuration and the main loop (« INITIALISATION »). */
  init: Stmt[];
  /** Body of `while(1)`, or null when main() simply ends (EXEMPLE1). */
  loop: Stmt[] | null;
  /** User functions and the interrupt routine (written before main()). */
  functions: FunctionDef[];
  /** `#define` lines the model does not interpret (kept verbatim in the macros section). */
  rawDefines?: string[];
  /** Global declarations the model does not interpret (kept verbatim before the functions). */
  rawGlobals?: string[];
}

/** A problem found by validate(): French message ready for the UI. */
export interface Issue {
  severity: 'error' | 'warning' | 'info';
  /** Stable machine code ('E_INPUT_WRITTEN', 'W_PIN_UNCONNECTED'…). */
  code: string;
  message: string;
  /** Statement, branch or function concerned. */
  stmtId?: string;
  signalId?: string;
}
