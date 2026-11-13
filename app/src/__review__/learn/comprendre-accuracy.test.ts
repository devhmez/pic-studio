// Adversarial review of the « Comprendre » drawer: every test below pins a sentence that is wrong or misleading for
// the student, checked against the PIC16F84A datasheet (research/07_tech_research.md), the course facts
// (research/00_SYNTHESIS.md) and what the app's own compiler / emulator / circuit simulator really do.
// Each test FAILS while the explanation is wrong.
import { describe, expect, it } from 'vitest';
import { autolayout, SimSession, type Schematic } from '@pic/circuit';
import { compile } from '@pic/compiler';
import type { Program } from '@pic/program-model';
import { describeChanges } from '../../learn/explain/changes';
import { explainLine } from '../../learn/explain/cline';
import { describeParts, partsOnPin, Topology } from '../../learn/explain/circuit';
import { CHAPTERS } from '../../learn/explain/course';
import { liveEnv, pinInfoLookup, staticEnv } from '../../learn/explain/env';
import { glossaryEntry } from '../../learn/explain/glossary';
import { explainInstruction } from '../../learn/explain/instructions';
import { capture, startSession, stepToLine } from '../../learn/explain/simTesting';
import { lineOf, loadTemplate, type LoadedTemplate } from '../../learn/explain/testTemplates';
import { partRoles, pinTable } from '../../learn/explain/tp';
import { explainWhy, type WhyAnswer } from '../../learn/explain/why';

const PIC_ONLY: Schematic = {
  clockHz: 1_000_000,
  components: [{ id: 'U1', kind: 'PIC16F84A', ref: 'U1', value: 'PIC16F84A', at: { x: 0, y: 0 }, rotation: 0, props: { clock: '1MHz' } }],
  wires: [],
};

/** A hand-written program on a given schematic, shaped like a course template for the sim helpers. */
function adHoc(source: string, schematic: Schematic = PIC_ONLY): LoadedTemplate {
  const build = compile(source, { clockHz: 1_000_000 });
  if (!build.ok) throw new Error(build.diagnostics.map((d) => d.message).join(' ; '));
  return { id: 'ad-hoc', source, clockHz: 1_000_000, build, program: null as unknown as Program, schematic };
}

function whyLive(t: LoadedTemplate, componentId: string, live: ReturnType<typeof capture>, program: Program | null = t.program): WhyAnswer {
  const topo = new Topology(t.schematic);
  return explainWhy({
    schematic: t.schematic, componentId, clockHz: t.clockHz, unit: t.build.ast, source: t.build.source, symbols: t.build.symbols,
    program, live: { cpu: live.cpu, visuals: live.visuals, line: live.line }, liveEnv: liveEnv(live.cpu, t.build.symbols),
    staticEnv: staticEnv(t.build.ast, topo), pinInfo: pinInfoLookup(program, topo),
  })!;
}

const stepOf = (a: WhyAnswer, title: string) => a.steps.find((s) => s.title.startsWith(title));

// ---------------------------------------------------------------------------------------------------------------
// 1. STATUS = 0 / CLRF STATUS: datasheet « 000u u1uu » — C and DC are UNCHANGED, only Z is forced to 1.

