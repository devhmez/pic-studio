/// <reference types="node" />
// fromAst on the prof's own files (and the derived drafts): sensible models, never an exception.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyze, decodeSource } from '@pic/compiler';
import { fromAst, fromAstDetailed, programFromSource, type Program, type Stmt } from '../src';

const fixture = (name: string) => decodeSource(readFileSync(new URL(`../../compiler/test/fixtures/${name}`, import.meta.url)));

function load(name: string, clockHz = 1_000_000): Program {
  const r = analyze(fixture(name), { clockHz });
  expect(r.ast, name).toBeDefined();
  return fromAst(r.ast!, r.source, { clockHz });
}

const kinds = (list: readonly Stmt[] | null) => list?.map((s) => s.kind) ?? null;

describe('fromAst: status.c (prof, two independent if)', () => {
  const p = load('status.c');

  it('reads her aliases, macros, notation and section comments', () => {
    expect(p.signals.map((s) => [s.name, s.pin, s.dir, s.device])).toEqual([
      ['LED_SUP', 'RB0', 'out', 'led'], ['LED_EGAL', 'RB1', 'out', 'led'], ['LED_INF', 'RB2', 'out', 'led'],
    ]);
    expect(p.style).toMatchObject({ bitNotation: 'index', macros: true, sections: 'status', tris: { A: 'auto', B: 'port' } });
    expect(p.variables.map((v) => `${v.type} ${v.name}`)).toEqual(['unsigned char x', 'unsigned char y', 'unsigned char z']);
  });

  it('init: x = 6, y = 6, LEDs off, STATUS = 0 kept as a register write', () => {
    expect(kinds(p.init)).toEqual(['assign', 'assign', 'set', 'set', 'set', 'assign']);
    expect(p.init[5]).toMatchObject({ kind: 'assign', target: { kind: 'reg', name: 'STATUS' }, value: { kind: 'num', value: 0 } });
  });

  it('loop: z = x - y then two separate if on the flags Z and C (her bug, kept as written)', () => {
    expect(kinds(p.loop)).toEqual(['set', 'set', 'set', 'assign', 'if', 'if']);
    expect(p.loop![3]).toMatchObject({ kind: 'assign', comment: 'Soustraction', value: { kind: 'bin', op: '-' } });
    const [zIf, cIf] = [p.loop![4], p.loop![5]];
    expect(zIf).toMatchObject({ kind: 'if', otherwise: null, branches: [{ cond: { kind: 'flag', flag: 'Z', value: 1 }, comment: 'Test du bit Zero, x = y' }] });
    expect(cIf).toMatchObject({
      kind: 'if',
      branches: [{ cond: { kind: 'flag', flag: 'C', value: 1 }, body: [{ kind: 'set', signal: 'led_sup', value: 1 }] }],
      otherwise: { comment: 'x < y', body: [{ kind: 'set', signal: 'led_inf', value: 1 }] },
    });
  });

  it('status_corrige.c is one if / else if / else chain on Z then C', () => {
    const q = load('status_corrige.c');
    expect(kinds(q.loop)).toEqual(['set', 'set', 'set', 'assign', 'if']);
    const chain = q.loop![4];
    if (chain.kind !== 'if') throw new Error('if attendu');
    expect(chain.branches.map((b) => b.cond)).toEqual([{ kind: 'flag', flag: 'Z', value: 1 }, { kind: 'flag', flag: 'C', value: 1 }]);
    expect(chain.otherwise).not.toBeNull();
  });
});

describe('fromAst: demux.c (prof, D1/D2 swapped)', () => {
  const p = load('demux.c');

  it('inputs L0 L1 on RA0 RA1, outputs D0..D3 on RB0..RB3, her compact writes and register echoes', () => {
    expect(p.signals.map((s) => `${s.name}:${s.pin}:${s.dir}`)).toEqual([
      'L0:RA0:in', 'L1:RA1:in', 'D0:RB0:out', 'D1:RB1:out', 'D2:RB2:out', 'D3:RB3:out',
    ]);
    expect(p.style).toMatchObject({ macros: false, compactAssign: true, echoRegister: true, sections: 'demux', tris: { A: 'bits', B: 'bits' } });
    expect(p.init.every((s) => s.kind === 'set' && s.value === 0 && s.comment === undefined)).toBe(true);
  });

  it('the loop is a 4-branch chain (3 tests + else), each branch setting all four outputs', () => {
    expect(kinds(p.loop)).toEqual(['if']);
    const chain = p.loop![0];
    if (chain.kind !== 'if') throw new Error('if attendu');
    expect(chain.lead).toBe('Décodage de L1 L0');
    expect(chain.branches.map((b) => b.cond)).toEqual([
      { kind: 'and', items: [{ kind: 'pin', signal: 'l0', value: 0 }, { kind: 'pin', signal: 'l1', value: 0 }] },
      { kind: 'and', items: [{ kind: 'pin', signal: 'l0', value: 0 }, { kind: 'pin', signal: 'l1', value: 1 }] },
      { kind: 'and', items: [{ kind: 'pin', signal: 'l0', value: 1 }, { kind: 'pin', signal: 'l1', value: 0 }] },
    ]);
    for (const body of [...chain.branches.map((b) => b.body), chain.otherwise!.body]) {
      expect(body.map((s) => (s.kind === 'set' ? s.signal : s.kind))).toEqual(['d0', 'd1', 'd2', 'd3']);
    }
    // Her swap is read as written: (L0, L1) = (0, 1) lights D1.
    expect(chain.branches[1].body.find((s) => s.kind === 'set' && s.value === 1)).toMatchObject({ signal: 'd1' });
  });
});

