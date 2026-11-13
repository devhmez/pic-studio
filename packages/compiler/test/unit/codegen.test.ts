import { describe, expect, it } from 'vitest';
import { compile } from '../../src/compile';
import { parseIntelHex } from '../../src/link/hex';
import { compileOk, fixture } from '../support/harness';

/** Instruction texts of the listing (addressed lines only). */
const asm = (src: string | Uint8Array, opts = {}) => compileOk(src, opts).listing.filter((l) => l.addr !== undefined).map((l) => l.text);

/** Instructions generated for the source line containing `needle`. */
function forLine(src: string | Uint8Array, needle: string): string[] {
  const r = compileOk(src);
  const lines = r.source.split(/\r\n|\r|\n/);
  const n = lines.findIndex((l) => l.includes(needle)) + 1;
  return r.listing.filter((l) => l.srcLine === n && l.addr !== undefined).map((l) => l.text);
}

describe('génération de code PIC14', () => {
  it('status.c : listing complet (vecteur de reset, banques, z = x - y, tests de bits, GOTO $)', () => {
    expect(asm(fixture('status.c'))).toEqual([
      'GOTO _main',
      'BSF STATUS, RP0', 'CLRF TRISB',
      'MOVLW 0x06', 'MOVWF x', 'MOVLW 0x06', 'MOVWF y',
      'BCF STATUS, RP0', 'BCF PORTB, 0', 'BCF PORTB, 1', 'BCF PORTB, 2',
      'CLRF STATUS',
      'BCF PORTB, 0', 'BCF PORTB, 1', 'BCF PORTB, 2',
      'MOVF y, W', 'SUBWF x, W', 'MOVWF z',
      'BTFSS STATUS, Z', 'GOTO L_main_3', 'BSF PORTB, 1',
      'BTFSS STATUS, C', 'GOTO L_main_5', 'BSF PORTB, 0', 'GOTO L_main_1',
      'BSF PORTB, 2',
      'GOTO L_main_1',
      'GOTO $',
    ]);
  });

  it('z = x - y reste un vrai SUBWF et rien ne touche STATUS avant le test suivant', () => {
    const r = compileOk(fixture('status.c'));
    const texts = r.listing.filter((l) => l.addr !== undefined).map((l) => l.text);
    const i = texts.indexOf('SUBWF x, W');
    expect(texts.slice(i - 1, i + 3)).toEqual(['MOVF y, W', 'SUBWF x, W', 'MOVWF z', 'BTFSS STATUS, Z']);
    // Dead store kept, no constant folding of x - y even though x and y are constants here.
    expect(forLine(fixture('status.c'), 'z = x - y;')).toEqual(['MOVF y, W', 'SUBWF x, W', 'MOVWF z']);
  });

  it('les variables locales commencent à 0x0C (x, y, z)', () => {
    const r = compileOk(fixture('status.c'));
    expect(r.symbols.map((s) => [s.name, s.scope, s.addr, s.size, s.type])).toEqual([
      ['x', 'main', 0x0c, 1, 'unsigned char'],
      ['y', 'main', 0x0d, 1, 'unsigned char'],
      ['z', 'main', 0x0e, 1, 'unsigned char'],
    ]);
    expect(r.usage.ram).toBe(3);
  });

  it('opérations 8 bits sans promotion en int', () => {
    const src = 'unsigned char a, b, r; void main() { r = a + b; r = a & 0x0F; r = 10 - a; r = a - 1; r += b; r--; }';
    expect(forLine(src, 'r = a + b;').slice(0, 3)).toEqual(['MOVF b, W', 'ADDWF a, W', 'MOVWF r']);
    expect(asm(src)).toEqual([
      'GOTO _main',
      'MOVF b, W', 'ADDWF a, W', 'MOVWF r',
      'MOVLW 0x0F', 'ANDWF a, W', 'MOVWF r',
      'MOVF a, W', 'SUBLW 0x0A', 'MOVWF r',
      'MOVLW 0x01', 'SUBWF a, W', 'MOVWF r',
      'MOVF b, W', 'ADDWF r, F',
      'DECF r, F',
      'GOTO $',
    ]);
  });

  it('accès bits : BSF/BCF/BTFSS, TRIS en banque 1, broches nommées sur n’importe quel registre', () => {
    expect(forLine(fixture('EXEMPLE1.c'), 'TRISA.RA0 = 0;')).toEqual(['BSF STATUS, RP0', 'BCF TRISA, 0']);
    expect(forLine(fixture('EXEMPLE1.c'), 'PORTA.RA0=1;')).toEqual(['BCF STATUS, RP0', 'BSF PORTA, 0']);
    const src = 'void main() {\n  INTCON.GIE = 1;\n  OPTION_REG.T0CS = 0;\n  STATUS.RP0 = 0;\n  PORTB.B7 = 1;\n  RB6_bit = 0;\n  if (PORTA.RA4 == 0) PORTB = 1;\n}';
    expect(asm(src)).toEqual([
      'GOTO _main',
      'BSF INTCON, GIE',
      'BSF STATUS, RP0', 'BCF OPTION_REG, T0CS',
      'BCF STATUS, RP0',
      'BSF PORTB, 7',
      'BCF PORTB, 6',
      'BTFSC PORTA, 4', 'GOTO L_main_1', 'MOVLW 0x01', 'MOVWF PORTB',
      'GOTO $',
    ]);
  });

  it('test d’un bit de TRIS (banque 1) sans toucher aux drapeaux (SWAPF)', () => {
    const r = forLine('void main() {\n  if (TRISB.RB2) PORTB = 1;\n}', 'if (TRISB');
    expect(r.slice(0, 5)).toEqual(['BSF STATUS, RP0', 'SWAPF TRISB, W', 'MOVWF _main.scr', 'BCF STATUS, RP0', 'BTFSS _main.scr, 6']);
  });

  it('main sans boucle se termine par GOTO $ (EXEMPLE1)', () => {
    const r = compileOk(fixture('EXEMPLE1.c'));
    const last = r.listing[r.listing.length - 1];
    expect(last.text).toBe('GOTO $');
    expect(last.word).toBe(0x2800 | last.addr!);
    expect(r.program![0]).toBe(0x2804);
    expect(r.program![1]).toBe(0x3fff);
  });

  it('interruption : vecteur 0x0004, sauvegarde W/STATUS/PCLATH/FSR, RETFIE', () => {
    const r = compileOk('unsigned char n;\nvoid interrupt() {\n    n++;\n    INTCON.INTF = 0;\n}\nvoid main() { while(1); }');
    const at = (a: number) => r.listing.find((l) => l.addr === a)!;
    expect(at(0).text).toBe('GOTO _main');
    expect(at(4)).toMatchObject({ label: '_interrupt', text: 'MOVWF __w_save' });
    const isr = r.listing.filter((l) => l.addr !== undefined && l.addr >= 4).map((l) => l.text);
    expect(isr.slice(0, 9)).toEqual([
      'MOVWF __w_save', 'SWAPF STATUS, W', 'CLRF STATUS', 'MOVWF __status_save', 'MOVF PCLATH, W',
      'MOVWF __pclath_save', 'CLRF PCLATH', 'MOVF FSR, W', 'MOVWF __fsr_save',
    ]);
    const end = isr.indexOf('RETFIE');
    expect(isr.slice(end - 8, end + 1)).toEqual([
      'MOVF __fsr_save, W', 'MOVWF FSR', 'MOVF __pclath_save, W', 'MOVWF PCLATH', 'SWAPF __status_save, W',
      'MOVWF STATUS', 'SWAPF __w_save, F', 'SWAPF __w_save, W', 'RETFIE',
    ]);
  });

  it('variables initialisées : code de démarrage avant main', () => {
    const r = compileOk('unsigned char a = 5;\nunsigned int b = 0x1234;\nvoid main() { PORTB = a + b; }');
    expect(r.listing.slice(0, 7).map((l) => l.text)).toEqual([
      'GOTO __start', 'MOVLW 0x05', 'MOVWF a', 'MOVLW 0x34', 'MOVWF b', 'MOVLW 0x12', 'MOVWF b+1',
    ]);
  });

  it('absolute place la variable à l’adresse demandée', () => {
    const r = compileOk('unsigned char temperature absolute 0x0C;\nunsigned char humidite absolute 0x20;\nvoid main() {\ntemperature = 12;\nhumidite = 42;\n\nwhile(1) { }\n}');
    expect(r.symbols.map((s) => [s.name, s.addr])).toEqual([['temperature', 0x0c], ['humidite', 0x20]]);
    expect(r.program!.slice(4, 8)).toEqual(new Uint16Array([0x300c, 0x008c, 0x302a, 0x00a0]));
  });

  it('listing : ligne C source en commentaire sur la première instruction, tables adresse ↔ ligne', () => {
    const r = compileOk(fixture('demux.c'));
    // demux.c line 19: `    TRISA.RA0 = 1;       // RA0 : entrée L0`
    const first = r.listing.find((l) => l.srcLine === 19)!;
    expect(first.comment).toBe('TRISA.RA0 = 1;       // RA0 : entrée L0');
    expect(r.lineToAddr.get(19)).toBe(first.addr);
    for (const [addr, line] of r.addrToLine) expect(r.lineToAddr.get(line)! <= addr).toBe(true);
    const again = r.listing.filter((l) => l.srcLine === 19);
    expect(again.slice(1).every((l) => l.comment === undefined)).toBe(true);
  });

  it('copie d’un bit dans STATUS.RP0 : banque inconnue ensuite, l’accès suivant resélectionne la banque', () => {
    const r = forLine('void main() {\n  STATUS.RP0 = PORTB.F0;\n  PORTB = 0x06;\n}', 'PORTB = 0x06');
    expect(r).toEqual(['MOVLW 0x06', 'BCF STATUS, RP0', 'MOVWF PORTB']);
  });

  it('tables RETLW : une table par déclaration const, même avec le même nom', () => {
    const r = compileOk(`const unsigned char T[2] = {1, 2};
unsigned char i, a, b, c;
void main() {
    { const unsigned char T[2] = {3, 4}; a = T[i]; }
    { const unsigned char T[2] = {5, 6}; b = T[i]; }
    c = T[i];
}`);
    const labels = r.listing.filter((l) => l.label?.startsWith('_tbl_')).map((l) => l.label);
    expect(labels).toEqual(['_tbl_main_T', '_tbl_main_T_2', '_tbl_T']);
  });

  it('symboles : sbit sur un registre ou sur une variable, sbit local', () => {
    const r = compileOk(`unsigned char flags;
sbit PRET at flags.B3;
sbit LED at PORTB.B1;
void main() {
    sbit BOUTON at PORTA.B0;
    TRISB = 0;
    flags = 0;
    PRET = BOUTON;
    LED = PRET;
}`);
    const sym = (n: string) => r.symbols.find((s) => s.name === n);
    expect(sym('LED')).toMatchObject({ scope: 'global', addr: 0x06, size: 1, type: 'sbit (bit 1)' });
    expect(sym('PRET')).toMatchObject({ scope: 'global', addr: sym('flags')!.addr, type: 'sbit (bit 3)' });
    expect(sym('BOUTON')).toMatchObject({ scope: 'main', addr: 0x05, type: 'sbit (bit 0)' });
  });

  it('identificateurs insensibles à la casse (MikroC)', () => {
    expect(asm('unsigned char Compteur; void main() { compteur = 1; COMPTEUR++; trisb = 0; }')).toEqual([
      'GOTO _main', 'MOVLW 0x01', 'MOVWF Compteur', 'INCF Compteur, F', 'BSF STATUS, RP0', 'CLRF TRISB', 'BCF STATUS, RP0', 'GOTO $',
    ]);
  });
});

