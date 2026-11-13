// Fixes after the adversarial review of « Comprendre » (see app/src/__review__/learn): the behaviour around them —
// PORTB pull-ups enabled by the program, the « Pourquoi ? » wording for writes whose conditions changed since, the
// PIC card with MCLR wired, series resistors still followed, the LOGICSTATE read.
import { describe, expect, it } from 'vitest';
import { autolayout, SimSession, type Schematic } from '@pic/circuit';
import { compile } from '@pic/compiler';
import type { Program } from '@pic/program-model';
import { explainLine } from './cline';
import { buttonWiring, describeParts, partsOnPin, Topology } from './circuit';
import { CHAPTERS } from './course';
import { liveEnv, pinInfoLookup, rbPullupsEnabled, schematicInputs, staticEnv, wiringOptions } from './env';
import { capture, startSession, stepToLine } from './simTesting';
import { lineOf, loadTemplate, type LoadedTemplate } from './testTemplates';
import { explainWhy } from './why';

const BUTTON_TO_GND = autolayout({
  parts: [{ ref: 'B1', kind: 'BUTTON' }, { ref: 'D1', kind: 'LED', color: 'RED' }],
  links: [{ from: 'B1.1', to: 'RB0' }, { from: 'B1.2', to: 'GND' }, { from: 'D1.A', to: 'RB1' }, { from: 'D1.K', to: 'GND' }],
}).schematic;

function adHoc(source: string, schematic: Schematic): LoadedTemplate {
  const build = compile(source, { clockHz: 1_000_000 });
  if (!build.ok) throw new Error(build.diagnostics.map((d) => d.message).join(' ; '));
  return { id: 'ad-hoc', source, clockHz: 1_000_000, build, program: null as unknown as Program, schematic };
}

describe('PORTB pull-ups enabled by the program', () => {
  const WITH = 'void main() {\n    OPTION_REG.RBPU = 0;\n    TRISB.RB0 = 1;\n    TRISB.RB1 = 0;\n    while(1) {\n        if (PORTB.RB0 == 0) PORTB.RB1 = 1;\n        else PORTB.RB1 = 0;\n    }\n}\n';
  const WITHOUT = 'void main() {\n    TRISB = 0x01;\n    while(1) { }\n}\n';

  it('detects OPTION_REG.RBPU = 0 or a whole OPTION_REG value with bit 7 clear', () => {
    expect(rbPullupsEnabled(compile(WITH, { clockHz: 1_000_000 }).ast)).toBe(true);
    expect(rbPullupsEnabled(compile('void main() {\n    OPTION_REG = 0x7F;\n}\n', { clockHz: 1_000_000 }).ast)).toBe(true);
    expect(rbPullupsEnabled(compile('void main() {\n    OPTION_REG = 0x80;\n}\n', { clockHz: 1_000_000 }).ast)).toBe(false);
    expect(rbPullupsEnabled(compile(WITHOUT, { clockHz: 1_000_000 }).ast)).toBe(false);
    expect(rbPullupsEnabled(null)).toBe(false);
  });

  it('the button card: no warning, released = 1, and the release wait uses the pressed level 0', () => {
    const topo = new Topology(BUTTON_TO_GND);
    const card = describeParts(topo, 1_000_000, wiringOptions(compile(WITH, { clockHz: 1_000_000 }).ast)).find((p) => p.id === 'B1')!;
    expect(card.warnings).toEqual([]);
    expect(card.text.join(' ')).toContain('activées par le programme (OPTION_REG.RBPU = 0)');
    expect(card.text.join(' ')).toContain('while (BOUTON == 0);');
    expect(schematicInputs(topo, { rbPullups: true }).get('RB0')).toBe(1);
  });

  it('without them the input has no starting level and the warning says how to fix it', () => {
    const topo = new Topology(BUTTON_TO_GND);
    expect(schematicInputs(topo).get('RB0')).toBeUndefined();
    const w = buttonWiring(topo, 'B1');
    expect(w.problem).toContain('OPTION_REG.RBPU = 0');
    expect(w.problem).toContain('10 kΩ');
    const card = describeParts(topo, 1_000_000).find((p) => p.id === 'B1')!;
    expect(card.text.join(' ')).not.toContain('relâché RB0 = 1');
  });

  it('« Pourquoi ? » live with the pull-ups on: released reads 1, no warning', () => {
    const t = adHoc(WITH, BUTTON_TO_GND);
    const s = new SimSession(t.schematic, t.build.program!, t.clockHz, { config: t.build.config });
    s.runFor(0.01);
    const live = capture(s, t);
    const topo = new Topology(t.schematic);
    const a = explainWhy({
      schematic: t.schematic, componentId: 'B1', clockHz: t.clockHz, unit: t.build.ast, source: t.build.source, symbols: t.build.symbols,
      program: null, live: { cpu: live.cpu, visuals: live.visuals, line: live.line }, liveEnv: liveEnv(live.cpu, t.build.symbols),
      staticEnv: staticEnv(t.build.ast, topo), pinInfo: pinInfoLookup(null, topo),
    })!;
    expect(a.steps.find((x) => x.title === 'Composant')!.text).toBe('Bouton relâché → RB0 = 1.');
    expect(a.steps.some((x) => x.title === 'Attention')).toBe(false);
  });
});

