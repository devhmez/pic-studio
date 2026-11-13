import type { DeclarationStatement, IntType, Statement, SwitchStatement } from '../ast';
import { caseValue } from '../sema/info';
import type { FuncSymbol } from '../sema/symbols';
import type { Emitter } from './emitter';
import type { ExprGen } from './expr';
import { at, R, sfr, Z } from './ir';
import { byteSrc, type Val } from './values';

interface Jumps {
  brk: string;
  /** Undefined for switch (continue goes to the enclosing loop). */
  cont?: string;
}

/** Statement code generation for one function body. */
export class StmtGen {
  private readonly jumps: Jumps[] = [];

  constructor(
    readonly ex: ExprGen,
    readonly fn: FuncSymbol | null,
    /** Label jumped to by `return`. */
    readonly exitLabel: string,
  ) {}

  private get em(): Emitter {
    return this.ex.em;
  }

  statement(s: Statement): void {
    const em = this.em;
    const mark = this.ex.temps.mark();
    em.line = s.span.line;
    switch (s.kind) {
      case 'Block':
        s.body.forEach((x) => this.statement(x));
        break;
      case 'ExpressionStatement':
        this.ex.discard(s.expression);
        break;
      case 'DeclarationStatement':
        this.declarations(s);
        break;
      case 'IfStatement': {
        const jump = s.alternate ? undefined : this.jumpTarget(s.consequent);
        if (jump) {
          // `if (c) break;` / `if (c) continue;` → one conditional jump.
          em.line = s.test.span.line;
          this.ex.branch(s.test, true, jump);
          break;
        }
        const lEnd = em.newLabel();
        const lElse = s.alternate ? em.newLabel() : lEnd;
        em.line = s.test.span.line;
        this.ex.branch(s.test, false, lElse);
        this.statement(s.consequent);
        if (s.alternate) {
          em.line = s.consequent.span.endLine;
          em.goto(lEnd);
          em.label(lElse);
          this.statement(s.alternate);
        }
        em.label(lEnd);
        break;
      }
      case 'WhileStatement': {
        const lTop = em.newLabel();
        const lEnd = em.newLabel();
        em.label(lTop);
        em.line = s.test.span.line;
        this.ex.branch(s.test, false, lEnd);
        this.loop({ brk: lEnd, cont: lTop }, s.body);
        em.line = s.span.line;
        em.goto(lTop);
        em.label(lEnd);
        break;
      }
      case 'DoWhileStatement': {
        const lTop = em.newLabel();
        const lCont = em.newLabel();
        const lEnd = em.newLabel();
        em.label(lTop);
        this.loop({ brk: lEnd, cont: lCont }, s.body);
        em.label(lCont);
        em.line = s.test.span.line;
        this.ex.branch(s.test, true, lTop);
        em.label(lEnd);
        break;
      }
      case 'ForStatement': {
        if (s.init) {
          if (s.init.kind === 'DeclarationStatement') this.declarations(s.init);
          else this.ex.discard(s.init);
        }
        const lTop = em.newLabel();
        const lCont = em.newLabel();
        const lEnd = em.newLabel();
        em.label(lTop);
        if (s.test) {
          em.line = s.test.span.line;
          this.ex.branch(s.test, false, lEnd);
        }
        this.loop({ brk: lEnd, cont: lCont }, s.body);
        em.label(lCont);
        em.line = s.span.line;
        if (s.update) this.ex.discard(s.update);
        em.goto(lTop);
        em.label(lEnd);
        break;
      }
      case 'SwitchStatement':
        this.switchStatement(s);
        break;
      case 'BreakStatement': {
        const j = this.jumps[this.jumps.length - 1];
        if (j) em.goto(j.brk);
        break;
      }
      case 'ContinueStatement': {
        const j = [...this.jumps].reverse().find((x) => x.cont);
        if (j?.cont) em.goto(j.cont);
        break;
      }
      case 'ReturnStatement':
        if (s.argument && this.fn && this.fn.returnType.kind === 'int') {
          const rt = this.fn.returnType;
          if (rt.size === 1 || this.isMain()) this.ex.toW(s.argument, rt);
          else this.ex.ops.storeMem(this.ex.svc.returnRef(this.fn), this.ex.valueAs(s.argument, rt), rt);
        } else if (s.argument) {
          this.ex.discard(s.argument);
        }
        em.goto(this.exitLabel);
        break;
      case 'SbitDeclaration':
      case 'TypedefDeclaration':
      case 'EmptyStatement':
        break;
    }
    this.ex.temps.release(mark);
  }

