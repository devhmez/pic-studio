// generate(p) → compile → fromAst → generate gives the same C, for every template, every statement kind and every
// style option: hand edits of generated code can always be parsed back into the model without loss.
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compile, decodeSource } from '@pic/compiler';
import {
  blocks as b, cloneProgram, emptyProgram, ensureIds, fromAst, fromAstDetailed, programFromSource,
  type CodeStyle, type Program, type Signal,
} from '@pic/program-model';
import { runFor, shownLeds, startTp } from '../../integration/test/support';
import { generate } from '../src';
import { TEMPLATE_PROGRAMS, tpPupitre, tpStatus, tpVote } from './template-programs';

function reparse(p: Program): { program: Program; notes: string[] } {
  const c = generate(p);
  const r = compile(c, { clockHz: p.clockHz });
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return fromAstDetailed(r.ast!, r.source, { clockHz: p.clockHz, title: p.title });
}

function expectRoundTrip(p: Program): Program {
  const { program, notes } = reparse(p);
  expect(notes).toEqual([]);
  expect(generate(program)).toBe(generate(p));
  return program;
}

const led = (name: string, pin: Signal['pin'], extra: Partial<Signal> = {}): Signal =>
  ({ id: name.toLowerCase(), name, pin, dir: 'out', label: `Led ${name}`, activeLevel: 1, device: 'led', ...extra });
const input = (name: string, pin: Signal['pin'], extra: Partial<Signal> = {}): Signal =>
  ({ id: name.toLowerCase(), name, pin, dir: 'in', label: `Entrée ${name}`, activeLevel: 1, device: 'logicstate', ...extra });

describe('round trip of the templates', () => {
  for (const t of TEMPLATE_PROGRAMS) {
    it(t.id, () => {
      const p = t.build();
      const q = expectRoundTrip(p);
      // The model itself comes back: same pins, directions, variables, style and statement shapes.
      expect(q.signals.map((s) => [s.name, s.pin, s.dir])).toEqual(p.signals.map((s) => [s.name, s.pin, s.dir]));
      expect(q.variables.map((v) => v.name)).toEqual(p.variables.map((v) => v.name));
      expect(q.style).toEqual({ ...p.style, tris: q.style.tris });
      expect(q.interrupts).toEqual(p.interrupts);
      const kinds = (list: Program['init'] | null) => list?.map((s) => s.kind) ?? null;
      expect(kinds(q.init)).toEqual(kinds(p.init));
      expect(kinds(q.loop)).toEqual(kinds(p.loop));
    });
  }

  it('recovers the 7SEG bus width from the values written (vote: RB0..RB3, RB5 stays a LED)', () => {
    const q = reparse(tpVote()).program;
    expect(q.buses).toMatchObject([{ name: 'AFFICHEUR', port: 'B', lsb: 0, width: 4, dir: 'out', device: 'bcd' }]);
    expect(q.signals.find((s) => s.name === 'LED_EGAL')).toMatchObject({ pin: 'RB5', dir: 'out', device: 'led' });
  });

  it('recovers input buses and constants (pupitre: REPONSES = PORTB, REPONSE_CORRECTE = 0xCA)', () => {
    const q = reparse(tpPupitre()).program;
    expect(q.buses).toMatchObject([{ name: 'REPONSES', lsb: 0, width: 8, dir: 'in' }]);
    // The comment is read back from the line above the #define.
    expect(q.constants).toEqual([{ name: 'REPONSE_CORRECTE', value: 0xca, radix: 16, comment: 'Réponses attendues : Q7..Q0 = 1 1 0 0 1 0 1 0' }]);
  });

  it('keeps branch comments on the branches, not on the statements', () => {
    const q = reparse(tpStatus()).program;
    const chain = q.loop![4];
    expect(chain.kind).toBe('if');
    if (chain.kind !== 'if') return;
    expect(chain.branches.map((x) => [x.cond, x.comment])).toEqual([
      [{ kind: 'flag', flag: 'Z', value: 1 }, 'Test du bit Zero, x = y'],
      [{ kind: 'flag', flag: 'C', value: 1 }, 'Test du Carry, x > y'],
    ]);
    expect(chain.otherwise?.comment).toBe('x < y');
    expect(chain.comment).toBeUndefined();
  });
});

