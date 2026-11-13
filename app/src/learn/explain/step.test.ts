import { describe, expect, it } from 'vitest';
import { namingFromSymbols } from './cpu';
import { replayBetween } from './replay';
import { capture, startSession, stepToLine } from './simTesting';
import { explainStep, portWriteOf, type StepInput } from './step';
import { lineOf, loadTemplate, type LoadedTemplate } from './testTemplates';

function input(t: LoadedTemplate, prev: ReturnType<typeof capture>, cur: ReturnType<typeof capture>, wSource?: string): StepInput {
  return {
    prev: prev.cpu, cur: cur.cpu, program: t.build.program!, listing: t.build.listing, addrToLine: t.build.addrToLine,
    clockHz: t.clockHz, config: t.build.config, naming: namingFromSymbols(t.build.symbols), wSource,
    partsBefore: prev.visuals, partsAfter: cur.visuals, partName: (id) => `LED ${id}`,
  };
}

describe('explainStep — single instructions (tp-status)', () => {
  const t = loadTemplate('tp-status');

  it('MOVF y, W then SUBWF x, W: W ← x − W (= y) with the borrow explained', () => {
    const s = startSession(t);
    stepToLine(s, t, 24, 10);
    const a = capture(s, t);
    s.step();
    const b = capture(s, t);
    const first = explainStep(input(t, a, b));
    expect(first.kind).toBe('instruction');
    expect(first.instruction!.asm).toBe('MOVF y, W');
    expect(first.summary).toBe('1 instruction : MOVF y, W — 1 cycle');
    expect(first.wSource).toBe('y');
    expect(first.line).toBe(24);

    s.step();
    const c = capture(s, t);
    const second = explainStep(input(t, b, c, first.wSource));
    expect(second.instruction!.asm).toBe('SUBWF x, W');
    expect(second.instruction!.summary).toBe('W ← x − W (= y) = 0x05 − 0x06 = 0xFF');
    expect(second.instruction!.flags.find((f) => f.flag === 'C')!.why).toBe('C = 0 car il y a eu un emprunt (x < y).');
    const w = second.changes.find((ch) => ch.kind === 'w')!;
    expect(w).toMatchObject({ from: '0x06', to: '0xFF' });
    expect(w.why).toContain('SUBWF');
  });

  it('BSF PORTB, 2 lights the LED and is recorded as a pin write of line 27', () => {
    const s = startSession(t);
    stepToLine(s, t, 27, 10);
    const a = capture(s, t);
    s.step();
    const b = capture(s, t);
    const ex = explainStep(input(t, a, b));
    expect(ex.instruction!.asm).toBe('BSF PORTB, 2');
    expect(ex.pinWrites).toEqual([{ pin: 'RB2', value: 1, line: 27 }]);
    expect(ex.changes.find((ch) => ch.label === 'RB2')).toMatchObject({ from: '0', to: '1', why: 'sortie écrite par le programme' });
  });

  it('BSF STATUS, RP0 (TRISB = 0x00): bank change listed with its reason', () => {
    const s = startSession(t);
    const a = capture(s, t);
    s.step(); // GOTO _main
    const b = capture(s, t);
    expect(explainStep(input(t, a, b)).instruction!.summary).toContain('Saut à _main');
    s.step(); // BSF STATUS, RP0
    const c = capture(s, t);
    const ex = explainStep(input(t, b, c));
    expect(ex.instruction!.summary).toBe('RP0 ← 1 : passage en banque 1');
    expect(ex.changes.find((ch) => ch.label === 'RP0')!.why).toContain('banque 1 sélectionnée');
  });
});

