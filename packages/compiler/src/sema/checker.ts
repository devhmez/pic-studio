import type {
  Block, DeclarationStatement, Expression, FunctionDeclaration, SbitDeclaration, Span, Statement, TranslationUnit,
  VariableDeclaration,
} from '../ast';
import { BIT_NAMES, findSfr, GPR_END, GPR_START, HITECH_BIT_VARS, isUnimplemented, SFRS } from '../device';
import { Codes, type DiagnosticBag } from '../diagnostics';
import { type CheckOptions, ExpressionChecker } from './expressions';
import { caseValue, intOfInfo, type Semantics } from './info';
import {
  BUILTINS, type BitTarget, type FuncSymbol, Scope, type SbitSymbol, type Symbol, type VarSymbol,
} from './symbols';
import { typeToString, wrap } from './types';

export type { CheckOptions } from './expressions';
export { caseValue, type ExprInfo, intOfInfo, isPatternOp, operandType, type Semantics } from './info';

export function check(unit: TranslationUnit, opts: CheckOptions, diags: DiagnosticBag): Semantics {
  return new Checker(unit, opts, diags).run();
}

/** Declarations, functions and statements; reports unused variables at the end. */
class Checker extends ExpressionChecker {
  private readonly allVars: VarSymbol[] = [];

  constructor(
    private readonly unit: TranslationUnit,
    opts: CheckOptions,
    diags: DiagnosticBag,
  ) {
    super(opts, diags);
    this.definePredefined();
  }