describe('fichier HEX (INHX8M)', () => {
  it('EXEMPLE1 : enregistrements, mot de configuration en 0x2007 (0x400E), fin de fichier', () => {
    const r = compileOk(fixture('EXEMPLE1.c'));
    const lines = r.hex!.trim().split('\n');
    expect(lines[0]).toBe(':020000000428D2');
    expect(lines[lines.length - 2]).toBe(':02400E00FB3F76');
    expect(lines[lines.length - 1]).toBe(':00000001FF');
    for (const l of lines) {
      const bytes = l.slice(1).match(/../g)!.map((x) => parseInt(x, 16));
      expect(bytes.reduce((a, b) => a + b, 0) & 0xff, l).toBe(0);
    }
  });

  it('relecture du HEX = programme compilé, configuration personnalisée', () => {
    const r = compileOk(fixture('demux.c'), { config: 0x3ff9 });
    const back = parseIntelHex(r.hex!);
    expect(back.program).toEqual(r.program);
    expect(back.config).toBe(0x3ff9);
    expect(r.config).toBe(0x3ff9);
  });

  it('pas de programme ni de HEX en cas d’erreur', () => {
    const r = compile('void main() { x = 1; }');
    expect(r.ok).toBe(false);
    expect(r.program).toBeUndefined();
    expect(r.hex).toBeUndefined();
    expect(r.config).toBe(0x3ffb);
  });
});

describe('variables bit', () => {
  it('regroupées dans un octet, nommées dans le listing et dans les symboles', () => {
    const r = compileOk('bit marche; bit arret;\nvoid main() { marche = 1; arret = marche; }');
    expect(r.symbols.map((s) => [s.name, s.addr, s.type])).toEqual([
      ['marche', 0x0c, 'bit (bit 0)'],
      ['arret', 0x0c, 'bit (bit 1)'],
    ]);
    expect(r.listing.filter((l) => l.addr !== undefined).map((l) => l.text).slice(1, 6)).toEqual([
      'BSF __bits, marche', 'BTFSC __bits, marche', 'BSF __bits, arret', 'BTFSS __bits, marche', 'BCF __bits, arret',
    ]);
  });
});
