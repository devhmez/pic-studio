// Définition des entrées
#define B4        PORTB.RB4
#define B5        PORTB.RB5
#define B6        PORTB.RB6
#define B7        PORTB.RB7

// Définition des sorties
#define AFFICHEUR PORTA

// Macros pour commander les sorties

// Programme d'interruption : appelé à chaque changement d'état de RB4 à RB7 (appui ET relâchement)
void interrupt() {
    if (INTCON.RBIF == 1) {       // Changement d'état sur RB4 à RB7
        // Lire les boutons : la lecture de PORTB met fin à la condition de changement
        if (B4 == 1) {
            AFFICHEUR = 4;
            Delay_ms(500);
        }
        else if (B5 == 1) {
            AFFICHEUR = 5;
            Delay_ms(500);
        }
        else if (B6 == 1) {
            AFFICHEUR = 6;
            Delay_ms(500);
        }
        else if (B7 == 1) {
            AFFICHEUR = 7;
            Delay_ms(500);
        }
        INTCON.RBIF = 0;          // RBIF peut alors être effacé
    }
}

void main() {
    unsigned char i;

    // Configuration des entrées
    TRISB.RB4 = 1;       // RB4 : entrée B4
    TRISB.RB5 = 1;       // RB5 : entrée B5
    TRISB.RB6 = 1;       // RB6 : entrée B6
    TRISB.RB7 = 1;       // RB7 : entrée B7

    // Configuration des sorties
    TRISA = 0x00;       // PORTA en sortie

    // Configuration des interruptions
    INTCON.RBIE = 1;       // Autoriser l'interruption sur changement de RB4 à RB7
    INTCON.GIE = 1;       // Autoriser les interruptions

    // Initialisation : toutes les sorties à 0
    AFFICHEUR = 0x00;

    // Boucle principale
    while(1) {
        // Compteur de 0 à 9
        for (i = 0; i < 10; i++) {
            AFFICHEUR = i;
            Delay_ms(500);
        }
    }
}
