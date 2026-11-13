// Définition des entrées
#define VALIDER        PORTA.RA0
#define DEMARRER       PORTA.RA4
#define REPONSES       PORTB

// Définition des sorties
#define LED_GAME_OVER  PORTA.RA1     // LED bleue
#define LED_NO         PORTA.RA2     // LED rouge
#define LED_YES        PORTA.RA3     // LED verte

#define REPONSE_CORRECTE 0xCA        // Q7..Q0 = 1 1 0 0 1 0 1 0

void main() {
    unsigned char essais;
    unsigned char reussi;

    // Configuration des entrées/sorties
    TRISA = 0x11;        // RA0, RA4 en entrée ; RA1, RA2, RA3 en sortie
    TRISB = 0xFF;        // PORTB en entrée (réponses Q0..Q7)

    // Initialisation
    LED_YES = 0; LED_NO = 0; LED_GAME_OVER = 0;

    // Traitement
    while(1) {
        while (DEMARRER == 0);              // attente du démarrage
        essais = 3; reussi = 0;
        while (essais > 0 && reussi == 0) {
            while (VALIDER == 0);           // attente de la validation
            if (REPONSES == REPONSE_CORRECTE) {
                LED_YES = 1; Delay_ms(3000); LED_YES = 0;
                reussi = 1;
            }
            else {
                LED_NO = 1; Delay_ms(3000); LED_NO = 0;
                essais = essais - 1;
            }
        }
        if (reussi == 0) {                  // trois essais infructueux
            LED_GAME_OVER = 1; Delay_ms(3000); LED_GAME_OVER = 0;
        }
    }
}
