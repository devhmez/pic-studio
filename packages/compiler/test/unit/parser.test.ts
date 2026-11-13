import { describe, expect, it } from 'vitest';
import type {
  Block, DeclarationStatement, Expression, ExpressionStatement, FunctionDeclaration, IfStatement, Statement,
  TranslationUnit, WhileStatement,
} from '../../src/ast';
import { compile } from '../../src/compile';
import { fixture } from '../support/harness';

function ast(src: string | Uint8Array): TranslationUnit {
  const r = compile(src);
  if (!r.ast) throw new Error('pas d’AST');
  return r.ast;
}

const fn = (u: TranslationUnit, name = 'main') =>
  u.body.find((x): x is FunctionDeclaration => x.kind === 'FunctionDeclaration' && x.name === name)!;
const body = (u: TranslationUnit, name = 'main') => fn(u, name).body!.body;
const loopBody = (stmts: Statement[]) => ((stmts.find((s) => s.kind === 'WhileStatement') as WhileStatement).body as Block).body;

describe('AST de status.c (le prof)', () => {
  const u = ast(fixture('status.c'));
  const main = body(u);
  const loop = loopBody(main);

  it('enregistre les macros dans l’ordre avec paramètres et corps', () => {
    expect(u.macros.map((m) => [m.name, m.params, m.body, m.line])).toEqual([
      ['LED_SUP', null, 'PORTB.F0', 1],
      ['LED_EGAL', null, 'PORTB.F1', 2],
      ['LED_INF', null, 'PORTB.F2', 3],
      ['LED_ON', ['pin'], '(pin = 1)', 4],
      ['LED_OFF', ['pin'], '(pin = 0)', 5],
    ]);
  });

  it('déclarations sur une ligne et commentaires de section', () => {
    const decls = main.filter((s): s is DeclarationStatement => s.kind === 'DeclarationStatement');
    expect(decls.map((d) => d.declarations[0].name)).toEqual(['x', 'y', 'z']);
    expect(decls[0].declarations[0].type).toEqual({ kind: 'int', size: 1, signed: false });
    const tris = main.find((s) => s.text.startsWith('TRISB'))!;
    expect(tris.leadingComments.map((c) => c.text)).toEqual(['Configuration  i/o']);
    expect(tris.trailingComment?.text).toBe('PORTB en sortie');
    expect(tris.trailingComment?.raw).toBe('// PORTB en sortie');
    const init = main.find((s) => s.text === 'x = 6;')!;
    expect(init.leadingComments.map((c) => c.text)).toEqual(['Initialisation']);
    const w = main.find((s) => s.kind === 'WhileStatement')!;
    expect(w.leadingComments.map((c) => c.text)).toEqual(['Traitement']);
  });

  it('garde le texte source avant expansion : LED_ON(LED_EGAL), LED_OFF(LED_SUP)', () => {
    const off = loop[0] as ExpressionStatement;
    expect(off.text).toBe('LED_OFF(LED_SUP);');
    expect(off.expression.kind).toBe('AssignmentExpression');
    expect(off.expression.text).toBe('LED_OFF(LED_SUP)');
    expect(off.expression.macro).toBe('LED_OFF');
    const assign = off.expression as Extract<typeof off.expression, { kind: 'AssignmentExpression' }>;
    expect(assign.left.kind).toBe('BitAccess');
    expect(assign.left.text).toBe('LED_SUP');
    expect(assign.left.macro).toBe('LED_SUP');
    expect(assign.right).toMatchObject({ kind: 'NumberLiteral', value: 0 });
    expect(off.span).toMatchObject({ line: 16, col: 9, endLine: 16, endCol: 26 });
  });

  it('z = x - y avec son commentaire, puis les deux if indépendants', () => {
    const sub = loop.find((s) => s.text.startsWith('z ='))!;
    expect(sub.text).toBe('z = x - y;');
    expect(sub.trailingComment?.text).toBe('Soustraction');
    const ifs = loop.filter((s): s is IfStatement => s.kind === 'IfStatement');
    expect(ifs).toHaveLength(2);
    expect(ifs[0].test.text).toBe('STATUS.F2 == 1');
    expect(ifs[0].alternate).toBeNull();
    expect(ifs[0].trailingComment?.text).toBe('Test du bit Zero, x = y');
    const then0 = (ifs[0].consequent as Block).body[0];
    expect(then0.text).toBe('LED_ON(LED_EGAL);');
    expect(ifs[1].test.text).toBe('STATUS.F0 == 1');
    expect(ifs[1].trailingComment?.text).toBe('Test du Carry, x > y');
    expect(ifs[1].alternate?.kind).toBe('Block');
    expect(ifs[1].alternate?.trailingComment?.text).toBe('x < y');
    expect(ifs[1].alternate?.text).toBe('{ LED_ON(LED_INF); }');
  });
});

