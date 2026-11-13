import type {
  BinaryOperator, BitAccess, CallExpression, CType, Expression, Identifier, IntType, Span,
} from '../ast';
import { findSfr, resolveBitSelector } from '../device';
import { Codes, type DiagnosticBag } from '../diagnostics';
import { foldBinary } from './fold';
import { ARITH_PATTERN_OPS, type ExprInfo, operandType, type Semantics } from './info';
import {
  BUILTINS, BYTE_SELECTORS, type BitTarget, type FuncSymbol, Scope, type SfrSymbol, type Symbol,
} from './symbols';
import { fitsPattern, sizeOf, typeOfConstant, typeToString, U8, wrap } from './types';

export interface CheckOptions {
  clockHz: number;
}

export interface FnContext {
  fn: FuncSymbol;
  loops: number;
  switches: number;
}

const COMPARE_OPS = new Set<BinaryOperator>(['==', '!=', '<', '>', '<=', '>=']);

/**
 * Expression typing and constant folding (MikroC rules: case-insensitive names, bit selectors, no int promotion).
 * Declarations and statements are checked by the Checker subclass.
 */
export abstract class ExpressionChecker {
  protected readonly predefined = new Scope(null);
  protected readonly globalScope = new Scope(this.predefined);
  protected scope: Scope = this.globalScope;
  protected ctx: FnContext | null = null;
  protected readonly sem: Semantics = {
    exprs: new Map(),
    symbols: new Map(),
    bits: new Map(),
    calls: new Map(),
    decls: new Map(),
    sbits: new Map(),
    fnOf: new Map(),
    functions: [],
    globals: [],
    main: null,
    isr: null,
  };
  protected readonly calledUndefined = new Map<FuncSymbol, Span>();

  constructor(
    protected readonly opts: CheckOptions,
    protected readonly diags: DiagnosticBag,
  ) {}

  // ---------------------------------------------------------------------------------------------------------
  // Expressions

  protected set(e: Expression, info: ExprInfo): ExprInfo {
    this.sem.exprs.set(e, info);
    return info;
  }

  protected resolve(id: Identifier): Symbol | undefined {
    let sym = this.scope.lookup(id.name);
    if (!sym) {
      const def = findSfr(id.name); // PORTBbits, TRISAbits… (XC8 style)
      if (def) sym = { kind: 'sfr', name: def.name, def } satisfies SfrSymbol;
    }
    if (sym) this.sem.symbols.set(id, sym);
    return sym;
  }

  /** Evaluate a required compile-time constant. */
  protected constValue(e: Expression, what: string): number | undefined {
    const info = this.expr(e);
    if (info.value === undefined) {
      this.diags.error(Codes.CONST_EXPECTED, `${what} : expression constante attendue`, e.span);
      return undefined;
    }
    return info.value;
  }

