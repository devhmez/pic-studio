import { describe, expect, it } from 'vitest';
import { duty, onMiniSim, readVar, runFor, runToHalt, symbolAddr } from '../support/harness';

/** Run a program to its final GOTO $ and read globals. */
function run(src: string, vars: [string, number?, boolean?][]): number[] {
  const { r, sim } = onMiniSim(src);
  runToHalt(sim);
  return vars.map(([n, size, signed]) => readVar(sim, r, n, size ?? 1, signed ?? false));
}

describe('instructions de contrôle', () => {
  it('for, while, do…while, break, continue', () => {
    const src = `unsigned char s1, s2, s3, i;
void main() {
    for (i = 0; i < 10; i++) { if (i == 3) continue; if (i == 8) break; s1 += i; }
    i = 5;
    while (i) { s2 += 2; i--; }
    do { s3++; } while (s3 < 7);
}`;
    expect(run(src, [['s1'], ['s2'], ['s3']])).toEqual([0 + 1 + 2 + 4 + 5 + 6 + 7, 10, 7]);
  });

  it('switch avec chute (fallthrough), default et break', () => {
    const src = `unsigned char k, r0, r1, r2, r3, r9;
unsigned char f(unsigned char v) {
    unsigned char r;
    r = 0;
    switch (v) {
        case 0: r = 10; break;
        case 1: r = 20;
        case 2: r += 5; break;
        case 3: return 99;
        default: r = 77;
    }
    return r;
}
void main() { r0 = f(0); r1 = f(1); r2 = f(2); r3 = f(3); r9 = f(9); }`;
    expect(run(src, [['r0'], ['r1'], ['r2'], ['r3'], ['r9']])).toEqual([10, 25, 5, 99, 77]);
  });

  it('switch : chaque case est converti dans le type promu de l’expression (C11 6.8.4.2)', () => {
    const src = `unsigned char u, r1, r2; unsigned int w; signed char s;
void main() {
    u = 5; w = 0xFFFF; s = -1;
    switch (u) { case 261: r1 = 1; break; case 5: r1 = 2; break; }          // 261 n'est jamais égal à un unsigned char
    switch (w) { case -1: r2 = 1; break; default: r2 = 2; }                 // -1 converti en unsigned int = 0xFFFF
    switch (s) { case -1: s = 10; break; case 255: s = 20; break; }
}`;
    expect(run(src, [['r1'], ['r2'], ['s', 1, true]])).toEqual([2, 1, 10]);
  });

  it('évaluation court-circuit de && et || (les effets de bord ne s’exécutent pas)', () => {
    const src = `unsigned char a, b, n1, n2, r1, r2;
void main() {
    a = 0; b = 1;
    if (a && n1++) r1 = 1;
    if (b || n2++) r2 = 1;
    if (a || n1++) r1 = 2;
}`;
    expect(run(src, [['n1'], ['n2'], ['r1'], ['r2']])).toEqual([1, 0, 0, 1]);
  });

  it('opérateur ?: et valeurs booléennes', () => {
    const src = `unsigned char a, b, m, z, nz; int s;
void main() { a = 7; b = 9; m = a > b ? a : b; z = !(a == 7); nz = (a != 0) + (b > 3); s = a < b ? -5 : 5; }`;
    expect(run(src, [['m'], ['z'], ['nz'], ['s', 2, true]])).toEqual([9, 0, 2, -5]);
  });
});