describe('AST de demux.c (le prof)', () => {
  const u = ast(fixture('demux.c'));
  const main = body(u);

  it('macros indentées avec leurs commentaires de section', () => {
    expect(u.macros.map((m) => m.name)).toEqual(['L0', 'L1', 'D0', 'D1', 'D2', 'D3']);
    expect(u.macros[0].leadingComments.map((c) => c.text)).toEqual(['Définition des entrées']);
    expect(u.macros[2].leadingComments.map((c) => c.text)).toEqual(['Définition des sorties']);
    expect(u.macros[1].leadingComments).toEqual([]);
    // « Macros pour commander les sorties » is followed by blank lines: it belongs to no statement.
    expect(fn(u).leadingComments).toEqual([]);
    expect(u.comments.some((c) => c.text === 'Macros pour commander les sorties')).toBe(true);
  });

  it('commentaires de fin de ligne, y compris collés (D1=0;//PORTB.RB1=0;)', () => {
    const trisa = main.find((s) => s.text === 'TRISA.RA0 = 1;')!;
    expect(trisa.leadingComments.map((c) => c.text)).toEqual(['Configuration des entrées']);
    expect(trisa.trailingComment?.text).toBe('RA0 : entrée L0');
    const d1 = main.find((s) => s.text === 'D1=0;')!;
    expect(d1.trailingComment?.text).toBe('PORTB.RB1=0;');
    expect((d1 as ExpressionStatement).expression.text).toBe('D1=0');
  });

  it('chaîne if / else if / else et commentaire dans la boucle', () => {
    const loop = loopBody(main);
    const first = loop[0] as IfStatement;
    expect(first.leadingComments.map((c) => c.text)).toEqual(['Décodage de L1 L0']);
    expect(first.test.text).toBe('L0== 0 &&L1== 0');
    expect(first.test.kind).toBe('LogicalExpression');
    const second = first.alternate as IfStatement;
    expect(second.kind).toBe('IfStatement');
    expect(second.test.text).toBe('L0 == 0 && L1== 1');
    const third = second.alternate as IfStatement;
    expect(third.test.text).toBe('L0== 1 && L1== 0');
    expect(third.alternate?.kind).toBe('Block');
    const left = (second.test as Extract<IfStatement['test'], { kind: 'LogicalExpression' }>).left;
    expect(left.kind).toBe('BinaryExpression');
    const l0 = (left as Extract<typeof left, { kind: 'BinaryExpression' }>).left;
    expect(l0).toMatchObject({ kind: 'BitAccess', text: 'L0', macro: 'L0', bit: 'RA0' });
  });
});

describe('AST d’EXEMPLE2.c et du mode HI-TECH', () => {
  it('if / else sans accolades', () => {
    const u = ast(fixture('EXEMPLE2.c'));
    const loop = loopBody(body(u));
    const s = loop[0] as IfStatement;
    expect(s.test.text).toBe('PORTB.RB0==1');
    expect(s.consequent.kind).toBe('ExpressionStatement');
    expect(s.alternate?.text).toBe('PORTA.RA0=0;');
    expect(s.leadingComments.map((c) => c.text)).toEqual(['commander une  LED par un bouton']);
  });

  it('ZERO==1 et CARRY reconnus avec <htc.h>', () => {
    const src = '#include <htc.h>\nint main() {\n    unsigned char a = 200; // Valeur initiale\n    CARRY = 0;\n    while(1) { if (ZERO==1) RB0 = 1; }\n}';
    const r = compile(src);
    expect(r.ok).toBe(true);
    expect(r.ast!.dialect).toBe('hitech');
    const main = body(r.ast!);
    expect(main[0].trailingComment?.text).toBe('Valeur initiale');
    const w = loopBody(main)[0] as IfStatement;
    expect(w.test.text).toBe('ZERO==1');
  });
});

