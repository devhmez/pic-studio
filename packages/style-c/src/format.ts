// C text of expressions, conditions and pin/register references, in the prof's MikroC dialect.
import {
  busById, hexLiteral, pinBit, pinPort, signalById,
  type CodeStyle, type Cond, type Expr, type FlagName, type PinName, type Program, type Signal,
} from '@pic/program-model';

/** `PORTA.RA0` (pin notation, demux.c) or `PORTA.F0` (index notation, status.c). */
export function portBit(pin: PinName, style: CodeStyle): string {
  return `PORT${pinPort(pin)}.${style.bitNotation === 'pin' ? pin : `F${pinBit(pin)}`}`;
}

/** `TRISA.RA0` (her habit: TRIS bits addressed with the PORT pin names) or `TRISA.F0`. */
export function trisBit(pin: PinName, style: CodeStyle): string {
  return `TRIS${pinPort(pin)}.${style.bitNotation === 'pin' ? pin : `F${pinBit(pin)}`}`;
}

/** What the code writes for a signal: its `#define` alias, or the register bit. */
export function signalRef(s: Signal, style: CodeStyle): string {
  return s.useDefine === false ? portBit(s.pin, style) : s.name;
}

/** STATUS flags always use index notation (status.c: `STATUS.F2`, `STATUS.F0`); interrupt flags their names. */
export const FLAG_C: Readonly<Record<FlagName, string>> = {
  Z: 'STATUS.F2',
  C: 'STATUS.F0',
  DC: 'STATUS.F1',
  INTF: 'INTCON.INTF',
  RBIF: 'INTCON.RBIF',
  T0IF: 'INTCON.T0IF',
};

export function numberLiteral(value: number, radix: number | undefined): string {
  if (radix === 16) return hexLiteral(value);
  if (radix === 2) {
    const width = value > 0xff ? 16 : 8;
    return `0b${(value >>> 0).toString(2).padStart(width, '0')}`;
  }
  return String(value);
}

const PRECEDENCE: Readonly<Record<string, number>> = {
  '*': 10, '/': 10, '%': 10, '+': 9, '-': 9, '<<': 8, '>>': 8, '&': 6, '^': 5, '|': 4,
};

export function exprC(program: Program, e: Expr): string {
  switch (e.kind) {
    case 'num': return numberLiteral(e.value, e.radix);
    case 'var': return e.name;
    case 'signal': {
      const s = signalById(program, e.id);
      return s ? signalRef(s, program.style) : e.id;
    }
    case 'bus': return busById(program, e.id)?.name ?? e.id;
    case 'reg': return e.bit ? `${e.name}.${e.bit}` : e.name;
    case 'bin': {
      const p = PRECEDENCE[e.op];
      const side = (x: Expr, right: boolean) => {
        const t = exprC(program, x);
        if (x.kind !== 'bin') return t;
        const q = PRECEDENCE[x.op];
        // Parentheses when C needs them, and for clarity when arithmetic meets bitwise operators: (k - 1) & 0x0F.
        const mixed = p <= 8 && q !== p;
        return q < p || (right && q === p) || mixed ? `(${t})` : t;
      };
      return `${side(e.left, false)} ${e.op} ${side(e.right, true)}`;
    }
    case 'unary': {
      const t = exprC(program, e.arg);
      return e.arg.kind === 'bin' ? `${e.op}(${t})` : `${e.op}${t}`;
    }
    case 'raw': return e.text;
  }
}

export function condC(program: Program, c: Cond): string {
  switch (c.kind) {
    case 'pin': {
      const s = signalById(program, c.signal);
      return `${s ? signalRef(s, program.style) : c.signal} == ${c.value}`;
    }
    case 'flag': return `${FLAG_C[c.flag]} == ${c.value}`;
    case 'compare': return `${exprC(program, c.left)} ${c.op} ${exprC(program, c.right)}`;
    case 'and':
    case 'or': {
      const joiner = c.kind === 'and' ? ' && ' : ' || ';
      return c.items
        .map((x) => {
          const t = condC(program, x);
          return (x.kind === 'and' || x.kind === 'or') && x.kind !== c.kind ? `(${t})` : t;
        })
        .join(joiner);
    }
    case 'not': return `!(${condC(program, c.cond)})`;
    case 'raw': return c.text;
  }
}
