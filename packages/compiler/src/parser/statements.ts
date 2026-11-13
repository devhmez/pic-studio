import type {
  Block, CType, DeclarationStatement, Expression, FunctionDeclaration, Parameter, SbitDeclaration, Statement,
  SwitchCase, TopLevel, TypeSpec, TypedefDeclaration, VariableDeclaration,
} from '../ast';
import { Codes } from '../diagnostics';
import { ExpressionParser } from './expressions';
import { ParseError, type TokenStream } from './stream';
import { isTypeStart, parseTypeSpec } from './types';

const noComments = () => ({ leadingComments: [] });

export class StatementParser {
  readonly typedefTypes = new Map<string, CType>();
  readonly expr: ExpressionParser;

  constructor(private readonly p: TokenStream) {
    this.expr = new ExpressionParser(p, this.typedefTypes);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Top level

  parseTopLevel(): TopLevel[] {
    const items: TopLevel[] = [];
    while (!this.p.atEnd()) {
      const before = this.p.pos;
      try {
        items.push(...this.parseExternalDeclaration());
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.synchronize(true);
      }
      if (this.p.pos === before) this.p.next();
    }
    return items;
  }

  private parseExternalDeclaration(): TopLevel[] {
    const p = this.p;
    if (p.accept(';')) return [];
    if (p.isKeyword('typedef')) return [this.parseTypedef()];
    if (p.peek().kind === 'ident' && /^__config$/i.test(p.peek().value) && p.is('(', 1)) {
      // HI-TECH `__CONFIG(FOSC_XT & WDTE_OFF);`: the configuration word comes from the project settings.
      const start = p.pos;
      p.next();
      let depth = 0;
      do {
        if (p.is('(')) depth++;
        if (p.is(')')) depth--;
        p.next();
      } while (depth > 0 && !p.atEnd());
      p.accept(';');
      p.diags.info(Codes.CONFIG_IGNORED, '__CONFIG ignoré : le mot de configuration vient des réglages du projet', p.spanFrom(start));
      return [];
    }
    if (!isTypeStart(p)) {
      const t = p.peek();
      // `main() { }` without a return type is accepted as int main().
      if (t.kind === 'ident' && p.is('(', 1)) {
        const start = p.pos;
        const spec = this.implicitIntSpec(start);
        return [this.parseFunctionRest(start, spec)];
      }
      p.error(Codes.SYNTAX, `Déclaration attendue, '${t.value}' trouvé`, t.span);
    }
    const start = p.pos;
    const spec = parseTypeSpec(p, this.typedefTypes);
    if (spec.base === 'sbit') return [this.parseSbitRest(start, spec)];
    // Function definition or prototype: type [interrupt] name '('
    if (this.looksLikeFunction()) return [this.parseFunctionRest(start, spec)];
    return [this.parseDeclarationRest(start, spec)];
  }

  private implicitIntSpec(start: number): TypeSpec {
    const b = this.p.base(start);
    return {
      kind: 'TypeSpec', ...b, base: 'int', signedness: 'default', isConst: false, isVolatile: false, storage: 'none',
      isSfr: false, type: { kind: 'int', size: 2, signed: true },
    };
  }

  private looksLikeFunction(): boolean {
    const p = this.p;
    if (p.peek().kind === 'ident' && p.is('(', 1)) return true;
    // HI-TECH `void interrupt isr(void)` and XC8 `void __interrupt() isr(void)`
    if (p.isKeyword('interrupt') && p.peek(1).kind === 'ident' && p.is('(', 2)) return true;
    if (p.isKeyword('__interrupt')) return true;
    return false;
  }

  private parseFunctionRest(start: number, returnType: TypeSpec): FunctionDeclaration {
    const p = this.p;
    let isInterrupt = false;
    if (p.isKeyword('interrupt') && p.peek(1).kind === 'ident' && p.is('(', 2)) {
      p.next();
      isInterrupt = true;
    } else if (p.acceptKeyword('__interrupt')) {
      if (p.accept('(')) {
        while (!p.is(')') && !p.atEnd()) p.next();
        p.expect(')');
      }
      isInterrupt = true;
    }
    const nameTok = p.expectIdent('Nom de fonction');
    if (nameTok.value.toLowerCase() === 'interrupt') isInterrupt = true;
    p.expect('(');
    const params = this.parseParameters();
    p.expect(')');
    let body: Block | null = null;
    if (!p.accept(';')) {
      if (!p.is('{')) p.errorExpected("'{'");
      body = this.parseBlock();
    }
    return {
      kind: 'FunctionDeclaration',
      ...p.base(start),
      ...noComments(),
      name: nameTok.value,
      nameSpan: nameTok.span,
      returnType,
      params,
      body,
      isInterrupt,
    };
  }

  private parseParameters(): Parameter[] {
    const p = this.p;
    const params: Parameter[] = [];
    if (p.is(')')) return params;
    if (p.isKeyword('void') && p.is(')', 1)) {
      p.next();
      return params;
    }
    do {
      const start = p.pos;
      if (p.is('...')) p.error(Codes.UNSUPPORTED, 'Fonctions à nombre variable d\'arguments non supportées', p.peek().span);
      const typeSpec = parseTypeSpec(p, this.typedefTypes);
      let type: CType = typeSpec.type;
      if (p.accept('*')) type = { kind: 'pointer', to: type };
      let name: string | null = null;
      if (p.peek().kind === 'ident') name = p.next().value;
      if (p.accept('[')) {
        if (!p.is(']')) this.expr.parseExpression();
        p.expect(']');
        type = { kind: 'pointer', to: type };
      }
      params.push({ kind: 'Parameter', ...p.base(start), name, typeSpec, type });
    } while (p.accept(','));
    return params;
  }

  private parseTypedef(): TypedefDeclaration {
    const p = this.p;
    const start = p.pos;
    p.next();
    const typeSpec = parseTypeSpec(p, this.typedefTypes);
    const nameTok = p.expectIdent('Nom de type');
    p.expect(';');
    p.typedefs.add(nameTok.value.toLowerCase());
    this.typedefTypes.set(nameTok.value.toLowerCase(), typeSpec.type);
    return { kind: 'TypedefDeclaration', ...p.base(start), ...noComments(), name: nameTok.value, typeSpec, type: typeSpec.type };
  }

  /** `sbit NAME at REG.Bn;` — the `sbit` specifier is already consumed. */
  private parseSbitRest(start: number, spec: TypeSpec): SbitDeclaration {
    const p = this.p;
    const nameTok = p.expectIdent("Nom de l'sbit");
    let target: Expression | null = null;
    if (p.acceptKeyword('at')) target = this.expr.parseAssignment();
    else if (!(spec.storage === 'extern')) p.errorExpected("'at'");
    p.expect(';');
    return {
      kind: 'SbitDeclaration', ...p.base(start), ...noComments(), name: nameTok.value, nameSpan: nameTok.span, target, isSfr: spec.isSfr,
    };
  }

  /** Variable declarators after the type: `x, y = 3, t[4] = {1,2,3,4}, v absolute 0x20;` */
  private parseDeclarationRest(start: number, typeSpec: TypeSpec): DeclarationStatement {
    const p = this.p;
    const declarations: VariableDeclaration[] = [];
    do {
      const dStart = p.pos;
      let type: CType = typeSpec.type;
      if (p.accept('*')) type = { kind: 'pointer', to: type };
      const nameTok = p.expectIdent();
      let arraySize: Expression | null = null;
      let isArray = false;
      if (p.accept('[')) {
        isArray = true;
        if (!p.is(']')) arraySize = this.expr.parseExpression();
        p.expect(']');
        if (p.is('[')) p.error(Codes.UNSUPPORTED, 'Tableaux à plusieurs dimensions non supportés', p.peek().span);
      }
      let absolute: Expression | null = null;
      if (p.acceptKeyword('absolute')) absolute = this.expr.parseAssignment();
      if (p.isKeyword('at')) p.error(Codes.UNSUPPORTED, "'at' n'est supporté que pour les déclarations sbit", p.peek().span);
      const init = p.accept('=') ? this.expr.parseInitializer() : null;
      if (isArray && type.kind === 'int') {
        // Length is filled in by the checker once the size expression / initializer is evaluated.
        type = { kind: 'array', elem: type, length: 0 };
      }
      declarations.push({
        kind: 'VariableDeclaration',
        ...p.base(dStart),
        name: nameTok.value,
        nameSpan: nameTok.span,
        typeSpec,
        type,
        arraySize,
        isArray,
        init,
        absolute,
      });
    } while (p.accept(','));
    p.expect(';');
    return { kind: 'DeclarationStatement', ...p.base(start), ...noComments(), declarations };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Statements

  parseBlock(): Block {
    const p = this.p;
    const start = p.pos;
    p.expect('{');
    const body: Statement[] = [];
    while (!p.is('}') && !p.atEnd()) {
      const before = p.pos;
      try {
        body.push(this.parseStatement());
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.synchronize(false);
      }
      if (p.pos === before) p.next();
    }
    p.expect('}');
    return { kind: 'Block', ...p.base(start), ...noComments(), body, danglingComments: [] };
  }

  parseStatement(): Statement {
    const p = this.p;
    const start = p.pos;
    const t = p.peek();
    if (t.kind === 'punct') {
      if (t.value === '{') return this.parseBlock();
      if (t.value === ';') {
        p.next();
        return { kind: 'EmptyStatement', ...p.base(start), ...noComments() };
      }
    }
    if (t.kind === 'ident') {
      switch (t.value) {
        case 'if': return this.parseIf();
        case 'while': return this.parseWhile();
        case 'do': return this.parseDoWhile();
        case 'for': return this.parseFor();
        case 'switch': return this.parseSwitch();
        case 'break':
          p.next();
          p.expect(';');
          return { kind: 'BreakStatement', ...p.base(start), ...noComments() };
        case 'continue':
          p.next();
          p.expect(';');
          return { kind: 'ContinueStatement', ...p.base(start), ...noComments() };
        case 'return': {
          p.next();
          const argument = p.is(';') ? null : this.expr.parseExpression();
          p.expect(';');
          return { kind: 'ReturnStatement', ...p.base(start), ...noComments(), argument };
        }
        case 'typedef':
          return this.parseTypedef();
        case 'goto':
          p.error(Codes.UNSUPPORTED, "'goto' n'est pas supporté", t.span);
          break;
        case 'asm':
          p.error(Codes.UNSUPPORTED, "Les blocs 'asm' ne sont pas supportés", t.span);
          break;
        case 'case':
        case 'default':
          p.error(Codes.SYNTAX, `'${t.value}' en dehors d'un switch`, t.span);
          break;
        case 'else':
          p.error(Codes.SYNTAX, "'else' sans 'if' correspondant", t.span);
          break;
      }
      if (isTypeStart(p)) {
        const spec = parseTypeSpec(p, this.typedefTypes);
        if (spec.base === 'sbit') return this.parseSbitRest(start, spec);
        if (p.peek().kind === 'ident' && p.is('(', 1)) {
          p.error(Codes.UNSUPPORTED, 'Définition de fonction imbriquée non supportée', p.peek().span);
        }
        return this.parseDeclarationRest(start, spec);
      }
      if (p.is(':', 1) && !p.is('::', 1)) {
        p.error(Codes.UNSUPPORTED, "Les étiquettes (goto) ne sont pas supportées", t.span);
      }
    }
    const expression = this.expr.parseExpression();
    p.expect(';');
    return { kind: 'ExpressionStatement', ...p.base(start), ...noComments(), expression };
  }

  private parseCondition(): Expression {
    this.p.expect('(');
    const e = this.expr.parseExpression();
    this.p.expect(')');
    return e;
  }

  private parseIf(): Statement {
    const p = this.p;
    const start = p.pos;
    p.next();
    const test = this.parseCondition();
    const consequent = this.parseStatement();
    let alternate: Statement | null = null;
    if (p.acceptKeyword('else')) alternate = this.parseStatement();
    return { kind: 'IfStatement', ...p.base(start), ...noComments(), test, consequent, alternate };
  }

  private parseWhile(): Statement {
    const p = this.p;
    const start = p.pos;
    p.next();
    const test = this.parseCondition();
    const body = this.parseStatement();
    return { kind: 'WhileStatement', ...p.base(start), ...noComments(), test, body };
  }

  private parseDoWhile(): Statement {
    const p = this.p;
    const start = p.pos;
    p.next();
    const body = this.parseStatement();
    if (!p.acceptKeyword('while')) p.errorExpected("'while'");
    const test = this.parseCondition();
    p.expect(';');
    return { kind: 'DoWhileStatement', ...p.base(start), ...noComments(), body, test };
  }

  private parseFor(): Statement {
    const p = this.p;
    const start = p.pos;
    p.next();
    p.expect('(');
    let init: Expression | DeclarationStatement | null = null;
    if (!p.accept(';')) {
      if (isTypeStart(p)) {
        const dStart = p.pos;
        init = this.parseDeclarationRest(dStart, parseTypeSpec(p, this.typedefTypes));
      } else {
        init = this.expr.parseExpression();
        p.expect(';');
      }
    }
    const test = p.is(';') ? null : this.expr.parseExpression();
    p.expect(';');
    const update = p.is(')') ? null : this.expr.parseExpression();
    p.expect(')');
    const body = this.parseStatement();
    return { kind: 'ForStatement', ...p.base(start), ...noComments(), init, test, update, body };
  }

  private parseSwitch(): Statement {
    const p = this.p;
    const start = p.pos;
    p.next();
    const discriminant = this.parseCondition();
    p.expect('{');
    const cases: SwitchCase[] = [];
    while (!p.is('}') && !p.atEnd()) {
      const cStart = p.pos;
      let test: Expression | null = null;
      if (p.acceptKeyword('case')) {
        test = this.expr.parseExpression();
      } else if (!p.acceptKeyword('default')) {
        p.errorExpected("'case' ou 'default'");
      }
      p.expect(':');
      const consequent: Statement[] = [];
      while (!p.is('}') && !p.isKeyword('case') && !p.isKeyword('default') && !p.atEnd()) {
        const before = p.pos;
        try {
          consequent.push(this.parseStatement());
        } catch (e) {
          if (!(e instanceof ParseError)) throw e;
          this.synchronize(false);
        }
        if (p.pos === before) p.next();
      }
      cases.push({ kind: 'SwitchCase', ...p.base(cStart), ...noComments(), test, consequent });
    }
    p.expect('}');
    return { kind: 'SwitchStatement', ...p.base(start), ...noComments(), discriminant, cases };
  }

  /** Skip to a likely statement boundary after a syntax error. */
  private synchronize(topLevel: boolean): void {
    const p = this.p;
    let depth = 0;
    while (!p.atEnd()) {
      const t = p.peek();
      if (t.kind === 'punct') {
        if (t.value === ';' && depth === 0) {
          p.next();
          return;
        }
        if (t.value === '{') depth++;
        if (t.value === '}') {
          if (depth === 0) {
            if (topLevel) p.next();
            return;
          }
          depth--;
          if (depth === 0 && topLevel) {
            p.next();
            return;
          }
        }
      }
      p.next();
    }
  }
}
