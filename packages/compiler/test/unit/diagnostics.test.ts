import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '../../src/api';
import { compile } from '../../src/compile';
import { fixture } from '../support/harness';

const diags = (src: string | Uint8Array, opts = {}) => compile(src, opts).diagnostics;
const find = (ds: Diagnostic[], code: string) => ds.filter((d) => d.code === code);

describe('erreurs sémantiques (messages MikroC en français)', () => {
  it("Identificateur non déclaré 'x'", () => {
    const ds = diags('void main() {\n    x = 1;\n}');
    expect(ds).toContainEqual(expect.objectContaining({ severity: 'error', code: 'E_UNDECLARED', message: "Identificateur non déclaré 'x'", line: 2, col: 5 }));
  });

  it('Delay_ms : l’argument doit être une constante', () => {
    const ds = diags('void main() {\n    unsigned int t;\n    t = 500;\n    Delay_ms(t);\n}');
    const e = find(ds, 'E_DELAY_NOT_CONST');
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ severity: 'error', line: 4, col: 14 });
    expect(e[0].message).toMatch(/^Delay_ms : l'argument doit être une constante/);
    // A true constant (const variable, #define, constant expression) is accepted.
    expect(compile('#define T 250\nconst unsigned int D = 2 * T;\nvoid main() { Delay_ms(D); Delay_us(T + 1); }').ok).toBe(true);
  });

  it('redéfinitions, constantes, lvalues, arguments, sélecteurs de bit', () => {
    expect(find(diags('unsigned char a; char a; void main() {}'), 'E_REDECLARED')[0].message).toBe("Identificateur 'a' redéfini");
    expect(find(diags('const unsigned char MAX = 10; void main() { MAX = 3; }'), 'E_CONST_ASSIGN')[0].message).toBe("Impossible de modifier la constante 'MAX'");
    expect(find(diags('unsigned char a; void main() { (a + 1) = 3; }'), 'E_NOT_LVALUE')[0].message).toBe("L'opérande gauche de l'affectation n'est pas modifiable");
    expect(find(diags('void f(unsigned char a) {} void main() { f(1, 2); }'), 'E_ARG_COUNT')[0].message).toBe("La fonction 'f' attend 1 argument(s), 2 fourni(s)");
    expect(find(diags('void main() { PORTB.F9 = 1; }'), 'E_BIT_SELECTOR')[0].message).toBe('Bit F9 hors limites (8 bits)');
    expect(find(diags('void main() { PORTB.XYZ = 1; }'), 'E_BIT_SELECTOR')[0].message).toBe("Sélecteur de bit inconnu 'XYZ'");
    expect(find(diags('unsigned char a; void main() { a = a / 0; }'), 'E_DIV_BY_ZERO')).toHaveLength(1);
    expect(find(diags('void main() { break; }'), 'E_BREAK_OUTSIDE')[0].message).toBe("'break' en dehors d'une boucle ou d'un switch");
  });

  it("fonction 'main' introuvable", () => {
    expect(find(diags('void f() {}'), 'E_NO_MAIN')[0].message).toBe("Fonction 'main' introuvable");
  });

  it('récursivité refusée (pile matérielle de 8 niveaux, cadres statiques)', () => {
    const ds = diags('void a(); void b() { a(); } void a() { b(); } void main() { a(); }');
    expect(find(ds, 'E_RECURSION')[0].message).toMatch(/^Récursivité non supportée : /);
  });

  it('débordement de pile : 9 appels imbriqués', () => {
    const fns = Array.from({ length: 9 }, (_, i) => `void f${i}() { ${i < 8 ? `f${i + 1}();` : 'PORTB = 1;'} }`).reverse().join('\n');
    const ok = Array.from({ length: 8 }, (_, i) => `void f${i}() { ${i < 7 ? `f${i + 1}();` : 'PORTB = 1;'} }`).reverse().join('\n');
    const r = compile(`${fns}\nvoid main() { f0(); }`);
    expect(r.ok).toBe(false);
    expect(find(r.diagnostics, 'E_STACK_OVERFLOW')[0].message).toBe('Débordement de la pile matérielle : 9 niveaux nécessaires (8 disponibles)');
    const r8 = compile(`${ok}\nvoid main() { f0(); }`);
    expect(r8.ok).toBe(true);
    expect(r8.stackDepth).toBe(8);
    // The interrupt needs its own level on top of the main line.
    const ri = compile(`${ok}\nvoid interrupt() { INTCON = 0; }\nvoid main() { f0(); }`);
    expect(find(ri.diagnostics, 'E_STACK_OVERFLOW')[0].message).toContain("dont 1 pour l'interruption");
  });

  it('RAM pleine (68 octets de 0x0C à 0x4F)', () => {
    const r = compile('unsigned char t[70]; void main() { t[0] = 1; t[69] = 2; }');
    expect(find(r.diagnostics, 'E_RAM_FULL')[0].message).toBe('Mémoire RAM insuffisante : il manque 70 octet(s) (68 octets de 0x0C à 0x4F)');
    expect(compile('unsigned char t[68]; void main() { t[0] = 1; t[67] = 2; }').ok).toBe(true);
  });

  it('mémoire programme pleine (1024 mots)', () => {
    const body = Array.from({ length: 400 }, () => 'a = b + c;').join('\n');
    const r = compile(`unsigned char a, b, c;\nvoid main() {\n${body}\n}`);
    expect(find(r.diagnostics, 'E_ROM_FULL')[0].message).toMatch(/^Mémoire programme insuffisante : \d+ mots utilisés \(1024 disponibles\)$/);
  });

  it('les mots-clés sont en minuscules (While n’est pas while)', () => {
    expect(compile('void main() { While (1) { } }').ok).toBe(false);
  });
});