  expr(e: Expression): ExprInfo {
    switch (e.kind) {
      case 'NumberLiteral':
      case 'CharLiteral':
        return this.set(e, { type: typeOfConstant(e.value), value: e.value });
      case 'StringLiteral':
        this.diags.error(Codes.UNSUPPORTED, 'Les chaînes de caractères ne sont pas supportées', e.span);
        return this.set(e, { type: U8 });
      case 'Identifier':
        return this.identifier(e);
      case 'BitAccess':
        return this.bitAccess(e, 'read');
      case 'IndexExpression':
        return this.index(e, 'read');
      case 'CallExpression':
        return this.call(e);
      case 'UnaryExpression':
        return this.unary(e);
      case 'UpdateExpression': {
        const t = this.lvalue(e.argument, true);
        if (t && t.kind !== 'int') this.diags.error(Codes.TYPE, `'${e.operator}' attend une variable entière`, e.span);
        return this.set(e, { type: t?.kind === 'int' ? t : U8 });
      }
      case 'BinaryExpression':
        return this.binary(e.operator, e.left, e.right, e);
      case 'LogicalExpression': {
        const a = this.expr(e.left);
        const b = this.expr(e.right);
        let value: number | undefined;
        if (a.value !== undefined && b.value !== undefined) {
          value = e.operator === '&&' ? (a.value && b.value ? 1 : 0) : (a.value || b.value ? 1 : 0);
        }
        return this.set(e, { type: U8, value, isBool: true });
      }
      case 'AssignmentExpression':
        return this.assignment(e);
      case 'ConditionalExpression': {
        const c = this.expr(e.test);
        const a = this.expr(e.consequent);
        const b = this.expr(e.alternate);
        const type = this.arithType(a, b, true);
        let value: number | undefined;
        if (c.value !== undefined) {
          const chosen = c.value ? a : b;
          if (chosen.value !== undefined) value = wrap(chosen.value, type);
        }
        return this.set(e, { type, value });
      }
      case 'CastExpression': {
        const a = this.expr(e.argument);
        const type = e.typeSpec.type;
        if (type.kind === 'bit') {
          return this.set(e, { type: U8, value: a.value === undefined ? undefined : a.value & 1, isBool: true });
        }
        if (type.kind !== 'int' && type.kind !== 'void') {
          this.diags.error(Codes.TYPE, 'Conversion de type invalide', e.span);
          return this.set(e, { type: U8 });
        }
        return this.set(e, { type, value: a.value !== undefined && type.kind === 'int' ? wrap(a.value, type) : undefined });
      }
      case 'SequenceExpression': {
        let last: ExprInfo = { type: U8 };
        for (const x of e.expressions) last = this.expr(x);
        return this.set(e, { ...last, value: undefined });
      }
      case 'SizeofExpression': {
        // The operand is only typed: the code generator never evaluates it, since the value is constant.
        const t = e.typeSpec ? e.typeSpec.type : this.expr(e.argument!).type;
        if (t.kind === 'void') {
          this.diags.error(Codes.TYPE, "'sizeof' ne s'applique pas à 'void'", e.span);
          return this.set(e, { type: U8 });
        }
        const size = sizeOf(t);
        return this.set(e, { type: typeOfConstant(size), value: size });
      }
    }
  }

  protected identifier(e: Identifier): ExprInfo {
    const sym = this.resolve(e);
    if (!sym) {
      this.diags.error(Codes.UNDECLARED, `Identificateur non déclaré '${e.name}'`, e.span);
      return this.set(e, { type: U8 });
    }
    switch (sym.kind) {
      case 'var':
        sym.reads++;
        if (sym.type.kind === 'bit') return this.set(e, { type: sym.type, isBool: true });
        return this.set(e, { type: sym.type, value: sym.constValue });
      case 'sfr':
        return this.set(e, { type: U8 });
      case 'sbit':
        if (sym.target.kind === 'var') sym.target.sym.reads++;
        return this.set(e, { type: { kind: 'bit' }, isBool: true });
      case 'bitname':
        return this.set(e, { type: U8, value: sym.bit });
      case 'func':
        this.diags.error(Codes.TYPE, `La fonction '${sym.name}' doit être appelée avec ( )`, e.span);
        return this.set(e, { type: U8 });
    }
  }

