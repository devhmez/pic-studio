import { encode, INSTRUCTIONS, Pic16F84A, type Mnemonic } from '@pic/emulator';
import { describe, expect, it } from 'vitest';
import { explainInstruction, explainInterruptEntry, wSourceAfter } from './instructions';
import type { CpuState } from './cpu';

const STATUS = 0x03;
const X = 0x0c;
const Y = 0x0d;

interface Setup {
  w?: number;
  status?: number;
  regs?: Record<number, number>;
  /** Instructions placed before the one under test (executed first, e.g. CALL to build a stack). */
  pre?: number[];
  at?: number;
}

/** Run `word` on the real emulator from a seeded state; return the states around it. */
function run(word: number, setup: Setup = {}): { before: CpuState; after: CpuState; addr: number } {
  const program = new Uint16Array(1024).fill(0x3fff);
  const at = setup.at ?? 0x10;
  program[at] = word;
  const core = new Pic16F84A({ clockHz: 1_000_000 });
  core.load(program);
  for (const [a, v] of Object.entries(setup.regs ?? {})) core.poke(Number(a), v);
  core.poke(STATUS, setup.status ?? 0x18);
  core.setW(setup.w ?? 0);
  core.setPc(at);
  const snap = (): CpuState => {
    const s = core.snapshot();
    return { pc: s.pc, w: s.w, status: s.status, file: Array.from(s.file), stack: s.stack, cycles: s.cycles };
  };
  const before = snap();
  core.step();
  return { before, after: snap(), addr: at };
}

function explain(word: number, setup: Setup = {}, extra: { text?: string; wSource?: string } = {}) {
  const { before, after, addr } = run(word, setup);
  return { ex: explainInstruction({ addr, word, before, after, text: extra.text, wSource: extra.wSource }), before, after };
}

const bit = (v: number, b: number) => (v >> b) & 1;

describe('explainInstruction — every mnemonic agrees with the emulator', () => {
  // Operands chosen to exercise carries, borrows and zero results.
  const cases: { m: Mnemonic; a?: number; b?: number; setup?: Setup }[] = [
    { m: 'ADDWF', a: X, b: 0, setup: { w: 100, regs: { [X]: 200 } } },
    { m: 'ADDWF', a: X, b: 1, setup: { w: 6, regs: { [X]: 250 } } },
    { m: 'ANDWF', a: X, b: 0, setup: { w: 0x0f, regs: { [X]: 0xf0 } } },
    { m: 'CLRF', a: X },
    { m: 'CLRW', setup: { w: 7 } },
    { m: 'COMF', a: X, b: 1, setup: { regs: { [X]: 0xff } } },
    { m: 'DECF', a: X, b: 1, setup: { regs: { [X]: 1 } } },
    { m: 'DECFSZ', a: X, b: 1, setup: { regs: { [X]: 1 } } },
    { m: 'DECFSZ', a: X, b: 1, setup: { regs: { [X]: 2 } } },
    { m: 'INCF', a: X, b: 1, setup: { regs: { [X]: 0xff } } },
    { m: 'INCFSZ', a: X, b: 0, setup: { regs: { [X]: 0xff } } },
    { m: 'IORWF', a: X, b: 0, setup: { w: 0, regs: { [X]: 0 } } },
    { m: 'MOVF', a: X, b: 0, setup: { regs: { [X]: 0 } } },
    { m: 'MOVF', a: X, b: 1, setup: { regs: { [X]: 9 } } },
    { m: 'MOVWF', a: X, setup: { w: 0x42 } },
    { m: 'NOP' },
    { m: 'RLF', a: X, b: 1, setup: { status: 0x19, regs: { [X]: 0x80 } } },
    { m: 'RRF', a: X, b: 1, setup: { status: 0x18, regs: { [X]: 0x01 } } },
    { m: 'SUBWF', a: X, b: 0, setup: { w: 6, regs: { [X]: 5 } } },
    { m: 'SUBWF', a: X, b: 0, setup: { w: 5, regs: { [X]: 5 } } },
    { m: 'SUBWF', a: X, b: 0, setup: { w: 5, regs: { [X]: 6 } } },
    { m: 'SUBWF', a: X, b: 1, setup: { w: 0x18, regs: { [X]: 0x21 } } },
    { m: 'SWAPF', a: X, b: 1, setup: { regs: { [X]: 0x9c } } },
    { m: 'XORWF', a: X, b: 0, setup: { w: 0x55, regs: { [X]: 0x55 } } },
    { m: 'BCF', a: X, b: 3, setup: { regs: { [X]: 0xff } } },
    { m: 'BSF', a: X, b: 3 },
    { m: 'BTFSC', a: X, b: 0, setup: { regs: { [X]: 0 } } },
    { m: 'BTFSC', a: X, b: 0, setup: { regs: { [X]: 1 } } },
    { m: 'BTFSS', a: STATUS, b: 2, setup: { status: 0x1c } },
    { m: 'BTFSS', a: STATUS, b: 2, setup: { status: 0x18 } },
    { m: 'ADDLW', a: 0x06, setup: { w: 0xfa } },
    { m: 'ANDLW', a: 0x0f, setup: { w: 0xf0 } },
    { m: 'CALL', a: 0x40 },
    { m: 'CLRWDT', setup: { status: 0x00 } },
    { m: 'GOTO', a: 0x40 },
    { m: 'IORLW', a: 0x01, setup: { w: 0x10 } },
    { m: 'MOVLW', a: 0x8c },
    { m: 'RETLW', a: 0x33 },
    { m: 'RETURN' },
    { m: 'RETFIE' },
    { m: 'SLEEP' },
    { m: 'SUBLW', a: 10, setup: { w: 3 } },
    { m: 'SUBLW', a: 3, setup: { w: 10 } },
    { m: 'XORLW', a: 0xff, setup: { w: 0xff } },
    { m: 'OPTION', setup: { w: 0x0f } },
    { m: 'TRIS', a: 6, setup: { w: 0x0f } },
  ];

  it('covers all 35 instructions (plus OPTION / TRIS)', () => {
    const covered = new Set(cases.map((c) => c.m));
    for (const i of INSTRUCTIONS) expect(covered.has(i.mnemonic), i.mnemonic).toBe(true);
  });

  for (const c of cases) {
    it(`${c.m} ${c.a ?? ''} ${c.b ?? ''}`, () => {
      const word = encode(c.m, c.a ?? 0, c.b ?? 0);
      const { ex, after } = explain(word, c.setup);
      expect(ex.mnemonic).toBe(c.m);
      expect(ex.summary.length).toBeGreaterThan(3);
      for (const f of ex.flags) {
        const b = { C: 0, DC: 1, Z: 2, PD: 3, TO: 4 }[f.flag];
        expect(f.value, `${c.m} ${f.flag}: ${f.why}`).toBe(bit(after.status, b));
        expect(f.why).toMatch(new RegExp(`${f.flag === 'PD' || f.flag === 'TO' ? '/' : ''}${f.flag} = ${f.value}`));
      }
      if (ex.skipped !== undefined) {
        const skippedPc = (0x10 + 2) & 0x1fff;
        expect(after.pc === skippedPc).toBe(ex.skipped);
        expect(ex.cycles).toBe(ex.skipped ? 2 : 1);
      }
    });
  }
});

