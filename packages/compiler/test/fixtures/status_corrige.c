#define LED_SUP  PORTB.F0
#define LED_EGAL PORTB.F1
#define LED_INF  PORTB.F2
#define LED_ON(pin)  (pin = 1)
#define LED_OFF(pin) (pin = 0)
void main() {
    unsigned char x; unsigned char y; unsigned char z;
    // Configuration  i/o
    TRISB = 0x00;       // PORTB en sortie
    // Initialisation
    x = 6; y = 6;
    LED_OFF(LED_SUP); LED_OFF(LED_EGAL); LED_OFF(LED_INF);
    STATUS=0;
    // Traitement
    while(1) {
        LED_OFF(LED_SUP); LED_OFF(LED_EGAL); LED_OFF(LED_INF);
        z = x - y;                       // Soustraction
        if (STATUS.F2 == 1) { LED_ON(LED_EGAL); }   // Test du bit Zero, x = y
        else if (STATUS.F0 == 1) { LED_ON(LED_SUP); }    // Test du Carry, x > y
        else { LED_ON(LED_INF); }                    // x < y
    }
}
