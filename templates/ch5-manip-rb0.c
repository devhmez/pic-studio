// Définition des entrées
#define BOUTON    PORTB.RB0

// Définition des sorties
#define LED_ROUGE PORTA.RA1
#define LED_VERTE PORTA.RA2

// Macros pour commander les sorties
#define LED_ON(pin)  (pin = 1)
#define LED_OFF(pin) (pin = 0)

// Variables globales
unsigned char j;

// Programme d'interruption : appelé à chaque appui sur le bouton (front montant sur RB0/INT)
void interrupt() {
    if (INTCON.INTF == 1) {       // Interruption RB0/INT
        // Éteindre la LED verte pendant le traitement
        LED_OFF(LED_VERTE);
        // La LED rouge clignote 2 fois
        for (j = 0; j < 2; j++) {
            LED_ON(LED_ROUGE);
            Delay_ms(500);
            LED_OFF(LED_ROUGE);
            Delay_ms(500);
        }
        INTCON.INTF = 0;          // Effacer le drapeau INTF
    }
}

void main() {
    unsigned char i;

    // Configuration des entrées
    TRISB.RB0 = 1;       // RB0 : entrée BOUTON

    // Configuration des sorties
    TRISA.RA1 = 0;       // RA1 : sortie LED_ROUGE
    TRISA.RA2 = 0;       // RA2 : sortie LED_VERTE

    // Configuration des interruptions
    OPTION_REG.INTEDG = 1;       // Front montant sur RB0/INT
    INTCON.INTE = 1;       // Autoriser l'interruption RB0/INT
    INTCON.GIE = 1;       // Autoriser les interruptions

    // Initialisation : toutes les sorties à 0
    LED_OFF(LED_ROUGE);
    LED_OFF(LED_VERTE);

    // Boucle principale
    while(1) {
        // La LED verte clignote 4 fois
        for (i = 0; i < 4; i++) {
            LED_ON(LED_VERTE);
            Delay_ms(500);
            LED_OFF(LED_VERTE);
            Delay_ms(500);
        }
    }
}
