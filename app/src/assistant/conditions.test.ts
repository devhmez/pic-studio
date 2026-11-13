import { blocks as b, describeCond, emptyProgram, type Cond, type Program } from '@pic/program-model';
import { condC } from '@pic/style-c';
import { describe, expect, it } from 'vitest';
import { condToDraft, draftToCond, levelHint, nextTerm, subjectOf, termForSubject, type CondDraft } from './conditions';
import { parseExpr, parseNumberLiteral } from './expr';

function prog(): Program {
  const p = emptyProgram('Cond');
  p.signals = [
    { id: 'l0', name: 'L0', pin: 'RA0', dir: 'in', label: 'L0', activeLevel: 1, device: 'logicstate' },
    { id: 'l1', name: 'L1', pin: 'RA1', dir: 'in', label: 'L1', activeLevel: 1, device: 'logicstate' },
    { id: 'valider', name: 'VALIDER', pin: 'RA2', dir: 'in', label: 'Bouton valider', activeLevel: 1, device: 'button' },
    { id: 'd0', name: 'D0', pin: 'RB0', dir: 'out', label: 'Led D0', activeLevel: 1, device: 'led' },
  ];
  p.buses = [{ id: 'aff', name: 'AFFICHEUR', port: 'B', lsb: 4, width: 4, dir: 'out', label: 'Afficheur', device: 'bcd' }];
  p.variables = [{ name: 'var1', type: 'unsigned char' }, { name: 'var2', type: 'unsigned char' }];
  p.constants = [{ name: 'REPONSE', value: 0xca, radix: 16 }];
  return p;
}

describe('condition builder ↔ Cond', () => {
  it('maps a single test to one row and back', () => {
    const c = b.pin('l0', 1);
    const d = condToDraft(prog(), c);
    expect(d).toEqual({ join: 'and', terms: [c] });
    expect(draftToCond(d)).toEqual(c);
  });

  it('maps the demux decoding (L1 == 0 && L0 == 1) to two « et » rows', () => {
    const c = b.and(b.pin('l1', 0), b.pin('l0', 1));
    const d = condToDraft(prog(), c);
    expect(d.join).toBe('and');
    expect(d.terms).toHaveLength(2);
    expect(draftToCond(d)).toEqual(c);
    expect(condC(prog(), draftToCond(d))).toBe('L1 == 0 && L0 == 1');
  });

  it('keeps « ou » joins', () => {
    const c = b.or(b.flag('Z', 1), b.cmp(b.v('var1'), '>', b.v('var2')));
    const d = condToDraft(prog(), c);
    expect(d.join).toBe('or');
    expect(draftToCond(d)).toEqual(c);
  });

  it('turns a negated simple test into the opposite test', () => {
    const d = condToDraft(prog(), b.not(b.cmp(b.v('var1'), '<', b.v('var2'))));
    expect(d.terms[0]).toEqual(b.cmp(b.v('var1'), '>=', b.v('var2')));
  });

  it('keeps nested and/or mixes as C text', () => {
    const c = b.and(b.pin('l0', 1), b.or(b.pin('l1', 1), b.flag('C', 1)));
    const d = condToDraft(prog(), c);
    expect(d.terms[1]).toEqual({ kind: 'raw', text: 'L1 == 1 || STATUS.F0 == 1' });
    expect(condC(prog(), draftToCond(d))).toBe('L0 == 1 && L1 == 1 || STATUS.F0 == 1');
  });

  it('builds rows from the subject select and keeps the level', () => {
    const p = prog();
    const pinRow = termForSubject(p, 'pin:l1', { kind: 'pin', signal: 'l0', value: 0 });
    expect(pinRow).toEqual({ kind: 'pin', signal: 'l1', value: 0 });
    expect(subjectOf(pinRow)).toBe('pin:l1');
    expect(termForSubject(p, 'flag:C', pinRow)).toEqual({ kind: 'flag', flag: 'C', value: 0 });
    expect(termForSubject(p, 'compare')).toEqual({ kind: 'compare', left: b.v('var1'), op: '==', right: b.v('var2') });
    expect(termForSubject(p, 'raw', pinRow)).toEqual({ kind: 'raw', text: 'L1 == 0' });
  });

  it('suggests the next untested input for « + condition »', () => {
    const p = prog();
    const draft: CondDraft = { join: 'and', terms: [b.pin('l0', 1) as Extract<Cond, { kind: 'pin' }>] };
    expect(nextTerm(p, draft)).toEqual({ kind: 'pin', signal: 'l1', value: 1 });
  });

  it('describes the builder result like the organigramme diamonds', () => {
    const d: CondDraft = { join: 'and', terms: [b.pin('l1', 0) as Extract<Cond, { kind: 'pin' }>, b.pin('l0', 1) as Extract<Cond, { kind: 'pin' }>] };
    expect(describeCond(prog(), draftToCond(d))).toBe('L1==0 et L0==1');
  });

  it('names pin levels in plain French', () => {
    const p = prog();
    expect(levelHint(p, 'valider', 1)).toBe('appuyé');
    expect(levelHint(p, 'valider', 0)).toBe('relâché');
    expect(levelHint(p, 'd0', 1)).toBe('allumée');
  });
});

