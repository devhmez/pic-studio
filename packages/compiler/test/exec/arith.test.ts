import { describe, expect, it } from 'vitest';
import { onMiniSim, readVar, runToHalt, writeVar } from '../support/harness';

// Execution tests on the reference simulator: every integer operator, for every MikroC integer type,
// compared with exact C semantics evaluated in the operand type (MikroC: no promotion to int).
// Each group is a separate program so that 32-bit cases fit in the 68 bytes of RAM.

interface TypeCase {
  c: string;
  size: 1 | 2 | 4;
  signed: boolean;
}

const TYPES: TypeCase[] = [
  { c: 'unsigned char', size: 1, signed: false },
  { c: 'signed char', size: 1, signed: true },
  { c: 'unsigned int', size: 2, signed: false },
  { c: 'int', size: 2, signed: true },
  { c: 'unsigned long', size: 4, signed: false },
  { c: 'long', size: 4, signed: true },
];

const wrapTo = (v: bigint, t: TypeCase): number =>
  Number(t.signed ? BigInt.asIntN(t.size * 8, v) : BigInt.asUintN(t.size * 8, v));

type Check = (get: (name: string, size?: number, signed?: boolean) => number, A: bigint, B: bigint, n: number) => void;

interface Group {
  name: string;
  decls: (t: TypeCase) => string;
  body: string;
  check: (t: TypeCase) => Check;
}

const GROUPS: Group[] = [
  {
    name: '+ - & | ^',
    decls: (t) => `${t.c} r_add; ${t.c} r_sub; ${t.c} r_and; ${t.c} r_or; ${t.c} r_xor;`,
    body: 'r_add = a + b; r_sub = a - b; r_and = a & b; r_or = a | b; r_xor = a ^ b;',
    check: (t) => (get, A, B) => {
      expect(get('r_add'), '+').toBe(wrapTo(A + B, t));
      expect(get('r_sub'), '-').toBe(wrapTo(A - B, t));
      expect(get('r_and'), '&').toBe(wrapTo(A & B, t));
      expect(get('r_or'), '|').toBe(wrapTo(A | B, t));
      expect(get('r_xor'), '^').toBe(wrapTo(A ^ B, t));
    },
  },
  {
    name: '*',
    decls: (t) => `${t.c} r_mul; ${t.c} r_cmul;`,
    body: 'r_mul = a * b; r_cmul = a; r_cmul *= b;',
    check: (t) => (get, A, B) => {
      expect(get('r_mul'), '*').toBe(wrapTo(A * B, t));
      expect(get('r_cmul'), '*=').toBe(wrapTo(A * B, t));
    },
  },
  {
    name: '/ %',
    decls: (t) => `${t.c} r_div; ${t.c} r_mod;`,
    body: 'if (b != 0) { r_div = a / b; r_mod = a % b; }',
    check: (t) => (get, A, B) => {
      if (B === 0n) return;
      expect(get('r_div'), '/').toBe(wrapTo(A / B, t));
      expect(get('r_mod'), '%').toBe(wrapTo(A % B, t));
    },
  },
  {
    name: 'comparaisons',
    decls: () => ['lt', 'gt', 'le', 'ge', 'eq', 'ne'].map((k) => `unsigned char c_${k}; unsigned char j_${k};`).join(' '),
    body: [
      ['lt', '<'], ['gt', '>'], ['le', '<='], ['ge', '>='], ['eq', '=='], ['ne', '!='],
    ].map(([k, op]) => `c_${k} = (a ${op} b); if (a ${op} b) j_${k} = 1; else j_${k} = 2;`).join(' '),
    check: () => (get, A, B) => {
      const cmp: Record<string, boolean> = { lt: A < B, gt: A > B, le: A <= B, ge: A >= B, eq: A === B, ne: A !== B };
      for (const [k, v] of Object.entries(cmp)) {
        expect(get(`c_${k}`, 1, false), `c_${k}`).toBe(v ? 1 : 0);
        expect(get(`j_${k}`, 1, false), `j_${k}`).toBe(v ? 1 : 2);
      }
    },
  },
  {
    name: 'unaires et décalages',
    decls: (t) => `${t.c} r_neg; ${t.c} r_not; unsigned char r_lnot; ${t.c} r_shl3; ${t.c} r_shr3; ${t.c} r_shln; ${t.c} r_shrn;`,
    body: 'r_neg = -a; r_not = ~a; r_lnot = !a; r_shl3 = a << 3; r_shr3 = a >> 3; r_shln = a << n; r_shrn = a >> n;',
    check: (t) => (get, A, _B, n) => {
      expect(get('r_neg'), '-a').toBe(wrapTo(-A, t));
      expect(get('r_not'), '~a').toBe(wrapTo(~A, t));
      expect(get('r_lnot', 1, false), '!a').toBe(A === 0n ? 1 : 0);
      expect(get('r_shl3'), '<<3').toBe(wrapTo(A << 3n, t));
      expect(get('r_shr3'), '>>3').toBe(wrapTo(A >> 3n, t));
      expect(get('r_shln'), '<<n').toBe(wrapTo(A << BigInt(n), t));
      expect(get('r_shrn'), '>>n').toBe(wrapTo(A >> BigInt(n), t));
    },
  },
  {
    name: '++ -- += -=',
    decls: (t) => `${t.c} r_inc; ${t.c} r_dec; ${t.c} r_cadd; ${t.c} r_csub; ${t.c} r_post;`,
    body: 'r_inc = a; r_inc++; r_dec = a; --r_dec; r_cadd = a; r_cadd += b; r_csub = a; r_csub -= b; r_post = r_inc--;',
    check: (t) => (get, A, B) => {
      expect(get('r_inc'), '++').toBe(wrapTo(A, t));
      expect(get('r_post'), 'post++').toBe(wrapTo(A + 1n, t));
      expect(get('r_dec'), '--').toBe(wrapTo(A - 1n, t));
      expect(get('r_cadd'), '+=').toBe(wrapTo(A + B, t));
      expect(get('r_csub'), '-=').toBe(wrapTo(A - B, t));
    },
  },
];

