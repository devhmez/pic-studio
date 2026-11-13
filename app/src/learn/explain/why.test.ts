import { compile } from '@pic/compiler';
import { describe, expect, it } from 'vitest';
import { Topology } from './circuit';
import { liveEnv, pinInfoLookup, staticEnv } from './env';
import { capture, startSession, stepToLine } from './simTesting';
import { lineOf, loadTemplate, type LoadedTemplate } from './testTemplates';
import { explainWhy, readsOfPin, writesToPin, type WhyAnswer, type WhyInput } from './why';

function whyStatic(t: LoadedTemplate, componentId: string): WhyAnswer {
  const topo = new Topology(t.schematic);
  return explainWhy({
    schematic: t.schematic, componentId, clockHz: t.clockHz, unit: t.build.ast, source: t.build.source, symbols: t.build.symbols,
    program: t.program, staticEnv: staticEnv(t.build.ast, topo), pinInfo: pinInfoLookup(t.program, topo),
  })!;
}

function whyLive(t: LoadedTemplate, componentId: string, live: ReturnType<typeof capture>, extra: Partial<WhyInput> = {}): WhyAnswer {
  const topo = new Topology(t.schematic);
  return explainWhy({
    schematic: t.schematic, componentId, clockHz: t.clockHz, unit: t.build.ast, source: t.build.source, symbols: t.build.symbols,
    program: t.program, live: { cpu: live.cpu, visuals: live.visuals, line: live.line }, liveEnv: liveEnv(live.cpu, t.build.symbols),
    staticEnv: staticEnv(t.build.ast, topo), pinInfo: pinInfoLookup(t.program, topo), ...extra,
  })!;
}

const step = (a: WhyAnswer, title: string) => a.steps.find((s) => s.title.startsWith(title));

describe('writesToPin / readsOfPin', () => {
  it('tp-status: RB1 is written by LED_OFF (init, loop) and LED_ON in the Z branch', () => {
    const t = loadTemplate('tp-status');
    const sites = writesToPin(t.build.ast!, 'RB1');
    expect(sites.map((s) => [s.visit.stmt.span.line, s.value])).toEqual([[18, 0], [23, 0], [25, 1]]);
  });

  it('tp1-demux: RA0 (L0) is read by the three tests', () => {
    const t = loadTemplate('tp1-demux');
    expect(readsOfPin(t.build.ast!, 'RA0').map((r) => r.line)).toEqual([
      lineOf(t.source, 'if (L1 == 0 && L0 == 0)'), lineOf(t.source, 'L1 == 0 && L0 == 1'), lineOf(t.source, 'L1 == 1 && L0 == 0'),
    ]);
  });

  it('tp-vote: whole-port writes of the display also write RB5', () => {
    const t = loadTemplate('tp-vote');
    const sites = writesToPin(t.build.ast!, 'RB5');
    expect(sites.some((s) => s.whole && s.value === 0)).toBe(true);
    expect(sites.some((s) => !s.whole && s.value === 1)).toBe(true);
  });
});

describe('Pourquoi ? — tp-status', () => {
  const t = loadTemplate('tp-status');

  it('stopped: EGALITE stays off because Z = 0 with x = 5, y = 6', () => {
    const a = whyStatic(t, 'EGALITE');
    expect(a.question).toBe('Quand la LED verte EGALITE s’allume-t-elle ?');
    expect(step(a, 'Câblage')!.text).toBe('La LED verte EGALITE est reliée à RB1 (broche 7), sa cathode à la masse : elle s’allume quand RB1 = 1 (5 V).');
    expect(step(a, 'Nom dans le code')!.text).toBe('Dans le code, RB1 s’appelle LED_EGAL (#define LED_EGAL PORTB.F1).');
    expect(step(a, 'Ligne qui fixera')).toMatchObject({ line: 23, tone: 'off' });
    const cond = step(a, 'Condition')!;
    expect(cond.line).toBe(25);
    expect(cond.text).toContain('le bit Z de STATUS vaut 1 (x − y est nul, donc x = y)');
    expect(cond.text).toContain('5 − 6 = −1');
    expect(cond.text).toContain('Z = 0 → ce n’est pas le cas');
  });

  it('stopped: X_INFERIEUR will be lit by the else branch (Z = 0 and C = 0)', () => {
    const a = whyStatic(t, 'X_INFERIEUR');
    const d = step(a, 'Ligne qui fixera')!;
    expect(d).toMatchObject({ line: 27, tone: 'ok' });
    expect(d.text).toContain('le bit Z de STATUS vaut 0 (x − y n’est pas nul, donc x ≠ y)');
    expect(d.text).toContain('le bit C de STATUS vaut 0 (il y a eu un emprunt dans x − y, donc x < y)');
    expect(d.text).not.toContain('ce n’est pas le cas');
  });

  it('running, at the top of the loop: X_INFERIEUR is lit, written by line 27 in the previous turn', () => {
    const s = startSession(t);
    stepToLine(s, t, 23, 40);
    const live = capture(s, t);
    const a = whyLive(t, 'X_INFERIEUR', live);
    expect(a.state).toBe('on');
    expect(a.question).toBe('Pourquoi la LED rouge X_INFERIEUR est allumée ?');
    expect(step(a, 'Broche')!.text).toBe('RB2 est une sortie et vaut 1 en ce moment → la LED est allumée.');
    expect(step(a, 'Ligne qui a fixé')).toMatchObject({ line: 27, tone: 'ok' });
    expect(a.summary).toBe('RB2 = 1, écrit par la ligne 27.');
  });

  it('running, at the top of the loop: EGALITE is off; lighting it needs x = y', () => {
    const s = startSession(t);
    stepToLine(s, t, 23, 40);
    const a = whyLive(t, 'EGALITE', capture(s, t));
    expect(a.state).toBe('off');
    expect(a.question).toBe('Pourquoi la LED verte EGALITE est éteinte ?');
    const on = step(a, 'Pour l’allumer')!;
    expect(on.line).toBe(25);
    expect(on.text).toContain('donc x = y');
    expect(on.text).toContain('ce n’est pas le cas');
  });

  it('paused right after LED_OFF: the LED looks lit (duty cycle) while RB2 = 0', () => {
    const s = startSession(t);
    stepToLine(s, t, 25, 60);
    const live = capture(s, t);
    const a = whyLive(t, 'X_INFERIEUR', live);
    expect(step(a, 'Broche')!.text).toContain('vaut 0 en ce moment');
    expect(step(a, 'Ligne qui a fixé')).toMatchObject({ line: 23 });
    if ((live.visuals.X_INFERIEUR as { lit: boolean }).lit) expect(step(a, 'Remarque')!.text).toContain('le programme la rallume à chaque tour');
  });

  it('with x = y, EGALITE is lit by line 25', () => {
    const source = t.source.replace('x = 5; y = 6;', 'x = 6; y = 6;');
    const build = compile(source, { clockHz: t.clockHz });
    const t2 = { ...t, source, build };
    const s = startSession(t2);
    stepToLine(s, t2, 23, 40);
    const a = whyLive(t2, 'EGALITE', capture(s, t2));
    expect(a.state).toBe('on');
    expect(step(a, 'Ligne qui a fixé')!.line).toBe(25);
    expect(step(a, 'Ligne qui a fixé')!.text).toContain('6 − 6 = 0 (0x00), donc Z = 1 → c’est le cas');
  });

  it('a write recorded during the step-by-step wins', () => {
    const s = startSession(t);
    stepToLine(s, t, 23, 40);
    const a = whyLive(t, 'EGALITE', capture(s, t), { lastWrites: new Map([['RB1', { line: 23, value: 0 }]]) });
    expect(step(a, 'Dernière écriture (pas à pas)')!.text).toBe('Pendant le pas à pas, la dernière ligne qui a écrit RB1 est la ligne 23 : « LED_OFF(LED_EGAL); » → RB1 = 0.');
  });
});