describe('CLRF STATUS keeps C and DC (datasheet: STATUS = 000u u1uu)', () => {
  // x = 6, y = 5: the subtraction leaves C = 1 and DC = 1 just before STATUS = 0.
  const SRC = 'void main() {\n    unsigned char x; unsigned char y; unsigned char z;\n    x = 6; y = 5;\n    z = x - y;\n    STATUS = 0;\n    while(1) { }\n}\n';
  const t = adHoc(SRC);
  const LINE = 5;

  function runClrf() {
    const s = startSession(t);
    stepToLine(s, t, LINE);
    const before = capture(s, t);
    s.step();
    const after = capture(s, t);
    return { before, after };
  }

  it('emulator check (passes): C and DC are still 1 after CLRF STATUS, Z = 1', () => {
    const { before, after } = runClrf();
    expect(before.cpu.status & 0x03).toBe(0x03);
    expect(after.cpu.status & 0x07).toBe(0x07);
  });

  it('instructions.ts: the CLRF STATUS explanation must not claim « C et DC passent à 0 »', () => {
    const { before, after } = runClrf();
    const word = t.build.program![before.cpu.pc];
    const ex = explainInstruction({ addr: before.cpu.pc, word, text: 'CLRF STATUS', before: before.cpu, after: after.cpu });
    expect(ex.asm).toBe('CLRF STATUS');
    expect(ex.details.join(' ')).not.toContain('C et DC passent à 0');
  });

  it('cline.ts: « STATUS = 0 » must not claim that C = 0 and DC = 0 afterwards', () => {
    const ex = explainLine({ unit: t.build.ast!, source: t.build.source, line: LINE, clockHz: t.clockHz, symbols: t.build.symbols });
    expect(ex.points.join(' ')).toContain('CLRF STATUS');
    expect(ex.points.join(' ')).not.toMatch(/C = 0, DC = 0/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. `var = 0` is compiled to CLRF, not MOVLW 0x00 / MOVWF (and CLRF also sets Z = 1).

describe('assignment of 0 to a variable', () => {
  it('tp-vote « var1 = 0; var2 = 0; »: the listing has CLRF, the explanation says MOVLW 0x00 / MOVWF', () => {
    const t = loadTemplate('tp-vote');
    const line = lineOf(t.source, 'var1 = 0; var2 = 0;');
    const asm = t.build.listing.filter((l) => l.srcLine === line).map((l) => l.text);
    expect(asm).toEqual(['CLRF var1', 'CLRF var2']);
    const topo = new Topology(t.schematic);
    const ex = explainLine({
      unit: t.build.ast!, source: t.build.source, line, clockHz: t.clockHz, symbols: t.build.symbols, program: t.program,
      env: staticEnv(t.build.ast, topo), envKind: 'static', pinInfo: pinInfoLookup(t.program, topo),
    });
    expect(ex.points.join(' ')).not.toContain('MOVLW 0x00');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Parts on a pin: a pull-down resistor leads to the GND net, whose other members (every LED cathode) are not
//    wired to the input pin.

describe('parts wired to an input pin with a pull-down', () => {
  it('tp-vote « Les broches utilisées »: RA0 is only the VOTE_A button, not the LEDs CONFIRMATION / EGALITE', () => {
    const t = loadTemplate('tp-vote');
    const row = pinTable(t.program, t.schematic).find((r) => r.pin === 'RA0')!;
    expect(row.part).not.toContain('LED');
    expect(row.part).toBe('bouton VOTE_A');
  });

  it('tp-pupitre: RA0 (VALIDER) is not wired to the YES / NO / GAME OVER LEDs', () => {
    const t = loadTemplate('tp-pupitre');
    const row = pinTable(t.program, t.schematic).find((r) => r.pin === 'RA0')!;
    expect(row.part).not.toContain('LED');
  });

  it('tp5-int-rb0: RB0 (BOUTON) is not wired to LED D1 / D2', () => {
    const t = loadTemplate('tp5-int-rb0');
    expect(partsOnPin(new Topology(t.schematic), 'RB0').map((c) => c.id)).toEqual(['BOUTON']);
  });

  it('without a program model (hand-written code), RA0 of the vote circuit is an input, not « LED jaune CONFIRMATION »', () => {
    const t = loadTemplate('tp-vote');
    const topo = new Topology(t.schematic);
    expect(pinInfoLookup(null, topo)('RA0')?.kind).not.toBe('led');
    expect(pinTable(null, t.schematic).find((r) => r.pin === 'RA0')!.dir).toBe('entrée');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. « Pourquoi ? » must explain the CURRENT state, not recompute old flags from variables changed since.

describe('« Pourquoi ? » with flags recomputed from variables that changed since the subtraction', () => {
  it('tp-vote: after « A » is shown and var1/var2 are reset, the display is attributed to the « E » line', () => {
    const t = loadTemplate('tp-vote');
    const s = startSession(t);
    stepToLine(s, t, lineOf(t.source, 'if (VOTE_A == 1)'), 10);
    s.interact('VOTE_A', { type: 'press' });
    stepToLine(s, t, lineOf(t.source, 'while (VOTE_A == 1);'), 10);
    s.interact('VOTE_A', { type: 'release' });
    s.interact('RESULTAT', { type: 'press' });
    stepToLine(s, t, lineOf(t.source, 'while (RESULTAT == 1);'), 10);
    const live = capture(s, t);
    expect((live.visuals.SEG1 as { value: number }).value).toBe(0x0a); // the display really shows « A »
    const a = whyLive(t, 'SEG1', live);
    expect(a.question).toBe('Pourquoi l’afficheur montre « A » ?');
    const decisive = stepOf(a, 'Ligne qui a fixé l’affichage')!;
    expect(decisive.line).toBe(lineOf(t.source, 'AFFICHEUR = 0x0A;'));
    expect(decisive.text).not.toContain('« E »');
  });

  it('tp-traffic: light switched on during the night blink, the « A » on the display is attributed to a day countdown line', () => {
    const t = loadTemplate('tp-traffic');
    const s = startSession(t);
    const nightDelay = lineOf(t.source, 'Delay_ms(500);');
    stepToLine(s, t, nightDelay, 10);
    s.interact('LDR1', { type: 'setLevel', level: 9 }); // the student turns the torch on: RA3 now reads 1
    s.runFor(0.01); // still inside the 0,5 s wait of the night branch
    const live = capture(s, t);
    expect(live.line).toBe(nightDelay);
    expect((live.visuals.SEG1 as { value: number }).value).toBe(0x0a);
    const a = whyLive(t, 'SEG1', live);
    expect(stepOf(a, 'Ligne qui a fixé l’affichage')!.line).toBe(lineOf(t.source, 'AFFICHEUR = 0x0A;'));
  });

  it('« x -= y; if (STATUS.F2 == 1) »: paused on the if, the line says FAUSSE while the real Z = 1 makes it VRAIE', () => {
    const SRC = 'void main() {\n    unsigned char x; unsigned char y;\n    TRISB = 0x00;\n    x = 5; y = 5;\n    x -= y;\n    if (STATUS.F2 == 1) { PORTB.F1 = 1; }\n    else { PORTB.F2 = 1; }\n    while(1) { }\n}\n';
    const t = adHoc(SRC);
    const s = startSession(t);
    stepToLine(s, t, 6);
    const live = capture(s, t);
    expect(live.cpu.status & 0x04).toBe(0x04); // Z = 1: 5 − 5 = 0, the branch WILL be taken
    const ex = explainLine({
      unit: t.build.ast!, source: t.build.source, line: 6, clockHz: t.clockHz, symbols: t.build.symbols,
      env: liveEnv(live.cpu, t.build.symbols), envKind: 'live',
    });
    const text = ex.points.join(' ');
    expect(text).toContain('VRAIE');
    expect(text).not.toContain('FAUSSE');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 5. A pin written by the interrupt routine.

describe('« Pourquoi ? » for a LED toggled by interrupt() (tp5-int-rb0)', () => {
  it('the lit LED_INT is attributed to « LED_OFF(LED_INT); » (which writes 0, once, at initialisation)', () => {
    const t = loadTemplate('tp5-int-rb0');
    const s = startSession(t);
    s.runFor(0.05);
    s.interact('BOUTON', { type: 'press' });
    s.runFor(0.01);
    s.interact('BOUTON', { type: 'release' });
    s.runFor(0.05);
    const live = capture(s, t);
    expect((live.cpu.file[0x06] >> 1) & 1).toBe(1); // RB1 = 1: the interrupt toggled LED_INT on
    const a = whyLive(t, 'D1', live);
    expect(a.state).toBe('on');
    const offLine = lineOf(t.source, 'LED_OFF(LED_INT);');
    expect(a.summary).not.toBe(`RB1 = 1, écrit par la ligne ${offLine}.`);
    expect(stepOf(a, 'Ligne qui a fixé')?.line).not.toBe(offLine);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 6. Inputs: PORTB weak pull-ups are OFF after reset (OPTION_REG = 0xFF, /RBPU = 1).

describe('button between RB0 and GND without any pull-up', () => {
  const SRC = 'void main() {\n    TRISB.RB0 = 1;\n    TRISB.RB1 = 0;\n    while(1) {\n        if (PORTB.RB0 == 1) PORTB.RB1 = 1;\n        else PORTB.RB1 = 0;\n    }\n}\n';
  const lay = autolayout({
    parts: [{ ref: 'B1', kind: 'BUTTON' }, { ref: 'D1', kind: 'LED', color: 'RED' }],
    links: [{ from: 'B1.1', to: 'RB0' }, { from: 'B1.2', to: 'GND' }, { from: 'D1.A', to: 'RB1' }, { from: 'D1.K', to: 'GND' }],
  });

  it('layout check (passes)', () => {
    expect(lay.problems).toEqual([]);
  });

  it('« Ce TP » card: no warning although /RBPU = 1 after reset leaves RB0 floating (the code never clears it)', () => {
    const card = describeParts(new Topology(lay.schematic), 1_000_000).find((p) => p.id === 'B1')!;
    expect(card.warnings.length).toBeGreaterThan(0);
  });

  it('« Pourquoi ? » live: says « Bouton relâché → RB0 = 1 » while the PIC reads 0 on the same card', () => {
    const t = adHoc(SRC, lay.schematic);
    const s = new SimSession(t.schematic, t.build.program!, t.clockHz, { config: t.build.config });
    s.runFor(0.01);
    const live = capture(s, t);
    const a = whyLive(t, 'B1', live, null);
    expect(stepOf(a, 'Broche')!.text).toBe('RB0 est une entrée et le PIC lit 0.');
    expect(stepOf(a, 'Composant')!.text).not.toContain('RB0 = 1');
  });

  it('active-low button card recommends « while (BOUTON == 1); » although pressed reads 0 (that waits while RELEASED)', () => {
    const card = describeParts(new Topology(lay.schematic), 1_000_000).find((p) => p.id === 'B1')!;
    expect(card.text.join(' ')).not.toContain('while (BOUTON == 1);');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 7. LOGICSTATE card suggests `if (RA0 == 1)`: in MikroC (and this compiler) RA0 is the bit-number constant 0, so
//    the test compares 0 with 1 and is always false, without any diagnostic. The read is PORTA.RA0.

describe('LOGICSTATE card: suggested C test', () => {
  it('compiler check (passes): « if (RA0 == 1) » never reads PORTA', () => {
    const b = compile('void main() {\n  TRISB = 0;\n  while (1) {\n    if (RA0 == 1) PORTB.RB1 = 1;\n    else PORTB.RB1 = 0;\n  }\n}\n', { clockHz: 1_000_000 });
    expect(b.ok).toBe(true);
    expect(b.listing.some((l) => /PORTA/.test(l.text))).toBe(false);
  });

  it('tp1-demux: the card must not tell the student to write « if (RA0 == 1) »', () => {
    const t = loadTemplate('tp1-demux');
    const card = partRoles(t.schematic, t.clockHz).find((p) => p.title === 'LOGICSTATE sur RA0')!;
    expect(card.text.join(' ')).not.toMatch(/if \(R[AB]\d == 1\)/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 8. 7SEG-BCD glyphs are A b C d E F (lower-case b and d), as the TP pages and the « Pourquoi ? » card say.

describe('« Ce qui a changé »: 7SEG-BCD letters', () => {
  it('value 11 is shown « b » and 13 « d » on the display', () => {
    const cpu = { pc: 0, w: 0, status: 0x18, file: new Array(256).fill(0), stack: [] };
    const seg = (value: number) => ({ SEG1: { kind: '7SEG-BCD' as const, value } });
    const b = describeChanges(cpu, cpu, { partsBefore: seg(10) as never, partsAfter: seg(11) as never }).find((c) => c.kind === 'part')!;
    expect(b.to).toBe('b');
    const d = describeChanges(cpu, cpu, { partsBefore: seg(12) as never, partsAfter: seg(13) as never }).find((c) => c.kind === 'part')!;
    expect(d.to).toBe('d');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 9. Course and glossary wording.

describe('Cours / Glossaire wording', () => {
  it('Ch4 « UAL et registre W »: STATUS is NOT updated after every operation (MOVWF, MOVLW, BCF/BSF, SWAPF, GOTO… leave it; INCF/DECF only touch Z)', () => {
    const ch4 = CHAPTERS.find((c) => c.id === 'ch4')!;
    const ual = ch4.sections.find((s) => s.title === 'UAL et registre W')!;
    expect((ual.paragraphs ?? []).join(' ')).not.toMatch(/après chaque opération, l’UAL met à jour STATUS/);
  });

  it('IRP / RP1 are read/write bits « à laisser à 0 », they do not « stay » at 0 by themselves', () => {
    // Emulator check: MOVWF STATUS with 0xC0 really sets IRP and RP1 (Z/DC/C not affected by MOVWF).
    const t = adHoc('void main() {\n    STATUS = 0xC0;\n    while(1) { }\n}\n');
    const s = startSession(t);
    s.runFor(0.001);
    expect(capture(s, t).cpu.status & 0xc0).toBe(0xc0);
    expect(glossaryEntry('rp1')!.short).not.toContain('Ils restent à 0');
    const status = CHAPTERS.find((c) => c.id === 'ch3')!.sections[0].table!.rows;
    expect(status.filter((r) => r[1] === 'IRP' || r[1] === 'RP1').map((r) => r[2]).join(' ')).not.toContain('reste à 0');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 10. PIC card: « OSC1, OSC2 et MCLR ne sont pas câblés » is printed even when they are (Ch1 crystal block, which the
//     copilot's autolayout places on the left).

describe('PIC card with the Ch1 crystal block wired', () => {
  it('does not claim that OSC1 / OSC2 are unwired', () => {
    const lay = autolayout({
      parts: [
        { ref: 'X1', kind: 'CRYSTAL', value: '20MHz' }, { ref: 'C1', kind: 'CAP', value: '22pF' }, { ref: 'C2', kind: 'CAP', value: '22pF' },
        { ref: 'D1', kind: 'LED', color: 'RED' },
      ],
      links: [
        { from: 'X1.1', to: 'OSC1' }, { from: 'X1.2', to: 'OSC2' },
        { from: 'C1.1', to: 'OSC1' }, { from: 'C1.2', to: 'GND' }, { from: 'C2.1', to: 'OSC2' }, { from: 'C2.2', to: 'GND' },
        { from: 'D1.A', to: 'RB0' }, { from: 'D1.K', to: 'GND' },
      ],
    });
    expect(lay.problems).toEqual([]);
    const topo = new Topology(lay.schematic);
    expect(topo.netOf('U1', 'OSC1/CLKIN')?.pins.some((p) => p.componentId === 'X1')).toBe(true);
    const pic = describeParts(topo, 1_000_000).find((p) => p.kind === 'PIC16F84A')!;
    expect(pic.text.join(' ')).not.toContain('OSC1, OSC2 et MCLR ne sont pas câblés');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 11. BSF / BCF on a port: « seul le bit N change » ignores the read-modify-write pitfall the glossary itself
//     teaches. Memoire slide 16 case: RA4 released (open drain, no pull-up, pin reads 0), then BSF PORTA, 0 rewrites
//     RA4's latch with the 0 it read, and RA4 starts driving 0.

describe('BSF on PORTA after RA4 was released (read-modify-write)', () => {
  const SRC = 'void main() {\n    TRISA = 0x00;\n    PORTA = 0x00;\n    PORTA.F4 = 1;\n    PORTA.F0 = 1;\n    while(1) { }\n}\n';
  const t = adHoc(SRC);

  it('emulator check (passes): BSF PORTA, 0 turns RA4 from released (Z) to driven 0', () => {
    const s = startSession(t);
    stepToLine(s, t, 5);
    expect(s.mcu.getDrive('RA4')).toBe('Z');
    s.step();
    expect(s.mcu.getDrive('RA4')).toBe(0);
  });

  it('the BSF explanation must not say that only bit 0 changes', () => {
    const s = startSession(t);
    stepToLine(s, t, 5);
    const before = capture(s, t);
    s.step();
    const after = capture(s, t);
    const text = t.build.listing.find((l) => l.addr === before.cpu.pc)!.text;
    expect(text).toBe('BSF PORTA, 0');
    const ex = explainInstruction({ addr: before.cpu.pc, word: t.build.program![before.cpu.pc], text, before: before.cpu, after: after.cpu });
    expect(ex.details.join(' ')).not.toContain('seul le bit 0 change');
  });
});