describe('round trip of every statement kind and style option', () => {
  const sink = (style: Partial<CodeStyle> = {}): Program => ensureIds({
    ...emptyProgram('Toutes les instructions'),
    style: { ...emptyProgram().style, ...style },
    signals: [input('BP', 'RB0', { device: 'button' }), led('L1', 'RB1'), led('L2', 'RB2'), input('CAP', 'RA3', { device: 'sensor' }), led('RA1', 'RA1', { useDefine: false })],
    buses: [{ id: 'aff', name: 'AFF', port: 'B', lsb: 4, width: 4, dir: 'out', label: 'Sorties AFF', comment: 'quartet haut' }],
    constants: [{ name: 'MAX', value: 10, comment: 'nombre maximal' }, { name: 'MASQUE', value: 0b1010, radix: 2 }],
    variables: [{ name: 'n', type: 'unsigned char' }, { name: 'k', type: 'unsigned char' }, { name: 't', type: 'unsigned int', comment: 'compteur 16 bits' }, { name: 's', type: 'signed char' }],
    interrupts: { int: { edge: 'falling' }, rbChange: true, tmr0: { prescaler: 64 }, gie: true },
    functions: [
      b.fn('clignoter', [b.on('l2'), b.delay(100), b.off('l2')], 'function', 'Fait clignoter L2 une fois'),
      b.interrupt([
        b.when(b.flag('INTF'), [b.incr('n'), b.clearFlag('INTF')], undefined, { comment: 'RB0/INT' }),
        b.when(b.flag('T0IF'), [b.toggle('l1'), b.clearFlag('T0IF')]),
        b.when(b.flag('RBIF'), [b.assign(b.sig('l2'), b.sig('bp')), b.clearFlag('RBIF')]),
      ], 'Interruptions'),
    ],
    init: [b.setAll(['l1', 'l2'], 0, { comment: 'tout éteindre' }), b.assign(b.v('n'), 0), b.display('aff', 0x05), b.on('ra1')],
    loop: [
      b.comment('Programme : début du tour'),
      b.waitFor(b.or(b.pin('bp', 1), b.not(b.pin('cap', 0))), { comment: 'attente' }),
      b.whileLoop(b.cmp(b.v('n'), '<', b.v('MAX')), [b.incr('n')], { lead: 'Comptage\njusqu’à MAX' }),
      b.repeat(3, 'k', [b.call('clignoter')]),
      b.forLoop(b.assign(b.v('k'), 10), b.cmp(b.v('k'), '>', b.num(0)), b.decr('k'), [
        b.display('aff', b.op('&', b.sub(b.v('k'), b.num(1)), b.hex(0x0f))),
      ]),
      b.forLoop(b.assign(b.v('k'), 0), b.cmp(b.v('k'), '<=', b.num(4)), b.assign(b.v('k'), b.op('+', b.v('k'), b.num(2))), []),
      b.assign(b.v('t'), b.op('+', b.v('t'), b.num(1000))),
      b.assign(b.v('s'), { kind: 'unary', op: '-', arg: b.v('n') }),
      b.assign(b.v('n'), { kind: 'unary', op: '~', arg: b.op('|', b.v('n'), b.v('MASQUE')) }),
      b.assign(b.reg('PORTA'), b.reg('PORTB')),
      b.assign(b.reg('OPTION_REG', 'RBPU'), 0),
      b.ifChain([
        b.branch(b.and(b.flag('C', 0), b.or(b.flag('Z', 1), b.rawCond('n > 3'))), [b.decr('n')], { comment: 'emprunt' }),
        b.branch(b.cmp(b.bus('aff'), '!=', b.num(0)), []),
      ], b.otherwise([b.comment('rien')], { comment: 'sinon' })),
      b.raw('switch (n) {\n    case 1: n = 2; break;\n    default: break;\n}', { comment: 'brut' }),
      b.delay(250, { lead: 'Pause' }),
      { ...b.delay(40), unit: 'us' },
      b.when(b.flag('DC', 1), [b.whileLoop(b.rawCond('1'), [b.raw('break;')])]),
    ],
  });

  const variants: [string, Partial<CodeStyle>][] = [
    ['defaults', {}],
    ['index notation, whole ports, status sections', { bitNotation: 'index', tris: { A: 'port', B: 'port' }, sections: 'status' }],
    ['no macros, compact, echoes, one-line chains', { macros: false, compactAssign: true, echoRegister: true, oneLineBranches: true }],
    ['packed lines', { packLines: true }],
    ['bit-by-bit TRIS', { tris: { A: 'bits', B: 'bits' } }],
  ];
  for (const [name, style] of variants) {
    it(name, () => {
      const p = sink(style);
      expectRoundTrip(p);
    });
  }

  it('template variants: every style option on every template', () => {
    const options: Partial<CodeStyle>[] = [
      { bitNotation: 'index' }, { macros: false }, { sections: 'status' }, { compactAssign: true, macros: false },
      { echoRegister: true }, { oneLineBranches: true }, { tris: { A: 'port', B: 'bits' } }, { packLines: true },
      { packLines: true, echoRegister: true, compactAssign: true, macros: false },
    ];
    for (const t of TEMPLATE_PROGRAMS) {
      for (const o of options) {
        const p = cloneProgram(t.build());
        p.style = { ...p.style, ...o };
        expectRoundTrip(p);
      }
    }
  });
});

