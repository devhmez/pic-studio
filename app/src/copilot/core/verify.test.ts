// Verification of a copilot answer: layout, compilation, prof-style rewrite, consistency, simulated tests.
import { describe, expect, it } from 'vitest';
import { blankProject } from '../../state/store';
import { DEMUX_ANSWER, STATUS_ANSWER, VOTE_ANSWER } from './answers.fixtures';
import { layoutCircuit } from './circuit';
import { EXEMPLE1, TRAFFIC } from './fixtures';
import type { CopilotAnswer } from './schema';
import { parseDisplayValue, runTest } from './simtests';
import { compile } from '@pic/compiler';
import { verifyAnswer, type ProjectState } from './verify';

function blank(): ProjectState {
  const p = blankProject();
  return { name: 'Nouveau projet', schematic: p.schematic, source: p.source, clockHz: p.clockHz };
}

describe('verifyAnswer', () => {
  it('accepts the demux and rewrites it in the prof style (sections, TRIS comments), all tests passing', async () => {
    const r = await verifyAnswer(DEMUX_ANSWER, blank());
    expect(r.ok).toBe(true);
    expect(r.style).toBe('prof');
    expect(r.program).not.toBeNull();
    expect(r.source).toContain('// Configuration des entrées');
    expect(r.source).toContain('TRISA.RA0 = 1;       // RA0 : entrée L0');
    expect(r.source).toContain('// Boucle principale');
    expect(r.tests).toHaveLength(4);
    expect(r.tests.every((t) => t.passed)).toBe(true);
    expect(r.schematicFromAnswer).toBe(true);
    expect(r.clockHz).toBe(1_000_000);
  });

  it('runs the vote scenario (buttons, delays, 7SEG-BCD) and the status flags in simulation', async () => {
    const vote = await verifyAnswer(VOTE_ANSWER, blank());
    expect(vote.tests.map((t) => t.passed)).toEqual([true, true]);
    const status = await verifyAnswer(STATUS_ANSWER, blank());
    expect(status.ok).toBe(true);
    expect(status.source).toContain('#define LED_ON(pin)  (pin = 1)');
  });

  it('reports compile errors with their line, and unknown parts / pins of the circuit', async () => {
    const bad: CopilotAnswer = {
      reponse: 'x',
      circuit: { horloge_mhz: 1, composants: [{ ref: 'D1', type: 'LED' }], liaisons: [{ de: 'U1.RA0', vers: 'D1.A' }, { de: 'D1.K', vers: 'GND' }, { de: 'U1.RA7', vers: 'D2.A' }] },
      code: 'void main() {\n    TRISA = 0\n}\n',
    };
    const r = await verifyAnswer(bad, blank());
    expect(r.ok).toBe(false);
    expect(r.compiled).toBe(false);
    expect(r.problems.compile[0]).toMatch(/^ligne \d+ : /);
    expect(r.problems.circuit.join(' ')).toMatch(/RA7|D2/);
    expect(r.style).toBe('copilote');
  });

  it('flags code that uses a pin with nothing wired, and parts the code never drives', async () => {
    const r = await verifyAnswer({
      reponse: 'x',
      circuit: { horloge_mhz: 1, composants: [{ ref: 'D1', type: 'LED' }, { ref: 'D2', type: 'LED' }], liaisons: [{ de: 'U1.RB0', vers: 'D1.A' }, { de: 'D1.K', vers: 'GND' }, { de: 'U1.RB2', vers: 'D2.A' }, { de: 'D2.K', vers: 'GND' }] },
      code: '#define LED PORTB.RB1\nvoid main() {\n    TRISB.RB1 = 0;\n    while(1) {\n        LED = 1;\n    }\n}\n',
    }, blank());
    expect(r.problems.consistency.join(' ')).toMatch(/RB1/);
    expect(r.warnings.join(' ')).toMatch(/RB0|RB2/);
  });

  it('asks for the missing circuit when only code comes for an empty project, and keeps the current code when only the circuit changes', async () => {
    const codeOnly = await verifyAnswer({ reponse: 'x', code: 'void main() {\n    TRISB = 0;\n}\n' }, blank());
    expect(codeOnly.problems.missing.join(' ')).toMatch(/circuit/);
    const project = { ...blank(), source: DEMUX_ANSWER.code! };
    const circuitOnly = await verifyAnswer({ reponse: 'x', circuit: DEMUX_ANSWER.circuit }, project);
    expect(circuitOnly.style).toBe('actuel');
    expect(circuitOnly.source).toBe(DEMUX_ANSWER.code);
    expect(circuitOnly.ok).toBe(true);
  });

  it('keeps the copilot’s own text when the program model cannot represent it', async () => {
    const odd = `#define LED PORTB.RB0
unsigned char t[3] = {1, 0, 1};
void main() {
    unsigned char i;
    TRISB.RB0 = 0;
    while(1) {
        for (i = 0; i < 3; i++) { LED = t[i]; Delay_ms(10); }
    }
}
`;
    const r = await verifyAnswer({ reponse: 'x', circuit: EXEMPLE1_ON_RB0, code: odd }, blank());
    expect(r.compiled).toBe(true);
    expect(r.style).toBe('copilote');
    expect(r.program).toBeNull();
    expect(r.source).toBe(odd);
  });
});