  protected bitAccess(e: BitAccess, mode: 'read' | 'write' | 'readwrite'): ExprInfo {
    const bit = resolveBitSelector(e.bit);
    const obj = e.object;
    let size = 1;
    if (obj.kind === 'Identifier') {
      const sym = this.resolve(obj);
      if (!sym) {
        this.diags.error(Codes.UNDECLARED, `Identificateur non déclaré '${obj.name}'`, obj.span);
      } else if (sym.kind === 'var') {
        if (sym.type.kind !== 'int') this.diags.error(Codes.TYPE, `Accès bit impossible sur '${obj.name}'`, e.span);
        else size = sym.type.size;
        if (mode !== 'write') sym.reads++;
        if (mode !== 'read') sym.writes++;
        if (mode !== 'read' && sym.isConst) this.diags.error(Codes.CONST_ASSIGN, `Impossible de modifier la constante '${sym.name}'`, e.span);
        this.set(obj, { type: sym.type });
      } else if (sym.kind === 'sfr') {
        this.set(obj, { type: U8 });
      } else {
        this.diags.error(Codes.TYPE, `Accès bit impossible sur '${obj.name}'`, e.span);
      }
    } else {
      this.diags.error(Codes.UNSUPPORTED, 'Accès bit supporté uniquement sur un registre ou une variable', e.span);
    }
    if (bit === undefined) {
      this.diags.error(Codes.BIT_SELECTOR, `Sélecteur de bit inconnu '${e.bit}'`, e.bitSpan);
    } else if (bit >= size * 8) {
      this.diags.error(Codes.BIT_SELECTOR, `Bit ${e.bit} hors limites (${size * 8} bits)`, e.bitSpan);
    } else {
      this.sem.bits.set(e, bit);
    }
    return this.set(e, { type: { kind: 'bit' }, isBool: true });
  }

  protected bitTargetOf(e: BitAccess): BitTarget | null {
    const bit = this.sem.bits.get(e);
    if (bit === undefined || e.object.kind !== 'Identifier') return null;
    const sym = this.sem.symbols.get(e.object);
    if (sym?.kind === 'sfr') return { kind: 'sfr', def: sym.def, bit };
    if (sym?.kind === 'var' && sym.type.kind === 'int') return { kind: 'var', sym, bit };
    return null;
  }

  protected index(e: Expression & { kind: 'IndexExpression' }, mode: 'read' | 'write' | 'readwrite'): ExprInfo {
    const idx = this.expr(e.index);
    if (idx.type.kind !== 'int' && idx.type.kind !== 'bit') this.diags.error(Codes.TYPE, 'Indice entier attendu', e.index.span);
    if (e.object.kind !== 'Identifier') {
      this.diags.error(Codes.UNSUPPORTED, 'Indexation supportée uniquement sur un tableau nommé', e.span);
      return this.set(e, { type: U8 });
    }
    const sym = this.resolve(e.object);
    if (!sym || sym.kind !== 'var' || sym.type.kind !== 'array') {
      if (!sym) this.diags.error(Codes.UNDECLARED, `Identificateur non déclaré '${e.object.name}'`, e.object.span);
      else this.diags.error(Codes.TYPE, `'${e.object.name}' n'est pas un tableau`, e.object.span);
      return this.set(e, { type: U8 });
    }
    this.set(e.object, { type: sym.type });
    if (mode !== 'write') sym.reads++;
    if (mode !== 'read') sym.writes++;
    const arr = sym.type;
    let value: number | undefined;
    if (idx.value !== undefined) {
      if (idx.value < 0 || idx.value >= arr.length) {
        this.diags.error(Codes.TYPE, `Indice ${idx.value} hors du tableau '${sym.name}' (taille ${arr.length})`, e.index.span);
      } else if (sym.romData) {
        value = sym.romData[idx.value];
      }
    }
    return this.set(e, { type: arr.elem, value });
  }

  protected call(e: CallExpression): ExprInfo {
    const sym = this.resolve(e.callee);
    if (!sym) {
      this.diags.error(Codes.UNDECLARED, `Fonction non déclarée '${e.callee.name}'`, e.callee.span);
      e.args.forEach((a) => this.expr(a));
      return this.set(e, { type: U8 });
    }
    if (sym.kind !== 'func') {
      this.diags.error(Codes.TYPE, `'${e.callee.name}' n'est pas une fonction`, e.callee.span);
      e.args.forEach((a) => this.expr(a));
      return this.set(e, { type: U8 });
    }
    this.sem.calls.set(e, sym);
    const args = e.args.map((a) => this.expr(a));
    if (sym.builtin) return this.set(e, this.builtinCall(e, sym, args));
    if (sym.isInterrupt) this.diags.error(Codes.TYPE, "La fonction d'interruption ne peut pas être appelée", e.span);
    if (args.length !== sym.params.length) {
      this.diags.error(Codes.ARG_COUNT, `La fonction '${sym.name}' attend ${sym.params.length} argument(s), ${args.length} fourni(s)`, e.span);
    } else {
      args.forEach((a, i) => this.checkConvertible(a, sym.params[i].type, e.args[i].span));
    }
    if (!sym.defined) this.calledUndefined.set(sym, e.callee.span);
    this.ctx?.fn.callees.add(sym);
    return this.set(e, { type: sym.returnType });
  }