describe('Pourquoi ? — tp1-demux', () => {
  const t = loadTemplate('tp1-demux');

  it('stopped: the schematic’s D3 is the code’s D2, lit for L1 = 1, L0 = 0 (switches of the DSN)', () => {
    const a = whyStatic(t, 'D3');
    expect(step(a, 'Câblage')!.text).toContain('reliée à RB2 (broche 8) à travers R2 (220 Ω)');
    const name = step(a, 'Nom dans le code')!;
    expect(name.tone).toBe('warn');
    expect(name.text).toContain('le schéma la nomme D3, le code D2');
    const d = step(a, 'Ligne qui fixera')!;
    expect(d.line).toBe(lineOf(t.source, 'D2=1;', lineOf(t.source, 'L1 == 1 && L0 == 0')));
    expect(d.text).toContain('L1 (RA1) vaut 1 et L0 (RA0) vaut 0');
    expect(d.text).toContain('L1 = 1, L0 = 0 → c’est le cas');
  });

  it('running: D3 lit, D1 off; flipping L0 lights D4 (code D3)', () => {
    const s = startSession(t);
    s.runFor(0.01);
    let live = capture(s, t);
    expect(whyLive(t, 'D3', live).state).toBe('on');
    const off = whyLive(t, 'D1', live);
    expect(off.state).toBe('off');
    expect(step(off, 'Pour l’allumer')!.text).toContain('L1 (RA1) vaut 0 et L0 (RA0) vaut 0');
    s.interact('LS1', { type: 'toggle' }); // RA0 = 1
    s.runFor(0.01);
    live = capture(s, t);
    const d4 = whyLive(t, 'D4', live);
    expect(d4.state).toBe('on');
    expect(step(d4, 'Ligne qui a fixé')!.line).toBe(lineOf(t.source, 'D3=1;', lineOf(t.source, 'else {', lineOf(t.source, 'L1 == 1 && L0 == 0'))));
  });

  it('LOGICSTATE: what the PIC reads and where', () => {
    const a = whyStatic(t, 'LS2');
    expect(a.question).toBe('Que lit le PIC sur RA1 ?');
    expect(a.state).toBe('on');
    expect(step(a, 'Code')!.text).toContain('Le programme lit RA1 aux lignes');
  });
});

describe('Pourquoi ? — other parts', () => {
  it('traffic: display and LDR', () => {
    const t = loadTemplate('tp-traffic');
    const seg = whyStatic(t, 'SEG1');
    expect(step(seg, 'Câblage')!.text).toContain('E0 ← RB0, E1 ← RB1, E2 ← RB2, E3 ← RB3');
    expect(step(seg, 'Ligne qui fixera')!.text).toContain('« A »');
    const ldr = whyStatic(t, 'LDR1');
    expect(step(ldr, 'Lumière')!.text).toContain('le PIC lit 0');
  });

  it('vote: button with pull-down', () => {
    const t = loadTemplate('tp-vote');
    const a = whyStatic(t, 'VOTE_A');
    expect(step(a, 'Composant')!.text).toContain('R1 (10 kΩ) tire RA0 vers la masse (pull-down) → RA0 = 0');
  });

  it('terminals have no answer', () => {
    const t = loadTemplate('tp-status');
    expect(whyStatic(t, 'GND1')).toBeNull();
  });
});