const EXEMPLE1_ON_RB0 = { ...EXEMPLE1, liaisons: [{ de: 'U1.RB0', vers: 'D1.A' }, { de: 'D1.K', vers: 'GND' }] };

describe('simulated tests', () => {
  const traffic = layoutCircuit(TRAFFIC);
  const code = `void main() {
    TRISA = 0x08;
    TRISB = 0x00;
    while(1) {
        if (PORTA.RA3 == 1) { PORTA = 0x01; PORTB = 0x09; }
        else { PORTA = 0x02; PORTB = 0x0A; }
    }
}
`;
  const build = compile(code, { clockHz: 8_000_000 });
  const target = { schematic: traffic.schematic, program: build.program!, clockHz: 8_000_000 };
  const idOf = (ref: string) => traffic.ids[ref.toUpperCase()];

  it('reads traffic lamps, the 7-segment value and PIC pins; drives the LDR', () => {
    const day = runTest({ description: 'jour', actions: [{ ref: 'LDR1', etat: 1 }, { attendre_ms: 5 }], attendu: [{ ref: 'FEU.R', etat: 1 }, { ref: 'FEU.A', etat: 0 }, { afficheur: 'AFF', valeur: '9' }, { ref: 'RB3', etat: 1 }] }, target, idOf);
    expect(day.details).toEqual([]);
    expect(day.passed).toBe(true);
    const night = runTest({ description: 'nuit', actions: [{ ref: 'LDR1', etat: 0 }, { attendre_ms: 5 }], attendu: [{ ref: 'feu.orange', etat: 1 }, { afficheur: 'aff', valeur: 'A' }, { ref: 'U1.RA0', etat: 0 }] }, target, idOf);
    expect(night.passed).toBe(true);
  });

  it('explains failures in French', () => {
    const r = runTest({ description: 'faux', actions: [{ ref: 'LDR1', etat: 0 }, { ref: 'XX', etat: 1 }], attendu: [{ ref: 'FEU.R', etat: 1 }, { afficheur: 'AFF', valeur: '3' }, { ref: 'NOPE', etat: 1 }] }, target, idOf);
    expect(r.passed).toBe(false);
    expect(r.details).toEqual([
      'action sur « XX » : composant introuvable dans le schéma',
      'FEU.R (feu rouge) : attendu allumé, obtenu éteint',
      'AFF : attendu « 3 », obtenu « A »',
      '« NOPE » introuvable dans le schéma',
    ]);
  });

  it('parses display values', () => {
    expect(parseDisplayValue('A')).toBe(10);
    expect(parseDisplayValue('b')).toBe(11);
    expect(parseDisplayValue('0x0E')).toBe(14);
    expect(parseDisplayValue('15')).toBe(15);
    expect(parseDisplayValue('16')).toBeNull();
    expect(parseDisplayValue('Z')).toBeNull();
  });
});