  protected builtinCall(e: CallExpression, fn: FuncSymbol, args: ExprInfo[]): ExprInfo {
    const sig = BUILTINS.get(e.callee.name.toLowerCase()) ?? [...BUILTINS.values()].find((b) => b.id === fn.builtin)!;
    if (args.length !== sig.params.length) {
      this.diags.error(Codes.ARG_COUNT, `${sig.name} attend ${sig.params.length} argument(s), ${args.length} fourni(s)`, e.span);
      return { type: sig.returnType };
    }
    for (const i of sig.constArgs) {
      if (args[i].value === undefined) {
        this.diags.error(Codes.DELAY_NOT_CONST, `${sig.name} : l'argument doit être une constante (utilisez Vdelay_ms pour une variable)`, e.args[i].span);
      } else if (args[i].value! < 0) {
        this.diags.error(Codes.TYPE, `${sig.name} : l'argument doit être positif`, e.args[i].span);
      }
    }
    const a0 = args[0]?.value;
    switch (fn.builtin) {
      case 'clock_khz':
        return { type: sig.returnType, value: Math.round(this.opts.clockHz / 1000) };
      case 'clock_mhz':
        return { type: sig.returnType, value: Math.round(this.opts.clockHz / 1e6) };
      case 'swap':
        return { type: U8, value: a0 === undefined ? undefined : ((a0 & 0x0f) << 4) | ((a0 >> 4) & 0x0f) };
      case 'lo':
      case 'hi':
      case 'higher':
      case 'highest': {
        const shift = 8 * BYTE_SELECTORS[fn.builtin]!;
        return { type: U8, value: a0 === undefined ? undefined : Number((BigInt.asUintN(32, BigInt(a0)) >> BigInt(shift)) & 0xffn) };
      }
      case 'button':
        if (args[0].address === undefined && args[0].value === undefined) {
          this.diags.error(Codes.CONST_EXPECTED, 'Button : le premier argument doit être l\'adresse d\'un port (ex. &PORTB)', e.args[0].span);
        }
        return { type: U8 };
      default:
        return { type: sig.returnType };
    }
  }

  protected unary(e: Expression & { kind: 'UnaryExpression' }): ExprInfo {
    if (e.operator === '&') {
      const arg = e.argument;
      if (arg.kind === 'Identifier') {
        const sym = this.resolve(arg);
        if (sym?.kind === 'sfr') {
          this.set(arg, { type: U8 });
          return this.set(e, { type: U8, address: sym.def.addr & 0xff });
        }
        if (sym?.kind === 'var' && sym.type.kind !== 'bit') {
          sym.reads++;
          sym.writes++;
          this.set(arg, { type: sym.type });
          return this.set(e, { type: U8, address: -1 });
        }
      }
      this.diags.error(Codes.UNSUPPORTED, "L'opérateur '&' n'est supporté que sur un registre ou une variable (ex. &PORTB)", e.span);
      return this.set(e, { type: U8 });
    }
    if (e.operator === '*') {
      this.diags.error(Codes.UNSUPPORTED, 'Les pointeurs ne sont pas supportés', e.span);
      this.expr(e.argument);
      return this.set(e, { type: U8 });
    }
    const a = this.expr(e.argument);
    const t = this.asInt(a, e.argument.span);
    if (e.operator === '!') return this.set(e, { type: U8, isBool: true, value: a.value === undefined ? undefined : a.value ? 0 : 1 });
    if (a.value !== undefined) {
      const v = e.operator === '-' ? -a.value : e.operator === '~' ? ~a.value : a.value;
      // Constants keep exact values (C semantics) so that `-1` or `~0x01` adapt to their use.
      return this.set(e, { type: typeOfConstant(v), value: v });
    }
    return this.set(e, { type: t });
  }

