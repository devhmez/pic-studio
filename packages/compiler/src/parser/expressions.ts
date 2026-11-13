import type {
  AssignmentOperator, BinaryOperator, CType, Expression, Identifier, InitializerList, UnaryOperator,
} from '../ast';
import { Codes } from '../diagnostics';
import { decodeEscapes } from '../lexer';
import type { TokenStream } from './stream';
import { isTypeStart, parseTypeSpec } from './types';

const ASSIGN_OPS = new Set<string>(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '^=']);

/** Binary operators by precedence level (lowest first). */
const BINARY_LEVELS: readonly (readonly string[])[] = [
  ['||'],
  ['&&'],
  ['|'],
  ['^'],
  ['&'],
  ['==', '!='],
  ['<', '>', '<=', '>='],
  ['<<', '>>'],
  ['+', '-'],
  ['*', '/', '%'],
];

export class ExpressionParser {
  constructor(
    private readonly p: TokenStream,
    private readonly typedefTypes: Map<string, CType>,
  ) {}

  /** expression := assignment (',' assignment)* */
  parseExpression(): Expression {
    const start = this.p.pos;
    const first = this.parseAssignment();
    if (!this.p.is(',')) return first;
    const expressions = [first];
    while (this.p.accept(',')) expressions.push(this.parseAssignment());
    return { kind: 'SequenceExpression', ...this.p.base(start), expressions };
  }

  parseAssignment(): Expression {
    const start = this.p.pos;
    const left = this.parseConditional();
    const t = this.p.peek();
    if (t.kind === 'punct' && ASSIGN_OPS.has(t.value)) {
      this.p.next();
      const right = this.parseAssignment();
      return { kind: 'AssignmentExpression', ...this.p.base(start), operator: t.value as AssignmentOperator, left, right };
    }
    return left;
  }

  private parseConditional(): Expression {
    const start = this.p.pos;
    const test = this.parseBinary(0);
    if (!this.p.accept('?')) return test;
    const consequent = this.parseExpression();
    this.p.expect(':');
    const alternate = this.parseConditional();
    return { kind: 'ConditionalExpression', ...this.p.base(start), test, consequent, alternate };
  }

  private parseBinary(level: number): Expression {
    if (level >= BINARY_LEVELS.length) return this.parseUnary();
    const start = this.p.pos;
    let left = this.parseBinary(level + 1);
    for (;;) {
      const t = this.p.peek();
      if (t.kind !== 'punct' || !BINARY_LEVELS[level].includes(t.value)) return left;
      this.p.next();
      const right = this.parseBinary(level + 1);
      if (t.value === '&&' || t.value === '||') {
        left = { kind: 'LogicalExpression', ...this.p.base(start), operator: t.value, left, right };
      } else {
        left = { kind: 'BinaryExpression', ...this.p.base(start), operator: t.value as BinaryOperator, left, right };
      }
    }
  }

  private parseUnary(): Expression {
    const start = this.p.pos;
    const t = this.p.peek();
    if (t.kind === 'punct') {
      if (t.value === '++' || t.value === '--') {
        this.p.next();
        const argument = this.parseUnary();
        return { kind: 'UpdateExpression', ...this.p.base(start), operator: t.value, prefix: true, argument };
      }
      if (['-', '+', '!', '~', '&', '*'].includes(t.value)) {
        this.p.next();
        const argument = this.parseUnary();
        return { kind: 'UnaryExpression', ...this.p.base(start), operator: t.value as UnaryOperator, argument };
      }
      // Cast: '(' type ')' unary
      if (t.value === '(' && isTypeStart(this.p, 1)) {
        this.p.next();
        const typeSpec = parseTypeSpec(this.p, this.typedefTypes);
        if (this.p.accept('*')) {
          this.p.diags.error(Codes.UNSUPPORTED, 'Les conversions de pointeurs ne sont pas supportées', typeSpec.span);
        }
        this.p.expect(')');
        const argument = this.parseUnary();
        return { kind: 'CastExpression', ...this.p.base(start), typeSpec, argument };
      }
    }
    if (t.kind === 'ident' && t.value === 'sizeof') return this.parseSizeof();
    return this.parsePostfix();
  }

