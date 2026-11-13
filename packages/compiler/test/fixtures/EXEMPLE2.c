void main() {
    // Configuration de la broche RA0 comme sortie
 TRISA = 0;
TRISB.RB0=1;
 while (1) {
        // commander une  LED par un bouton
if(PORTB.RB0==1)
PORTA.RA0=1;
else 
	PORTA.RA0=0;
}
}
