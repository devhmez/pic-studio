// Définition des sorties
#define LED PORTA.RA0

// Macros pour commander les sorties

void main() {

    // Configuration des sorties
    TRISA.RA0 = 0;       // RA0 : sortie LED

    // Initialisation
    LED = 1;       // Allumer la LED
}
