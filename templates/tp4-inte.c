// Définition des entrées
#define BOUTON    PORTB.RB0

// Définition des sorties
#define LED       PORTB.RB3
#define AFFICHEUR PORTA

// Macros pour commander les sorties
#define LED_ON(pin)  (pin = 1)
#define LED_OFF(pin) (pin = 0)

// Variables globales
unsigned char j;

// Programme d'interruption : appelé à chaque appui sur le bouton (front montant sur RB0/INT)
void interrupt() {
    if (INTCON.INTF == 1) {       // Interruption RB0/INT : appui sur le bouton
        // La LED rouge clignote 3 fois
        for (j = 0; j < 3; j++) {
            LED_ON(LED);
            Delay_ms(500);
            LED_OFF(LED);
            Delay_ms(500);
        }
        INTCON.INTF = 0;          // Remettre le drapeau à zéro
    }
}

void main() {
    unsigned char i;

    // Configuration des entrées
    TRISB.RB0 = 1;       // RB0 : entrée BOUTON

    // Configuration des sorties
    TRISA = 0x00;       // PORTA en sortie
    TRISB.RB3 = 0;       // RB3 : sortie LED

    // Configuration des interruptions
    OPTION_REG.INTEDG = 1;       // Front montant sur RB0/INT
    INTCON.INTE = 1;       // Autoriser l'interruption RB0/INT
    INTCON.GIE = 1;       // Autoriser les interruptions

    // Initialisation : toutes les sorties à 0
    LED_OFF(LED);
    AFFICHEUR = 0x00;

    // Boucle principale
    while(1) {
        // Compteur de 0 à 9 : le programme principal ne lit jamais le bouton
        for (i = 0; i < 10; i++) {
            AFFICHEUR = i;
            Delay_ms(500);
        }
    }
}
