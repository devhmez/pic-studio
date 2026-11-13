import { describe, expect, it } from 'vitest';
import { duty, readVar, runFor, runToHalt } from '../support/harness';
import { onEmulator } from './support';

describe('interruptions (void interrupt() en 0x0004)', () => {
  const src = `unsigned char compteur;
unsigned char a; unsigned char b; unsigned char s; unsigned char erreurs;
unsigned int big;
void interrupt() {
    unsigned char t;
    if (INTCON.INTF == 1) {
        t = compteur + 1;          // the ISR uses W and STATUS heavily
        compteur = t;
        INTCON.INTF = 0;
    }
}
void main() {
    TRISB = 0x01;                  // RB0/INT en entrée
    OPTION_REG.INTEDG = 1;         // front montant
    INTCON.INTE = 1;
    INTCON.GIE = 1;
    a = 17; b = 13;
    while(1) {
        s = a + b;
        if (s != 30) erreurs++;
        big = big + 1000;
        if (STATUS.F0 == 1 && big > 64000) erreurs = erreurs + 0;
    }
}`;

  it('compte les fronts montants sur RB0/INT sans perturber main (W, STATUS, FSR, PCLATH sauvegardés)', () => {
    const { r, core } = onEmulator(src);
    expect(r.listing.find((l) => l.addr === 4)?.text).toBe('MOVWF __w_save');
    core.setInput('RB0', 0);
    runFor(core, 500);
    for (let i = 0; i < 25; i++) {
      core.setInput('RB0', 1);
      runFor(core, 97 + i);
      core.setInput('RB0', 0);
      runFor(core, 61 + 3 * i);
    }
    expect(readVar(core, r, 'compteur')).toBe(25);
    expect(readVar(core, r, 'erreurs')).toBe(0);
  });

  it('la profondeur de pile compte l’interruption', () => {
    const { r } = onEmulator(src);
    expect(r.stackDepth).toBe(1);
  });
});

describe('EEPROM_Write / EEPROM_Read (séquence 0x55/0xAA)', () => {
  it('écrit puis relit des octets', () => {
    const src = `unsigned char lu1; unsigned char lu2;
void main() {
    EEPROM_Write(0x05, 0x42);
    EEPROM_Write(0x06, 0x99);
    lu1 = EEPROM_Read(0x05);
    lu2 = EEPROM_Read(6);
}`;
    const { r, core } = onEmulator(src);
    runToHalt(core, 2_000_000);
    expect(readVar(core, r, 'lu1')).toBe(0x42);
    expect(readVar(core, r, 'lu2')).toBe(0x99);
    expect(core.peekEeprom(5)).toBe(0x42);
    expect(core.peekEeprom(6)).toBe(0x99);
  });
});

describe('Button(&PORTB, pin, time, active_state)', () => {
  const src = `void main() {
    TRISA = 0x00;
    TRISB = 0xFF;
    PORTA = 0;
    while(1) {
        if (Button(&PORTB, 3, 5, 1)) PORTA.F0 = 1;
        else PORTA.F0 = 0;
    }
}`;
  it('renvoie 255 quand la broche reste active pendant la durée anti-rebond', () => {
    const { core } = onEmulator(src);
    core.setInput('RB3', 1);
    runFor(core, 5000);
    expect(duty(core, 'RA0', 3000)).toBeGreaterThan(0.9);
    core.setInput('RB3', 0);
    runFor(core, 5000);
    expect(duty(core, 'RA0', 3000)).toBe(0);
  });
});

describe('tables constantes (RETLW) et tableaux en RAM', () => {
  it('affiche les chiffres 7 segments depuis une table', () => {
    const src = `const unsigned char segments[10] = {0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F};
unsigned char resultats[10];
unsigned char i;
void main() {
    for (i = 0; i < 10; i++) resultats[i] = segments[i];
}`;
    const { r, core } = onEmulator(src);
    runToHalt(core);
    const base = r.symbols.find((s) => s.name === 'resultats')!.addr;
    const got = Array.from({ length: 10 }, (_, k) => core.peek(base + k));
    expect(got).toEqual([0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f]);
  });

  it('table de int (deux octets par entrée) et index calculé', () => {
    const src = `const unsigned int carres[] = {0, 1, 4, 9, 16, 25, 300, 1000, 40000};
unsigned int somme; unsigned char k;
void main() {
    somme = 0;
    for (k = 0; k < 9; k++) somme += carres[k];
}`;
    const { r, core } = onEmulator(src);
    runToHalt(core);
    expect(readVar(core, r, 'somme', 2)).toBe((0 + 1 + 4 + 9 + 16 + 25 + 300 + 1000 + 40000) & 0xffff);
  });
});

describe('fonctions', () => {
  it('paramètres, valeurs de retour 8 et 16 bits, appels imbriqués', () => {
    const src = `unsigned char r8; unsigned int r16; int rs;
unsigned char max(unsigned char a, unsigned char b) {
    if (a > b) return a;
    return b;
}
unsigned int carre(unsigned char x) {
    unsigned int t;
    t = x;
    return t * x;
}
int difference(int a, int b) { return a - b; }
void main() {
    r8 = max(max(3, 9), 7);
    r16 = carre(r8) + carre(2);
    rs = difference(10, 300);
}`;
    const { r, core } = onEmulator(src);
    runToHalt(core);
    expect(readVar(core, r, 'r8')).toBe(9);
    expect(readVar(core, r, 'r16', 2)).toBe(81 + 4);
    expect(readVar(core, r, 'rs', 2, true)).toBe(-290);
  });
});