  protected binary(op: BinaryOperator, left: Expression, right: Expression, node: Expression): ExprInfo {
    const a = this.expr(left);
    const b = this.expr(right);
    this.asInt(a, left.span);
    this.asInt(b, right.span);
    if (a.value !== undefined && b.value !== undefined) {
      const r = foldBinary(op, a.value, b.value);
      if (r === 'divzero') {
        this.diags.error(Codes.DIV_BY_ZERO, 'Division par zéro', right.span);
        return this.set(node, { type: U8 });
      }
      if (COMPARE_OPS.has(op)) return this.set(node, { type: U8, value: r, isBool: true });
      return this.set(node, { type: typeOfConstant(r), value: r });
    }
    if ((op === '/' || op === '%') && b.value === 0) this.diags.error(Codes.DIV_BY_ZERO, 'Division par zéro', right.span);
    if (COMPARE_OPS.has(op)) {
      this.arithType(a, b, false);
      return this.set(node, { type: U8, isBool: true });
    }
    if (op === '<<' || op === '>>') {
      const lt = a.value !== undefined ? typeOfConstant(a.value) : this.asInt(a, left.span);
      return this.set(node, { type: lt });
    }
    return this.set(node, { type: this.arithType(a, b, ARITH_PATTERN_OPS.has(op)) });
  }

  arithType(a: ExprInfo, b: ExprInfo, patternFit: boolean): IntType {
    return operandType(a, b, patternFit);
  }

  protected asInt(i: ExprInfo, span: Span): IntType {
    if (i.type.kind === 'int') return i.type;
    if (i.type.kind === 'bit') return U8;
    this.diags.error(Codes.TYPE, `Valeur entière attendue (${typeToString(i.type)})`, span);
    return U8;
  }

  protected assignment(e: Expression & { kind: 'AssignmentExpression' }): ExprInfo {
    const compound = e.operator !== '=';
    const target = this.lvalue(e.left, compound);
    const r = this.expr(e.right);
    if (!target) return this.set(e, { type: U8 });
    this.checkConvertible(r, target, e.right.span);
    if (r.value !== undefined && e.operator === '=') {
      if (target.kind === 'int') this.warnTruncation(r.value, target, e.right.span);
      if (target.kind === 'bit' && r.value !== 0 && r.value !== 1) {
        this.diags.warning(Codes.TRUNCATED_CONSTANT, `Un bit ne vaut que 0 ou 1 : ${r.value} tronqué à ${r.value & 1}`, e.right.span);
      }
    }
    if (compound && target.kind === 'bit') this.diags.error(Codes.TYPE, `'${e.operator}' impossible sur un bit`, e.span);
    if ((e.operator === '/=' || e.operator === '%=') && r.value === 0) this.diags.error(Codes.DIV_BY_ZERO, 'Division par zéro', e.right.span);
    return this.set(e, { type: target.kind === 'bit' ? U8 : target, isBool: target.kind === 'bit' });
  }

