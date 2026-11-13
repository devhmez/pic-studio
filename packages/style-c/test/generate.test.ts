/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compile, decodeSource } from '@pic/compiler';
import { blocks as b, cloneProgram, emptyProgram, ensureIds, type Program, type Signal } from '@pic/program-model';
import { generate, generateWithMap, toMikroCFile, trisValue } from '../src';
import { TEMPLATE_PROGRAMS, tp1Demux, tpStatus, tpVote } from './template-programs';

const fixture = (name: string) =>
  decodeSource(readFileSync(new URL(`../../compiler/test/fixtures/${name}`, import.meta.url))).replace(/\r\n/g, '\n');

const led = (name: string, pin: Signal['pin'], extra: Partial<Signal> = {}): Signal =>
  ({ id: name.toLowerCase(), name, pin, dir: 'out', label: `Led ${name}`, activeLevel: 1, device: 'led', ...extra });
const input = (name: string, pin: Signal['pin'], extra: Partial<Signal> = {}): Signal =>
  ({ id: name.toLowerCase(), name, pin, dir: 'in', label: `Entrée ${name}`, activeLevel: 1, device: 'logicstate', ...extra });

function make(p: Partial<Program>): Program {
  return ensureIds({ ...emptyProgram('Essai'), ...p });
}

