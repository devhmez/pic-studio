/// <reference types="node" />
// The organigramme prose in the prof's wording (research 06 §3 verbatim, 00 §4.3–§4.5).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  blocks as b, branchNote, describeActions, describeBranchCond, describeCond, describeConfiguration, describeExpr,
  describeFor, describeInitialisation, describeRepeat, describeStmt, describeWait, describeWhile, formatDuration, functionTitle, segmentStmts,
  glyphName, parseProgramJson, pinListText, type Program, type Stmt,
} from '../src';

const template = (id: string): Program =>
  parseProgramJson(readFileSync(new URL(`../../../templates/${id}.program.json`, import.meta.url), 'utf8'));

const texts = (lines: { text: string }[]) => lines.map((l) => l.text);

function nth<K extends Stmt['kind']>(list: readonly Stmt[] | null, i: number, kind: K): Extract<Stmt, { kind: K }> {
  const s = list?.[i];
  if (!s || s.kind !== kind) throw new Error(`${kind} attendu en position ${i}`);
  return s as Extract<Stmt, { kind: K }>;
}

describe('her TP STATUS organigramme (slide 6)', () => {
  const p = template('tp-status');

  it('CONFIGURATION names the pins the program uses, as on her slide 6, even with `TRISB = 0x00;`', () => {
    expect(texts(describeConfiguration(p))).toEqual(['RB0,RB1 et RB2 sont des sorties', 'Déclaration des variables']);
    // Same wording when the pins are configured one by one.
    const bits = { ...p, style: { ...p.style, tris: { A: 'bits' as const, B: 'bits' as const } } };
    expect(texts(describeConfiguration(bits))).toEqual(['RB0,RB1 et RB2 sont des sorties', 'Déclaration des variables']);
  });

  it('« PORTB est en sortie » only when the whole port is written and all 8 pins are used', () => {
    const outs = (['RB0', 'RB1', 'RB2', 'RB3', 'RB4', 'RB5', 'RB6', 'RB7'] as const).map((pin, k) => ({
      id: `led${k}`, name: `LED${k}`, pin, dir: 'out' as const, label: `Led ${k}`, activeLevel: 1 as const, device: 'led' as const,
    }));
    const all = { ...p, signals: outs };
    expect(texts(describeConfiguration(all))[0]).toBe('PORTB est en sortie');
    // Seven of them: listed (runs of 4+ shortened, her comma without space, « et » before the last).
    const seven = { ...p, signals: outs.filter((s) => s.pin !== 'RB5') };
    expect(texts(describeConfiguration(seven))[0]).toBe('RB0 à RB4,RB6 et RB7 sont des sorties');
    // Pin by pin, all 8: still listed (the code does not write the port as a whole).
    const bits = { ...all, style: { ...p.style, tris: { A: 'bits' as const, B: 'bits' as const } } };
    expect(texts(describeConfiguration(bits))[0]).toBe('RB0 à RB7 sont des sorties');
    // Inputs the same way: two LOGICSTATEs on a port written as a whole → « RB0 et RB1 sont des entrées ».
    const ins = { ...p, signals: outs.slice(0, 2).map((s) => ({ ...s, dir: 'in' as const, device: 'logicstate' as const })) };
    expect(texts(describeConfiguration(ins))[0]).toBe('RB0 et RB1 sont des entrées');
  });

  it('INITIALISATION: « x=5 et y=6 », « Les Leds sont éteintes » in red, then status.c’s « STATUS=0 »', () => {
    expect(describeInitialisation(p)).toEqual([
      { text: 'x=5 et y=6' }, { text: 'Les Leds sont éteintes', emphasis: 'off' }, { text: 'STATUS=0' },
    ]);
  });

  it('first loop box: « Les Leds sont éteintes » / « z= x-y »', () => {
    expect(texts(describeActions(p, p.loop!.slice(0, 4)))).toEqual(['Les Leds sont éteintes', 'z= x-y']);
  });

  it('diamonds « ZERO==1 » and « CARRY==1 » (no question mark), boxes « // x= y » + « Led égalité allumée »', () => {
    const chain = nth(p.loop, 4, 'if');
    expect(chain.branches.map((x) => describeBranchCond(p, x))).toEqual(['ZERO==1', 'CARRY==1']);
    const boxes = [...chain.branches, chain.otherwise!].map((x) => [branchNote(x), ...texts(describeActions(p, x.body))]);
    expect(boxes).toEqual([
      ['// x= y', 'Led égalité allumée'],
      ['// x> y', 'Led supérieur allumée'],
      ['// x<y', 'Led inférieur allumée'],
    ]);
  });

  it('never uses « ← » nor « ? »', () => {
    const all = [
      ...describeConfiguration(p), ...describeInitialisation(p), ...describeActions(p, p.loop!),
    ].map((l) => l.text).join('\n');
    expect(all).not.toMatch(/[←?]/);
  });
});

