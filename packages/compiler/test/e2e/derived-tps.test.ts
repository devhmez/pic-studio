import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/compile';
import { codes, fixture, runFor } from '../support/harness';
import { onEmulator } from './support';

// Reference solutions derived in the research reports (not prof material): they must compile and behave.

const ms = (clockHz: number, t: number) => Math.round((t * clockHz) / 4000);

describe('TP dérivés (vote, feu tricolore, pupitre)', () => {
  it('compilent sans erreur', () => {
    expect(onEmulator(fixture('derived/vote.c')).r.ok).toBe(true);
    expect(onEmulator(fixture('derived/pupitre.c')).r.ok).toBe(true);
    const traffic = onEmulator(fixture('derived/traffic.c'), { clockHz: 8_000_000 }).r;
    // The draft defines its own delay_ms(), which replaces MikroC's Delay_ms (identifiers are case-insensitive).
    expect(codes(traffic)).toContain('W_BUILTIN_OVERRIDDEN');
  });

  it('vote : affiche « F » (0x0F) au démarrage pendant 0,5 s', () => {
    const { core } = onEmulator(fixture('derived/vote.c'));
    runFor(core, ms(1_000_000, 100));
    const nibble = () => (['RB0', 'RB1', 'RB2', 'RB3'] as const).reduce((v, p, i) => v | ((core.getDrive(p) === 1 ? 1 : 0) << i), 0);
    expect(nibble()).toBe(0x0f);
    expect(core.getDrive('RB5')).toBe(0);
  });

  it('pupitre : bonnes réponses (0xCA) puis VALIDER → LED YES (RA3) pendant 3 s', () => {
    const { core } = onEmulator(fixture('derived/pupitre.c'));
    const answers = 0xca;
    (['RB0', 'RB1', 'RB2', 'RB3', 'RB4', 'RB5', 'RB6', 'RB7'] as const).forEach((p, i) => core.setInput(p, ((answers >> i) & 1) as 0 | 1));
    core.setInput('RA4', 1); // DEMARRER
    runFor(core, 1000);
    expect(core.getDrive('RA3')).toBe(0);
    core.setInput('RA0', 1); // VALIDER
    runFor(core, ms(1_000_000, 50));
    core.setInput('RA0', 0);
    expect(core.getDrive('RA3')).toBe(1);
    expect(core.getDrive('RA2')).toBe(0);
    runFor(core, ms(1_000_000, 3100));
    expect(core.getDrive('RA3')).toBe(0);
  });

  it('pupitre : mauvaise réponse → LED NO (RA2)', () => {
    const { core } = onEmulator(fixture('derived/pupitre.c'));
    core.setInput('RB0', 1);
    core.setInput('RA4', 1);
    runFor(core, 1000);
    core.setInput('RA0', 1);
    runFor(core, ms(1_000_000, 50));
    expect(core.getDrive('RA2')).toBe(1);
    expect(core.getDrive('RA3')).toBe(0);
  });
});

describe('analyze() : vérification sans génération de code', () => {
  it('renvoie AST et diagnostics', () => {
    const a = analyze(fixture('status.c'));
    expect(a.ok).toBe(true);
    expect(a.ast?.macros).toHaveLength(5);
    expect(a.diagnostics.map((d) => d.code)).toContain('W_SEPARATE_IF_AFTER_FLAG');
    const bad = analyze('void main() { x = 1; }');
    expect(bad.ok).toBe(false);
    expect(bad.ast?.body).toHaveLength(1);
  });
});