describe('explainInstruction — flag wording', () => {
  it('SUBWF x, W with x < y: borrow, C = 0, Z = 0 (example of the course)', () => {
    const { ex } = explain(encode('SUBWF', X, 0), { w: 6, regs: { [X]: 5 } }, { text: 'SUBWF x, W', wSource: 'y' });
    expect(ex.asm).toBe('SUBWF x, W');
    expect(ex.summary).toBe('W ← x − W (= y) = 0x05 − 0x06 = 0xFF');
    const c = ex.flags.find((f) => f.flag === 'C')!;
    expect(c.value).toBe(0);
    expect(c.why).toBe('C = 0 car il y a eu un emprunt (x < y).');
    expect(ex.flags.find((f) => f.flag === 'Z')!.why).toBe('Z = 0 car le résultat n’est pas nul.');
    expect(ex.details.join(' ')).toContain('5 − 6 = −1 est négatif : sur 8 bits on obtient −1 + 256 = 255 (0xFF)');
  });

  it('SUBWF with x = y: Z = 1 and C = 1 (no borrow), the cause of the two-LED bug', () => {
    const { ex } = explain(encode('SUBWF', X, 0), { w: 5, regs: { [X]: 5 } }, { text: 'SUBWF x, W', wSource: 'y' });
    expect(ex.flags.find((f) => f.flag === 'Z')).toMatchObject({ value: 1 });
    expect(ex.flags.find((f) => f.flag === 'Z')!.why).toContain('donc x = y');
    const c = ex.flags.find((f) => f.flag === 'C')!;
    expect(c.value).toBe(1);
    expect(c.why).toContain('pas eu d’emprunt (x ≥ y)');
    expect(c.why).toContain('C = 1 veut dire « pas d’emprunt »');
  });

  it('SUBWF DC is NOT borrow on the low nibble', () => {
    const { ex } = explain(encode('SUBWF', X, 1), { w: 0x18, regs: { [X]: 0x21 } });
    expect(ex.flags.find((f) => f.flag === 'DC')).toMatchObject({ value: 0 });
    expect(ex.flags.find((f) => f.flag === 'DC')!.why).toContain('emprunt sur le quartet bas (1 < 8)');
    expect(ex.flags.find((f) => f.flag === 'C')).toMatchObject({ value: 1 });
  });

  it('SUBLW computes k − W', () => {
    const { ex } = explain(encode('SUBLW', 3), { w: 10 });
    expect(ex.summary).toBe('W ← 0x03 − W = 0x03 − 0x0A = 0xF9');
    expect(ex.flags.find((f) => f.flag === 'C')).toMatchObject({ value: 0 });
    expect(ex.details[0]).toContain('k − W');
  });

  it('ADDWF 200 + 100: C = 1, DC = 0, Z = 0 (MPLAB vector of the course)', () => {
    const { ex, after } = explain(encode('ADDWF', X, 0), { w: 100, regs: { [X]: 200 } });
    expect(after.status).toBe(0x19);
    expect(ex.summary).toContain('= 0x2C');
    expect(ex.flags.map((f) => `${f.flag}${f.value}`)).toEqual(['C1', 'DC0', 'Z0']);
    expect(ex.details.join(' ')).toContain('300 ne tient pas sur 8 bits : le PIC garde 300 − 256 = 44');
  });

  it('ADDWF 250 + 6: C = 1, DC = 1, Z = 1 (STATUS 0x1F)', () => {
    const { ex, after } = explain(encode('ADDWF', X, 0), { w: 6, regs: { [X]: 250 } });
    expect(after.status).toBe(0x1f);
    expect(ex.flags.map((f) => `${f.flag}${f.value}`)).toEqual(['C1', 'DC1', 'Z1']);
  });

  it('CLRF STATUS leaves Z = 1', () => {
    const { ex, after } = explain(encode('CLRF', STATUS), { status: 0x1b });
    expect(bit(after.status, 2)).toBe(1);
    // Datasheet: STATUS = 000u u1uu — C and DC are unchanged (here 1 and 1).
    expect(after.status & 0x03).toBe(0x03);
    expect(ex.summary).toBe('IRP, RP1, RP0 ← 0 et Z ← 1 (C et DC inchangés)');
    expect(ex.details[0]).toContain('CLRF met toujours Z à 1');
    expect(ex.details.join(' ')).toContain('C et DC gardent leur valeur');
  });

  it('INCF 255 → 0 sets Z but not C', () => {
    const { ex } = explain(encode('INCF', X, 1), { regs: { [X]: 0xff } });
    expect(ex.flags).toEqual([expect.objectContaining({ flag: 'Z', value: 1 })]);
    expect(ex.details.join(' ')).toContain('INCF ne modifie pas C');
  });

  it('MOVF f, F is a zero test', () => {
    const { ex } = explain(encode('MOVF', X, 1), { regs: { [X]: 0 } });
    expect(ex.details[0]).toContain('Z indique s’il vaut zéro');
    expect(ex.flags[0]).toMatchObject({ flag: 'Z', value: 1 });
  });

  it('RLF shifts bit 7 into C', () => {
    const { ex } = explain(encode('RLF', X, 1), { status: 0x18, regs: { [X]: 0x80 } });
    expect(ex.flags[0]).toMatchObject({ flag: 'C', value: 1 });
    expect(ex.summary).toContain('= 0x00');
  });
});