describe('explainStep — C lines and delays (replay)', () => {
  it('a whole C line: three BCF verified by the replay, pins recorded', () => {
    const t = loadTemplate('tp-status');
    const s = startSession(t);
    stepToLine(s, t, 23, 40);
    const a = capture(s, t);
    stepToLine(s, t, 24, 1);
    const b = capture(s, t);
    const ex = explainStep(input(t, a, b));
    expect(ex.kind).toBe('trace');
    expect(ex.trace!.count).toBe(3);
    expect(ex.trace!.first.map((i) => i.asm)).toEqual(['BCF PORTB, 0', 'BCF PORTB, 1', 'BCF PORTB, 2']);
    expect(ex.pinWrites).toEqual(expect.arrayContaining([{ pin: 'RB0', value: 0, line: 23 }, { pin: 'RB1', value: 0, line: 23 }, { pin: 'RB2', value: 0, line: 23 }]));
    expect(ex.changes.find((ch) => ch.label === 'RB2')).toMatchObject({ from: '1', to: '0' });
  });

  it('Delay_ms(500) at 1 MHz: about 125 000 cycles replayed and verified', () => {
    const t = loadTemplate('tp5-int-rb0');
    const s = startSession(t);
    const line = lineOf(t.source, 'Delay_ms(500);');
    stepToLine(s, t, line, 1);
    const a = capture(s, t);
    stepToLine(s, t, line + 1, 1);
    const b = capture(s, t);
    const cycles = b.cpu.cycles - a.cpu.cycles;
    expect(cycles).toBeGreaterThan(120_000);
    expect(cycles).toBeLessThan(130_000);
    const ex = explainStep(input(t, a, b));
    expect(ex.kind).toBe('trace');
    expect(ex.trace!.omitted).toBeGreaterThan(0);
    expect(ex.trace!.last.length).toBeGreaterThan(0);
    expect(ex.summary).toContain('cycles');
  });

  it('a replay that cannot reproduce the end state is refused', () => {
    const t = loadTemplate('tp-status');
    const s = startSession(t);
    stepToLine(s, t, 23, 40);
    const a = capture(s, t);
    stepToLine(s, t, 24, 1);
    const b = capture(s, t);
    const tampered = { ...b.cpu, w: (b.cpu.w + 1) & 0xff };
    expect(replayBetween(t.build.program!, a.cpu, tampered, { clockHz: t.clockHz })).toBeNull();
  });
});

describe('explainStep — inputs and interrupts (tp5-int-rb0)', () => {
  const t = loadTemplate('tp5-int-rb0');

  it('pressing the button while paused: no instruction, RB0 changed by the button', () => {
    const s = startSession(t);
    s.runFor(0.001);
    const a = capture(s, t);
    s.interact('BOUTON', { type: 'press' });
    const b = capture(s, t);
    const ex = explainStep({ ...input(t, a, b), inputSource: (p) => (p === 'RB0' ? 'le bouton BOUTON' : undefined) });
    expect(ex.kind).toBe('entree');
    expect(ex.changes.find((ch) => ch.label === 'RB0')).toMatchObject({ from: '0', to: '1', why: 'entrée : vous avez changé le bouton BOUTON' });
    expect(ex.changes.find((ch) => ch.label === 'INTCON.INTF')!.why).toBe('front montant détecté sur RB0/INT');
  });

  it('interrupt entry: GIE cleared, return address pushed, PC → 0004h', () => {
    const s = startSession(t);
    s.runFor(0.001);
    s.interact('BOUTON', { type: 'press' });
    let prev = capture(s, t);
    for (let i = 0; i < 10; i++) {
      const r = s.step();
      const cur = capture(s, t, r.interruptEntry);
      if (r.interruptEntry) {
        const ex = explainStep(input(t, prev, cur));
        expect(ex.kind).toBe('interruption');
        expect(ex.instruction!.summary).toMatch(/^Interruption acceptée : adresse de retour [0-9A-F]{4}h empilée, GIE ← 0, PC ← 0004h$/);
        expect(ex.changes.find((ch) => ch.label === 'INTCON.GIE')!.why).toBe('en entrant dans l’interruption, le PIC interdit les autres interruptions');
        expect(ex.changes.find((ch) => ch.kind === 'stack')!.why).toContain('entrée en interruption');
        expect(cur.cpu.pc).toBe(4);
        return;
      }
      prev = cur;
    }
    throw new Error('pas d’entrée en interruption');
  });
});

describe('portWriteOf', () => {
  it('recognises the port writes of the listing', () => {
    expect(portWriteOf('BSF PORTB, 1')).toEqual({ port: 'PORTB', bit: 1 });
    expect(portWriteOf('MOVWF PORTB')).toEqual({ port: 'PORTB', bit: null });
    expect(portWriteOf('INCF PORTA, F')).toEqual({ port: 'PORTA', bit: null });
    expect(portWriteOf('BSF TRISB, 1')).toBeNull();
    expect(portWriteOf('MOVF PORTB, W')).toBeNull();
  });
});
