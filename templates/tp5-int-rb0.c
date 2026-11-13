// Définition des entrées
#define BOUTON  PORTB.RB0

// Définition des sorties
#define LED_INT PORTB.RB1
#define LED_CLI PORTB.RB2

// Macros pour commander les sorties
#define LED_ON(pin)  (pin = 1)
#define LED_OFF(pin) (pin = 0)

// Programme d'interruption : appelé à chaque front montant sur RB0/INT
void interrupt() {
    if (INTCON.INTF == 1) {       // Interruption RB0/INT
        LED_INT = !LED_INT;       // Inverser la LED
        INTCON.INTF = 0;          // Effacer le drapeau INTF
    }
}

void main() {

    // Configuration des entrées
    TRISB.RB0 = 1;       // RB0 : entrée BOUTON

    // Configuration des sorties
    TRISB.RB1 = 0;       // RB1 : sortie LED_INT
    TRISB.RB2 = 0;       // RB2 : sortie LED_CLI

    // Configuration des interruptions
    OPTION_REG.INTEDG = 1;       // Front montant sur RB0/INT
    INTCON.INTE = 1;       // Autoriser l'interruption RB0/INT
    INTCON.GIE = 1;       // Autoriser les interruptions

    // Initialisation : toutes les sorties à 0
    LED_OFF(LED_INT);
    LED_OFF(LED_CLI);

    // Boucle principale
    while(1) {
        LED_ON(LED_CLI);
        Delay_ms(500);
        LED_OFF(LED_CLI);
        Delay_ms(500);
    }
}