describe('fromAst: TP0 files (no #define)', () => {
  it('EXEMPLE1: one raw-pin output, no loop', () => {
    const p = load('EXEMPLE1.c');
    expect(p.signals).toMatchObject([{ name: 'RA0', pin: 'RA0', dir: 'out', useDefine: false }]);
    expect(p.init).toMatchObject([{ kind: 'set', signal: 'ra0', value: 1, lead: 'allumer led RA0' }]);
    expect(p.loop).toBeNull();
  });

  it('EXEMPLE2: TRISA = 0 as a whole-port write, the LED follows RB0 through if / else', () => {
    const p = load('EXEMPLE2.c');
    expect(p.style.tris).toEqual({ A: 'port', B: 'bits' });
    expect(p.signals.map((s) => `${s.pin}:${s.dir}`).sort()).toEqual(['RA0:out', 'RB0:in']);
    expect(p.loop).toMatchObject([{
      kind: 'if',
      lead: 'commander une  LED par un bouton',
      branches: [{ cond: { kind: 'pin', signal: 'rb0', value: 1 }, body: [{ kind: 'set', signal: 'ra0', value: 1 }] }],
      otherwise: { body: [{ kind: 'set', signal: 'ra0', value: 0 }] },
    }]);
  });
});

describe('fromAst: the derived TP programs', () => {
  it('traffic.c: lamps, the 7SEG bus on RB0..RB3, the day/night if and the counted loops', () => {
    const p = load('traffic.c', 8_000_000);
    expect(p.signals.map((s) => `${s.name}:${s.device}`)).toEqual(['CAPTEUR:sensor', 'ROUGE:lamp', 'ORANGE:lamp', 'VERT:lamp']);
    expect(p.buses).toMatchObject([{ name: 'AFFICHEUR', lsb: 0, width: 4, dir: 'out', device: 'bcd' }]);
    const chain = p.loop![0];
    if (chain.kind !== 'if') throw new Error('if attendu');
    expect(chain.branches[0].cond).toEqual({ kind: 'pin', signal: 'capteur', value: 0 });
    expect(chain.otherwise!.body.filter((s) => s.kind === 'repeat').map((s) => (s.kind === 'repeat' ? s.times : 0))).toEqual([10, 3, 10]);
  });

  it('vote.c: buttons, counters, the wait-for-release loops and the Z/C dépouillement', () => {
    const p = load('vote.c');
    expect(p.signals.filter((s) => s.dir === 'in').map((s) => `${s.name}:${s.device}`)).toEqual(['VOTE_A:button', 'VOTE_B:button', 'RESULTAT:button']);
    expect(kinds(p.loop)).toEqual(['if', 'if', 'if']);
    const voteA = p.loop![0];
    if (voteA.kind !== 'if') throw new Error('if attendu');
    expect(kinds(voteA.branches[0].body)).toEqual(['incr', 'set', 'delay', 'set', 'delay', 'waitFor']);
    expect(voteA.branches[0].body[5]).toMatchObject({ kind: 'waitFor', cond: { kind: 'pin', signal: 'vote_a', value: 0 } });
  });

  it('derived pupitre.c: several statements per line, whole-port TRIS, constant and input bus', () => {
    const p = load('derived/pupitre.c');
    expect(p.style.tris).toEqual({ A: 'port', B: 'port' });
    expect(p.constants).toEqual([{ name: 'REPONSE_CORRECTE', value: 0xca, radix: 16, comment: 'Q7..Q0 = 1 1 0 0 1 0 1 0' }]);
    expect(p.buses).toMatchObject([{ name: 'REPONSES', width: 8, dir: 'in' }]);
    expect(p.signals.map((s) => `${s.name}:${s.dir}`)).toEqual(['VALIDER:in', 'DEMARRER:in', 'LED_GAME_OVER:out', 'LED_NO:out', 'LED_YES:out']);
    expect(p.loop![0]).toMatchObject({ kind: 'waitFor', cond: { kind: 'pin', signal: 'demarrer', value: 1 } });
    expect(p.loop![3]).toMatchObject({ kind: 'while', cond: { kind: 'and' } });
  });

  it('derived traffic.c: the user delay_ms() is kept verbatim and its calls stay calls (not Delay_ms)', () => {
    const { program: p, notes } = fromAstDetailed(analyze(fixture('derived/traffic.c'), { clockHz: 8_000_000 }).ast!);
    expect(p.rawGlobals?.[0]).toMatch(/^void delay_ms\(unsigned int ms\) \{/);
    expect(notes.join(' ')).toContain('delay_ms');
    const night = p.loop![0];
    if (night.kind !== 'if') throw new Error('if attendu');
    const calls = night.branches[0].body.filter((s) => s.kind === 'raw').map((s) => (s.kind === 'raw' ? s.code : ''));
    expect(calls).toEqual(['delay_ms(500);', 'delay_ms(500);']);
    expect(p.loop![0]).toMatchObject({ kind: 'if' });
    const day = night.otherwise!.body.filter((s) => s.kind === 'for');
    expect(day).toHaveLength(3); // for (i = 10; i > 0; i--)
  });
});

describe('fromAst never throws', () => {
  const samples = [
    '',
    'void main() {}',
    'void main( {',
    '}}} int x = ;',
    '#define X\nvoid main() { X; }',
    'void main() { do { PORTB = 1; } while (0); switch (PORTB) { case 1: break; } return; }',
    'unsigned char t[3] = {1, 2, 3};\nsbit LED at PORTB.B0;\nvoid main() { LED = t[1]; }',
    'int f(int a) { return a + 1; }\nvoid main() { unsigned char k = 3; PORTB = f(k); k += 2; ++k; }',
    '#include <htc.h>\nint main() { TRISA0 = 0; RA0 = 1; CARRY = 0; }',
  ];
  for (const src of samples) {
    it(JSON.stringify(src.slice(0, 40)), () => {
      const r = programFromSource(src);
      expect(Array.isArray(r.diagnostics)).toBe(true);
      if (r.program) expect(r.program.version).toBe(1);
    });
  }
});

describe('fromAst: interrupt set-up', () => {
  it('reads INTEDG / INTE / RBIE / T0IE / prescaler / GIE into the model and keeps the ISR', () => {
    const { program: p } = programFromSource(`unsigned char n;
void interrupt() {
    if (INTCON.INTF == 1) { n++; INTCON.INTF = 0; }
}
void main() {
    TRISB = 0xFF;
    OPTION_REG.INTEDG = 0;
    INTCON.INTE = 1;
    INTCON.RBIE = 1;
    OPTION_REG.T0CS = 0;
    OPTION_REG.PSA = 0;
    OPTION_REG.PS2 = 1;
    OPTION_REG.PS1 = 1;
    OPTION_REG.PS0 = 1;
    INTCON.T0IE = 1;
    INTCON.GIE = 1;
    while(1);
}`);
    expect(p!.interrupts).toEqual({ gie: true, int: { edge: 'falling' }, rbChange: true, tmr0: { prescaler: 256 } });
    expect(p!.init).toEqual([]);
    expect(p!.functions).toMatchObject([{ kind: 'interrupt', name: 'interrupt', body: [{ kind: 'if', branches: [{ cond: { kind: 'flag', flag: 'INTF', value: 1 } }] }] }]);
    expect(p!.variables).toEqual([{ name: 'n', type: 'unsigned char', scope: 'global' }]);
  });

  it('keeps edge and prescaler writes as statements when their interrupt is not enabled', () => {
    const { program: p } = programFromSource('void main() {\n    OPTION_REG.INTEDG = 0;\n    OPTION_REG.PSA = 1;\n    while(1);\n}');
    expect(p!.interrupts).toBeUndefined();
    expect(p!.init).toMatchObject([
      { kind: 'assign', target: { kind: 'reg', name: 'OPTION_REG', bit: 'INTEDG' } },
      { kind: 'assign', target: { kind: 'reg', name: 'OPTION_REG', bit: 'PSA' } },
    ]);
  });
});
