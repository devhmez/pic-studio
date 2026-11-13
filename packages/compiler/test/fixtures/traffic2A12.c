//define
#define LEDR PORTA.RA0
#define LEDO PORTA.RA1
#define LEDV PORTA.RA2
#define CAP PORTA.RA3
int i;
void main() {
//CONFIG
TRISA.RA0=0;
TRISA.RA1=0;
TRISA.RA2=0;
TRISA.RA3=1;
//TRISA=0b00001000;
TRISB=0;
//INIT
LEDR=0;LEDO=0;LEDV=0;PORTB=0;
//PROG
while(1)
{ if(CAP==0)
  {//mode_nuit
  PORTB=0x0A;
  LEDR=0;LEDO=1;LEDV=0;delay_ms(500);
  LEDO=0; delay_ms(500);
  }
  else
  {//mode_jour
   //rouge
LEDR=1;LEDO=0;LEDV=0;delay_ms(500);
for(i=0;i<10;i++)
 {PORTB=i; delay_ms(500);}
    //orange
LEDR=0;LEDO=1;LEDV=0;delay_ms(500);
for(i=0;i<3;i++)
 {PORTB=i; delay_ms(500);}
    //vert
LEDR=0;LEDO=0;LEDV=1;delay_ms(500);
for(i=0;i<10;i++)
 {PORTB=i; delay_ms(500);}
  }
}

}