  /** Check an assignable expression and return its type (null on error). */
  protected lvalue(e: Expression, alsoRead: boolean): CType | null {
    const mode = alsoRead ? 'readwrite' : 'write';
    switch (e.kind) {
      case 'Identifier': {
        const sym = this.resolve(e);
        if (!sym) {
          this.diags.error(Codes.UNDECLARED, `Identificateur non déclaré '${e.name}'`, e.span);
          return null;
        }
        if (sym.kind === 'var') {
          if (alsoRead) sym.reads++;
          sym.writes++;
          this.set(e, { type: sym.type });
          if (sym.isConst) {
            this.diags.error(Codes.CONST_ASSIGN, `Impossible de modifier la constante '${sym.name}'`, e.span);
            return null;
          }
          if (sym.type.kind === 'array') {
            this.diags.error(Codes.NOT_LVALUE, `Impossible d'affecter le tableau '${sym.name}' en entier`, e.span);
            return null;
          }
          return sym.type;
        }
        if (sym.kind === 'sfr') {
          this.set(e, { type: U8 });
          return U8;
        }
        if (sym.kind === 'sbit') {
          if (sym.target.kind === 'var') sym.target.sym.writes++;
          this.set(e, { type: { kind: 'bit' } });
          return { kind: 'bit' };
        }
        this.diags.error(Codes.NOT_LVALUE, `'${e.name}' n'est pas modifiable`, e.span);
        return null;
      }
      case 'BitAccess':
        this.bitAccess(e, mode);
        return { kind: 'bit' };
      case 'IndexExpression': {
        const info = this.index(e, mode);
        if (e.object.kind === 'Identifier') {
          const sym = this.sem.symbols.get(e.object);
          if (sym?.kind === 'var' && sym.isConst) {
            this.diags.error(Codes.CONST_ASSIGN, `Impossible de modifier le tableau constant '${sym.name}'`, e.span);
            return null;
          }
        }
        return info.type;
      }
      case 'CallExpression': {
        const fn = this.resolve(e.callee);
        const k = fn?.kind === 'func' && fn.builtin ? BYTE_SELECTORS[fn.builtin] : undefined;
        if (fn?.kind === 'func' && k !== undefined) return this.byteLvalue(e, fn, k, alsoRead);
        break;
      }
      default:
        break;
    }
    this.expr(e);
    this.diags.error(Codes.NOT_LVALUE, "L'opérande gauche de l'affectation n'est pas modifiable", e.span);
    return null;
  }

  /** `Hi(x) = v`: byte k of an integer variable, register or array element. */
  private byteLvalue(e: CallExpression, fn: FuncSymbol, k: number, alsoRead: boolean): CType | null {
    this.sem.calls.set(e, fn);
    this.set(e, { type: U8 });
    if (e.args.length !== 1) {
      e.args.forEach((a) => this.expr(a));
      this.diags.error(Codes.ARG_COUNT, `${fn.name} attend 1 argument(s), ${e.args.length} fourni(s)`, e.span);
      return null;
    }
    const arg = e.args[0];
    const t = this.lvalue(arg, alsoRead);
    if (!t) return null;
    if (t.kind !== 'int') {
      this.diags.error(Codes.TYPE, `${fn.name} : variable entière attendue`, arg.span);
      return null;
    }
    if (k >= t.size) {
      this.diags.error(Codes.TYPE, `${fn.name}(${arg.text}) : '${arg.text}' n'a que ${t.size} octet(s)`, e.span);
      return null;
    }
    return U8;
  }

  protected checkConvertible(from: ExprInfo, to: CType, span: Span): void {
    const ok = (t: CType) => t.kind === 'int' || t.kind === 'bit';
    if (to.kind === 'void') return;
    if (!ok(from.type) || !ok(to)) {
      this.diags.error(Codes.TYPE, `Conversion impossible de '${typeToString(from.type)}' vers '${typeToString(to)}'`, span);
    }
  }

  protected warnTruncation(value: number, t: IntType, span: Span): void {
    if (!fitsPattern(value, t)) {
      this.diags.warning(Codes.TRUNCATED_CONSTANT, `Constante ${value} tronquée en ${typeToString(t)} (${wrap(value, t)})`, span);
    }
  }

  protected isVolatileRead(e: Expression): boolean {
    if (e.kind === 'Identifier') {
      const s = this.sem.symbols.get(e);
      return s?.kind === 'sfr' || (s?.kind === 'var' && s.isVolatile);
    }
    return false;
  }
}