function compileClean(source: string, clockHz = 1_000_000) {
  const r = compile(source, { clockHz });
  expect(r.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.line}: ${d.message}`)).toEqual([]);
  return r;
}

describe('generate(): the prof’s formatting', () => {
  it('TP demux is byte for byte the corrected demux.c (her layout, D0=0; //PORTB.RB0=0; echoes)', () => {
    expect(generate(tp1Demux())).toBe(fixture('demux_corrige.c').replace(/\n*$/, '\n'));
  });

  it('TP status: status.c layout with her section comments, macros, packed lines, STATUS=0 and one-line else-if chain', () => {
    // As status.c: `x = 5; y = 6;` and the three LED_OFF on one line each, `STATUS=0;` closing the initialisation,
    // and one comment column for `z = x - y;` and the chain (her 3–4-space gap after the longest line).
    expect(generate(tpStatus())).toBe(`// Définition des sorties
#define LED_SUP  PORTB.F0
#define LED_EGAL PORTB.F1
#define LED_INF  PORTB.F2

// Macros pour commander les sorties
#define LED_ON(pin)  (pin = 1)
#define LED_OFF(pin) (pin = 0)

void main() {
    unsigned char x; unsigned char y; unsigned char z;

    // Configuration  i/o
    TRISB = 0x00;       // PORTB en sortie

    // Initialisation
    x = 5; y = 6;
    LED_OFF(LED_SUP); LED_OFF(LED_EGAL); LED_OFF(LED_INF);
    STATUS=0;

    // Traitement
    while(1) {
        LED_OFF(LED_SUP); LED_OFF(LED_EGAL); LED_OFF(LED_INF);
        z = x - y;                                       // Soustraction
        if (STATUS.F2 == 1) { LED_ON(LED_EGAL); }        // Test du bit Zero, x = y
        else if (STATUS.F0 == 1) { LED_ON(LED_SUP); }    // Test du Carry, x > y
        else { LED_ON(LED_INF); }                        // x < y
    }
}
`);
  });

  it('TP status keeps her status.c line for line, except x = 5 (her organigramme) and the corrected else if', () => {
    // Ignore what is only layout: blank lines, the #define section titles, the width of the comment gaps.
    const shape = (c: string) => c.split('\n')
      .filter((l) => l.trim() !== '' && !/^\/\/ (Définition|Macros)/.test(l))
      .map((l) => l.replace(/ +\/\//, '  //'));
    const ours = shape(generate(tpStatus()));
    const hers = shape(fixture('status.c'));
    expect(ours.length).toBe(hers.length);
    const differ = ours.map((l, i) => [hers[i], l]).filter(([h, o]) => h !== o);
    expect(differ).toEqual([
      ['    x = 6; y = 6;', '    x = 5; y = 6;'],
      ['        if (STATUS.F0 == 1) { LED_ON(LED_SUP); }  // Test du Carry, x > y', '        else if (STATUS.F0 == 1) { LED_ON(LED_SUP); }  // Test du Carry, x > y'],
    ]);
  });

  it('follows her rules in every template: // comments only, 4-space indentation, no } else, no typos', () => {
    for (const t of TEMPLATE_PROGRAMS) {
      const c = generate(t.build());
      expect(c, t.id).not.toContain('/*');
      expect(c, t.id).not.toContain('\t');
      expect(c, t.id).not.toMatch(/\}[ \t]*else/);
      expect(c, t.id).not.toMatch(/pricipal|superieur|inferieur/);
      expect(c, t.id).not.toMatch(/[ \t]+\n/);
      for (const line of c.split('\n')) {
        const indent = line.length - line.trimStart().length;
        expect(indent % 4, `${t.id}: « ${line} »`).toBe(0);
      }
      expect(c.match(/\{/g)?.length, t.id).toBe(c.match(/\}/g)?.length);
    }
  });

  it('config comments use her fixed 7-space gap; chain comments share a column', () => {
    const c = generate(tpVote());
    expect(c).toContain('    TRISA.RA0 = 1;       // RA0 : entrée VOTE_A\n');
    expect(c).toContain('    TRISB = 0x00;       // PORTB en sortie\n');
    expect(c).toContain('            if (STATUS.F2 == 1) {            // Test du bit Zero, var1 = var2\n');
    expect(c).toContain('            else if (STATUS.F0 == 1) {       // Test du Carry, var1 > var2\n');
    expect(c).toContain('            else {                           // var1 < var2\n');
  });
});

describe('generate(): style options', () => {
  const base = () => make({
    signals: [input('BP', 'RA0'), led('LED', 'RB3')],
    init: [b.off('led')],
    loop: [b.when(b.pin('bp', 1), [b.on('led')], [b.off('led')])],
  });

  it('index notation (PORTB.F3) and whole-port TRIS', () => {
    const p = base();
    p.style.bitNotation = 'index';
    p.style.tris = { A: 'port', B: 'port' };
    const c = generate(p);
    expect(c).toContain('#define LED PORTB.F3');
    expect(c).toContain('    TRISA = 0x1F;       // PORTA en entrée\n');
    expect(c).toContain('    TRISB = 0x00;       // PORTB en sortie\n');
    compileClean(c);
  });

  it('a whole-port TRIS on a mixed port lists its inputs; unused bits are outputs', () => {
    const p = make({ signals: [input('A', 'RA0'), led('B', 'RA2'), input('C', 'RA4')], loop: [] });
    p.style.tris.A = 'port';
    expect(trisValue(p, 'A')).toBe(0x11);
    expect(generate(p)).toContain('    TRISA = 0x11;       // RA0, RA4 en entrée, les autres en sortie\n');
  });

  it('without macros, compact writes and echoes are her demux.c habits', () => {
    const p = base();
    p.style.macros = false;
    p.style.compactAssign = true;
    p.style.echoRegister = true;
    const c = generate(p);
    expect(c).toContain('    LED=0; //PORTB.RB3=0;\n');
    expect(c).toContain('            LED=1;\n');
    expect(c).not.toContain('#define LED_ON');
    compileClean(c);
  });

  it('LED_ON / LED_OFF only for active-high LEDs and lamps', () => {
    const p = make({
      signals: [led('LED', 'RB0'), led('LEDN', 'RB1', { activeLevel: 0 }), { ...led('OUT', 'RB2'), device: 'output' }],
      init: [b.on('led'), b.on('ledn'), b.on('out')],
      loop: null,
    });
    const c = generate(p);
    expect(c).toContain('LED_ON(LED);');
    expect(c).toContain('LEDN = 1;');
    expect(c).toContain('OUT = 1;');
  });

  it('one-line chains fall back to blocks when a branch has several statements or comments', () => {
    const p = base();
    p.style.oneLineBranches = true;
    expect(generate(p)).toContain('        if (BP == 1) { LED_ON(LED); }\n        else { LED_OFF(LED); }\n');
    const q = cloneProgram(p);
    const chain = q.loop![0];
    if (chain.kind !== 'if') throw new Error();
    chain.branches[0].body.push(b.delay(10));
    expect(generate(ensureIds(q))).toContain('        if (BP == 1) {\n            LED_ON(LED);\n            Delay_ms(10);\n        }\n');
  });

  it('signals without #define use the register bit; loop-less programs end main()', () => {
    const p = make({ signals: [led('RA1', 'RA1', { useDefine: false })], init: [b.on('ra1')], loop: null });
    const c = generate(p);
    expect(c).not.toContain('#define RA1');
    expect(c).toContain('    TRISA.RA1 = 0;       // RA1 : sortie\n');
    expect(c).toMatch(/LED_ON\(PORTA\.RA1\);\n\}\n$/);
    compileClean(c);
  });
});

describe('generate(): every statement kind compiles', () => {
  const sink = (): Program => make({
    title: 'Toutes les instructions',
    signals: [input('BP', 'RB0', { device: 'button' }), led('L1', 'RB1'), led('L2', 'RB2'), input('CAP', 'RA3', { device: 'sensor' })],
    buses: [{ id: 'aff', name: 'AFF', port: 'B', lsb: 4, width: 4, dir: 'out', label: 'Sorties AFF' }],
    constants: [{ name: 'MAX', value: 10, comment: 'nombre maximal' }],
    variables: [{ name: 'n', type: 'unsigned char' }, { name: 'k', type: 'unsigned char' }, { name: 't', type: 'unsigned int', comment: 'compteur 16 bits' }],
    interrupts: { int: { edge: 'falling' }, tmr0: { prescaler: 64 }, gie: true },
    functions: [
      b.fn('clignoter', [b.on('l2'), b.delay(100), b.off('l2')], 'function', 'Fait clignoter L2 une fois'),
      b.interrupt([
        b.when(b.flag('INTF'), [b.incr('n'), b.clearFlag('INTF')]),
        b.when(b.flag('T0IF'), [b.toggle('l1'), b.clearFlag('T0IF')]),
      ]),
    ],
    init: [b.setAll(['l1', 'l2'], 0, { comment: 'tout éteindre' }), b.assign(b.v('n'), 0), b.display('aff', 0x05)],
    loop: [
      b.comment('Programme principal'),
      b.waitFor(b.or(b.pin('bp', 1), b.not(b.pin('cap', 0))), { comment: 'attente' }),
      b.whileLoop(b.cmp(b.v('n'), '<', b.v('MAX')), [b.incr('n')]),
      b.repeat(3, 'k', [b.call('clignoter')]),
      b.forLoop(b.assign(b.v('k'), 10), b.cmp(b.v('k'), '>', b.num(0)), b.decr('k'), [
        b.display('aff', b.op('&', b.sub(b.v('k'), b.num(1)), b.hex(0x0f))),
      ]),
      b.assign(b.v('t'), b.op('+', b.v('t'), b.num(1000))),
      b.assign(b.sig('l1'), b.sig('bp')),
      b.ifChain([b.branch(b.and(b.flag('C', 0), b.or(b.flag('Z', 1), b.rawCond('n > 3'))), [b.decr('n')])]),
      b.raw('switch (n) {\n    case 1: n = 2; break;\n    default: break;\n}', { comment: 'brut' }),
      b.delay(250, { lead: 'Pause' }),
      { ...b.delay(40), unit: 'us' },
    ],
  });

  it('compiles without error and with the expected interrupt set-up', () => {
    const p = sink();
    const c = generate(p);
    expect(c).toContain('    OPTION_REG.INTEDG = 0;       // Front descendant sur RB0/INT\n');
    expect(c).toContain('    OPTION_REG.PSA = 0;       // Prédiviseur 1:64 affecté à TMR0\n    OPTION_REG.PS2 = 1;\n    OPTION_REG.PS1 = 0;\n    OPTION_REG.PS0 = 1;\n');
    expect(c).toContain('// Variables globales\nunsigned char n;\n');
    expect(c).toContain('    unsigned char k;\n    unsigned int t;       // compteur 16 bits\n');
    expect(c).toContain('        while (BP == 0 && CAP == 0);       // attente\n');
    expect(c).toContain('        for (k = 10; k > 0; k--) {\n            AFF = (k - 1) & 0x0F;\n');
    expect(c).toContain('        if (STATUS.F0 == 0 && (STATUS.F2 == 1 || n > 3)) {\n');
    expect(c).toContain('        switch (n) {       // brut\n            case 1: n = 2; break;\n            default: break;\n        }\n');
    expect(c).toContain('        Delay_us(40);\n');
    compileClean(c);
  });

  it('maps every statement id to the lines it produced', () => {
    const p = tpStatus();
    const { source, map } = generateWithMap(p);
    const lines = source.split('\n');
    const at = (id: string) => lines.slice(map[id].line - 1, map[id].endLine);
    const z = p.loop![3];
    expect(at(z.id)).toEqual([`        z = x - y;${' '.repeat(39)}// Soustraction`]);
    const chain = p.loop![4];
    expect(at(chain.id)).toHaveLength(3);
    if (chain.kind !== 'if') throw new Error();
    expect(at(chain.branches[1].id)[0]).toContain('else if (STATUS.F0 == 1)');
    const s = generateWithMap(tpVote());
    const vote = tpVote();
    const first = vote.loop![0];
    expect(s.source.split('\n')[s.map[first.id].line - 1]).toBe('        if (VOTE_A == 1) {');
  });
});

describe('toMikroCFile', () => {
  it('writes Windows-1252 with CRLF line ends, like the prof’s files', () => {
    const c = generate(tp1Demux());
    const bytes = toMikroCFile(c);
    expect(bytes[4]).toBe(0xe9); // '// Définition' → é
    const text = String.fromCharCode(...bytes);
    expect(text.split('\r\n').length).toBe(c.split('\n').length);
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
    expect(decodeSource(bytes).replace(/\r\n/g, '\n')).toBe(c);
    expect(compile(bytes).ok).toBe(true);
  });
});
