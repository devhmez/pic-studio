// Définition des entrées
#define CAPTEUR   PORTA.RA3

// Définition des sorties
#define ROUGE     PORTA.RA0
#define ORANGE    PORTA.RA1
#define VERT      PORTA.RA2
#define AFFICHEUR PORTB

// Macros pour commander les sorties
#define LED_ON(pin)  (pin = 1)
#define LED_OFF(pin) (pin = 0)

void main() {
    unsigned char compte;

    // Configuration des entrées
    TRISA.RA3 = 1;       // RA3 : entrée CAPTEUR

    // Configuration des sorties
    TRISA.RA0 = 0;       // RA0 : sortie ROUGE
    TRISA.RA1 = 0;       // RA1 : sortie ORANGE
    TRISA.RA2 = 0;       // RA2 : sortie VERT
    TRISB = 0x00;       // PORTB en sortie

    // Initialisation : toutes les sorties à 0
    LED_OFF(ROUGE);
    LED_OFF(ORANGE);
    LED_OFF(VERT);
    AFFICHEUR = 0x00;

    // Boucle principale
    while(1) {
        // Lecture du capteur de luminosité (une fois par cycle : le mode nuit attend la fin du cycle de jour)
        if (CAPTEUR == 0) {
            // Mode nuit : orange clignotant, afficheur "A"
            LED_OFF(ROUGE);
            LED_OFF(VERT);
            AFFICHEUR = 0x0A;       // Afficher la lettre 'A'
            LED_ON(ORANGE);
            Delay_ms(500);
            LED_OFF(ORANGE);
            Delay_ms(500);
        }
        else {
            // Mode jour : rouge 10 s, décompte de 9 à 0
            LED_ON(ROUGE);
            LED_OFF(ORANGE);
            LED_OFF(VERT);
            for (compte = 0; compte < 10; compte++) {
                AFFICHEUR = 9 - compte;
                Delay_ms(1000);
            }
            // Orange : décompte de 2 à 0 (3 valeurs, 1 s chacune : 3 s ; l'énoncé dit 2 s)
            LED_OFF(ROUGE);
            LED_ON(ORANGE);
            LED_OFF(VERT);
            for (compte = 0; compte < 3; compte++) {
                AFFICHEUR = 2 - compte;
                Delay_ms(1000);
            }
            // Vert : 10 s, décompte de 9 à 0
            LED_OFF(ROUGE);
            LED_OFF(ORANGE);
            LED_ON(VERT);
            for (compte = 0; compte < 10; compte++) {
                AFFICHEUR = 9 - compte;
                Delay_ms(1000);
            }
        }
    }
}
