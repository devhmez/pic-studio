import { describe, expect, it } from 'vitest';
import { DiagnosticBag } from '../../src/diagnostics';
import { lex } from '../../src/lexer';
import { decodeSource, encodeSourceCp1252 } from '../../src/source';
import { fixture } from '../support/harness';

describe('décodage des sources (Windows-1252 comme MikroC)', () => {
  it('décode les octets CP1252 (é = 0xE9, € = 0x80)', () => {
    expect(decodeSource(new Uint8Array([0x44, 0xe9, 0x66, 0x20, 0x80, 0xe0]))).toBe('Déf €à');
  });

  it('décode demux.c du prof', () => {
    const text = decodeSource(fixture('demux.c'));
    expect(text).toContain('// Définition des entrées');
    expect(text).toContain('// Initialisation : toutes les sorties à 0');
    expect(text.includes('\r\n')).toBe(true);
  });

  it('reconnaît un fichier UTF-8', () => {
    const utf8 = new TextEncoder().encode('// Définition\n');
    expect(decodeSource(utf8)).toBe('// Définition\n');
    expect(decodeSource(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe('a');
  });

  it('réencode en CP1252 avec CRLF', () => {
    const bytes = encodeSourceCp1252('// é\nx = 1;\n');
    expect([...bytes]).toEqual([0x2f, 0x2f, 0x20, 0xe9, 0x0d, 0x0a, 0x78, 0x20, 0x3d, 0x20, 0x31, 0x3b, 0x0d, 0x0a]);
    expect(decodeSource(encodeSourceCp1252(decodeSource(fixture('demux.c'))))).toBe(decodeSource(fixture('demux.c')));
  });
});

describe('analyse lexicale', () => {
  const tokens = (src: string) => {
    const d = new DiagnosticBag();
    const r = lex(src, d);
    return { toks: r.tokens.filter((t) => t.kind !== 'eof'), comments: r.comments, diags: d.items };
  };

  it('nombres décimaux, hexadécimaux, binaires, octaux et caractères', () => {
    const { toks, diags } = tokens("12 0x1F 0X0a 0b01110110 017 0 'A' '\\n' '\\x41' '\\0' 100u 70000UL");
    expect(diags).toEqual([]);
    expect(toks.map((t) => t.num)).toEqual([12, 31, 10, 0x76, 15, 0, 65, 10, 65, 0, 100, 70000]);
    expect(toks.map((t) => t.radix ?? 'c')).toEqual([10, 16, 16, 2, 8, 10, 'c', 'c', 'c', 'c', 10, 10]);
  });

  it('opérateurs : correspondance la plus longue', () => {
    const { toks } = tokens('a>>=b<<=c&&d||e==f!=g<=h>=i++ --j->k ## #');
    expect(toks.filter((t) => t.kind === 'punct').map((t) => t.value)).toEqual([
      '>>=', '<<=', '&&', '||', '==', '!=', '<=', '>=', '++', '--', '->', '##', '#',
    ]);
  });

  it('identificateurs avec la casse d’origine et positions 1-based', () => {
    const { toks } = tokens('void main() {\r\n  PORTA.RA0=1;\r\n}');
    const porta = toks.find((t) => t.value === 'PORTA')!;
    expect(porta.span).toMatchObject({ line: 2, col: 3, endLine: 2, endCol: 8 });
    expect(toks.find((t) => t.value === 'RA0')!.span.col).toBe(9);
    expect(toks[0].atLineStart).toBe(true);
    expect(porta.atLineStart).toBe(true);
  });

  it('commentaires // et /* */ conservés avec leur texte', () => {
    const { toks, comments } = tokens('x = 1; // Soustraction\r\n/* bloc\r\n sur deux lignes */ y = 2;');
    expect(comments.map((c) => [c.kind, c.text, c.span.line])).toEqual([
      ['line', 'Soustraction', 1],
      ['block', 'bloc\r\n sur deux lignes', 2],
    ]);
    expect(toks.find((t) => t.value === 'y')!.span.line).toBe(3);
  });

  it('accepte TAB, espace après else et absence de saut de ligne final (EXEMPLE2, demux)', () => {
    const { diags } = tokens('else \r\n\tPORTA.RA0=0;\r\n}');
    expect(diags).toEqual([]);
  });

  it('erreurs lexicales en français', () => {
    const stray = tokens('x = 3 @ 4;').toks.find((t) => t.kind === 'other')!;
    expect(stray).toMatchObject({ value: '@', span: { line: 1, col: 7 } });
    // Malformed literals are recorded on the token; the preprocessor reports them only in active code.
    const literalError = (src: string) => tokens(src).toks.find((t) => t.error)?.error;
    expect(literalError('x = 0b102;')).toMatchObject({ code: 'E_BAD_NUMBER' });
    expect(literalError('x = 1.5;')).toMatchObject({ code: 'E_UNSUPPORTED', message: 'Les nombres à virgule flottante ne sont pas supportés' });
    expect(literalError("c = 'A;")).toMatchObject({ code: 'E_UNTERMINATED', message: 'Caractère littéral non terminé' });
    expect(tokens('x = 0b102;').diags).toEqual([]);
    expect(tokens('/* jamais fermé').diags[0]).toMatchObject({ code: 'E_UNTERMINATED' });
  });
});
