// Définition des entrées
#define L0 PORTA.RA0
#define L1 PORTA.RA1

// Définition des sorties
#define D0 PORTB.RB0
#define D1 PORTB.RB1
#define D2 PORTB.RB2
#define D3 PORTB.RB3

// Macros pour commander les sorties

void main() {

    // Configuration des entrées
    TRISA.RA0 = 1;       // RA0 : entrée L0
    TRISA.RA1 = 1;       // RA1 : entrée L1

    // Configuration des sorties
    TRISB.RB0 = 0;       // RB0 : sortie D0
    TRISB.RB1 = 0;       // RB1 : sortie D1
    TRISB.RB2 = 0;       // RB2 : sortie D2
    TRISB.RB3 = 0;       // RB3 : sortie D3

    // Initialisation : toutes les sorties à 0
    D0=0; //PORTB.RB0=0;
    D1=0; //PORTB.RB1=0;
    D2=0; //PORTB.RB2=0;
    D3=0; //PORTB.RB3=0;

    // Boucle principale
    while(1) {
        // Décodage de L1 L0
        if (L1 == 0 && L0 == 0) {
            D0=1;
            D1=0;
            D2=0;
            D3=0;
        }
        else if (L1 == 0 && L0 == 1) {
            D0=0;
            D1=1;
            D2=0;
            D3=0;
        }
        else if (L1 == 1 && L0 == 0) {
            D0=0;
            D1=0;
            D2=1;
            D3=0;
        }
        else {
            D0=0;
            D1=0;
            D2=0;
            D3=1;
        }
    }
}
