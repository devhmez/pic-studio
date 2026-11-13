// Définition des entrées
#define VOTE_A    PORTA.RA0
#define VOTE_B    PORTA.RA1
#define RESULTAT  PORTA.RA3

// Définition des sorties
#define LED_VOTE  PORTA.RA2
#define LED_EGAL  PORTB.RB5
#define AFFICHEUR PORTB

// Macros pour commander les sorties
#define LED_ON(pin)  (pin = 1)
#define LED_OFF(pin) (pin = 0)

void main() {
    unsigned char var1; unsigned char var2; unsigned char z; unsigned char i;

    // Configuration des entrées
    TRISA.RA0 = 1;       // RA0 : entrée VOTE_A
    TRISA.RA1 = 1;       // RA1 : entrée VOTE_B
    TRISA.RA3 = 1;       // RA3 : entrée RESULTAT

    // Configuration des sorties
    TRISA.RA2 = 0;       // RA2 : sortie LED_VOTE
    TRISB = 0x00;       // PORTB en sortie

    // Initialisation
    var1 = 0; var2 = 0;
    LED_OFF(LED_VOTE); LED_OFF(LED_EGAL);
    AFFICHEUR = 0x0F;       // Afficher la lettre 'F'
    Delay_ms(500);

    // Boucle principale
    while(1) {
        if (VOTE_A == 1) {
            // Vote A : compter, puis faire clignoter la LED de confirmation
            var1++;
            LED_ON(LED_VOTE);
            Delay_ms(500);
            LED_OFF(LED_VOTE);
            Delay_ms(500);
            while (VOTE_A == 1);       // Attente du relâchement du bouton
        }
        if (VOTE_B == 1) {
            // Vote B : compter, puis faire clignoter la LED de confirmation
            var2++;
            LED_ON(LED_VOTE);
            Delay_ms(500);
            LED_OFF(LED_VOTE);
            Delay_ms(500);
            while (VOTE_B == 1);       // Attente du relâchement du bouton
        }
        if (RESULTAT == 1) {
            // Dépouillement
            z = var1 - var2;                 // Soustraction
            if (STATUS.F2 == 1) {            // Test du bit Zero, var1 = var2
                AFFICHEUR = 0x0E;            // Afficher la lettre 'E'
                for (i = 0; i < 3; i++) {
                    LED_ON(LED_EGAL);
                    Delay_ms(500);
                    LED_OFF(LED_EGAL);
                    Delay_ms(500);
                }
            }
            else if (STATUS.F0 == 1) {       // Test du Carry, var1 > var2
                AFFICHEUR = 0x0A;            // Afficher la lettre 'A'
                Delay_ms(500);
            }
            else {                           // var1 < var2
                AFFICHEUR = 0x0B;            // Afficher la lettre 'B'
                Delay_ms(500);
            }
            var1 = 0; var2 = 0;              // Nouveau cycle de vote
            while (RESULTAT == 1);           // Attente du relâchement du bouton
        }
    }
}