describe('types et données', () => {
  it('tableaux en RAM (index variable, éléments 16 bits) et initialisation locale', () => {
    const src = `unsigned int t[5]; unsigned int somme; unsigned char i; unsigned char loc;
void main() {
    unsigned char petit[3] = {4, 5, 6};
    for (i = 0; i < 5; i++) t[i] = 1000 * i + i;
    for (i = 0; i < 5; i++) somme += t[i];
    t[2]++;
    i = 1;
    loc = petit[i] + petit[2];
}`;
    const { r, sim } = onMiniSim(src);
    runToHalt(sim);
    expect(readVar(sim, r, 'somme', 2)).toBe(10010);
    const base = r.symbols.find((s) => s.name === 't')!.addr;
    expect(sim.peek(base + 4) | (sim.peek(base + 5) << 8)).toBe(2003);
    expect(readVar(sim, r, 'loc')).toBe(11);
  });

  it('variables bit, sbit, accès .B0/.F7 sur une variable, alias _bit', () => {
    const src = `bit f1; bit f2; sbit SORTIE at PORTB.B3;
unsigned char v; unsigned char r1; unsigned char r2;
void main() {
    TRISB = 0;
    f1 = 1; f2 = f1; f1 = 0;
    SORTIE = f2;
    v.B0 = 1; v.F7 = 1;
    if (v.B7) r1 = 1;
    if (!f1 && f2) r2 = 1;
    RB4_bit = 1;
}`;
    const { r, sim } = onMiniSim(src);
    runToHalt(sim);
    expect(readVar(sim, r, 'v')).toBe(0x81);
    expect(readVar(sim, r, 'r1')).toBe(1);
    expect(readVar(sim, r, 'r2')).toBe(1);
    expect(sim.getDrive('RB3')).toBe(1);
    expect(sim.getDrive('RB4')).toBe(1);
  });

  it('constantes, #define, static, conversions, Lo/Hi/swap', () => {
    const src = `#define BASE 1000
const unsigned char MAX = 10;
unsigned int big; unsigned char bas, haut, sw, c1, cnt; long neg; signed char sc;
void compte() { static unsigned char n = 3; n++; cnt = n; }
void main() {
    big = BASE * 3 + MAX;
    bas = Lo(big); haut = Hi(big);
    sw = swap(0x3C);
    sc = -100;
    neg = sc;              // sign extension
    c1 = (unsigned char)(big >> 4);
    compte(); compte();
}`;
    expect(run(src, [['big', 2], ['bas'], ['haut'], ['sw'], ['neg', 4, true], ['c1'], ['cnt']])).toEqual([
      3010, 3010 & 0xff, 3010 >> 8, 0xc3, -100, (3010 >> 4) & 0xff, 5,
    ]);
  });

  it('pas de promotion : unsigned char + unsigned char reste sur 8 bits (comme MikroC)', () => {
    const src = 'unsigned char a, b; unsigned int r8, r16;\nvoid main() { a = 200; b = 100; r8 = a + b; r16 = (unsigned int)a + b; }';
    expect(run(src, [['r8', 2], ['r16', 2]])).toEqual([44, 300]);
  });

  it('opérateurs composés et décalages variables', () => {
    const src = `unsigned int x; unsigned char n; unsigned char y;
void main() { x = 3; n = 4; x <<= n; x |= 1; x ^= 0x100; x >>= 1; y = 0xF0; y &= ~0x10; y %= 7; }`;
    expect(run(src, [['x', 2], ['y']])).toEqual([((((3 << 4) | 1) ^ 0x100) >> 1), (0xe0 % 7)]);
  });

  it('x /= e et x %= e calculent dans le type de x / e, comme x = x / e', () => {
    const src = `signed char s1, s2; unsigned char t[3], i, u; int w; unsigned int big;
void main() {
    s1 = -100; s1 /= 200;          // -100 / 200 = 0 (200 ne tient pas dans un signed char)
    s2 = -100; s2 %= 300;          // -100
    w = 300; i = 1;
    t[i] = 250; t[i] /= w;         // élément de tableau (FSR) : 0
    u = 7; u %= w;                 // 7
    big = 60000; big /= 70000;     // 0 (70000 est un long)
}`;
    expect(run(src, [['s1', 1, true], ['s2', 1, true], ['t'], ['u'], ['big', 2]])).toEqual([0, -100, 0, 7, 0]);
  });

  it('Lo/Hi/Higher/Highest en destination (built_in.h) : =, +=, ++ et élément de tableau', () => {
    const src = `#include "built_in.h"
unsigned int w, arr[3]; unsigned long l; unsigned char i;
void main() {
    Hi(w) = 0x12; Lo(w) = 0x34;
    Lo(w) += 1; Hi(w)++;
    Highest(l) = 0xAB; Higher(l) = 0xCD; Hi(l) = 0xEF; Lo(l) = 0x01;
    i = 2; Hi(arr[i]) = 0x56; Lo(arr[i]) = 0x78;
}`;
    const { r, sim } = onMiniSim(src);
    runToHalt(sim);
    expect(readVar(sim, r, 'w', 2)).toBe(0x1335);
    expect(readVar(sim, r, 'l', 4)).toBe(0xabcdef01);
    expect(sim.peek(symbolAddr(r, 'arr') + 4) | (sim.peek(symbolAddr(r, 'arr') + 5) << 8)).toBe(0x5678);
  });

  it('sizeof sur un type, une variable, un tableau et un élément (opérande non évalué)', () => {
    const src = `const unsigned char SEG[10] = {0x3F,0x06,0x5B,0x4F,0x66,0x6D,0x7D,0x07,0x7F,0x6F};
unsigned int t[3]; long l; unsigned char a, b, c, d, e, n;
void main() {
    a = sizeof(int); b = sizeof l; c = sizeof(t); d = sizeof(SEG) / sizeof(SEG[0]);
    e = sizeof(n++);               // n n'est pas incrémenté
}`;
    expect(run(src, [['a'], ['b'], ['c'], ['d'], ['e'], ['n']])).toEqual([2, 4, 6, 10, 1, 0]);
  });
});

