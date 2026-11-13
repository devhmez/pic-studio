// Course circuits written the way the copilot answers (parts + links), shared by the tests.
import type { AnswerCircuit } from './schema';

const led = (ref: string, couleur: string, nom?: string) => ({ ref, type: 'LED' as const, couleur, ...(nom ? { nom } : {}) });
const ls = (ref: string, valeur = '0', nom?: string) => ({ ref, type: 'LOGICSTATE' as const, valeur, ...(nom ? { nom } : {}) });
const res = (ref: string, valeur: string) => ({ ref, type: 'RES' as const, valeur });
const btn = (ref: string) => ({ ref, type: 'BUTTON' as const });
const link = (de: string, vers: string) => ({ de, vers });

export const EXEMPLE1: AnswerCircuit = {
  horloge_mhz: 1,
  composants: [led('D1', 'BLUE')],
  liaisons: [link('U1.RA0', 'D1.A'), link('D1.K', 'GND')],
};

export const EXEMPLE2: AnswerCircuit = {
  horloge_mhz: 1,
  composants: [ls('LS1', '1', 'BOUTON'), led('D1', 'GREEN')],
  liaisons: [link('LS1', 'U1.RB0'), link('U1.RA0', 'D1.A'), link('D1.K', 'GND')],
};

export const STATUS: AnswerCircuit = {
  horloge_mhz: 1,
  composants: [led('X_SUPERIEUR', 'BLUE'), led('EGALITE', 'GREEN'), led('X_INFERIEUR', 'RED')],
  liaisons: [
    link('U1.RB0', 'X_SUPERIEUR.A'), link('U1.RB1', 'EGALITE.A'), link('U1.RB2', 'X_INFERIEUR.A'),
    link('X_SUPERIEUR.K', 'GND'), link('EGALITE.K', 'GND'), link('X_INFERIEUR.K', 'GND'),
  ],
};

export const DEMUX: AnswerCircuit = {
  horloge_mhz: 1,
  composants: [
    ls('L0', '0'), ls('L1', '0'),
    res('R1', '220'), res('R2', '220'), res('R3', '220'), res('R4', '220'),
    led('D0', 'YELLOW'), led('D1', 'RED'), led('D2', 'GREEN'), led('D3', 'BLUE'),
  ],
  liaisons: [
    link('L0', 'U1.RA0'), link('L1', 'U1.RA1'),
    link('U1.RB0', 'R1.1'), link('R1.2', 'D0.A'), link('D0.K', 'GND'),
    link('U1.RB1', 'R2.1'), link('R2.2', 'D1.A'), link('D1.K', 'GND'),
    link('U1.RB2', 'R3.1'), link('R3.2', 'D2.A'), link('D2.K', 'GND'),
    link('U1.RB3', 'R4.1'), link('R4.2', 'D3.A'), link('D3.K', 'GND'),
  ],
};

export const VOTE: AnswerCircuit = {
  horloge_mhz: 1,
  composants: [
    btn('VOTE_A'), res('R1', '10k'), btn('VOTE_B'), res('R2', '10k'), btn('RESULTAT'), res('R3', '10k'),
    led('CONFIRMATION', 'YELLOW'), { ref: 'AFF', type: '7SEG-BCD', couleur: 'RED' }, led('EGALITE', 'GREEN'),
  ],
  liaisons: [
    link('VDD', 'VOTE_A.1'), link('VOTE_A.2', 'U1.RA0'), link('U1.RA0', 'R1.1'), link('R1.2', 'GND'),
    link('VDD', 'VOTE_B.1'), link('VOTE_B.2', 'U1.RA1'), link('U1.RA1', 'R2.1'), link('R2.2', 'GND'),
    link('VDD', 'RESULTAT.1'), link('RESULTAT.2', 'U1.RA3'), link('U1.RA3', 'R3.1'), link('R3.2', 'GND'),
    link('U1.RA2', 'CONFIRMATION.A'), link('CONFIRMATION.K', 'GND'),
    link('U1.RB0', 'AFF.E0'), link('U1.RB1', 'AFF.E1'), link('U1.RB2', 'AFF.E2'), link('U1.RB3', 'AFF.E3'),
    link('U1.RB5', 'EGALITE.A'), link('EGALITE.K', 'GND'),
  ],
};