describe('déclarations et constructions', () => {
  it('déclarateurs multiples, tableaux, absolute, sbit, prototypes, interrupt', () => {
    const src = `unsigned char x, y = 3, t[4] = {1, 2, 3, 4};
unsigned char temperature absolute 0x0C;
sbit LED at PORTB.B0;
const unsigned char table[] = {1, 2};
short s; int i; long l; unsigned u; char c;
unsigned char carre(unsigned char v);
void interrupt() { }
unsigned char carre(unsigned char v) { return v * v; }
void main() { x = carre(y) + temperature + table[1] + t[2] + s + i + l + u + c; LED = 1; }`;
    const r = compile(src);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const u = r.ast!;
    const d0 = u.body[0] as DeclarationStatement;
    expect(d0.declarations.map((d) => [d.name, d.isArray, d.init?.kind ?? null])).toEqual([
      ['x', false, null],
      ['y', false, 'NumberLiteral'],
      ['t', true, 'InitializerList'],
    ]);
    expect(d0.declarations[2].type).toEqual({ kind: 'array', elem: { kind: 'int', size: 1, signed: false }, length: 4 });
    expect((u.body[1] as DeclarationStatement).declarations[0].absolute?.text).toBe('0x0C');
    expect(u.body[2]).toMatchObject({ kind: 'SbitDeclaration', name: 'LED', target: { kind: 'BitAccess', bit: 'B0' } });
    const types = (u.body[4] as DeclarationStatement).declarations.map((d) => d.type);
    expect(types).toEqual([{ kind: 'int', size: 1, signed: true }]);
    const all = u.body.slice(4, 9).map((s) => (s as DeclarationStatement).declarations[0].type);
    expect(all).toEqual([
      { kind: 'int', size: 1, signed: true },
      { kind: 'int', size: 2, signed: true },
      { kind: 'int', size: 4, signed: true },
      { kind: 'int', size: 2, signed: false },
      { kind: 'int', size: 1, signed: false },
    ]);
    const isr = u.body.find((s) => s.kind === 'FunctionDeclaration' && s.isInterrupt);
    expect(isr).toMatchObject({ name: 'interrupt', isInterrupt: true });
    const proto = u.body.filter((s) => s.kind === 'FunctionDeclaration' && s.name === 'carre');
    expect(proto.map((p) => (p as FunctionDeclaration).body === null)).toEqual([true, false]);
  });

  it('interruption HI-TECH (void interrupt isr(void)) et XC8 (void __interrupt() isr(void))', () => {
    for (const head of ['void interrupt isr(void)', 'void __interrupt() isr(void)']) {
      const r = compile(`${head} { INTCON.INTF = 0; }\nvoid main() { }`);
      expect(r.ok).toBe(true);
      expect(r.listing.find((l) => l.addr === 4)?.label).toBe('_interrupt');
    }
  });

  it('switch, do…while, for, break, continue, ?:, opérateurs composés', () => {
    const src = `void main() {
  unsigned char i, k;
  for (i = 0; i < 10; i++) { if (i == 3) continue; k += i; }
  do { k--; } while (k > 5);
  switch (k) { case 1: k = 2; break; case 2: case 3: k = 4; default: k = 0; }
  k = k > 2 ? 1 : 0;
  k <<= 1; k |= 0x80; k ^= 1; k &= ~0x01;
}`;
    const r = compile(src);
    expect(r.ok).toBe(true);
    const main = body(r.ast!);
    expect(main.map((s) => s.kind)).toEqual([
      'DeclarationStatement', 'ForStatement', 'DoWhileStatement', 'SwitchStatement', 'ExpressionStatement',
      'ExpressionStatement', 'ExpressionStatement', 'ExpressionStatement', 'ExpressionStatement',
    ]);
    const sw = main[3] as Extract<Statement, { kind: 'SwitchStatement' }>;
    expect(sw.cases.map((c) => [c.test?.text ?? 'default', c.consequent.length])).toEqual([
      ['1', 2], ['2', 0], ['3', 1], ['default', 1],
    ]);
  });

  it('sizeof(type), sizeof(variable) et sizeof expression', () => {
    const r = compile('unsigned char t[4], n;\nvoid main() { n = sizeof(int) + sizeof(t) / sizeof t[0]; }');
    expect(r.ok).toBe(true);
    const e = (body(r.ast!)[0] as ExpressionStatement).expression as Extract<Expression, { kind: 'AssignmentExpression' }>;
    const sum = e.right as Extract<Expression, { kind: 'BinaryExpression' }>;
    expect(sum.left).toMatchObject({ kind: 'SizeofExpression', text: 'sizeof(int)', typeSpec: { base: 'int' }, argument: null });
    const div = sum.right as Extract<Expression, { kind: 'BinaryExpression' }>;
    expect(div.left).toMatchObject({ kind: 'SizeofExpression', typeSpec: null, argument: { kind: 'Identifier', name: 't' } });
    expect(div.right).toMatchObject({ kind: 'SizeofExpression', text: 'sizeof t[0]', argument: { kind: 'IndexExpression' } });
  });

  it('macros : commentaires retirés du corps, commentaire de fin de ligne', () => {
    const u = ast('#define A (1 /* un */ + /* deux */ 2)  // somme\n#define B 3 /* trois */\nvoid main() { PORTB = A + B; }');
    const [a, b] = u.macros;
    expect([a.body, a.trailingComment?.text]).toEqual(['(1 + 2)', 'somme']);
    expect([b.body, b.trailingComment?.text]).toEqual(['3', 'trois']);
  });

  it('commentaires orphelins dans un bloc vide (diapo 16 : while(1) { // Traitement })', () => {
    const u = ast('void main() {\n    while(1) {\n        // Traitement\n    }\n}');
    const w = body(u)[0] as WhileStatement;
    expect((w.body as Block).danglingComments.map((c) => c.text)).toEqual(['Traitement']);
  });

  it('commentaire sur la ligne de fermeture', () => {
    const u = ast('void main() {\n    while(1) {\n        PORTB = 1;\n    }   // fin de la boucle\n}');
    const w = body(u)[0] as WhileStatement;
    expect(w.endComment?.text).toBe('fin de la boucle');
  });

  it('les identificateurs gardent leur casse, la résolution l’ignore (MikroC)', () => {
    const r = compile('void main() { porta.ra0 = 1; DELAY_MS(1); delay_ms(1); }');
    expect(r.ok).toBe(true);
    const s = body(r.ast!)[0] as ExpressionStatement;
    expect(s.expression.text).toBe('porta.ra0 = 1');
  });
});

