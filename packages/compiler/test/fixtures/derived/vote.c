// Définition des entrées
#define VOTE_A    PORTA.RA0
#define VOTE_B    PORTA.RA1
#define RESULTAT  PORTA.RA3

// Définition des sorties
#define LED_VOTE  PORTA.RA2
#define LED_EGAL  PORTB.RB5

// Macros pour commander les LEDs
#define LED_ON(pin)  (pin = 1)
#define LED_OFF(pin) (pin = 0)

void main() {
    unsigned char var1; unsigned char var2; unsigned char z; unsigned char i;

    // Configuration  i/o
    TRISA = 0x0B;       // RA0, RA1, RA3 en entrée ; RA2 en sortie (0b00001011)
    TRISB = 0x00;       // PORTB en sortie

    // Initialisation
    var1 = 0; var2 = 0;
    LED_OFF(LED_VOTE); LED_OFF(LED_EGAL);
    PORTB = 0x0F;       // Afficher la lettre 'F'
    Delay_ms(500);

    // Traitement
    while(1) {
        if (VOTE_A == 1) {                // Vote A
            var1++;
            LED_ON(LED_VOTE);  Delay_ms(500);
            LED_OFF(LED_VOTE); Delay_ms(500);
        }
        if (VOTE_B == 1) {                // Vote B
            var2++;
            LED_ON(LED_VOTE);  Delay_ms(500);
            LED_OFF(LED_VOTE); Delay_ms(500);
        }
        if (RESULTAT == 1) {              // Dépouillement
            z = var1 - var2;              // Soustraction
            if (STATUS.F2 == 1) {         // Test du bit Zero, var1 = var2
                PORTB = 0x0E;             // Afficher la lettre 'E'
                for (i = 0; i < 3; i++) {
                    LED_ON(LED_EGAL);  Delay_ms(500);
                    LED_OFF(LED_EGAL); Delay_ms(500);
                }
            }
            else if (STATUS.F0 == 1) {    // Test du Carry, var1 > var2
                PORTB = 0x0A;             // Afficher la lettre 'A'
                Delay_ms(500);
            }
            else {                        // var1 < var2
                PORTB = 0x0B;             // Afficher la lettre 'B'
                Delay_ms(500);
            }
            var1 = 0; var2 = 0;           // Nouveau cycle de vote
        }
    }
}