export const TRAFFIC: AnswerCircuit = {
  horloge_mhz: 8,
  composants: [
    { ref: 'FEU', type: 'TRAFFIC_LIGHTS' }, { ref: 'LDR1', type: 'TORCH_LDR', valeur: '9' }, res('R1', '1k'),
    { ref: 'AFF', type: '7SEG-BCD', couleur: 'BLUE' },
  ],
  liaisons: [
    link('U1.RA0', 'FEU.R'), link('U1.RA1', 'FEU.A'), link('U1.RA2', 'FEU.G'),
    link('VDD', 'LDR1.1'), link('LDR1.2', 'U1.RA3'), link('U1.RA3', 'R1.1'), link('R1.2', 'GND'),
    link('U1.RB0', 'AFF.E0'), link('U1.RB1', 'AFF.E1'), link('U1.RB2', 'AFF.E2'), link('U1.RB3', 'AFF.E3'),
  ],
};

export const PUPITRE: AnswerCircuit = {
  horloge_mhz: 1,
  composants: [
    btn('VALIDER'), res('R1', '10k'), led('D4', 'BLUE', 'GAME_OVER'), led('D2', 'RED', 'NO'), led('D3', 'GREEN', 'YES'),
    ls('DEMARRER'), ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ls(`Q${i}`)),
  ],
  liaisons: [
    link('VDD', 'VALIDER.1'), link('VALIDER.2', 'U1.RA0'), link('U1.RA0', 'R1.1'), link('R1.2', 'GND'),
    link('U1.RA1', 'D4.A'), link('D4.K', 'GND'), link('U1.RA2', 'D2.A'), link('D2.K', 'GND'),
    link('U1.RA3', 'D3.A'), link('D3.K', 'GND'), link('DEMARRER', 'U1.RA4'),
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => link(`Q${i}`, `U1.RB${i}`)),
  ],
};

/** Inputs and outputs interleaved, a pull-up button, an active-low LED. */
export const MIXED: AnswerCircuit = {
  horloge_mhz: 4,
  composants: [led('D1', 'RED'), ls('S1', '1'), btn('BP'), res('R1', '10k'), led('D2', 'GREEN'), res('R2', '220')],
  liaisons: [
    link('U1.RA0', 'D1.A'), link('D1.K', 'GND'), link('S1', 'U1.RA1'),
    link('GND', 'BP.1'), link('BP.2', 'U1.RB4'), link('U1.RB4', 'R1.1'), link('R1.2', 'VDD'),
    link('VDD', 'D2.A'), link('D2.K', 'R2.1'), link('R2.2', 'U1.RB7'),
  ],
};

/** The Ch1 drawing: crystal + 22 pF on OSC1/OSC2, MCLR pulled up with a reset button (decorative parts). */
export const OSCILLATOR: AnswerCircuit = {
  horloge_mhz: 4,
  composants: [
    { ref: 'X1', type: 'CRYSTAL', valeur: '4MHz' }, { ref: 'C1', type: 'CAP', valeur: '22pF' }, { ref: 'C2', type: 'CAP', valeur: '22pF' },
    led('D1', 'RED'),
  ],
  liaisons: [
    link('U1.OSC1', 'X1.1'), link('U1.OSC2', 'X1.2'), link('X1.1', 'C1.1'), link('C1.2', 'GND'), link('X1.2', 'C2.1'), link('C2.2', 'GND'),
    link('U1.RB0', 'D1.A'), link('D1.K', 'GND'),
  ],
};

export const COURSE_CIRCUITS: Record<string, AnswerCircuit> = {
  EXEMPLE1, EXEMPLE2, STATUS, DEMUX, VOTE, TRAFFIC, PUPITRE, MIXED, OSCILLATOR,
};