  /** Label reached by a statement that is only `break;` or `continue;` (possibly in braces). */
  private jumpTarget(s: Statement): string | undefined {
    if (s.kind === 'Block' && s.body.length === 1) return this.jumpTarget(s.body[0]);
    if (s.kind === 'BreakStatement') return this.jumps[this.jumps.length - 1]?.brk;
    if (s.kind === 'ContinueStatement') return [...this.jumps].reverse().find((x) => x.cont)?.cont;
    return undefined;
  }

  private isMain(): boolean {
    return this.fn !== null && this.fn === this.ex.svc.sem.main;
  }

  private loop(j: Jumps, body: Statement): void {
    this.jumps.push(j);
    this.statement(body);
    this.jumps.pop();
  }

  /** Local initialisers run each time the declaration is reached; statics and constants are set up elsewhere. */
  private declarations(s: DeclarationStatement): void {
    for (const d of s.declarations) {
      const sym = this.ex.svc.sem.decls.get(d);
      if (!sym || !d.init || sym.storage === 'static' || sym.constValue !== undefined || sym.romData) continue;
      this.em.line = d.span.line;
      if (sym.type.kind === 'int' && d.init.kind !== 'InitializerList') {
        this.ex.ops.storeMem(this.ex.svc.varRef(sym), this.ex.valueAs(d.init, sym.type), sym.type);
      } else if (sym.type.kind === 'array' && d.init.kind === 'InitializerList') {
        const elem = sym.type.elem;
        const base = this.ex.svc.varRef(sym);
        d.init.elements.forEach((el, i) => this.ex.ops.storeMem(at(base, i * elem.size), this.ex.valueAs(el, elem), elem));
        for (let i = d.init.elements.length; i < sym.type.length; i++) {
          for (let b = 0; b < elem.size; b++) this.em.clrf(at(base, i * elem.size + b));
        }
      }
    }
  }

  private switchStatement(s: SwitchStatement): void {
    const em = this.em;
    const ex = this.ex;
    const t: IntType = ex.intType(s.discriminant);
    em.line = s.discriminant.span.line;
    const d = ex.ops.stable(ex.valueAs(s.discriminant, t));
    const lEnd = em.newLabel();
    const labels = s.cases.map(() => em.newLabel());
    let defaultLabel = lEnd;
    s.cases.forEach((c, i) => {
      if (!c.test) {
        defaultLabel = labels[i];
        return;
      }
      const k = caseValue(ex.info(c.test).value ?? 0, t);
      if (k === undefined) return; // never equal to the switch value (reported by the checker)
      em.line = c.test.span.line;
      this.caseTest(d, k, t, labels[i]);
    });
    em.goto(defaultLabel);
    this.jumps.push({ brk: lEnd });
    s.cases.forEach((c, i) => {
      em.label(labels[i]);
      c.consequent.forEach((x) => this.statement(x));
    });
    this.jumps.pop();
    em.label(lEnd);
  }

  /** Jump to `label` when the (stable) discriminant equals k. */
  private caseTest(d: Val, k: number, t: IntType, label: string): void {
    const em = this.em;
    const ex = this.ex;
    const kVal = { k: 'imm' as const, v: k, t };
    const next = t.size > 1 ? em.newLabel() : label;
    for (let i = 0; i < t.size; i++) {
      const a = byteSrc(d, i);
      const b = byteSrc(kVal, i);
      if ('imm' in a) {
        em.movlw(a.imm);
        em.lit('XORLW', (b as { imm: number }).imm);
      } else {
        em.movf(a.f, 0);
        em.lit('XORLW', (b as { imm: number }).imm);
      }
      if (t.size === 1) em.testBitGoto('BTFSC', sfr(R.STATUS), Z, label, ex.scratch);
      else em.testBitGoto('BTFSS', sfr(R.STATUS), Z, next, ex.scratch);
    }
    if (t.size > 1) {
      em.goto(label);
      em.label(next);
    }
  }

  /** Statements of a function body. */
  body(stmts: Statement[]): void {
    stmts.forEach((s) => this.statement(s));
  }
}