  run(): Semantics {
    // Pass 1: function signatures, so functions may be called before their definition.
    for (const item of this.unit.body) if (item.kind === 'FunctionDeclaration') this.declareFunction(item);
    // Pass 2: declarations and bodies in source order.
    for (const item of this.unit.body) {
      switch (item.kind) {
        case 'FunctionDeclaration':
          if (item.body) this.checkFunction(item);
          break;
        case 'DeclarationStatement':
          this.checkDeclarations(item, true);
          break;
        case 'SbitDeclaration':
          this.checkSbit(item);
          break;
        case 'TypedefDeclaration':
          break;
      }
    }
    if (!this.sem.main) this.diags.error(Codes.NO_MAIN, "Fonction 'main' introuvable", this.unit.span);
    for (const [fn, span] of this.calledUndefined) {
      if (!fn.defined) this.diags.error(Codes.UNDEFINED_FUNCTION, `Fonction '${fn.name}' déclarée mais jamais définie`, span);
    }
    this.reportUnused();
    return this.sem;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Predefined symbols

  private definePredefined(): void {
    const hitech = this.unit.dialect === 'hitech';
    for (const def of SFRS) this.predefined.define(def.name, { kind: 'sfr', name: def.name, def });
    this.predefined.define('OPTION', { kind: 'sfr', name: 'OPTION', def: findSfr('OPTION_REG')! });
    for (const [name, b] of BIT_NAMES) {
      const def = findSfr(b.reg)!;
      this.predefined.define(`${name}_bit`, { kind: 'sbit', name: `${name}_bit`, target: { kind: 'sfr', def, bit: b.bit }, decl: null });
      if (!hitech) this.predefined.define(name, { kind: 'bitname', name, bit: b.bit });
    }
    if (hitech) {
      for (const [name, b] of HITECH_BIT_VARS) {
        this.predefined.define(name, { kind: 'sbit', name, target: { kind: 'sfr', def: findSfr(b.reg)!, bit: b.bit }, decl: null });
      }
    }
    for (const [key, sig] of BUILTINS) {
      this.predefined.define(key, {
        kind: 'func', name: sig.name, returnType: sig.returnType, params: [], decl: null, defined: true,
        isInterrupt: false, builtin: sig.id, locals: [], callees: new Set(),
      });
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Functions

  private declareFunction(decl: FunctionDeclaration): void {
    const existing = this.globalScope.lookupLocal(decl.name);
    let fn: FuncSymbol;
    if (existing && existing.kind === 'func') {
      fn = existing;
      if (decl.body && fn.defined) {
        this.diags.error(Codes.REDECLARED, `Fonction '${decl.name}' déjà définie`, decl.nameSpan);
        return;
      }
    } else {
      if (existing) this.diags.error(Codes.REDECLARED, `Identificateur '${decl.name}' redéfini`, decl.nameSpan);
      const pre = this.predefined.lookupLocal(decl.name);
      if (pre?.kind === 'func') {
        this.diags.warning(Codes.BUILTIN_OVERRIDDEN, `La fonction '${decl.name}' remplace la routine intégrée '${pre.name}'`, decl.nameSpan);
      }
      fn = {
        kind: 'func', name: decl.name, returnType: decl.returnType.type, params: [], decl, defined: false,
        isInterrupt: decl.isInterrupt, locals: [], callees: new Set(),
      };
      this.globalScope.define(decl.name, fn);
    }
    if (decl.body) {
      fn.defined = true;
      fn.decl = decl;
      fn.isInterrupt = decl.isInterrupt;
      fn.returnType = decl.returnType.type;
      this.sem.fnOf.set(decl, fn);
      fn.params = decl.params.map((p, i) => {
        const v: VarSymbol = {
          kind: 'var', name: p.name ?? `__arg${i}`, type: p.type, isConst: p.typeSpec.isConst,
          isVolatile: p.typeSpec.isVolatile, storage: 'param', fn, decl: p, reads: 0, writes: 0,
        };
        if (p.type.kind === 'bit') this.diags.error(Codes.TYPE, "Un paramètre ne peut pas être de type 'bit'", p.span);
        if (p.type.kind === 'pointer') this.diags.error(Codes.UNSUPPORTED, 'Les paramètres pointeurs/tableaux ne sont pas supportés', p.span);
        if (p.type.kind === 'void') this.diags.error(Codes.TYPE, "Paramètre de type 'void'", p.span);
        return v;
      });
      if (fn.returnType.kind === 'bit') this.diags.error(Codes.TYPE, "Une fonction ne peut pas retourner un 'bit'", decl.returnType.span);
      const lower = decl.name.toLowerCase();
      if (lower === 'main') this.sem.main = fn;
      if (fn.isInterrupt) {
        if (this.sem.isr) this.diags.error(Codes.REDECLARED, "Une seule fonction d'interruption est permise", decl.nameSpan);
        else this.sem.isr = fn;
        if (decl.params.length > 0 || fn.returnType.kind !== 'void') {
          this.diags.error(Codes.TYPE, "La fonction d'interruption doit être 'void interrupt()'", decl.nameSpan);
        }
      }
      this.sem.functions.push(fn);
    } else if (fn.params.length === 0 && !fn.defined) {
      fn.params = decl.params.map((p, i) => ({
        kind: 'var', name: p.name ?? `__arg${i}`, type: p.type, isConst: false, isVolatile: false, storage: 'param',
        fn, decl: p, reads: 0, writes: 0,
      }));
    }
  }

  private checkFunction(decl: FunctionDeclaration): void {
    const fn = this.sem.fnOf.get(decl);
    if (!fn || !decl.body) return;
    const saved = this.scope;
    this.scope = new Scope(this.globalScope);
    for (const p of fn.params) {
      if (this.scope.lookupLocal(p.name)) this.diags.error(Codes.REDECLARED, `Paramètre '${p.name}' redéfini`, p.decl.span);
      this.scope.define(p.name, p);
      this.allVars.push(p);
    }
    this.ctx = { fn, loops: 0, switches: 0 };
    this.checkBlockBody(decl.body, false);
    const isMain = fn === this.sem.main;
    if (fn.returnType.kind !== 'void' && !isMain && !endsWithReturn(decl.body)) {
      this.diags.warning(Codes.MISSING_RETURN, `La fonction '${fn.name}' doit retourner une valeur`, decl.nameSpan);
    }
    this.ctx = null;
    this.scope = saved;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Declarations

  private checkSbit(decl: SbitDeclaration): void {
    if (!decl.target) return; // extern sfr sbit X; — the definition is elsewhere (not supported across units)
    let target: BitTarget | null = null;
    const t = decl.target;
    if (t.kind === 'BitAccess') {
      this.expr(t);
      target = this.bitTargetOf(t);
    } else if (t.kind === 'Identifier') {
      const sym = this.resolve(t);
      if (sym?.kind === 'sbit') target = sym.target;
    }
    if (!target) {
      this.diags.error(Codes.TYPE, `sbit '${decl.name}' : bit de registre attendu après 'at' (ex. PORTB.B0)`, t.span);
      return;
    }
    const sym: SbitSymbol = { kind: 'sbit', name: decl.name, target, decl };
    if (this.ctx) sym.fn = this.ctx.fn;
    this.defineSymbol(decl.name, sym, decl.nameSpan);
    this.sem.sbits.set(decl, sym);
  }

  private checkDeclarations(stmt: DeclarationStatement, global: boolean): void {
    for (const d of stmt.declarations) this.checkDeclaration(d, global);
  }

  private checkDeclaration(d: VariableDeclaration, global: boolean): void {
    const spec = d.typeSpec;
    const isStatic = !global && spec.storage === 'static';
    const sym: VarSymbol = {
      kind: 'var',
      name: d.name,
      type: d.type,
      isConst: spec.isConst,
      isVolatile: spec.isVolatile,
      storage: global ? 'global' : isStatic ? 'static' : 'local',
      fn: global ? null : (this.ctx?.fn ?? null),
      decl: d,
      reads: 0,
      writes: 0,
    };
    if (d.type.kind === 'void') this.diags.error(Codes.TYPE, `Variable '${d.name}' de type 'void'`, d.nameSpan);
    if (d.type.kind === 'pointer') this.diags.error(Codes.UNSUPPORTED, 'Les pointeurs ne sont pas supportés', d.span);
    if (d.isArray && d.typeSpec.type.kind === 'bit') this.diags.error(Codes.TYPE, "Tableau de 'bit' interdit", d.span);

    // Array length
    if (d.type.kind === 'array') {
      let length = 0;
      if (d.arraySize) {
        const v = this.constValue(d.arraySize, 'Taille de tableau');
        if (v !== undefined) {
          if (v <= 0) this.diags.error(Codes.TYPE, 'La taille du tableau doit être positive', d.arraySize.span);
          length = Math.max(0, v);
        }
      }
      if (d.init?.kind === 'InitializerList') {
        if (!d.arraySize) length = d.init.elements.length;
        else if (d.init.elements.length > length) this.diags.error(Codes.TYPE, `Trop de valeurs d'initialisation pour '${d.name}'`, d.init.span);
      } else if (!d.arraySize) {
        this.diags.error(Codes.TYPE, `Taille du tableau '${d.name}' inconnue`, d.nameSpan);
      }
      d.type.length = length;
      sym.type = d.type;
    }

    if (d.absolute) {
      const addr = this.constValue(d.absolute, 'Adresse absolute');
      if (addr !== undefined) {
        sym.absolute = addr;
        if (addr < 0 || addr > 0xff) this.diags.error(Codes.TYPE, `Adresse absolute 0x${addr.toString(16)} hors de la RAM`, d.absolute.span);
        else if (isUnimplemented(addr)) {
          this.diags.warning(Codes.UNIMPLEMENTED_RAM, `L'adresse 0x${addr.toString(16).toUpperCase()} n'existe pas sur le PIC16F84A (lue comme 0)`, d.absolute.span);
        }
      }
    }

    // Initialiser
    if (d.init) this.checkInitializer(d, sym, global || isStatic);
    else if (sym.isConst && d.type.kind === 'array') this.diags.error(Codes.TYPE, `Le tableau constant '${d.name}' doit être initialisé`, d.nameSpan);

    if (d.type.kind === 'bit' && d.init) this.diags.error(Codes.TYPE, "Une variable 'bit' ne peut pas être initialisée", d.init.span);

    this.defineSymbol(d.name, sym, d.nameSpan);
    this.sem.decls.set(d, sym);
    this.allVars.push(sym);
    if (global || isStatic) this.sem.globals.push(sym);
    else this.ctx?.fn.locals.push(sym);
  }

  private checkInitializer(d: VariableDeclaration, sym: VarSymbol, staticStorage: boolean): void {
    const init = d.init!;
    if (d.type.kind === 'array') {
      if (init.kind !== 'InitializerList') {
        this.diags.error(Codes.TYPE, `Liste d'initialisation { … } attendue pour le tableau '${d.name}'`, init.span);
        return;
      }
      const elem = d.type.elem;
      const values: number[] = [];
      let allConst = true;
      for (const e of init.elements) {
        const info = this.expr(e);
        if (info.value === undefined) allConst = false;
        else values.push(wrap(info.value, elem));
      }
      while (values.length < d.type.length) values.push(0);
      if (sym.isConst || staticStorage) {
        if (!allConst) {
          this.diags.error(Codes.CONST_EXPECTED, `Les valeurs initiales de '${d.name}' doivent être constantes`, init.span);
          return;
        }
        if (sym.isConst) sym.romData = values;
        else sym.initData = values;
      }
      return;
    }
    if (init.kind === 'InitializerList') {
      this.diags.error(Codes.TYPE, `Initialisation { … } invalide pour '${d.name}'`, init.span);
      return;
    }
    const info = this.expr(init);
    this.checkConvertible(info, d.type, init.span);
    if (d.type.kind !== 'int') return;
    if (info.value !== undefined) this.warnTruncation(info.value, d.type, init.span);
    if (sym.isConst && info.value !== undefined) {
      sym.constValue = wrap(info.value, d.type);
    } else if (staticStorage) {
      if (info.value === undefined) {
        this.diags.error(Codes.CONST_EXPECTED, `La valeur initiale de '${d.name}' doit être constante`, init.span);
        return;
      }
      sym.initData = [wrap(info.value, d.type)];
    }
  }

  private defineSymbol(name: string, sym: Symbol, span: Span): void {
    if (this.scope.lookupLocal(name)) {
      this.diags.error(Codes.REDECLARED, `Identificateur '${name}' redéfini`, span);
      return;
    }
    const pre = this.predefined.lookupLocal(name);
    if (pre?.kind === 'sfr') this.diags.warning(Codes.SHADOWS_PREDEFINED, `'${name}' masque le registre ${pre.name}`, span);
    this.scope.define(name, sym);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Statements

  private checkBlockBody(block: Block, newScope = true): void {
    const saved = this.scope;
    if (newScope) this.scope = new Scope(this.scope);
    for (const s of block.body) this.statement(s);
    this.scope = saved;
  }

  private statement(s: Statement): void {
    const ctx = this.ctx!;
    switch (s.kind) {
      case 'Block':
        this.checkBlockBody(s);
        break;
      case 'ExpressionStatement':
        this.expr(s.expression);
        if (!hasSideEffect(s.expression) && !this.isVolatileRead(s.expression)) {
          this.diags.warning(Codes.NO_EFFECT, 'Instruction sans effet', s.span);
        }
        break;
      case 'DeclarationStatement':
        this.checkDeclarations(s, false);
        break;
      case 'SbitDeclaration':
        this.checkSbit(s);
        break;
      case 'TypedefDeclaration':
      case 'EmptyStatement':
        break;
      case 'IfStatement':
        this.condition(s.test);
        this.statement(s.consequent);
        if (s.alternate) this.statement(s.alternate);
        break;
      case 'WhileStatement':
        this.condition(s.test);
        ctx.loops++;
        this.statement(s.body);
        ctx.loops--;
        break;
      case 'DoWhileStatement':
        ctx.loops++;
        this.statement(s.body);
        ctx.loops--;
        this.condition(s.test);
        break;
      case 'ForStatement': {
        const saved = this.scope;
        this.scope = new Scope(this.scope);
        if (s.init) {
          if (s.init.kind === 'DeclarationStatement') this.checkDeclarations(s.init, false);
          else this.expr(s.init);
        }
        if (s.test) this.condition(s.test);
        if (s.update) this.expr(s.update);
        ctx.loops++;
        this.statement(s.body);
        ctx.loops--;
        this.scope = saved;
        break;
      }
      case 'SwitchStatement': {
        const d = this.expr(s.discriminant);
        if (d.type.kind !== 'int' && d.type.kind !== 'bit') this.diags.error(Codes.TYPE, 'Expression entière attendue dans switch', s.discriminant.span);
        const dt = intOfInfo(d);
        const seen = new Set<number>();
        let hasDefault = false;
        ctx.switches++;
        for (const c of s.cases) {
          if (c.test) {
            const v = this.constValue(c.test, 'Valeur de case');
            const cv = v === undefined ? undefined : caseValue(v, dt);
            if (v !== undefined && cv === undefined) {
              this.diags.warning(
                Codes.CASE_OUT_OF_RANGE,
                `Valeur de case ${v} hors de la plage de '${typeToString(dt)}' : ce cas n'est jamais exécuté`,
                c.test.span,
              );
            } else if (cv !== undefined) {
              if (seen.has(cv)) this.diags.error(Codes.REDECLARED, `Valeur de case ${v} en double`, c.test.span);
              seen.add(cv);
            }
          } else {
            if (hasDefault) this.diags.error(Codes.REDECLARED, "'default' en double", c.span);
            hasDefault = true;
          }
          const saved = this.scope;
          this.scope = new Scope(this.scope);
          for (const st of c.consequent) this.statement(st);
          this.scope = saved;
        }
        ctx.switches--;
        break;
      }
      case 'BreakStatement':
        if (ctx.loops === 0 && ctx.switches === 0) this.diags.error(Codes.BREAK_OUTSIDE, "'break' en dehors d'une boucle ou d'un switch", s.span);
        break;
      case 'ContinueStatement':
        if (ctx.loops === 0) this.diags.error(Codes.BREAK_OUTSIDE, "'continue' en dehors d'une boucle", s.span);
        break;
      case 'ReturnStatement': {
        const rt = ctx.fn.returnType;
        if (s.argument) {
          const info = this.expr(s.argument);
          if (rt.kind === 'void') this.diags.error(Codes.RETURN_VALUE, `La fonction '${ctx.fn.name}' ne retourne pas de valeur`, s.argument.span);
          else this.checkConvertible(info, rt, s.argument.span);
        } else if (rt.kind !== 'void' && ctx.fn !== this.sem.main) {
          this.diags.warning(Codes.MISSING_RETURN, `'return' sans valeur dans la fonction '${ctx.fn.name}'`, s.span);
        }
        break;
      }
    }
  }

  private condition(e: Expression): void {
    const info = this.expr(e);
    if (info.type.kind !== 'int' && info.type.kind !== 'bit') this.diags.error(Codes.TYPE, 'Condition entière attendue', e.span);
  }

  private reportUnused(): void {
    for (const v of this.allVars) {
      if (v.storage === 'param') continue;
      if (v.reads === 0 && v.writes === 0) {
        const d = v.decl as VariableDeclaration;
        this.diags.warning(Codes.UNUSED_VARIABLE, `Variable '${v.name}' déclarée mais jamais utilisée`, d.nameSpan ?? d.span);
      }
    }
    // Absolute variables overlapping each other.
    const abs = this.allVars.filter((v) => v.absolute !== undefined && v.absolute >= GPR_START && v.absolute <= GPR_END);
    for (let i = 0; i < abs.length; i++) {
      for (let j = i + 1; j < abs.length; j++) {
        const a = abs[i];
        const b = abs[j];
        const sa = sizeOfVar(a);
        const sb = sizeOfVar(b);
        if (a.absolute! < b.absolute! + sb && b.absolute! < a.absolute! + sa) {
          this.diags.warning(Codes.ABSOLUTE_OVERLAP, `'${b.name}' chevauche '${a.name}' en RAM`, (b.decl as VariableDeclaration).nameSpan);
        }
      }
    }
  }
}

function sizeOfVar(v: VarSymbol): number {
  const t = v.type;
  return t.kind === 'int' ? t.size : t.kind === 'array' ? t.elem.size * t.length : 1;
}

function hasSideEffect(e: Expression): boolean {
  switch (e.kind) {
    case 'AssignmentExpression':
    case 'UpdateExpression':
    case 'CallExpression':
      return true;
    case 'SequenceExpression':
      return e.expressions.some(hasSideEffect);
    case 'ConditionalExpression':
      return hasSideEffect(e.consequent) || hasSideEffect(e.alternate) || hasSideEffect(e.test);
    case 'BinaryExpression':
    case 'LogicalExpression':
      return hasSideEffect(e.left) || hasSideEffect(e.right);
    case 'UnaryExpression':
    case 'CastExpression':
      return hasSideEffect(e.argument);
    default:
      return false;
  }
}

function endsWithReturn(b: Block): boolean {
  const last = b.body[b.body.length - 1];
  if (!last) return false;
  if (last.kind === 'ReturnStatement') return true;
  if (last.kind === 'WhileStatement' && last.test.kind === 'NumberLiteral' && last.test.value !== 0) return true;
  if (last.kind === 'Block') return endsWithReturn(last);
  if (last.kind === 'IfStatement' && last.alternate) {
    const wrapB = (s: Statement): Block => (s.kind === 'Block' ? s : { ...b, body: [s] });
    return endsWithReturn(wrapB(last.consequent)) && endsWithReturn(wrapB(last.alternate));
  }
  return false;
}
