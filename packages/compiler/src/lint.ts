import type { Expression, Span, Statement, TranslationUnit } from './ast';
import { findSfr } from './device';
import { Codes, type DiagnosticBag } from './diagnostics';
import type { Semantics } from './sema/checker';

export interface LintOptions {
  clockHz: number;
  xtalFreq?: number;
}

type BitRef = { reg: string; bit: number };

/** Teaching warnings for the classic mistakes of the course (they never stop compilation). */
export function lint(unit: TranslationUnit, sem: Semantics, opts: LintOptions, diags: DiagnosticBag): void {
  new Linter(unit, sem, opts, diags).run();
}

class Linter {
  /** Port bits written one at a time somewhere in the program (e.g. RB5 for the vote LED). */
  private readonly bitWrites = new Map<string, Set<number>>();
  private readonly portWrites: { reg: string; value: number | undefined; span: Span; text: string }[] = [];

  constructor(
    private readonly unit: TranslationUnit,
    private readonly sem: Semantics,
    private readonly opts: LintOptions,
    private readonly diags: DiagnosticBag,
  ) {}

  run(): void {
    for (const item of this.unit.body) {
      if (item.kind === 'FunctionDeclaration' && item.body) this.statements(item.body.body);
      else if (item.kind === 'SbitDeclaration') this.statement(item);
    }
    this.checkPortOverwrites();
    if (this.opts.xtalFreq !== undefined && this.opts.xtalFreq !== this.opts.clockHz) {
      const m = this.unit.macros.find((x) => x.name === '_XTAL_FREQ');
      this.diags.warning(
        Codes.CLOCK_MISMATCH,
        `_XTAL_FREQ = ${this.opts.xtalFreq} Hz mais l'horloge du projet est ${this.opts.clockHz} Hz : les temporisations seront fausses en simulation`,
        m?.span,
      );
    }
  }

  // ---------------------------------------------------------------------------------------------------------

