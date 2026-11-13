import { compile } from '@pic/compiler';
import { describe, expect, it } from 'vitest';
import { Topology } from './circuit';
import { explainLine, type LineContext } from './cline';
import { pinInfoLookup, staticEnv } from './env';
import { glossaryEntry } from './glossary';
import { lineOf, loadTemplate, TEMPLATE_IDS, type LoadedTemplate } from './testTemplates';
import { THIN_SPACE } from './text';

function ctxFor(t: LoadedTemplate, line: number, withEnv = true): LineContext {
  const topo = new Topology(t.schematic);
  return {
    unit: t.build.ast!, source: t.build.source, line, clockHz: t.clockHz, symbols: t.build.symbols, program: t.program,
    env: withEnv ? staticEnv(t.build.ast, topo) : undefined, envKind: 'static', pinInfo: pinInfoLookup(t.program, topo),
  };
}

function explain(t: LoadedTemplate, text: string, from = 1) {
  const line = lineOf(t.source, text, from);
  const ex = explainLine(ctxFor(t, line));
  return { ...ex, all: [...ex.points, ...ex.warnings].join('\n') };
}

describe('explainLine — every line of every template', () => {
  for (const id of TEMPLATE_IDS) {
    it(`${id}: each line gets an explanation, glossary links resolve`, () => {
      const t = loadTemplate(id);
      const lines = t.source.split('\n');
      lines.forEach((text, i) => {
        if (text.trim() === '') return;
        const ex = explainLine(ctxFor(t, i + 1));
        expect(ex.points.length, `${id}:${i + 1} « ${text.trim()} »`).toBeGreaterThan(0);
        for (const p of ex.points) expect(p, `${id}:${i + 1}`).not.toMatch(/undefined|NaN|\[object/);
        for (const term of ex.terms) expect(glossaryEntry(term), `terme ${term}`).toBeDefined();
      });
    });
  }
});

describe('explainLine — TP 0', () => {
  const e1 = loadTemplate('tp0-exemple1');
  const e2 = loadTemplate('tp0-exemple2');

  it('TRISA.RA0 = 0 makes RA0 an output, with the bank switch', () => {
    const ex = explain(e1, 'TRISA.RA0 = 0;');
    expect(ex.section).toBe('Configuration');
    expect(ex.all).toContain('RA0 devient une sortie : bit 0 de TRISA à 0. Règle du cours : 1 = entrée (Input), 0 = sortie (Output).');
    expect(ex.all).toContain('BSF STATUS, RP0');
  });

  it('LED = 1 lights the blue LED on RA0', () => {
    const ex = explain(e1, 'LED = 1;');
    expect(ex.all).toContain('Met la broche RA0 (broche 17, Led bleue) à 1 (5 V) → Led bleue allumée.');
    expect(ex.all).toContain('LED = PORTA.RA0 (broche RA0)');
  });

  it('end of main without a loop: GOTO $', () => {
    const ex = explainLine(ctxFor(e1, e1.source.trimEnd().split('\n').length));
    expect(ex.points.join(' ')).toContain('Sans boucle infinie, le programme s’arrête ici');
  });

  it('if (BOUTON == 1) is evaluated with the LOGICSTATE position', () => {
    const ex = explain(e2, 'if (BOUTON == 1)');
    expect(ex.all).toContain('Si BOUTON (RB0) vaut 1');
    expect(ex.all).toContain('Avec les valeurs de départ : BOUTON = 1 → la condition est VRAIE.');
  });

  it('TRISA = 0x00 sets the whole port as outputs', () => {
    expect(explain(e2, 'TRISA = 0x00;').all).toContain('toutes les broches de PORTA sont des sorties');
  });
});

describe('explainLine — TP démultiplexeur', () => {
  const t = loadTemplate('tp1-demux');

  it('TRISA.RA1 = 1 is an input', () => {
    expect(explain(t, 'TRISA.RA1 = 1;').all).toContain('RA1 devient une entrée');
  });

  it('else if (L1 == 0 && L0 == 1) is explained as an else-if with the switch values', () => {
    const ex = explain(t, 'else if (L1 == 0 && L0 == 1)');
    expect(ex.all).toContain('Sinon, si L1 (RA1) vaut 0 et L0 (RA0) vaut 1');
    expect(ex.all).toContain('une seule branche s’exécute');
    // The prof's DSN: L1 (RA1) = 1, L0 (RA0) = 0.
    expect(ex.all).toContain('L1 = 1, L0 = 0 → la condition est FAUSSE.');
  });

  it('the third branch is the one that runs with L1 = 1, L0 = 0', () => {
    expect(explain(t, 'else if (L1 == 1 && L0 == 0)').all).toContain('la condition est VRAIE');
  });

  it('initialisation writes are grouped', () => {
    const ex = explain(t, 'D0=0; //PORTB.RB0=0;');
    expect(ex.section).toBe('Initialisation');
    expect(ex.all).toContain('Met la broche RB0 (broche 6, Led D0) à 0 (0 V) → Led D0 éteinte.');
  });
});

describe('explainLine — TP STATUS', () => {
  const t = loadTemplate('tp-status');

  it('z = x - y: SUBWF, flags, and the values of the initialisation', () => {
    const ex = explain(t, 'z = x - y;');
    expect(ex.section).toBe('Boucle principale');
    expect(ex.all).toContain('Le PIC la calcule avec SUBWF');
    expect(ex.all).toContain('C = 1 s’il n’y a pas d’emprunt (x ≥ y), C = 0 s’il y en a un (x < y)');
    expect(ex.all).toContain('5 − 6 = −1, qui ne tient pas sur 8 bits : le PIC garde 255 (0xFF) → Z = 0, C = 0 (emprunt)');
  });

  it('if (STATUS.F2 == 1): Z test, flag source, outcome and one-line branch', () => {
    const ex = explain(t, 'if (STATUS.F2 == 1)');
    expect(ex.all).toContain('Si le bit Z de STATUS vaut 1 (x − y est nul, donc x = y)');
    expect(ex.all).toContain('viennent du calcul de la ligne 24 (z = x - y;)');
    expect(ex.all).toContain('donc Z = 0 → la condition est FAUSSE.');
    expect(ex.points).toContain('Si oui :');
    expect(ex.all).toContain('LED_ON(…) est une macro (#define)');
  });

  it('else if (STATUS.F0 == 1): C means no borrow, so x > y once Z failed', () => {
    const ex = explain(t, 'else if (STATUS.F0 == 1)');
    expect(ex.all).toContain('le bit C de STATUS vaut 1 (pas d’emprunt dans x − y, donc x ≥ y ; et comme le test de Z a échoué (x ≠ y), x > y)');
    expect(ex.all).toContain('C = 0 → la condition est FAUSSE.');
  });

  it('else { LED_ON(LED_INF); } lights the LED of x < y', () => {
    const ex = explain(t, 'else { LED_ON(LED_INF); }');
    expect(ex.points[0]).toBe('Sinon (tous les tests au-dessus étaient faux) :');
    expect(ex.all).toContain('→ Led inférieur allumée');
  });

  it('STATUS=0 is CLRF STATUS, which sets Z', () => {
    expect(explain(t, 'STATUS=0;').all).toContain('CLRF met toujours Z à 1');
  });

  it('three declarations on one line become one sentence with their RAM addresses', () => {
    const ex = explain(t, 'unsigned char x;');
    expect(ex.points).toHaveLength(1);
    expect(ex.all).toContain('x (un octet, de 0 à 255, adresse 0x0C), y (un octet, de 0 à 255, adresse 0x0D) et z (un octet, de 0 à 255, adresse 0x0E)');
  });

  it('the prof’s status.c (two separate ifs) gets the two-LED warning', () => {
    const buggy = t.source.replace('else if (STATUS.F0 == 1)', 'if (STATUS.F0 == 1)').replace('else { LED_ON(LED_INF); }', '');
    const build = compile(buggy, { clockHz: 1_000_000 });
    const line = lineOf(buggy, 'if (STATUS.F2 == 1)');
    const ex = explainLine({ unit: build.ast!, source: build.source, line, clockHz: 1_000_000, symbols: build.symbols });
    expect(ex.warnings.join(' ')).toContain('deux LEDs s’allument');
  });
});

describe('explainLine — vote, feu tricolore, pupitre', () => {
  it('vote: waiting for the button release', () => {
    const t = loadTemplate('tp-vote');
    const ex = explain(t, 'while (VOTE_A == 1);');
    expect(ex.all).toContain('Attente : tant que VOTE_A (RA0) vaut 1 (bouton appuyé)');
    expect(ex.all).toContain('C’est l’attente du relâchement');
    expect(ex.all).toContain('le PIC passe à la suite');
    expect(ex.terms).toContain('rebond');
  });

  it('vote: writing the whole PORTB to the BCD display clears RB5', () => {
    const t = loadTemplate('tp-vote');
    const ex = explain(t, 'AFFICHEUR = 0x0E;');
    expect(ex.all).toContain('il affiche « E »');
    expect(ex.warnings.join(' ')).toContain('Écrire tout PORTB change aussi RB5 (LED_EGAL) : ici RB5 = 0');
  });

  it('vote: for loop of 3 turns', () => {
    const t = loadTemplate('tp-vote');
    expect(explain(t, 'for (i = 0; i < 3; i++)').all).toContain('Ici : 3 tours (de 0 à 2).');
  });

  it('traffic: Delay_ms(1000) at 8 MHz is 2 000 000 cycles', () => {
    const t = loadTemplate('tp-traffic');
    const ex = explain(t, 'Delay_ms(1000);');
    expect(ex.all).toContain(`Attendre 1 s : Delay_ms fait tourner le PIC dans une boucle vide d’environ 2${THIN_SPACE}000${THIN_SPACE}000 cycles d’instruction (à 8 MHz, 1 cycle = 4 périodes d’horloge = 0,5 µs).`);
  });

  it('traffic: the sensor test reads the LDR divider', () => {
    const t = loadTemplate('tp-traffic');
    const ex = explain(t, 'if (CAPTEUR == 0)');
    expect(ex.all).toContain('Si CAPTEUR (RA3) vaut 0 (il fait sombre)');
    expect(ex.all).toContain('CAPTEUR = 0 → la condition est VRAIE.');
  });

  it('pupitre: TRISB = 0xFF and the 8-bit comparison', () => {
    const t = loadTemplate('tp-pupitre');
    expect(explain(t, 'TRISB = 0xFF;').all).toContain('toutes les broches de PORTB sont des entrées');
    const ex = explain(t, 'if (REPONSES == REPONSE_CORRECTE)');
    expect(ex.all).toContain('Si REPONSES (tout le PORTB) == REPONSE_CORRECTE (0xCA)');
    expect(ex.all).toContain('REPONSES = 0 (0x00) → la condition est FAUSSE.');
    expect(explain(t, 'essais--;').all).toContain('essais diminue de 1 (DECF)');
  });
});

describe('explainLine — interruptions', () => {
  it('RB0/INT: routine header, edge, enable bits, flag clear, toggle', () => {
    const t = loadTemplate('tp5-int-rb0');
    expect(explain(t, 'void interrupt()').all).toContain('vecteur 0004h');
    expect(explain(t, 'OPTION_REG.INTEDG = 1;').all).toContain('front montant (0 → 1)');
    expect(explain(t, 'INTCON.GIE = 1;').all).toContain('sans GIE = 1, aucune interruption n’est prise');
    expect(explain(t, 'INTCON.INTF = 0;').all).toContain('efface le drapeau INTF : sinon, dès le RETFIE, l’interruption recommencerait');
    expect(explain(t, 'LED_INT = !LED_INT;').all).toContain('Inverse la broche RB1');
    expect(explain(t, 'if (INTCON.INTF == 1)').section).toBe('Programme d’interruption');
  });

  it('RBIE: copy of the inputs, flag clear after reading PORTB', () => {
    const t = loadTemplate('tp6-rbie');
    expect(explain(t, 'LED0 = INTER4;').all).toContain('Recopie l’état de l’entrée INTER4 (RB4) sur la sortie RA0');
    expect(explain(t, 'INTCON.RBIF = 0;').all).toContain('après avoir lu PORTB');
    expect(explain(t, 'INTCON.RBIE = 1;').section).toBe('Configuration');
  });
});