describe('expression fields', () => {
  it('parses numbers in the three bases', () => {
    expect(parseExpr('10', prog())).toEqual({ ok: true, expr: { kind: 'num', value: 10 } });
    expect(parseExpr('0x0A', prog())).toEqual({ ok: true, expr: { kind: 'num', value: 10, radix: 16 } });
    expect(parseExpr('0b0101', prog())).toEqual({ ok: true, expr: { kind: 'num', value: 5, radix: 2 } });
    expect(parseNumberLiteral('0xCA')).toEqual({ value: 0xca, radix: 16 });
    expect(parseNumberLiteral('abc')).toBeNull();
  });

  it('resolves names case-insensitively (variables, constants, pins, buses, registers)', () => {
    const p = prog();
    expect(parseExpr('VAR1', p)).toEqual({ ok: true, expr: { kind: 'var', name: 'var1' } });
    expect(parseExpr('reponse', p)).toEqual({ ok: true, expr: { kind: 'var', name: 'REPONSE' } });
    expect(parseExpr('L0', p)).toEqual({ ok: true, expr: { kind: 'signal', id: 'l0' } });
    expect(parseExpr('afficheur', p)).toEqual({ ok: true, expr: { kind: 'bus', id: 'aff' } });
    expect(parseExpr('PORTB', p)).toEqual({ ok: true, expr: { kind: 'reg', name: 'PORTB' } });
    expect(parseExpr('STATUS.F2', p)).toEqual({ ok: true, expr: { kind: 'reg', name: 'STATUS', bit: 'F2' } });
  });

  it('respects C precedence and parentheses', () => {
    const p = prog();
    const r = parseExpr('var1 - var2 * 2', p);
    expect(r.ok && condC(p, b.cmp(r.expr, '==', b.num(0)))).toBe('var1 - var2 * 2 == 0');
    const q = parseExpr('(var1 - 1) & 0x0F', p);
    expect(q).toEqual({ ok: true, expr: b.op('&', b.sub(b.v('var1'), b.num(1)), b.hex(0x0f)) });
    expect(parseExpr('-var1', p)).toEqual({ ok: true, expr: { kind: 'unary', op: '-', arg: b.v('var1') } });
  });

  it('reports mistakes in French', () => {
    const p = prog();
    expect(parseExpr('', p)).toEqual({ ok: false, error: 'Valeur vide.' });
    expect(parseExpr('(var1 + 1', p)).toMatchObject({ ok: false, error: expect.stringContaining('Parenthèse') });
    expect(parseExpr('var1 +', p)).toMatchObject({ ok: false });
    expect(parseExpr('3x', p)).toMatchObject({ ok: false, error: expect.stringContaining('Nombre') });
    expect(parseExpr('var1 # 2', p)).toMatchObject({ ok: false, error: expect.stringContaining('#') });
  });
});
