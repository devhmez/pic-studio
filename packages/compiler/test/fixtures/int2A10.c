//define
#define led portb.RB3
#define CAP portb.RB0
int i;
int j;
void main() {
//config i/o
TRISB.RB3=0;
TRISB.RB0=1;
TRISA=0;
//config interrupt
INTCON.GIE=1;
INTCON.INTE=1;
OPTION_REG.INTEDG=1;
//init
led=0;
PORTA=0;
//prog
while(1)
{ for(i=0;i<10;i++)
  {PORTA=i; delay_ms(500);}
}
}

void interrupt()
{ if(INTCON.INTF==1)
 {for(j=0; j<3;j++)
   {led=1; delay_ms(500);
    led=0; delay_ms(500);}
 //remettre le flag a zero
 INTCON.INTF=0;}
}
