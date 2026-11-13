// Typed AST of a MikroC PRO for PIC translation unit.
//
// Every node carries a `span` in the ORIGINAL source (before macro expansion) and `text`, the original source slice
// covered by that span. A statement written as `LED_ON(LED_EGAL);` therefore has text 'LED_ON(LED_EGAL);' even though
// the parser saw `(PORTB.F1 = 1);`. Nodes produced entirely by one macro expansion carry `macro` (the macro name).

/** Source range. Lines and columns are 1-based; `endCol` is exclusive. `start`/`end` are offsets into the decoded source. */
export interface Span {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  start: number;
  end: number;
}

export interface Comment {
  kind: 'line' | 'block';
  /** Comment content without `//` or `/* *\/`, trimmed. */
  text: string;
  /** Exact source text including the delimiters. */
  raw: string;
  span: Span;
}

// ---------------------------------------------------------------------------------------------------------------
// C types

export interface IntType { kind: 'int'; size: 1 | 2 | 4; signed: boolean }
export interface BitType { kind: 'bit' }
export interface VoidType { kind: 'void' }
export interface ArrayType { kind: 'array'; elem: IntType; length: number }
export interface PointerType { kind: 'pointer'; to: CType }
export type CType = IntType | BitType | VoidType | ArrayType | PointerType;

// ---------------------------------------------------------------------------------------------------------------
// Base

export interface NodeBase {
  span: Span;
  /** Original source text covered by `span` (before macro expansion). */
  text: string;
  /** Name of the macro whose expansion produced this whole node, if any. */
  macro?: string;
}

export interface StatementBase extends NodeBase {
  /** `//` (or block) comment lines directly above the statement, without a blank line in between. */
  leadingComments: Comment[];
  /** Comment at the end of the statement's first line (e.g. `TRISB = 0x00;       // PORTB en sortie`). */
  trailingComment?: Comment;
  /** Comment after the statement's closing line when it spans several lines (e.g. `}  // fin while`). */
  endComment?: Comment;
}

// ---------------------------------------------------------------------------------------------------------------
// Types as written

export type BaseTypeName = 'void' | 'char' | 'short' | 'int' | 'long' | 'bit' | 'sbit' | 'float' | 'double';

export interface TypeSpec extends NodeBase {
  kind: 'TypeSpec';
  base: BaseTypeName;
  signedness: 'signed' | 'unsigned' | 'default';
  isConst: boolean;
  isVolatile: boolean;
  storage: 'none' | 'static' | 'extern' | 'register';
  /** MikroC `sfr` qualifier (only meaningful with `extern sfr sbit`). */
  isSfr: boolean;
  /** Set when the type came from a typedef name. */
  typedefName?: string;
  /** Resolved type (scalar; arrays are added by the declarator). */
  type: CType;
}

// ---------------------------------------------------------------------------------------------------------------
// Expressions

export interface NumberLiteral extends NodeBase { kind: 'NumberLiteral'; value: number; raw: string; radix: 2 | 8 | 10 | 16 }
export interface CharLiteral extends NodeBase { kind: 'CharLiteral'; value: number; raw: string }
export interface StringLiteral extends NodeBase { kind: 'StringLiteral'; value: string; raw: string }
export interface Identifier extends NodeBase { kind: 'Identifier'; /** As written (identifiers are case-insensitive). */ name: string }

/** `REG.F0`, `REG.B3`, `PORTA.RA0`, `STATUS.Z`, `PORTBbits.RB0`, `var.B2`… */
export interface BitAccess extends NodeBase {
  kind: 'BitAccess';
  object: Expression;
  /** Bit selector as written (F0..F31, B0..B31 or a predefined bit name). */
  bit: string;
  bitSpan: Span;
}

export interface IndexExpression extends NodeBase { kind: 'IndexExpression'; object: Expression; index: Expression }
export interface CallExpression extends NodeBase { kind: 'CallExpression'; callee: Identifier; args: Expression[] }

export type UnaryOperator = '-' | '+' | '!' | '~' | '&' | '*';
export interface UnaryExpression extends NodeBase { kind: 'UnaryExpression'; operator: UnaryOperator; argument: Expression }
export interface UpdateExpression extends NodeBase { kind: 'UpdateExpression'; operator: '++' | '--'; prefix: boolean; argument: Expression }

export type BinaryOperator =
  | '+' | '-' | '*' | '/' | '%' | '<<' | '>>' | '&' | '|' | '^'
  | '==' | '!=' | '<' | '>' | '<=' | '>=';
export interface BinaryExpression extends NodeBase { kind: 'BinaryExpression'; operator: BinaryOperator; left: Expression; right: Expression }
export interface LogicalExpression extends NodeBase { kind: 'LogicalExpression'; operator: '&&' | '||'; left: Expression; right: Expression }

export type AssignmentOperator = '=' | '+=' | '-=' | '*=' | '/=' | '%=' | '<<=' | '>>=' | '&=' | '|=' | '^=';
export interface AssignmentExpression extends NodeBase { kind: 'AssignmentExpression'; operator: AssignmentOperator; left: Expression; right: Expression }
export interface ConditionalExpression extends NodeBase { kind: 'ConditionalExpression'; test: Expression; consequent: Expression; alternate: Expression }
export interface CastExpression extends NodeBase { kind: 'CastExpression'; typeSpec: TypeSpec; argument: Expression }
export interface SequenceExpression extends NodeBase { kind: 'SequenceExpression'; expressions: Expression[] }
/** `sizeof(type)` (typeSpec set) or `sizeof expr` / `sizeof(SEG)` (argument set; never evaluated, only typed). */
export interface SizeofExpression extends NodeBase { kind: 'SizeofExpression'; typeSpec: TypeSpec | null; argument: Expression | null }