describe('fonctions et pile', () => {
  it('chaîne d’appels profonde et retours 32 bits', () => {
    const src = `unsigned long r;
unsigned long f3(unsigned long v) { return v + 1; }
unsigned long f2(unsigned long v) { return f3(v) * 2; }
unsigned long f1(unsigned long v) { return f2(v) + f2(v + 1); }
void main() { r = f1(100000); }`;
    const { r, sim } = onMiniSim(src);
    runToHalt(sim);
    expect(readVar(sim, r, 'r', 4)).toBe((100001 * 2) + (100002 * 2));
    expect(r.stackDepth).toBeGreaterThanOrEqual(3);
  });

  it('les cadres des fonctions sœurs partagent la RAM (allocation statique superposée)', () => {
    const src = `unsigned char g;
unsigned char a(unsigned char x) { unsigned char t[10]; t[9] = x; return t[9]; }
unsigned char b(unsigned char x) { unsigned char u[10]; u[9] = x + 1; return u[9]; }
void main() { g = a(1) + b(2); }`;
    const { r, sim } = onMiniSim(src);
    runToHalt(sim);
    expect(readVar(sim, r, 'g')).toBe(4);
    const ta = r.symbols.find((s) => s.name === 't')!;
    const ub = r.symbols.find((s) => s.name === 'u')!;
    expect(ta.addr).toBe(ub.addr);
  });
});

describe('entrées/sorties', () => {
  it('lecture de PORTA et écriture de PORTB entier', () => {
    const src = 'void main() {\n    TRISA = 0xFF;\n    TRISB = 0x00;\n    while(1) {\n        PORTB = PORTA + 1;\n    }\n}';
    const { sim } = onMiniSim(src);
    sim.setInput('RA0', 1);
    sim.setInput('RA2', 1);
    runFor(sim, 200);
    expect(['RB0', 'RB1', 'RB2', 'RB3'].map((p) => sim.getDrive(p as 'RB0'))).toEqual([0, 1, 1, 0]);
  });

  it('RA4 en drain ouvert : écrire 1 libère la broche', () => {
    const { sim } = onMiniSim('void main() { TRISA = 0; PORTA.F4 = 1; PORTA.F3 = 1; }');
    runToHalt(sim);
    expect(sim.getDrive('RA4')).toBe('Z');
    expect(sim.getDrive('RA3')).toBe(1);
  });

  it('boucle infinie de vote : LED de confirmation qui clignote (duty 50 %)', () => {
    const src = '#define LED_VOTE PORTA.RA2\nvoid main() {\n    TRISA = 0x0B;\n    while(1) {\n        LED_VOTE = 1; Delay_ms(5);\n        LED_VOTE = 0; Delay_ms(5);\n    }\n}';
    const { sim } = onMiniSim(src);
    runFor(sim, 3000);
    const d = duty(sim, 'RA2', 25_000);
    expect(d).toBeGreaterThan(0.45);
    expect(d).toBeLessThan(0.55);
  });
});
