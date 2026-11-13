// Définition des entrées
#define INTER4 PORTB.RB4
#define INTER5 PORTB.RB5
#define INTER6 PORTB.RB6
#define INTER7 PORTB.RB7

// Définition des sorties
#define LED0   PORTA.RA0
#define LED1   PORTA.RA1
#define LED2   PORTA.RA2
#define LED3   PORTA.RA3

// Macros pour commander les sorties

// Programme d'interruption : appelé à chaque changement de RB4 à RB7
void interrupt() {
    if (INTCON.RBIF == 1) {       // Changement d'état sur RB4 à RB7
        // Recopier RB4..RB7 sur RA0..RA3 : la lecture de PORTB met fin à la condition de changement
        LED0 = INTER4;
        LED1 = INTER5;
        LED2 = INTER6;
        LED3 = INTER7;
        INTCON.RBIF = 0;          // RBIF peut alors être effacé
    }
}

void main() {

    // Configuration des entrées
    TRISB.RB4 = 1;       // RB4 : entrée INTER4
    TRISB.RB5 = 1;       // RB5 : entrée INTER5
    TRISB.RB6 = 1;       // RB6 : entrée INTER6
    TRISB.RB7 = 1;       // RB7 : entrée INTER7

    // Configuration des sorties
    TRISA.RA0 = 0;       // RA0 : sortie LED0
    TRISA.RA1 = 0;       // RA1 : sortie LED1
    TRISA.RA2 = 0;       // RA2 : sortie LED2
    TRISA.RA3 = 0;       // RA3 : sortie LED3

    // Configuration des interruptions
    INTCON.RBIE = 1;       // Autoriser l'interruption sur changement de RB4 à RB7
    INTCON.GIE = 1;       // Autoriser les interruptions

    // Initialisation
    // Afficher l'état des interrupteurs dès le démarrage
    LED0 = INTER4;
    LED1 = INTER5;
    LED2 = INTER6;
    LED3 = INTER7;

    // Boucle principale
    while(1) {
        // Attente des interruptions
    }
}
