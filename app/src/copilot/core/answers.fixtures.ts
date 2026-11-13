// Answers the copilot could send (course circuits + MikroC code + tests), for the pipeline tests.
import { DEMUX, EXEMPLE2, STATUS, VOTE } from './fixtures';
import type { CopilotAnswer } from './schema';

export const EXEMPLE2_CODE = `// Définition des entrées
#define BOUTON PORTB.RB0

// Définition des sorties
#define LED PORTA.RA0

void main() {
    // Configuration des entrées
    TRISB.RB0 = 1;
    // Configuration des sorties
    TRISA.RA0 = 0;
    // Initialisation
    LED = 0;
    // Boucle principale
    while(1) {
        if (BOUTON == 1) {
            LED = 1;
        }
        else {
            LED = 0;
        }
    }
}
`;

export const EXEMPLE2_ANSWER: CopilotAnswer = {
  reponse: 'La LED sur RA0 suit l’interrupteur branché sur RB0.',
  circuit: EXEMPLE2,
  code: EXEMPLE2_CODE,
  tests: [
    { description: 'Interrupteur à 1 : LED allumée', actions: [{ ref: 'LS1', etat: 1 }, { attendre_ms: 10 }], attendu: [{ ref: 'D1', etat: 1 }] },
    { description: 'Interrupteur à 0 : LED éteinte', actions: [{ ref: 'LS1', etat: 0 }, { attendre_ms: 10 }], attendu: [{ ref: 'D1', etat: 0 }] },
  ],
};

export const DEMUX_CODE = `// Définition des entrées
#define L0 PORTA.RA0
#define L1 PORTA.RA1

// Définition des sorties
#define D0 PORTB.RB0
#define D1 PORTB.RB1
#define D2 PORTB.RB2
#define D3 PORTB.RB3

void main() {
    TRISA.RA0 = 1;
    TRISA.RA1 = 1;
    TRISB.RB0 = 0;
    TRISB.RB1 = 0;
    TRISB.RB2 = 0;
    TRISB.RB3 = 0;
    D0 = 0; D1 = 0; D2 = 0; D3 = 0;
    while(1) {
        if (L1 == 0 && L0 == 0) { D0 = 1; D1 = 0; D2 = 0; D3 = 0; }
        else if (L1 == 0 && L0 == 1) { D0 = 0; D1 = 1; D2 = 0; D3 = 0; }
        else if (L1 == 1 && L0 == 0) { D0 = 0; D1 = 0; D2 = 1; D3 = 0; }
        else { D0 = 0; D1 = 0; D2 = 0; D3 = 1; }
    }
}
`;

const demuxTest = (l1: 0 | 1, l0: 0 | 1, lit: string) => ({
  description: `L1=${l1} L0=${l0} : ${lit} allumée`,
  actions: [{ ref: 'L1', etat: l1 }, { ref: 'L0', etat: l0 }, { attendre_ms: 5 }],
  attendu: ['D0', 'D1', 'D2', 'D3'].map((d) => ({ ref: d, etat: (d === lit ? 1 : 0) as 0 | 1 })),
});

export const DEMUX_ANSWER: CopilotAnswer = {
  reponse: 'Démultiplexeur 1 vers 4 : une seule LED allumée selon L1 L0.',
  circuit: DEMUX,
  code: DEMUX_CODE,
  tests: [demuxTest(0, 0, 'D0'), demuxTest(0, 1, 'D1'), demuxTest(1, 0, 'D2'), demuxTest(1, 1, 'D3')],
};

/** Status TP: z = x - y and the flags (else-if chain, as the organigramme). */
export const STATUS_CODE = `// Définition des sorties
#define LED_SUP PORTB.F0
#define LED_EGAL PORTB.F1
#define LED_INF PORTB.F2

// Macros pour commander les sorties
#define LED_ON(pin)  (pin = 1)
#define LED_OFF(pin) (pin = 0)

void main() {
    unsigned char x; unsigned char y; unsigned char z;
    // Configuration  i/o
    TRISB = 0x00;
    // Initialisation
    x = 5; y = 6;
    // Traitement
    while(1) {
        LED_OFF(LED_SUP); LED_OFF(LED_EGAL); LED_OFF(LED_INF);
        z = x - y;
        if (STATUS.F2 == 1) { LED_ON(LED_EGAL); }
        else if (STATUS.F0 == 1) { LED_ON(LED_SUP); }
        else { LED_ON(LED_INF); }
    }
}
`;

export const STATUS_ANSWER: CopilotAnswer = {
  reponse: 'Comparaison de x et y avec les drapeaux Z et C.',
  circuit: STATUS,
  code: STATUS_CODE,
  tests: [{ description: 'x=5, y=6 : LED inférieur', actions: [{ attendre_ms: 20 }], attendu: [{ ref: 'X_INFERIEUR', etat: 1 }, { ref: 'EGALITE', etat: 0 }, { ref: 'X_SUPERIEUR', etat: 0 }] }],
};

/** Vote-like code with button waits, a counter and a 7SEG-BCD on PORTB. */
export const VOTE_CODE = `// Définition des entrées
#define VOTE_A PORTA.RA0
#define VOTE_B PORTA.RA1
#define RESULTAT PORTA.RA3

// Définition des sorties
#define CONFIRMATION PORTA.RA2
#define EGALITE PORTB.RB5

void main() {
    unsigned char var1;
    unsigned char var2;
    TRISA = 0x0B;
    TRISB = 0x00;
    var1 = 0;
    var2 = 0;
    PORTB = 0x0F;
    Delay_ms(500);
    while(1) {
        if (VOTE_A == 1) {
            var1++;
            CONFIRMATION = 1;
            Delay_ms(500);
            CONFIRMATION = 0;
            while (VOTE_A == 1);
        }
        else if (VOTE_B == 1) {
            var2++;
            CONFIRMATION = 1;
            Delay_ms(500);
            CONFIRMATION = 0;
            while (VOTE_B == 1);
        }
        else if (RESULTAT == 1) {
            if (var1 == var2) {
                PORTB = 0x0E;
            }
            else if (var1 > var2) {
                PORTB = 0x0A;
            }
            else {
                PORTB = 0x0B;
            }
            while (RESULTAT == 1);
        }
    }
}
`;

export const VOTE_ANSWER: CopilotAnswer = {
  reponse: 'Boîtier de vote : A, B puis résultat sur l’afficheur.',
  circuit: VOTE,
  code: VOTE_CODE,
  tests: [
    { description: 'Au démarrage : F', actions: [{ attendre_ms: 100 }], attendu: [{ afficheur: 'AFF', valeur: 'F' }] },
    {
      description: 'Deux votes A puis résultat : A',
      actions: [{ attendre_ms: 600 }, { ref: 'VOTE_A', appui_ms: 100 }, { attendre_ms: 700 }, { ref: 'VOTE_A', appui_ms: 100 }, { attendre_ms: 700 }, { ref: 'RESULTAT', appui_ms: 100 }, { attendre_ms: 50 }],
      attendu: [{ afficheur: 'AFF', valeur: 'A' }],
    },
  ],
};
