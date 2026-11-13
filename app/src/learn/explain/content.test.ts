import { describe, expect, it } from 'vitest';
import { CHAPTERS, DS_QUESTIONS, ORGANIGRAMME_RULES } from './course';
import { GLOSSARY, glossaryEntry, searchGlossary } from './glossary';
import { describeParts, Topology } from './circuit';
import { loadTemplate, TEMPLATE_IDS } from './testTemplates';
import { pinTable, programWalkthrough, TP_CONTENT, tpContent, condWords, delaySummary } from './tp';

describe('Glossaire', () => {
  it('has unique ids and every « see » link resolves', () => {
    const ids = GLOSSARY.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of GLOSSARY) for (const s of g.see ?? []) expect(glossaryEntry(s), `${g.id} → ${s}`).toBeDefined();
  });

  it('covers the registers and bits of the course', () => {
    for (const id of ['w', 'pc', 'pile', 'trisa', 'trisb', 'porta', 'portb', 'status', 'carry', 'dc', 'zero', 'pd', 'to', 'rp0', 'rp1', 'banque',
      'intcon', 'gie', 'eeie', 't0ie', 'inte', 'rbie', 't0if', 'intf', 'rbif', 'option_reg', 'rbpu', 'intedg', 't0cs', 'psa', 'tmr0',
      'prediviseur', 'interruption', 'vecteur', 'front', 'rebond', 'pull-up', 'open-drain', 'logicstate', '7seg-bcd', 'delay_ms', 'cycle',
      'organigramme', 'losange', 'boucle-infinie', 'define', 'macro']) {
      expect(glossaryEntry(id), id).toBeDefined();
    }
  });

  it('search ignores accents, case and dashes', () => {
    expect(searchGlossary('pull up')[0].id).toBe('pull-up');
    expect(searchGlossary('INTEDG')[0].id).toBe('intedg');
    expect(searchGlossary('prediviseur')[0].id).toBe('prediviseur');
    expect(searchGlossary('drapeau')[0].id).toBe('drapeau');
    expect(searchGlossary('carry')[0].id).toBe('carry');
    expect(searchGlossary('7seg bcd')[0].id).toBe('7seg-bcd');
    expect(searchGlossary('relachement').map((g) => g.id)).toContain('rebond');
    expect(searchGlossary('').length).toBe(GLOSSARY.length);
    expect(searchGlossary('zzzz')).toEqual([]);
  });

  it('states the course corrections', () => {
    expect(glossaryEntry('carry')!.short).toContain('PAS eu d’emprunt');
    expect(glossaryEntry('cycle')!.short).toContain('4 périodes d’horloge');
    expect(glossaryEntry('trisa')!.short).toContain('bit à 1 = entrée');
  });
});

describe('Cours', () => {
  it('chapters 1–6 link to existing templates', () => {
    expect(CHAPTERS.map((c) => c.number)).toEqual(['1', '2', '3', '4', '5', '6']);
    const all = CHAPTERS.flatMap((c) => c.templates);
    for (const id of all) expect(TEMPLATE_IDS as readonly string[]).toContain(id);
    expect(new Set(all).size).toBe(TEMPLATE_IDS.length);
  });

  it('révision DS: questions with answers, organigramme rules', () => {
    expect(DS_QUESTIONS.length).toBeGreaterThanOrEqual(20);
    for (const q of DS_QUESTIONS) expect(q.answer.length).toBeGreaterThan(10);
    expect(DS_QUESTIONS.find((q) => q.question.includes('Combien d’instructions'))!.answer).toContain('35 instructions');
    expect(DS_QUESTIONS.find((q) => q.question.includes('x = 5 et y = 6'))!.answer).toContain('C = 0 car il y a eu un emprunt');
    expect(ORGANIGRAMME_RULES.join(' ')).toContain('« oui » sort en bas, « non » sort à droite');
  });

  it('the STATUS chapter corrects the slide about C', () => {
    const ch3 = CHAPTERS.find((c) => c.id === 'ch3')!;
    const text = JSON.stringify(ch3);
    expect(text).toContain('C = 1 veut dire qu’il n’y a PAS eu d’emprunt');
    expect(text).toContain('0x77');
  });
});

