/// <reference types="node" />
// Model invariants: JSON-serialisable, stable unique ids, involutive negation, pin helpers.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ALL_PINS, allStmts, blocks as b, busPins, checkProgramShape, cloneProgram, emptyProgram, ensureIds, findStmt,
  forEachStmt, gpioOfSchematicPin, negateCond, normalizeProgram, parseProgramJson, pinBit, pinPort, schematicPinName,
  serializeProgram, stmtVariables, type Cond, type Program,
} from '../src';

const IDS = ['tp0-exemple1', 'tp0-exemple2', 'tp1-demux', 'tp-status', 'tp-vote', 'tp-traffic', 'tp-pupitre', 'tp5-int-rb0', 'tp6-rbie'];
const text = (id: string) => readFileSync(new URL(`../../../templates/${id}.program.json`, import.meta.url), 'utf8');

function everyId(p: Program): string[] {
  const ids: string[] = p.functions.map((f) => f.id);
  forEachStmt(p, ({ stmt }) => {
    ids.push(stmt.id);
    if (stmt.kind === 'if') {
      ids.push(...stmt.branches.map((x) => x.id));
      if (stmt.otherwise) ids.push(stmt.otherwise.id);
    }
    if (stmt.kind === 'for') ids.push(stmt.init.id, stmt.update.id);
  });
  return ids;
}

describe('templates/*.program.json', () => {
  for (const id of IDS) {
    it(`${id}: parses, re-serialises identically, survives JSON and has unique non-empty ids`, () => {
      const raw = text(id);
      const p = parseProgramJson(raw);
      expect(serializeProgram(p)).toBe(raw);
      expect(JSON.parse(JSON.stringify(p))).toEqual(p);
      const ids = everyId(p);
      expect(ids.every((x) => /^[sbf]\d+$/.test(x))).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
    });
  }
});

describe('ids', () => {
  it('ensureIds numbers blanks in source order and keeps existing ids', () => {
    const p = emptyProgram();
    p.init = [b.on('a'), { ...b.off('a'), id: 's7' }, b.when(b.pin('x'), [b.delay(1)], [b.delay(2)])];
    ensureIds(p);
    expect(everyId(p)).toEqual(['s8', 's7', 's9', 'b1', 'b2', 's10', 's11']);
    const again = cloneProgram(p);
    ensureIds(again);
    expect(again).toEqual(p);
  });

  it('duplicate ids are renumbered, the first occurrence keeps its id', () => {
    const p = emptyProgram();
    p.init = [{ ...b.on('a'), id: 's1' }, { ...b.on('a'), id: 's1' }];
    ensureIds(p);
    expect(p.init.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('findStmt locates nested statements with their path', () => {
    const p = parseProgramJson(text('tp-vote'));
    const nested = allStmts(p).find((s) => s.kind === 'repeat')!;
    const visit = findStmt(p, nested.id)!;
    expect(visit.owner).toBe('loop');
    expect(visit.depth).toBe(2);
    expect(visit.path).toHaveLength(4); // if(RESULTAT) › branch › if(Z) › branch
  });
});

describe('conditions', () => {
  const samples: Cond[] = [
    b.pin('l0', 0),
    b.flag('Z', 1),
    b.cmp(b.v('x'), '<', b.num(3)),
    b.and(b.pin('a', 1), b.or(b.cmp(b.v('n'), '>=', b.num(2)), b.flag('C', 0))),
    b.not(b.rawCond('x')),
    b.rawCond('PORTB & 0x0F'),
  ];
  it('negateCond is an involution and keeps tests readable', () => {
    for (const c of samples) expect(negateCond(negateCond(c))).toEqual(c);
    expect(negateCond(b.pin('vote_a', 0))).toEqual(b.pin('vote_a', 1));
    expect(negateCond(b.cmp(b.v('x'), '<', b.num(3)))).toEqual(b.cmp(b.v('x'), '>=', b.num(3)));
    expect(negateCond(b.and(b.pin('a', 1), b.flag('Z', 1)))).toEqual(b.or(b.pin('a', 0), b.flag('Z', 0)));
  });

  it('variables used by a statement', () => {
    expect([...stmtVariables(b.assign(b.v('z'), b.sub(b.v('x'), b.v('y'))))].sort()).toEqual(['x', 'y', 'z']);
    expect([...stmtVariables(b.repeat(3, 'i', []))]).toEqual(['i']);
    expect([...stmtVariables(b.whileLoop(b.cmp(b.v('essais'), '>', b.num(0)), []))]).toEqual(['essais']);
  });
});

describe('JSON shape checks', () => {
  it('reports French errors for broken files', () => {
    expect(() => parseProgramJson('{')).toThrow('Fichier de programme illisible : JSON invalide.');
    expect(checkProgramShape({ version: 2, title: 3, clockHz: -1, signals: [{ pin: 'RC0' }], buses: [], constants: [], variables: [], init: [{}], loop: 4, functions: [] }))
      .toEqual([
        'Version de programme non prise en charge : 2 (attendu 1).',
        '« title » doit être un texte.',
        '« clockHz » doit être une fréquence positive (Hz).',
        '« loop » doit être une liste ou null.',
        'Signal n°1 : identifiant manquant.',
        'Signal n°1 : nom manquant.',
        'Signal n°1 : broche invalide « RC0 ».',
        'Signal n°1 : direction « in » ou « out » attendue.',
        'Signal n°1 : niveau actif 0 ou 1 attendu.',
        'Initialisation, instruction n°1 : « kind » manquant.',
      ]);
  });

  it('normalizeProgram fills style options missing from older files', () => {
    const p = emptyProgram();
    const partial = { ...p, style: { macros: false } } as unknown as Program;
    expect(normalizeProgram(partial).style).toEqual({ ...p.style, macros: false });
  });
});

describe('pins', () => {
  it('ports, bits and schematic pin names', () => {
    expect(ALL_PINS).toHaveLength(13);
    expect([pinPort('RB5'), pinBit('RB5')]).toEqual(['B', 5]);
    expect(busPins({ port: 'B', lsb: 4, width: 4 })).toEqual(['RB4', 'RB5', 'RB6', 'RB7']);
    expect(busPins({ port: 'A', lsb: 3, width: 4 })).toEqual(['RA3', 'RA4']);
    expect([schematicPinName('RB0'), schematicPinName('RA4'), schematicPinName('RA1')]).toEqual(['RB0/INT', 'RA4/T0CKI', 'RA1']);
    expect([gpioOfSchematicPin('RB0/INT'), gpioOfSchematicPin('OSC1/CLKIN'), gpioOfSchematicPin('MCLR')]).toEqual(['RB0', undefined, undefined]);
  });
});