describe('« Pourquoi ? » wording', () => {
  it('a decisive write whose conditions changed since says so; an initialisation line runs once', () => {
    const t = loadTemplate('tp-vote');
    const s = startSession(t);
    stepToLine(s, t, lineOf(t.source, 'if (VOTE_A == 1)'), 10);
    s.interact('VOTE_A', { type: 'press' });
    stepToLine(s, t, lineOf(t.source, 'while (VOTE_A == 1);'), 10);
    s.interact('VOTE_A', { type: 'release' });
    s.interact('RESULTAT', { type: 'press' });
    stepToLine(s, t, lineOf(t.source, 'while (RESULTAT == 1);'), 10);
    const live = capture(s, t);
    const topo = new Topology(t.schematic);
    const base = { schematic: t.schematic, componentId: 'SEG1', clockHz: t.clockHz, unit: t.build.ast, source: t.build.source, symbols: t.build.symbols, program: t.program, staticEnv: staticEnv(t.build.ast, topo), pinInfo: pinInfoLookup(t.program, topo) };
    const a = explainWhy({ ...base, live: { cpu: live.cpu, visuals: live.visuals, line: live.line }, liveEnv: liveEnv(live.cpu, t.build.symbols) })!;
    const step = a.steps.find((x) => x.title === 'Ligne qui a fixé l’affichage')!;
    expect(step.text).toContain('Au moment de l’écriture, toutes ces conditions étaient vraies');
    expect(step.text).toContain('« A »');
    const still = explainWhy(base)!;
    expect(still.steps.find((x) => x.title === 'Ligne qui fixera l’affichage')!.text).toContain('exécutée une fois au démarrage');
  });

  it('the LED toggled by the interrupt is attributed to the interrupt routine', () => {
    const t = loadTemplate('tp5-int-rb0');
    const s = startSession(t);
    s.runFor(0.05);
    s.interact('BOUTON', { type: 'press' });
    s.runFor(0.01);
    s.interact('BOUTON', { type: 'release' });
    s.runFor(0.05);
    const live = capture(s, t);
    const topo = new Topology(t.schematic);
    const a = explainWhy({
      schematic: t.schematic, componentId: 'D1', clockHz: t.clockHz, unit: t.build.ast, source: t.build.source, symbols: t.build.symbols,
      program: t.program, live: { cpu: live.cpu, visuals: live.visuals, line: live.line }, liveEnv: liveEnv(live.cpu, t.build.symbols),
      staticEnv: staticEnv(t.build.ast, topo), pinInfo: pinInfoLookup(t.program, topo),
    })!;
    const toggle = lineOf(t.source, 'LED_INT = !LED_INT;');
    expect(a.summary).toBe(`RB1 = 1, écrit par la ligne ${toggle}.`);
    expect(a.steps.find((x) => x.title === 'Ligne qui a fixé l’état')!.text).toContain('(programme d’interruption)');
  });
});

describe('circuit cards after review', () => {
  it('the PIC card describes MCLR tied to +5 V and lists only the pins really unwired', () => {
    const lay = autolayout({ parts: [{ ref: 'D1', kind: 'LED' }], links: [{ from: 'U1.MCLR', to: 'VDD' }, { from: 'D1.A', to: 'RB0' }, { from: 'D1.K', to: 'GND' }] });
    expect(lay.problems).toEqual([]);
    const pic = describeParts(new Topology(lay.schematic), 1_000_000).find((p) => p.kind === 'PIC16F84A')!;
    const text = pic.text.join(' ');
    expect(text).toContain('MCLR est relié au +5 V');
    expect(text).toContain('OSC1 et OSC2 ne sont pas câblées');
  });

  it('a series resistor still leads to its LED', () => {
    const lay = autolayout({ parts: [{ ref: 'R1', kind: 'RES', value: '220' }, { ref: 'D1', kind: 'LED' }], links: [{ from: 'U1.RB0', to: 'R1.1' }, { from: 'R1.2', to: 'D1.A' }, { from: 'D1.K', to: 'GND' }] });
    expect(partsOnPin(new Topology(lay.schematic), 'RB0').map((c) => c.id)).toEqual(['D1']);
  });

  it('the LOGICSTATE card reads the pin through its port, and the course says RA0 alone is a bit number', () => {
    const t = loadTemplate('tp1-demux');
    const card = describeParts(new Topology(t.schematic), t.clockHz).find((p) => p.title === 'LOGICSTATE sur RA0')!;
    expect(card.text.join(' ')).toContain('« if (PORTA.RA0 == 1) »');
    const ch2 = CHAPTERS.flatMap((c) => c.sections).find((s) => s.title === 'Lire et écrire : PORTA et PORTB')!;
    expect(ch2.bullets!.join(' ')).toContain('RA0 tout seul n’est que le numéro du bit');
  });

  it('x = x - y: the flags tested next come from STATUS, not from a recomputation with the new x', () => {
    const SRC = 'void main() {\n    unsigned char x; unsigned char y;\n    TRISB = 0x00;\n    x = 7; y = 7;\n    x = x - y;\n    if (STATUS.F2 == 1) { PORTB.F1 = 1; }\n    while(1) { }\n}\n';
    const t = adHoc(SRC, loadTemplate('tp-status').schematic);
    const s = startSession(t);
    stepToLine(s, t, 6);
    const live = capture(s, t);
    expect(live.cpu.status & 0x04).toBe(0x04);
    const ex = explainLine({ unit: t.build.ast!, source: t.build.source, line: 6, clockHz: t.clockHz, symbols: t.build.symbols, env: liveEnv(live.cpu, t.build.symbols), envKind: 'live' });
    expect(ex.points.join(' ')).toContain('VRAIE');
  });
});