function samples(t: TypeCase): [bigint, bigint][] {
  const bits = BigInt(t.size * 8);
  const min = t.signed ? -(1n << (bits - 1n)) : 0n;
  const max = t.signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
  const pick = [0n, 1n, 2n, 3n, 5n, 6n, 7n, 10n, 100n, 127n, 128n, 200n, 255n, 256n, 1000n, 32767n, 40000n, 65535n, 70000n, 0x12345678n, -1n, -2n, -7n, -128n, -1000n, -32768n, min, max];
  const vals = [...new Set(pick.filter((v) => v >= min && v <= max))];
  let seed = 12345 + t.size * 7 + (t.signed ? 1 : 0);
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  const base: [bigint, bigint][] = [[6n, 6n], [5n, 6n], [6n, 5n], [10n, 3n], [3n, 10n], [200n, 100n], [min, -1n], [max, 1n]];
  const out = base.filter(([a, b]) => a >= min && a <= max && b >= min && b <= max);
  for (let i = 0; i < 12; i++) out.push([vals[rnd() % vals.length], vals[rnd() % vals.length]]);
  return out;
}

for (const t of TYPES) {
  describe(`opérateurs sur ${t.c}`, () => {
    for (const g of GROUPS) {
      const src = `${t.c} a; ${t.c} b; unsigned char n; ${g.decls(t)}\nvoid main() {\n  ${g.body}\n}\n`;
      it(g.name, () => {
        const { r, sim } = onMiniSim(src);
        const check = g.check(t);
        for (const [a, b] of samples(t)) {
          sim.reset();
          const n = Number((a < 0n ? -a : a) % BigInt(t.size * 8));
          writeVar(sim, r, 'a', Number(a), t.size);
          writeVar(sim, r, 'b', Number(b), t.size);
          writeVar(sim, r, 'n', n, 1);
          runToHalt(sim);
          const get = (name: string, size: number = t.size, signed: boolean = t.signed) => readVar(sim, r, name, size, signed);
          try {
            check(get, BigInt(wrapTo(a, t)), BigInt(wrapTo(b, t)), n);
          } catch (e) {
            throw new Error(`a = ${a}, b = ${b}, n = ${n} : ${(e as Error).message}`);
          }
        }
      });
    }
  });
}