describe('erreurs de syntaxe et reprise', () => {
  it("';' attendu, signalé à la fin de l'instruction précédente, puis l'analyse continue", () => {
    const r = compile('void main() {\n    PORTB = 1\n    PORTA = 2;\n    x = ;\n}');
    expect(r.ok).toBe(false);
    const errs = r.diagnostics.filter((d) => d.severity === 'error');
    expect(errs[0]).toMatchObject({ code: 'E_EXPECTED_SEMICOLON', message: "';' attendu, 'PORTA' trouvé", line: 2, col: 14 });
    expect(errs[1]).toMatchObject({ code: 'E_SYNTAX', message: "Expression attendue, ';' trouvé", line: 4 });
    expect(r.ast?.body).toHaveLength(1);
  });

  it('accolade manquante en fin de fichier', () => {
    const r = compile('void main() {\n    PORTB = 1;\n');
    expect(r.diagnostics[0]).toMatchObject({ severity: 'error', message: "'}' attendu, fin de fichier trouvé" });
  });

  it('constructions non supportées signalées clairement', () => {
    expect(compile('struct s { int a; }; void main() {}').diagnostics[0].message).toBe("'struct' n'est pas supporté");
    expect(compile('void main() { float f; }').diagnostics[0].message).toBe('Les types à virgule flottante ne sont pas supportés');
    expect(compile('void main() { goto fin; }').diagnostics[0].message).toBe("'goto' n'est pas supporté");
  });
});
