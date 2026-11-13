// Définition des entrées
#define VALIDER       PORTA.RA0
#define DEMARRER      PORTA.RA4
#define REPONSES      PORTB           // Q0..Q7 sur RB0..RB7

// Définition des sorties
#define LED_GAME_OVER PORTA.RA1       // LED bleue
#define LED_NO        PORTA.RA2       // LED rouge
#define LED_YES       PORTA.RA3       // LED verte

// Macros pour commander les sorties
#define LED_ON(pin)  (pin = 1)
#define LED_OFF(pin) (pin = 0)

// Réponses attendues : Q7..Q0 = 1 1 0 0 1 0 1 0
#define REPONSE_CORRECTE 0xCA

void main() {
    unsigned char essais; unsigned char reussi;

    // Configuration des entrées
    TRISA.RA0 = 1;       // RA0 : entrée VALIDER
    TRISA.RA4 = 1;       // RA4 : entrée DEMARRER
    TRISB = 0xFF;       // PORTB en entrée

    // Configuration des sorties
    TRISA.RA1 = 0;       // RA1 : sortie LED_GAME_OVER
    TRISA.RA2 = 0;       // RA2 : sortie LED_NO
    TRISA.RA3 = 0;       // RA3 : sortie LED_YES

    // Initialisation : toutes les sorties à 0
    LED_OFF(LED_GAME_OVER);
    LED_OFF(LED_NO);
    LED_OFF(LED_YES);

    // Boucle principale
    while(1) {
        while (DEMARRER == 0);       // Attente du démarrage
        essais = 3;
        reussi = 0;
        // Trois essais au maximum
        while (essais > 0 && reussi == 0) {
            while (VALIDER == 0);       // Attente de la validation
            if (REPONSES == REPONSE_CORRECTE) {
                // Toutes les réponses sont correctes
                LED_ON(LED_YES);
                Delay_ms(3000);
                LED_OFF(LED_YES);
                reussi = 1;
            }
            else {
                // Erreur : un essai de moins
                LED_ON(LED_NO);
                Delay_ms(3000);
                LED_OFF(LED_NO);
                essais--;
            }
            while (VALIDER == 1);       // Attente du relâchement du bouton
        }
        // Trois essais infructueux : GAME OVER
        if (reussi == 0) {
            LED_ON(LED_GAME_OVER);
            Delay_ms(3000);
            LED_OFF(LED_GAME_OVER);
        }
        while (DEMARRER == 1);       // Attente de la remise à 0 de DEMARRER
    }
}