describe('explainInstruction — registers, banks, pins', () => {
  it('BSF STATUS, RP0 switches to bank 1', () => {
    const { ex } = explain(encode('BSF', STATUS, 5));
    expect(ex.summary).toBe('RP0 ← 1 : passage en banque 1');
    expect(ex.details.join(' ')).toContain('TRISA (85h), TRISB (86h)');
    expect(ex.terms).toContain('banque');
  });

  it('BCF TRISB, 1 in bank 1 makes RB1 an output (TRIS 0 = sortie)', () => {
    const { ex } = explain(encode('BCF', 0x06, 1), { status: 0x38 });
    expect(ex.summary).toBe('TRISB.1 ← 0 : RB1 devient une sortie');
  });

  it('BSF TRISA, 0 makes RA0 an input (TRIS 1 = entrée)', () => {
    const { ex } = explain(encode('BSF', 0x05, 0), { status: 0x38 });
    expect(ex.summary).toBe('TRISA.0 ← 1 : RA0 devient une entrée');
  });

  it('BSF PORTB, 1 drives RB1 high and names what is wired', () => {
    const { before, after, addr } = run(encode('BSF', 0x06, 1), { regs: { 0x86: 0x00 } });
    const ex = explainInstruction({ addr, word: encode('BSF', 0x06, 1), before, after, pinLabel: (p) => (p === 'RB1' ? 'LED_EGAL' : undefined) });
    expect(ex.summary).toBe('RB1 (LED_EGAL) ← 1');
    expect(ex.details.join(' ')).toContain('La broche RB1 passe à 1 (5 V)');
  });

  it('BSF PORTB on an input only changes the latch', () => {
    const { ex } = explain(encode('BSF', 0x06, 2), { regs: { 0x86: 0xff } });
    expect(ex.details.join(' ')).toContain('RB2 est une entrée');
  });

  it('BSF PORTA, 4 warns about the RA4 open drain', () => {
    const { ex } = explain(encode('BSF', 0x05, 4), { regs: { 0x85: 0x00 } });
    expect(ex.details.join(' ')).toContain('drain ouvert');
    expect(ex.terms).toContain('open-drain');
  });

  it('MOVWF TRISB (bank 1) lists outputs and inputs', () => {
    const { ex } = explain(encode('MOVWF', 0x06), { status: 0x38, w: 0x0f });
    expect(ex.summary).toBe('TRISB ← W = 0x0F');
    expect(ex.details.join(' ')).toContain('Sorties : RB4, RB5, RB6, RB7');
    expect(ex.details.join(' ')).toContain('Entrées : RB0, RB1, RB2, RB3');
  });

  it('BCF INTCON, INTF explains why the flag must be cleared', () => {
    const { ex } = explain(encode('BCF', 0x0b, 1), { regs: { 0x0b: 0x92 } });
    expect(ex.summary).toContain('sinon l’interruption recommencerait');
  });

  it('BTFSS STATUS, Z with Z = 0 does not skip', () => {
    const { ex } = explain(encode('BTFSS', STATUS, 2), { status: 0x18 }, { text: 'BTFSS STATUS, Z' });
    expect(ex.skipped).toBe(false);
    expect(ex.summary).toBe('Teste Z (bit 2 de STATUS) = 0 → l’instruction suivante s’exécute');
  });

  it('DECFSZ on 1 skips (end of a delay loop)', () => {
    const { ex } = explain(encode('DECFSZ', X, 1), { regs: { [X]: 1 } });
    expect(ex.skipped).toBe(true);
    expect(ex.cycles).toBe(2);
  });

  it('CALL pushes the return address', () => {
    const { ex, after } = explain(encode('CALL', 0x40), {}, { text: 'CALL _clignoter' });
    expect(after.stack).toEqual([0x11]);
    expect(ex.summary).toBe('Appel du sous-programme _clignoter : empile 0011h, PC ← 0040h');
    expect(ex.cycles).toBe(2);
  });

  it('GOTO $ is the end of main', () => {
    const { ex } = explain(encode('GOTO', 0x10), {}, { text: 'GOTO $' });
    expect(ex.summary).toBe('GOTO $ : le PIC saute sur lui-même');
  });

  it('RETFIE sets GIE again', () => {
    const word = encode('RETFIE');
    const before: CpuState = { pc: 0x20, w: 0, status: 0x18, file: new Array(256).fill(0), stack: [0x2b] };
    const after: CpuState = { ...before, pc: 0x2b, stack: [] };
    const ex = explainInstruction({ addr: 0x20, word, before, after });
    expect(ex.summary).toBe('Retour d’interruption à 002Bh, GIE ← 1');
  });

  it('interrupt entry: GIE cleared, PC → 0004h, return address on the stack', () => {
    const file = new Array(256).fill(0);
    file[0x0b] = 0x92; // GIE, INTE, INTF
    const before: CpuState = { pc: 0x2c, w: 0, status: 0x18, file, stack: [] };
    const after: CpuState = { pc: 0x04, w: 0, status: 0x18, file: file.map((v, i) => (i === 0x0b ? 0x12 : v)), stack: [0x2c] };
    const ex = explainInterruptEntry(before, after);
    expect(ex.summary).toBe('Interruption acceptée : adresse de retour 002Ch empilée, GIE ← 0, PC ← 0004h');
    expect(ex.details[0]).toContain('front sur RB0/INT');
  });

  it('wSourceAfter follows MOVF y, W', () => {
    const before: CpuState = { pc: 0, w: 0, status: 0x18, file: new Array(256).fill(0), stack: [] };
    expect(wSourceAfter(encode('MOVF', Y, 0), before, undefined, 'MOVF y, W')).toBe('y');
    expect(wSourceAfter(encode('MOVWF', X), before, undefined, 'MOVWF z', 'y')).toBe('y');
    expect(wSourceAfter(encode('SUBWF', X, 0), before, undefined, 'SUBWF x, W', 'y')).toBeUndefined();
  });
});
