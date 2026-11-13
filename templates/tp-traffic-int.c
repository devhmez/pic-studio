// Définition des entrées
#define CAPTEUR   PORTB.RB0

// Définition des sorties
#define ROUGE     PORTB.RB2
#define ORANGE    PORTB.RB3
#define VERT      PORTB.RB4
#define AFFICHEUR PORTA

// Macros pour commander les sorties
#define LED_ON(pin)  (pin = 1)
#define LED_OFF(pin) (pin = 0)

// Programme d'interruption : appelé quand le capteur passe de 1 à 0 (front descendant sur RB0/INT)
void interrupt() {
    if (INTCON.INTF == 1) {       // Interruption RB0/INT : le capteur passe à 0 (nuit)
        // Mode nuit : orange clignotant et "A" tant que le capteur est à 0
        while (CAPTEUR == 0) {
            LED_OFF(ROUGE);
            LED_OFF(ORANGE);
            LED_OFF(VERT);
            AFFICHEUR = 0x0A;       // Afficher la lettre 'A'
            LED_ON(ORANGE);
            Delay_ms(500);
            LED_OFF(ORANGE);
            Delay_ms(500);
        }
        INTCON.INTF = 0;          // Effacer le drapeau INTF
    }
}

void main() {
    unsigned char compte;

    // Configuration des entrées
    TRISB.RB0 = 1;       // RB0 : entrée CAPTEUR

    // Configuration des sorties
    TRISA = 0x00;       // PORTA en sortie
    TRISB.RB2 = 0;       // RB2 : sortie ROUGE
    TRISB.RB3 = 0;       // RB3 : sortie ORANGE
    TRISB.RB4 = 0;       // RB4 : sortie VERT

    // Configuration des interruptions
    OPTION_REG.INTEDG = 0;       // Front descendant sur RB0/INT
    INTCON.INTE = 1;       // Autoriser l'interruption RB0/INT
    INTCON.GIE = 1;       // Autoriser les interruptions

    // Initialisation : toutes les sorties à 0
    LED_OFF(ROUGE);
    LED_OFF(ORANGE);
    LED_OFF(VERT);
    AFFICHEUR = 0x00;

    // Boucle principale
    while(1) {
        // Rouge : décompte de 9 à 0 (feux réécrits chaque seconde, utile au retour du mode nuit)
        for (compte = 0; compte < 10; compte++) {
            LED_ON(ROUGE);
            LED_OFF(ORANGE);
            LED_OFF(VERT);
            AFFICHEUR = 9 - compte;
            Delay_ms(1000);
        }
        // Orange : décompte de 2 à 0
        for (compte = 0; compte < 3; compte++) {
            LED_OFF(ROUGE);
            LED_ON(ORANGE);
            LED_OFF(VERT);
            AFFICHEUR = 2 - compte;
            Delay_ms(1000);
        }
        // Vert : décompte de 9 à 0
        for (compte = 0; compte < 10; compte++) {
            LED_OFF(ROUGE);
            LED_OFF(ORANGE);
            LED_ON(VERT);
            AFFICHEUR = 9 - compte;
            Delay_ms(1000);
        }
    }
}