describe('other templates', () => {
  it('demux: « Led D0 allumée » + « Les autres Leds sont éteintes », diamonds with « et »', () => {
    const p = template('tp1-demux');
    expect(texts(describeConfiguration(p))).toEqual(['RA0 et RA1 sont des entrées', 'RB0 à RB3 sont des sorties']);
    const chain = nth(p.loop, 0, 'if');
    expect(chain.branches.map((x) => describeCond(p, x.cond))).toEqual(['L1==0 et L0==0', 'L1==0 et L0==1', 'L1==1 et L0==0']);
    expect(describeCond(p, chain.branches[0].cond, { logic: 'c' })).toBe('L1==0 && L0==0');
    expect(texts(describeActions(p, chain.branches[1].body))).toEqual(['Led D1 allumée', 'Les autres Leds sont éteintes']);
    expect(describeInitialisation(p)).toEqual([{ text: 'Les Leds sont éteintes', emphasis: 'off' }]);
  });

  it('vote: blink, display for 0,5 s, counters, wait for release', () => {
    const p = template('tp-vote');
    expect(texts(describeConfiguration(p))).toEqual([
      'RA0,RA1 et RA3 sont des entrées', 'RA2,RB0 à RB3 et RB5 sont des sorties', 'Déclaration des variables',
    ]);
    expect(texts(describeInitialisation(p))).toEqual(['var1=0 et var2=0', 'Les Leds sont éteintes', "Afficher la lettre 'F' pendant 0,5 s"]);
    const voteA = nth(p.loop, 0, 'if');
    expect(describeCond(p, voteA.branches[0].cond)).toBe('VOTE_A==1');
    const body = voteA.branches[0].body;
    expect(texts(describeActions(p, body.slice(0, 5)))).toEqual(['var1=var1+1', 'Led de confirmation clignote (0,5 s / 0,5 s)']);
    // The diamond holds the condition that ends the wait: `oui` continues, `non` loops back (research 06 §7).
    expect(describeWait(p, nth(body, 5, 'waitFor'))).toEqual({ text: 'VOTE_A==0', loopOn: 'non' });
    expect(describeWait(p, nth(body, 5, 'waitFor'), { waits: 'loop' })).toEqual({ text: 'VOTE_A==1', loopOn: 'oui' });
    const result = nth(p.loop, 2, 'if').branches[0].body;
    const flags = nth(result, 1, 'if');
    expect(texts(describeActions(p, flags.branches[0].body.slice(0, 1)))).toEqual(["Afficher la lettre 'E'"]);
    expect(describeRepeat(p, nth(flags.branches[0].body, 1, 'repeat'))).toEqual({
      summary: 'Led verte clignote 3 fois (0,5 s / 0,5 s)', box: ['Led verte clignote 3 fois (0,5 s / 0,5 s)'],
      init: 'i=0', test: 'i<3', update: 'i=i+1',
    });
    expect(texts(describeActions(p, flags.branches[0].body.slice(1, 2)))).toEqual(['Led verte clignote 3 fois (0,5 s / 0,5 s)']);
    expect(texts(describeActions(p, nth(flags.branches[0].body, 1, 'repeat').body))).toEqual(['Led verte clignote (0,5 s / 0,5 s)']);
    expect(texts(describeActions(p, flags.branches[1].body))).toEqual(["Afficher la lettre 'A' pendant 0,5 s"]);
    expect(texts(describeActions(p, flags.otherwise!.body))).toEqual(["Afficher la lettre 'B' pendant 0,5 s"]);
  });

  it('traffic: lamps are masculine (« Feu rouge allumé »), countdown displays « 9-compte »', () => {
    const p = template('tp-traffic');
    expect(texts(describeInitialisation(p))).toEqual(['Les feux sont éteints', 'Afficher le chiffre 0']);
    const chain = nth(p.loop, 0, 'if');
    expect(texts(describeActions(p, chain.branches[0].body))).toEqual([
      'Feu rouge éteint', 'Feu vert éteint', "Afficher la lettre 'A'", 'Feu orange clignote (0,5 s / 0,5 s)',
    ]);
    const day = chain.otherwise!.body;
    expect(texts(describeActions(p, day.slice(0, 3)))).toEqual(['Feu rouge allumé', 'Les autres feux sont éteints']);
    expect(texts(describeActions(p, nth(day, 3, 'repeat').body))).toEqual(['Afficher 9-compte pendant 1 s']);
    // The repetition itself, in one line (research 00 §4.5): no C arithmetic in the prose.
    expect(describeRepeat(p, nth(day, 3, 'repeat')).summary).toBe("Décompte de 9 à 0 sur l'afficheur (1 s par chiffre)");
    expect(describeRepeat(p, nth(day, 7, 'repeat')).summary).toBe("Décompte de 2 à 0 sur l'afficheur (1 s par chiffre)");
    expect(texts(describeConfiguration(p))).toEqual([
      'RA3 est une entrée', 'RA0,RA1,RA2 et RB0 à RB3 sont des sorties', 'Déclaration des variables',
    ]);
  });

  it('pupitre: busy waits, the while loop, compare to the constant', () => {
    const p = template('tp-pupitre');
    expect(texts(describeConfiguration(p))).toEqual([
      'RA0 et RA4 sont des entrées', 'PORTB est en entrée', 'RA1,RA2 et RA3 sont des sorties', 'Déclaration des variables',
    ]);
    expect(describeWait(p, nth(p.loop, 0, 'waitFor')).text).toBe('DEMARRER==1');
    // A new game needs DEMARRER switched off first (it is a latched LOGICSTATE).
    expect(describeWait(p, nth(p.loop, 5, 'waitFor')).text).toBe('DEMARRER==0');
    const loop = nth(p.loop, 3, 'while');
    expect(describeWhile(p, loop).text).toBe('essais>0 et reussi==0');
    const test = nth(loop.body, 1, 'if');
    expect(describeCond(p, test.branches[0].cond)).toBe('REPONSES==REPONSE_CORRECTE');
    expect(texts(describeActions(p, test.branches[0].body))).toEqual(['Led YES allumée pendant 3 s', 'reussi=1']);
    expect(texts(describeActions(p, test.otherwise!.body))).toEqual(['Led NO allumée pendant 3 s', 'essais=essais-1']);
  });

  it('interrupts: configuration lines and the interrupt routine', () => {
    const p5 = template('tp5-int-rb0');
    expect(texts(describeConfiguration(p5))).toEqual([
      'RB0 est une entrée', 'RB1 et RB2 sont des sorties', 'Interruption RB0/INT sur front montant', 'Les interruptions sont autorisées',
    ]);
    const isr = nth(p5.functions[0].body, 0, 'if');
    expect(describeCond(p5, isr.branches[0].cond)).toBe('INTF==1');
    expect(texts(describeActions(p5, isr.branches[0].body))).toEqual(['Led rouge inversée', 'Effacer le drapeau INTF']);
    expect(texts(describeActions(p5, p5.loop!))).toEqual(['Led verte clignote (0,5 s / 0,5 s)']);
    const p6 = template('tp6-rbie');
    expect(texts(describeConfiguration(p6))[2]).toBe('Interruption sur changement de RB4 à RB7');
    // A run of input → output copies is one line of prose, not four C assignments.
    expect(texts(describeActions(p6, nth(p6.functions[0].body, 0, 'if').branches[0].body))).toEqual([
      'Recopier RB4 à RB7 sur RA0 à RA3', 'Effacer le drapeau RBIF',
    ]);
    expect(texts(describeInitialisation(p6))).toEqual(['Recopier RB4 à RB7 sur RA0 à RA3']);
    expect(texts(describeActions(p6, p6.loop!))).toEqual(['Attente des interruptions']);
  });
});