describe('Ce TP', () => {
  it('every template has hand-written content', () => {
    for (const id of TEMPLATE_IDS) {
      const c = tpContent(id)!;
      expect(c, id).toBeDefined();
      expect(c.goal.length).toBeGreaterThan(0);
      expect(c.mistakes.length).toBeGreaterThan(1);
    }
    expect(TP_CONTENT).toHaveLength(TEMPLATE_IDS.length);
  });

  it('classic mistakes of the course', () => {
    expect(tpContent('tp-status')!.mistakes.join(' ')).toContain('Deux if séparés au lieu de « else if »');
    expect(tpContent('tp1-demux')!.mistakes.join(' ')).toContain('L’ordre L1 / L0');
    expect(tpContent('tp-vote')!.mistakes.join(' ')).toContain('attendre le relâchement');
  });

  it('demux: pins table from the program model and the circuit', () => {
    const t = loadTemplate('tp1-demux');
    const rows = pinTable(t.program, t.schematic);
    expect(rows.map((r) => r.pin)).toEqual(['RA0', 'RA1', 'RB0', 'RB1', 'RB2', 'RB3']);
    expect(rows[0]).toMatchObject({ pin: 'RA0', number: 17, dir: 'entrée', name: 'L0' });
    expect(rows[2]).toMatchObject({ pin: 'RB0', number: 6, dir: 'sortie', name: 'D0', part: 'LED bleue D1' });
  });

  it('vote: the display bus is listed bit by bit', () => {
    const t = loadTemplate('tp-vote');
    const rows = pinTable(t.program, t.schematic);
    expect(rows.find((r) => r.pin === 'RB3')).toMatchObject({ name: 'AFFICHEUR', role: 'Afficheur BCD, entrée E3' });
    expect(rows.find((r) => r.pin === 'RB5')).toMatchObject({ name: 'LED_EGAL', dir: 'sortie' });
  });

  it('status: walkthrough in the organigramme order', () => {
    const t = loadTemplate('tp-status');
    const sections = programWalkthrough(t.program);
    expect(sections.map((s) => s.title)).toEqual(['CONFIGURATION', 'INITIALISATION', 'Boucle infinie — while(1)']);
    expect(sections[0].items.map((i) => i.text)).toEqual(['RB0,RB1 et RB2 sont des sorties', 'Déclaration des variables']);
    const loop = sections[2].items.map((i) => i.text);
    expect(loop).toContain('Si Z = 1 (le résultat est nul) :');
    expect(loop).toContain('Sinon, si C = 1 (pas d’emprunt : le premier nombre est plus grand ou égal) :');
    expect(loop).toContain('Sinon :');
  });

  it('interrupt templates show the routine; delays are summarised', () => {
    const t = loadTemplate('tp5-int-rb0');
    const sections = programWalkthrough(t.program);
    expect(sections.map((s) => s.title)).toContain('Programme d’interruption — interrupt()');
    expect(delaySummary(t.program)).toContain('0,5 s ≈ 125');
    expect(condWords(t.program, { kind: 'flag', flag: 'INTF', value: 1 })).toBe('INTF = 1 (front sur RB0/INT)');
  });

  it('every template circuit gets part cards', () => {
    for (const id of TEMPLATE_IDS) {
      const t = loadTemplate(id);
      const parts = describeParts(new Topology(t.schematic), t.clockHz);
      expect(parts.length, id).toBeGreaterThan(1);
      for (const p of parts) expect(p.text.join(' '), `${id}/${p.id}`).not.toMatch(/undefined|NaN/);
    }
  });

  it('part cards explain the wiring choices', () => {
    const pupitre = describeParts(new Topology(loadTemplate('tp-pupitre').schematic), 1e6);
    expect(pupitre.find((p) => p.id === 'VALIDER')!.text.join(' ')).toContain('résistance de rappel (pull-down)');
    const traffic = describeParts(new Topology(loadTemplate('tp-traffic').schematic), 8e6);
    const ldr = traffic.find((p) => p.id === 'LDR1')!.text.join(' ');
    expect(ldr).toContain('pont diviseur');
    expect(ldr).toContain('niveaux de lumière 8 et 9 → 1');
    const demux = describeParts(new Topology(loadTemplate('tp1-demux').schematic), 1e6);
    expect(demux.find((p) => p.id === 'D1')!.text.join(' ')).toContain('(5 − 2,2) / 220 ≈ 12,7 mA');
    const status = describeParts(new Topology(loadTemplate('tp-status').schematic), 1e6);
    expect(status.find((p) => p.id === 'EGALITE')!.text.join(' ')).toContain('Pas de résistance');
  });
});