export type Expression =
  | NumberLiteral | CharLiteral | StringLiteral | Identifier | BitAccess | IndexExpression | CallExpression
  | UnaryExpression | UpdateExpression | BinaryExpression | LogicalExpression | AssignmentExpression
  | ConditionalExpression | CastExpression | SequenceExpression | SizeofExpression;

export interface InitializerList extends NodeBase { kind: 'InitializerList'; elements: Expression[] }

// ---------------------------------------------------------------------------------------------------------------
// Declarations

export interface VariableDeclaration extends NodeBase {
  kind: 'VariableDeclaration';
  name: string;
  nameSpan: Span;
  typeSpec: TypeSpec;
  /** Full declared type (array/pointer applied). Arrays declared `[]` get their length from the initializer. */
  type: CType;
  /** Array size expression as written (`null` for scalars and `[]`). */
  arraySize: Expression | null;
  isArray: boolean;
  init: Expression | InitializerList | null;
  /** `absolute 0x0C` address expression. */
  absolute: Expression | null;
}

export interface DeclarationStatement extends StatementBase { kind: 'DeclarationStatement'; declarations: VariableDeclaration[] }

/** `sbit NAME at REG.Bn;` (or `sbit NAME at RB0_bit;`). `target` is null for `extern sfr sbit NAME;`. */
export interface SbitDeclaration extends StatementBase { kind: 'SbitDeclaration'; name: string; nameSpan: Span; target: Expression | null; isSfr: boolean }

export interface TypedefDeclaration extends StatementBase { kind: 'TypedefDeclaration'; name: string; typeSpec: TypeSpec; type: CType }

export interface Parameter extends NodeBase { kind: 'Parameter'; name: string | null; typeSpec: TypeSpec; type: CType }

export interface FunctionDeclaration extends StatementBase {
  kind: 'FunctionDeclaration';
  name: string;
  nameSpan: Span;
  returnType: TypeSpec;
  params: Parameter[];
  /** null for a prototype. */
  body: Block | null;
  /** `void interrupt()` (MikroC), `void interrupt isr(void)` (HI-TECH) or `void __interrupt() isr(void)` (XC8). */
  isInterrupt: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Statements

export interface Block extends StatementBase { kind: 'Block'; body: Statement[]; /** Comments inside the block not followed by a statement. */ danglingComments: Comment[] }
export interface ExpressionStatement extends StatementBase { kind: 'ExpressionStatement'; expression: Expression }
export interface IfStatement extends StatementBase { kind: 'IfStatement'; test: Expression; consequent: Statement; alternate: Statement | null }
export interface WhileStatement extends StatementBase { kind: 'WhileStatement'; test: Expression; body: Statement }
export interface DoWhileStatement extends StatementBase { kind: 'DoWhileStatement'; body: Statement; test: Expression }
export interface ForStatement extends StatementBase {
  kind: 'ForStatement';
  init: Expression | DeclarationStatement | null;
  test: Expression | null;
  update: Expression | null;
  body: Statement;
}
export interface SwitchCase extends StatementBase { kind: 'SwitchCase'; /** null for `default:` */ test: Expression | null; consequent: Statement[] }
export interface SwitchStatement extends StatementBase { kind: 'SwitchStatement'; discriminant: Expression; cases: SwitchCase[] }
export interface BreakStatement extends StatementBase { kind: 'BreakStatement' }
export interface ContinueStatement extends StatementBase { kind: 'ContinueStatement' }
export interface ReturnStatement extends StatementBase { kind: 'ReturnStatement'; argument: Expression | null }
export interface EmptyStatement extends StatementBase { kind: 'EmptyStatement' }

export type Statement =
  | Block | ExpressionStatement | DeclarationStatement | SbitDeclaration | TypedefDeclaration
  | IfStatement | WhileStatement | DoWhileStatement | ForStatement | SwitchStatement
  | BreakStatement | ContinueStatement | ReturnStatement | EmptyStatement;

export type TopLevel = FunctionDeclaration | DeclarationStatement | SbitDeclaration | TypedefDeclaration;

// ---------------------------------------------------------------------------------------------------------------
// Preprocessor records

export interface MacroDefinition {
  name: string;
  /** null for object-like macros; [] for `NAME()`. */
  params: string[] | null;
  /** Replacement text as written (trimmed, comments removed). */
  body: string;
  line: number;
  span: Span;
  leadingComments: Comment[];
  trailingComment?: Comment;
  /** Line of the `#undef` that removed it, if any. */
  undefinedAtLine?: number;
}

export interface IncludeDirective {
  path: string;
  system: boolean;
  line: number;
  span: Span;
}

export type Dialect = 'mikroc' | 'hitech';

export interface TranslationUnit {
  kind: 'TranslationUnit';
  body: TopLevel[];
  macros: MacroDefinition[];
  includes: IncludeDirective[];
  /** Every comment of the file in source order. */
  comments: Comment[];
  /** 'hitech' once `<htc.h>`, `<xc.h>` or `<pic.h>` is included. */
  dialect: Dialect;
  span: Span;
  /** The decoded source text all spans refer to. */
  source: string;
}

export type Node =
  | Expression | Statement | TopLevel | TypeSpec | Parameter | VariableDeclaration | InitializerList | SwitchCase;
