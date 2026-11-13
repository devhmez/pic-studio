import { describe, expect, it } from 'vitest';
import { onMiniSim, readVar, runToHalt, writeVar } from '../support/harness';

// Differential test: random nested expressions over mixed integer types, compiled and executed, compared with an
// independent model of MikroC's typing (wider operand wins, equal widths are signed only if both are, no int
// promotion) and C operator semantics.

interface T { size: 1 | 2; signed: boolean }
const VARS: { name: string; c: string; t: T }[] = [
  { name: 'a', c: 'unsigned char', t: { size: 1, signed: false } },
  { name: 'b', c: 'unsigned char', t: { size: 1, signed: false } },
  { name: 'c', c: 'signed char', t: { size: 1, signed: true } },
  { name: 'd', c: 'signed char', t: { size: 1, signed: true } },
  { name: 'e', c: 'unsigned int', t: { size: 2, signed: false } },
  { name: 'f', c: 'unsigned int', t: { size: 2, signed: false } },
  { name: 'g', c: 'int', t: { size: 2, signed: true } },
  { name: 'h', c: 'int', t: { size: 2, signed: true } },
];

const wrap = (v: bigint, t: T) => (t.signed ? BigInt.asIntN(t.size * 8, v) : BigInt.asUintN(t.size * 8, v));
const unify = (x: T, y: T): T => (x.size !== y.size ? (x.size > y.size ? x : y) : { size: x.size, signed: x.signed && y.signed });
const U8: T = { size: 1, signed: false };

interface Node { code: string; t: T; eval: (env: Map<string, bigint>) => bigint }

class Gen {
  private seed: number;
  constructor(seed: number) {
    this.seed = seed;
  }
  rnd(n: number): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed % n;
  }

  expr(depth: number): Node {
    if (depth <= 0 || this.rnd(5) === 0) {
      const v = VARS[this.rnd(VARS.length)];
      return { code: v.name, t: v.t, eval: (env) => env.get(v.name)! };
    }
    const k = this.rnd(12);
    if (k < 6) {
      const ops = ['+', '-', '*', '&', '|', '^', '/', '%'] as const;
      const op = ops[this.rnd(ops.length)];
      const l = this.expr(depth - 1);
      const r = this.expr(depth - 1);
      const t = unify(l.t, r.t);
      if (op === '/' || op === '%') {
        // Divisor made non-zero with `| 1` (same type as r).
        return {
          code: `(${l.code} ${op} (${r.code} | 1))`,
          t,
          eval: (env) => {
            const A = wrap(l.eval(env), t);
            const B = wrap(wrap(r.eval(env) | 1n, r.t), t);
            return wrap(op === '/' ? A / B : A % B, t);
          },
        };
      }
      const f: Record<string, (a: bigint, b: bigint) => bigint> = {
        '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '&': (a, b) => a & b, '|': (a, b) => a | b, '^': (a, b) => a ^ b,
      };
      return { code: `(${l.code} ${op} ${r.code})`, t, eval: (env) => wrap(f[op](wrap(l.eval(env), t), wrap(r.eval(env), t)), t) };
    }
    if (k === 6) {
      const ops = ['<', '>', '<=', '>=', '==', '!='] as const;
      const op = ops[this.rnd(ops.length)];
      const l = this.expr(depth - 1);
      const r = this.expr(depth - 1);
      const t = unify(l.t, r.t);
      const f: Record<string, (a: bigint, b: bigint) => boolean> = {
        '<': (a, b) => a < b, '>': (a, b) => a > b, '<=': (a, b) => a <= b, '>=': (a, b) => a >= b, '==': (a, b) => a === b, '!=': (a, b) => a !== b,
      };
      return { code: `(${l.code} ${op} ${r.code})`, t: U8, eval: (env) => (f[op](wrap(l.eval(env), t), wrap(r.eval(env), t)) ? 1n : 0n) };
    }
    if (k === 7) {
      const s = this.rnd(9);
      const op = this.rnd(2) ? '<<' : '>>';
      const l = this.expr(depth - 1);
      return {
        code: `(${l.code} ${op} ${s})`,
        t: l.t,
        eval: (env) => wrap(op === '<<' ? wrap(l.eval(env), l.t) << BigInt(s) : wrap(l.eval(env), l.t) >> BigInt(s), l.t),
      };
    }
    if (k === 8) {
      const u = ['-', '~', '!'][this.rnd(3)];
      const x = this.expr(depth - 1);
      if (u === '!') return { code: `(!${x.code})`, t: U8, eval: (env) => (wrap(x.eval(env), x.t) === 0n ? 1n : 0n) };
      return { code: `(${u}${x.code})`, t: x.t, eval: (env) => wrap(u === '-' ? -x.eval(env) : ~x.eval(env), x.t) };
    }
    if (k === 9) {
      const c = this.expr(depth - 1);
      const x = this.expr(depth - 1);
      const y = this.expr(depth - 1);
      const t = unify(x.t, y.t);
      return { code: `(${c.code} ? ${x.code} : ${y.code})`, t, eval: (env) => wrap(wrap(c.eval(env), c.t) !== 0n ? x.eval(env) : y.eval(env), t) };
    }
    if (k === 10) {
      const l = this.expr(depth - 1);
      const r = this.expr(depth - 1);
      const and = this.rnd(2) === 0;
      return {
        code: `(${l.code} ${and ? '&&' : '||'} ${r.code})`,
        t: U8,
        eval: (env) => {
          const a = wrap(l.eval(env), l.t) !== 0n;
          const b = wrap(r.eval(env), r.t) !== 0n;
          return (and ? a && b : a || b) ? 1n : 0n;
        },
      };
    }
    const casts: [string, T][] = [['unsigned char', U8], ['signed char', { size: 1, signed: true }], ['unsigned int', { size: 2, signed: false }], ['int', { size: 2, signed: true }]];
    const [cn, ct] = casts[this.rnd(casts.length)];
    const x = this.expr(depth - 1);
    return { code: `((${cn})${x.code})`, t: ct, eval: (env) => wrap(x.eval(env), ct) };
  }
}

describe('test différentiel d’expressions aléatoires (types mélangés)', () => {
  for (let p = 0; p < 40; p++) {
    it(`programme ${p}`, () => {
      const gen = new Gen(1000 + p * 7919);
      const exprs = [0, 1, 2].map(() => gen.expr(3));
      const src = [
        VARS.map((v) => `${v.c} ${v.name};`).join(' '),
        'long r0; long r1; long r2;',
        'void main() {',
        ...exprs.map((e, i) => `    r${i} = ${e.code};`),
        '}',
      ].join('\n');
      const { r, sim } = onMiniSim(src);
      for (let trial = 0; trial < 6; trial++) {
        sim.reset();
        const env = new Map<string, bigint>();
        for (const v of VARS) {
          const raw = BigInt(gen.rnd(1 << 16)) - (trial % 2 ? 0n : 1n << 15n);
          const val = wrap(trial === 5 ? 0n : raw, v.t);
          env.set(v.name, val);
          writeVar(sim, r, v.name, Number(val), v.t.size);
        }
        runToHalt(sim);
        exprs.forEach((e, i) => {
          if (!r.symbols.some((s) => s.name === `r${i}`)) return;
          const expected = Number(BigInt.asIntN(32, wrap(e.eval(env), e.t)));
          expect(readVar(sim, r, `r${i}`, 4, true), `${e.code} avec ${[...env].map(([k, v]) => `${k}=${v}`).join(' ')}`).toBe(expected);
        });
      }
    });
  }
});