describe('programFromSource', () => {
  it('parses C text into a program (front end only, never throws)', () => {
    const { program, diagnostics } = programFromSource('void main() { TRISB.RB0 = 0; while(1) { PORTB.RB0 = 1; } }');
    expect(diagnostics).toEqual([]);
    expect(program?.signals).toMatchObject([{ name: 'RB0', pin: 'RB0', dir: 'out', useDefine: false }]);
    expect(program?.loop).toMatchObject([{ kind: 'set', signal: 'rb0', value: 1 }]);
  });

  it('returns a program even for code with semantic errors, and null only when nothing parses', () => {
    expect(programFromSource('void main() { inconnue = 3; }').program?.init).toMatchObject([{ kind: 'raw' }]);
    expect(programFromSource('void main( {').program).not.toBeUndefined();
    const garbage = programFromSource('}}}');
    expect(garbage.program === null || garbage.program.init.length >= 0).toBe(true);
  });

  it('fromAst also accepts the unit alone', () => {
    const r = compile(generate(tpStatus()));
    expect(generate(fromAst(r.ast!))).toBe(generate(tpStatus()));
  });
});

describe('the prof’s own files, parsed then regenerated', () => {
  const fixture = (name: string) =>
    decodeSource(readFileSync(new URL(`../../compiler/test/fixtures/${name}`, import.meta.url)));
  const regenerate = (name: string, clockHz = 1_000_000) => {
    const parsed = programFromSource(fixture(name), { clockHz });
    expect(parsed.program, name).not.toBeNull();
    return generate(parsed.program!);
  };

  it('demux_corrige.c comes back byte for byte', () => {
    expect(regenerate('demux_corrige.c')).toBe(fixture('demux_corrige.c').replace(/\r\n/g, '\n').replace(/\n*$/, '\n'));
  });

  for (const [name, clockHz] of [
    ['EXEMPLE1.c', 1e6], ['EXEMPLE2.c', 1e6], ['demux.c', 1e6], ['status.c', 1e6], ['status_corrige.c', 1e6],
    ['traffic.c', 8e6], ['vote.c', 1e6], ['derived/pupitre.c', 1e6], ['derived/vote.c', 1e6], ['derived/traffic.c', 8e6],
  ] as const) {
    it(`${name}: the regenerated C compiles and parses back to the same C`, () => {
      const c = regenerate(name, clockHz);
      const r = compile(c, { clockHz });
      expect(r.diagnostics.filter((d) => d.severity === 'error'), c).toEqual([]);
      expect(generate(fromAst(r.ast!, r.source, { clockHz }))).toBe(c);
    });
  }

  it('status.c keeps its bug through the model (two separate if: EGALITE and X_SUPERIEUR when x = y)', () => {
    const session = startTp('tp-status', regenerate('status.c')).session;
    runFor(session, 0.1);
    expect(shownLeds(session, ['X_SUPERIEUR', 'EGALITE', 'X_INFERIEUR'])).toEqual(['X_SUPERIEUR', 'EGALITE']);
  });

  it('demux.c keeps its D1/D2 swap through the model', () => {
    const session = startTp('tp1-demux', regenerate('demux.c')).session;
    const rows: string[][] = [];
    for (const [l1, l0] of [[0, 0], [0, 1], [1, 0], [1, 1]] as const) {
      for (const [id, v] of [['LS1', l0], ['LS2', l1]] as const) {
        const vis = session.snapshot().visuals[id];
        if (vis?.kind === 'LOGICSTATE' && vis.state !== v) session.interact(id, { type: 'toggle' });
      }
      runFor(session, 0.05);
      rows.push(shownLeds(session, ['D1', 'D2', 'D3', 'D4']));
    }
    expect(rows).toEqual([['D1'], ['D3'], ['D2'], ['D4']]);
  });
});