  private statements(list: Statement[]): void {
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const next = list[i + 1];
      if (s.kind === 'IfStatement' && next?.kind === 'IfStatement' && this.testsStatusFlag(s.test) && this.testsStatusFlag(next.test)) {
        this.diags.warning(
          Codes.SEPARATE_IF_AFTER_FLAG,
          "Test de drapeau STATUS indépendant du précédent : utilisez 'else if'. Après une soustraction, x = y donne Z = 1 et C = 1, donc les deux branches s'exécutent (deux LEDs allumées)",
          next.test.span,
        );
      }
      this.statement(s);
    }
  }

  private statement(s: Statement): void {
    switch (s.kind) {
      case 'Block':
        this.statements(s.body);
        break;
      case 'ExpressionStatement':
        this.expression(s.expression);
        break;
      case 'DeclarationStatement':
        s.declarations.forEach((d) => d.init && d.init.kind !== 'InitializerList' && this.expression(d.init));
        break;
      case 'IfStatement':
        this.expression(s.test);
        this.statements([s.consequent]);
        if (s.alternate) this.statements([s.alternate]);
        break;
      case 'WhileStatement':
      case 'DoWhileStatement':
        this.expression(s.test);
        this.statements([s.body]);
        break;
      case 'ForStatement':
        if (s.init && s.init.kind !== 'DeclarationStatement') this.expression(s.init);
        if (s.test) this.expression(s.test);
        if (s.update) this.expression(s.update);
        this.statements([s.body]);
        break;
      case 'SwitchStatement':
        this.expression(s.discriminant);
        s.cases.forEach((c) => this.statements(c.consequent));
        break;
      case 'ReturnStatement':
        if (s.argument) this.expression(s.argument);
        break;
      case 'SbitDeclaration':
        // `sbit LED at PORTA.B6;` names a pin that does not exist, like `PORTA.F6 = 1;`.
        if (s.target) this.expression(s.target);
        break;
      default:
        break;
    }
  }

  private expression(e: Expression): void {
    switch (e.kind) {
      case 'AssignmentExpression':
        this.assignment(e);
        this.expression(e.left);
        this.expression(e.right);
        break;
      case 'BitAccess':
        this.bitAccess(e);
        break;
      case 'BinaryExpression':
      case 'LogicalExpression':
        this.expression(e.left);
        this.expression(e.right);
        break;
      case 'UnaryExpression':
      case 'UpdateExpression':
      case 'CastExpression':
        this.expression(e.argument);
        break;
      case 'ConditionalExpression':
        this.expression(e.test);
        this.expression(e.consequent);
        this.expression(e.alternate);
        break;
      case 'SequenceExpression':
        e.expressions.forEach((x) => this.expression(x));
        break;
      case 'CallExpression':
        e.args.forEach((x) => this.expression(x));
        break;
      case 'IndexExpression':
        this.expression(e.index);
        break;
      default:
        break;
    }
  }

  private bitAccess(e: Expression & { kind: 'BitAccess' }): void {
    const reg = this.registerOf(e.object);
    const bit = this.sem.bits.get(e);
    if (bit === undefined || !reg) return;
    const def = findSfr(reg);
    if (def && def.width < 8 && bit >= def.width) {
      this.diags.warning(
        Codes.PORTA_BIT_UNIMPLEMENTED,
        `${def.name}.${e.bit} n'existe pas sur le PIC16F84A (${def.name} n'a que les bits 0 à ${def.width - 1})`,
        e.span,
      );
    }
  }

  /** Register name an expression designates (SFR identifier), if any. */
  private registerOf(e: Expression): string | undefined {
    if (e.kind !== 'Identifier') return undefined;
    const sym = this.sem.symbols.get(e);
    return sym?.kind === 'sfr' ? sym.def.name : undefined;
  }

  /** The register bit an assignment target designates (`PORTA.F4`, an sbit, `RA4_bit`…). */
  private bitTarget(e: Expression): BitRef | undefined {
    if (e.kind === 'BitAccess') {
      const reg = this.registerOf(e.object);
      const bit = this.sem.bits.get(e);
      return reg && bit !== undefined ? { reg, bit } : undefined;
    }
    if (e.kind === 'Identifier') {
      const sym = this.sem.symbols.get(e);
      if (sym?.kind === 'sbit' && sym.target.kind === 'sfr') return { reg: sym.target.def.name, bit: sym.target.bit };
    }
    return undefined;
  }

  private assignment(e: Expression & { kind: 'AssignmentExpression' }): void {
    const rhs = this.sem.exprs.get(e.right)?.value;
    const bt = this.bitTarget(e.left);
    if (bt) {
      if (bt.reg === 'PORTA' || bt.reg === 'PORTB') {
        const set = this.bitWrites.get(bt.reg) ?? new Set<number>();
        set.add(bt.bit);
        this.bitWrites.set(bt.reg, set);
      }
      if (bt.reg === 'PORTA' && bt.bit === 4 && e.operator === '=' && rhs !== undefined && (rhs & 1) === 1) this.warnRa4(e.span);
      if (bt.reg === 'STATUS' && e.operator === '=') return;
      return;
    }
    const reg = this.registerOf(e.left);
    if (!reg) return;
    if (reg === 'PORTA' && rhs !== undefined && (e.operator === '=' || e.operator === '|=') && (rhs & 0x10) !== 0) this.warnRa4(e.span);
    if (reg === 'STATUS' && e.operator === '=' && rhs === 0) {
      this.diags.info(
        Codes.STATUS_CLEAR_SETS_Z,
        'STATUS=0 est compilé en CLRF STATUS, qui met Z à 1 (STATUS = 000u u1uu d\'après la fiche technique)',
        e.span,
      );
    }
    if ((reg === 'PORTA' || reg === 'PORTB') && e.operator === '=') {
      this.portWrites.push({ reg, value: rhs, span: e.span, text: e.right.text });
    }
  }

  private warnRa4(span: Span): void {
    this.diags.warning(
      Codes.RA4_OPEN_DRAIN,
      "RA4 est une sortie à drain ouvert : écrire 1 libère la broche, une LED sur RA4 ne s'allume pas sans résistance de tirage (pull-up)",
      span,
    );
  }

  /**
   * `PORTB = 0x0E` also clears RB5 when RB5 is driven bit by bit elsewhere (vote TP). Reported once per port, on the
   * first such write, with the number of similar writes.
   */
  private checkPortOverwrites(): void {
    for (const reg of ['PORTA', 'PORTB']) {
      const bits = this.bitWrites.get(reg);
      if (!bits || bits.size === 0) continue;
      const pin = reg === 'PORTA' ? 'RA' : 'RB';
      const hits = this.portWrites
        .filter((w) => w.reg === reg && w.value !== 0) // initialising every output to 0 is intended
        .map((w) => ({ w, clobbered: [...bits].filter((b) => w.value === undefined || ((w.value >> b) & 1) === 0).sort() }))
        .filter((h) => h.clobbered.length > 0);
      if (hits.length === 0) continue;
      const { w, clobbered } = hits[0];
      const names = clobbered.map((b) => `${pin}${b}`).join(', ');
      const more = hits.length > 1 ? ` (et ${hits.length - 1} autre(s) écriture(s) de ${reg})` : '';
      this.diags.warning(
        Codes.PORT_WRITE_CLEARS_BITS,
        `${reg} = ${w.text} réécrit tout le port et met aussi ${names} à 0, alors que ${clobbered.length > 1 ? 'ces broches sont commandées' : 'cette broche est commandée'} bit par bit ailleurs${more}`,
        w.span,
      );
    }
  }

  private testsStatusFlag(e: Expression): boolean {
    let found = false;
    const visit = (x: Expression) => {
      if (found) return;
      if (x.kind === 'BitAccess') {
        const reg = this.registerOf(x.object);
        const bit = this.sem.bits.get(x);
        if (reg === 'STATUS' && bit !== undefined && bit <= 2) found = true;
        return;
      }
      if (x.kind === 'Identifier') {
        const sym = this.sem.symbols.get(x);
        if (sym?.kind === 'sbit' && sym.target.kind === 'sfr' && sym.target.def.name === 'STATUS' && sym.target.bit <= 2) found = true;
        return;
      }
      if (x.kind === 'BinaryExpression' || x.kind === 'LogicalExpression') {
        visit(x.left);
        visit(x.right);
      } else if (x.kind === 'UnaryExpression' || x.kind === 'CastExpression') {
        visit(x.argument);
      }
    };
    visit(e);
    return found;
  }
}