describe('helpers', () => {
  it('durations with a French decimal comma', () => {
    expect([500, 1000, 1500, 250, 3000, 20].map((ms) => formatDuration(ms))).toEqual(['0,5 s', '1 s', '1,5 s', '0,25 s', '3 s', '20 ms']);
    expect(formatDuration(40, 'us')).toBe('40 µs');
  });

  it('7SEG-BCD glyphs as the énoncés name them', () => {
    expect([0, 9, 10, 11, 14, 15].map(glyphName)).toEqual([
      'le chiffre 0', 'le chiffre 9', "la lettre 'A'", "la lettre 'B'", "la lettre 'E'", "la lettre 'F'",
    ]);
  });

  it('pin lists in her spelling, long runs shortened', () => {
    expect(pinListText(['RB2', 'RB0', 'RB1'])).toBe('RB0,RB1 et RB2');
    expect(pinListText(['RA0'])).toBe('RA0');
    expect(pinListText(['RB0', 'RB1', 'RB2', 'RB3', 'RB5', 'RA2'])).toBe('RA2,RB0 à RB3 et RB5');
  });

  it('expressions: compact, parentheses only when needed', () => {
    const p = template('tp-status');
    expect(describeExpr(p, b.sub(b.num(9), b.v('compte')))).toBe('9-compte');
    expect(describeExpr(p, b.sub(b.v('a'), b.sub(b.v('b'), b.v('c'))))).toBe('a-(b-c)');
    expect(describeExpr(p, b.op('&', b.sub(b.v('k'), b.num(1)), b.hex(15)))).toBe('(k-1)&0x0F');
  });

  it('text overrides win over the generated prose', () => {
    const p = template('tp-status');
    expect(texts(describeStmt(p, b.on('led_egal', { text: 'Allumer\nla Led' })))).toEqual(['Allumer', 'la Led']);
    expect(texts(describeActions(p, [b.off('led_sup', { text: 'Rien' }), b.off('led_egal'), b.off('led_inf')]))).toEqual([
      'Rien', 'Led égalité éteinte', 'Led inférieur éteinte',
    ]);
  });

  it('for loops: init box, diamond, update box', () => {
    const p = template('tp-status');
    const f = b.forLoop(b.assign(b.v('x'), 10), b.cmp(b.v('x'), '>', b.num(0)), b.decr('x'), []);
    expect(describeFor(p, f)).toEqual({ summary: 'Tant que x>0', box: ['Tant que x>0'], init: 'x=10', test: 'x>0', update: 'x=x-1' });
  });

  it('repeat: one line for a blink or a countdown, else « Répéter N fois : » and the body', () => {
    const p = template('tp-vote');
    const other = b.repeat(2, 'i', [b.assign(b.v('z'), b.num(1))]);
    expect(describeRepeat(p, other)).toMatchObject({ summary: 'Répéter 2 fois', box: ['Répéter 2 fois :', 'z=1'] });
    expect(describeRepeat(p, { ...other, text: 'Deux fois' }).box).toEqual(['Deux fois']);
  });
});

