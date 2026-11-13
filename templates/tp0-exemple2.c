// Définition des entrées
#define BOUTON PORTB.RB0

// Définition des sorties
#define LED    PORTA.RA0

// Macros pour commander les sorties

void main() {

    // Configuration des entrées
    TRISB.RB0 = 1;       // RB0 : entrée BOUTON

    // Configuration des sorties
    TRISA = 0x00;       // PORTA en sortie

    // Initialisation : toutes les sorties à 0
    LED = 0;

    // Boucle principale
    while(1) {
        // La LED suit le bouton
        if (BOUTON == 1) {
            LED = 1;
        }
        else {
            LED = 0;
        }
    }
}