describe('avertissements pédagogiques (lint)', () => {
  it('if indépendant après un test de drapeau STATUS (bug de status.c)', () => {
    const w = find(diags(fixture('status.c')), 'W_SEPARATE_IF_AFTER_FLAG');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: 'warning', line: 19, col: 13 });
    expect(w[0].message).toContain("utilisez 'else if'");
    expect(find(diags(fixture('status_corrige.c')), 'W_SEPARATE_IF_AFTER_FLAG')).toEqual([]);
    // HI-TECH names count as flag tests too.
    const ht = '#include <htc.h>\nvoid main() { unsigned char x, y, z; x = 1; y = 2;\n z = x - y; if (ZERO == 1) PORTB = 1;\n if (CARRY == 1) PORTB = 2; }';
    expect(find(diags(ht), 'W_SEPARATE_IF_AFTER_FLAG')).toHaveLength(1);
  });

  it('PORTA.F5 à F7 n’existent pas', () => {
    const w = find(diags('void main() { TRISA = 0; PORTA.F5 = 1; PORTA.F4 = 0; }'), 'W_PORTA_BIT_UNIMPLEMENTED');
    expect(w).toHaveLength(1);
    expect(w[0].message).toBe("PORTA.F5 n'existe pas sur le PIC16F84A (PORTA n'a que les bits 0 à 4)");
  });

  it('LED sur RA4 : sortie à drain ouvert (diapo 16 du cours, SET_HIGH(PORTA.F4))', () => {
    const src = '#define SET_HIGH(pin) (pin = 1)\nvoid main() {\n    TRISA = 0x00;\n    PORTA = 0x00;\n    while(1) {\n        SET_HIGH(PORTA.F4);\n    }\n}';
    const w = find(diags(src), 'W_RA4_OPEN_DRAIN');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ line: 6 });
    expect(find(diags('#define rouge PORTA.F4\nvoid main() { TRISA = 0; rouge = 1; PORTA = 0x10; }'), 'W_RA4_OPEN_DRAIN')).toHaveLength(2);
  });

  it('PORTB = valeur efface une autre sortie commandée bit par bit (vote : PORTB = 0x0E et RB5)', () => {
    const src = '#define LED_EGAL PORTB.RB5\nvoid main() {\n    TRISB = 0x00;\n    PORTB = 0x00;\n    PORTB = 0x0E;\n    LED_EGAL = 1;\n    PORTB = 0x2F;\n}';
    const w = find(diags(src), 'W_PORT_WRITE_CLEARS_BITS');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ line: 5, message: 'PORTB = 0x0E réécrit tout le port et met aussi RB5 à 0, alors que cette broche est commandée bit par bit ailleurs' });
  });

  it('variable inutilisée', () => {
    const w = find(diags('unsigned char g;\nvoid main() {\n    unsigned char inutile;\n    PORTB = 0;\n}'), 'W_UNUSED_VARIABLE');
    expect(w.map((d) => d.message)).toEqual(["Variable 'g' déclarée mais jamais utilisée", "Variable 'inutile' déclarée mais jamais utilisée"]);
    // status.c's z is only written: not reported (the TP reads STATUS instead).
    expect(find(diags(fixture('status.c')), 'W_UNUSED_VARIABLE')).toEqual([]);
  });

  it('horloge _XTAL_FREQ différente de celle du projet', () => {
    const w = find(diags('#include <htc.h>\n#define _XTAL_FREQ 4000000\nvoid main() { __delay_ms(10); }', { clockHz: 1_000_000 }), 'W_CLOCK_MISMATCH');
    expect(w[0].message).toBe("_XTAL_FREQ = 4000000 Hz mais l'horloge du projet est 1000000 Hz : les temporisations seront fausses en simulation");
  });

  it('STATUS=0 laisse Z = 1 (information), constante tronquée, instruction sans effet', () => {
    const ds = diags(fixture('status.c'));
    expect(find(ds, 'I_STATUS_CLEAR_SETS_Z')[0]).toMatchObject({ severity: 'info', line: 13 });
    expect(find(diags('unsigned char x; void main() { x = 300; }'), 'W_TRUNCATED_CONSTANT')[0].message).toBe('Constante 300 tronquée en unsigned char (44)');
    expect(find(diags('unsigned char x; void main() { x + 1; }'), 'W_NO_EFFECT')).toHaveLength(1);
    expect(find(diags('void main() { PORTB; }'), 'W_NO_EFFECT')).toEqual([]);
  });

  it('case hors de la plage du switch (jamais exécuté) et doublons après conversion', () => {
    const w = find(diags('unsigned char u; void main() { switch (u) { case 300: u = 1; } }'), 'W_CASE_OUT_OF_RANGE');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: 'warning', message: "Valeur de case 300 hors de la plage de 'unsigned char' : ce cas n'est jamais exécuté" });
    // -1 and 65535 are the same unsigned int value.
    expect(find(diags('unsigned int w; void main() { switch (w) { case -1: w = 1; case 65535: w = 2; } }'), 'E_REDECLARED')).toHaveLength(1);
  });

  it('Lo/Hi en destination et sizeof : erreurs', () => {
    expect(find(diags('unsigned char c; void main() { Hi(c) = 1; }'), 'E_TYPE')[0].message).toBe("Hi(c) : 'c' n'a que 1 octet(s)");
    expect(find(diags('unsigned int w; void main() { Lo(w + 1) = 1; }'), 'E_NOT_LVALUE')).toHaveLength(1);
    expect(find(diags('unsigned char n; void main() { n = sizeof(void); }'), 'E_TYPE')[0].message).toBe("'sizeof' ne s'applique pas à 'void'");
  });

  it('les fichiers du prof compilent sans erreur', () => {
    for (const f of ['EXEMPLE1.c', 'EXEMPLE2.c', 'demux.c', 'status.c', 'status_corrige.c', 'demux_corrige.c']) {
      const r = compile(fixture(f));
      expect(r.diagnostics.filter((d) => d.severity === 'error'), f).toEqual([]);
      expect(r.ok, f).toBe(true);
    }
  });
});

describe('mode HI-TECH', () => {
  it('__CONFIG(...) accepté (information), #pragma config ignoré', () => {
    const r = compile('#include <htc.h>\n__CONFIG(0x3FFB);\n#pragma config WDTE = OFF\nvoid main() { TRISB0 = 0; RB0 = 1; }');
    expect(r.ok).toBe(true);
    expect(r.diagnostics.map((d) => [d.severity, d.code])).toEqual([['info', 'I_CONFIG_IGNORED'], ['info', 'I_PRAGMA_IGNORED']]);
  });

  it('en mode MikroC, RA0 est une constante (numéro de bit) et ne peut pas être affecté', () => {
    const r = compile('void main() { RA0 = 1; }');
    expect(r.diagnostics[0]).toMatchObject({ code: 'E_NOT_LVALUE', message: "'RA0' n'est pas modifiable" });
    expect(compile('void main() { PORTB = 1 << RB3; }').ok).toBe(true);
  });
});