describe('segments and chart titles', () => {
  it('cuts a block into boxes and control shapes', () => {
    const p = template('tp-status');
    expect(segmentStmts(p.loop!).map((s) => (s.kind === 'actions' ? `box(${s.stmts.length})` : s.stmt.kind))).toEqual(['box(4)', 'if']);
    const v = template('tp-vote');
    const voteA = nth(v.loop, 0, 'if').branches[0].body;
    expect(segmentStmts(voteA).map((s) => (s.kind === 'actions' ? `box(${s.stmts.length})` : s.stmt.kind))).toEqual(['box(5)', 'waitFor']);
  });

  it('titles the interrupt routine’s own chart', () => {
    expect(functionTitle(template('tp5-int-rb0').functions[0])).toBe("Programme d'interruption");
    expect(functionTitle(b.fn('clignoter', []))).toBe('Sous-programme clignoter()');
  });
});

describe('generic wording (her « Organigramme général du programme »)', () => {
  it('« Configurer les entrées. » / « Configurer les sorties. » / « Initialiser les sorties »', () => {
    const p = template('tp1-demux');
    expect(describeConfiguration(p, { wording: 'generic' }).map((l) => l.text)).toEqual(['Configurer les entrées.', 'Configurer les sorties.']);
    expect(describeInitialisation(p, { wording: 'generic' })).toEqual([{ text: 'Initialiser les sorties', emphasis: 'off' }]);
  });
});

describe('single LED programs', () => {
  it('EXEMPLE2: « Led verte éteinte » in red in INITIALISATION, « LED==… » tests by name', () => {
    const p = template('tp0-exemple2');
    expect(describeInitialisation(p)).toEqual([{ text: 'Led verte éteinte', emphasis: 'off' }]);
    const chain = nth(p.loop, 0, 'if');
    expect(describeCond(p, chain.branches[0].cond)).toBe('BOUTON==1');
    expect(texts(describeActions(p, chain.branches[0].body))).toEqual(['Led verte allumée']);
    expect(texts(describeInitialisation(template('tp0-exemple1')))).toEqual(['Led bleue allumée']);
  });
});