  /** `sizeof(type)` or `sizeof unary-expression` (`sizeof(SEG)`, `sizeof(t) / sizeof(t[0])`). */
  private parseSizeof(): Expression {
    const start = this.p.pos;
    this.p.next();
    if (this.p.is('(') && isTypeStart(this.p, 1)) {
      this.p.next();
      const typeSpec = parseTypeSpec(this.p, this.typedefTypes);
      this.p.expect(')');
      return { kind: 'SizeofExpression', ...this.p.base(start), typeSpec, argument: null };
    }
    const argument = this.parseUnary();
    return { kind: 'SizeofExpression', ...this.p.base(start), typeSpec: null, argument };
  }

  private parsePostfix(): Expression {
    const start = this.p.pos;
    let expr = this.parsePrimary();
    for (;;) {
      if (this.p.is('(')) {
        if (expr.kind !== 'Identifier') {
          this.p.error(Codes.UNSUPPORTED, "Appel indirect de fonction non supporté", this.p.peek().span);
        }
        const callee: Identifier = expr;
        this.p.next();
        const args: Expression[] = [];
        if (!this.p.is(')')) {
          do args.push(this.parseAssignment());
          while (this.p.accept(','));
        }
        this.p.expect(')');
        expr = { kind: 'CallExpression', ...this.p.base(start), callee, args };
      } else if (this.p.is('[')) {
        this.p.next();
        const index = this.parseExpression();
        this.p.expect(']');
        expr = { kind: 'IndexExpression', ...this.p.base(start), object: expr, index };
      } else if (this.p.is('.')) {
        this.p.next();
        const sel = this.p.peek();
        if (sel.kind !== 'ident') this.p.errorExpected('Nom de bit (F0..F7, B0..B7, RA0…)');
        this.p.next();
        expr = { kind: 'BitAccess', ...this.p.base(start), object: expr, bit: sel.value, bitSpan: sel.span };
      } else if (this.p.is('->')) {
        this.p.error(Codes.UNSUPPORTED, "L'opérateur '->' n'est pas supporté", this.p.peek().span);
      } else if (this.p.is('++') || this.p.is('--')) {
        const op = this.p.next().value as '++' | '--';
        expr = { kind: 'UpdateExpression', ...this.p.base(start), operator: op, prefix: false, argument: expr };
      } else {
        return expr;
      }
    }
  }

  private parsePrimary(): Expression {
    const start = this.p.pos;
    const t = this.p.peek();
    switch (t.kind) {
      case 'number':
        this.p.next();
        return { kind: 'NumberLiteral', ...this.p.base(start), value: t.num ?? 0, raw: t.value, radix: t.radix ?? 10 };
      case 'char':
        this.p.next();
        return { kind: 'CharLiteral', ...this.p.base(start), value: t.num ?? 0, raw: t.value };
      case 'string': {
        this.p.next();
        const value = String.fromCharCode(...decodeEscapes(t.value.slice(1, -1)));
        return { kind: 'StringLiteral', ...this.p.base(start), value, raw: t.value };
      }
      case 'ident':
        if (isTypeStart(this.p)) this.p.errorExpected('Expression');
        this.p.next();
        return { kind: 'Identifier', ...this.p.base(start), name: t.value };
      case 'punct':
        if (t.value === '(') {
          this.p.next();
          const inner = this.parseExpression();
          this.p.expect(')');
          // Keep the inner node but widen its span to include the parentheses.
          const b = this.p.base(start);
          return { ...inner, span: b.span, text: b.text, macro: b.macro ?? inner.macro };
        }
        break;
      default:
        break;
    }
    this.p.errorExpected('Expression');
  }

  /** `{ a, b, c }` initializer for arrays. */
  parseInitializer(): Expression | InitializerList {
    if (!this.p.is('{')) return this.parseAssignment();
    const start = this.p.pos;
    this.p.next();
    const elements: Expression[] = [];
    while (!this.p.is('}')) {
      if (this.p.is('{')) this.p.error(Codes.UNSUPPORTED, 'Tableaux à plusieurs dimensions non supportés', this.p.peek().span);
      elements.push(this.parseAssignment());
      if (!this.p.accept(',')) break;
    }
    this.p.expect('}');
    return { kind: 'InitializerList', ...this.p.base(start), elements };
  }
}
