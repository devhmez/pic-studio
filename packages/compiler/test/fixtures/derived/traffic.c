// Définition des entrées
#define CAPTEUR     PORTA.RA3

// Définition des sorties
#define LED_ROUGE   PORTA.RA0
#define LED_ORANGE  PORTA.RA1
#define LED_VERTE   PORTA.RA2
#define AFFICHEUR   PORTB

// Fonction delay_ms() fournie  (coller ici le corps donné par l'enseignant)
void delay_ms(unsigned int ms) {
    /* corps fourni */
}

void main() {
    unsigned char i;

    // Configuration des entrées/sorties
    TRISA.RA0 = 0;      // RA0 : sortie LED rouge
    TRISA.RA1 = 0;      // RA1 : sortie LED orange
    TRISA.RA2 = 0;      // RA2 : sortie LED verte
    TRISA.RA3 = 1;      // RA3 : entrée capteur de luminosité
    TRISB = 0x00;       // PORTB en sortie (afficheur BCD)

    // Initialisation
    LED_ROUGE = 0; LED_ORANGE = 0; LED_VERTE = 0;
    AFFICHEUR = 0;

    // Traitement
    while(1) {
        if (CAPTEUR == 0) {               // Mode nuit
            LED_ROUGE = 0; LED_VERTE = 0;
            AFFICHEUR = 0x0A;             // lettre "A"
            LED_ORANGE = 1;  delay_ms(500);
            LED_ORANGE = 0;  delay_ms(500);
        }
        else {                            // Mode jour
            // Rouge : 10 s, décompte 9 -> 0
            LED_ROUGE = 1; LED_ORANGE = 0; LED_VERTE = 0;
            for (i = 10; i > 0; i--) { AFFICHEUR = i - 1; delay_ms(1000); }
            // Orange : décompte 2 -> 0
            LED_ROUGE = 0; LED_ORANGE = 1; LED_VERTE = 0;
            for (i = 3; i > 0; i--) { AFFICHEUR = i - 1; delay_ms(1000); }
            // Vert : 10 s, décompte 9 -> 0
            LED_ROUGE = 0; LED_ORANGE = 0; LED_VERTE = 1;
            for (i = 10; i > 0; i--) { AFFICHEUR = i - 1; delay_ms(1000); }
        }
    }
}
