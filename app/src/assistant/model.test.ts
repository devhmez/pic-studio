/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { parseSchematicJson } from '@pic/circuit';
import { compile } from '@pic/compiler';
import { blocks as b, deriveSignals, emptyProgram, ensureIds, parseProgramJson, validate, type Program, type Stmt } from '@pic/program-model';
import { generate } from '@pic/style-c';
import { describe, expect, it } from 'vitest';
import { blockSummary, createBlock } from './blocks';
import {
  addElse, addElseIf, addSignal, addVariable, asProgram, bodyList, branchList, computeUsage, duplicateStmt, finalizeProgram,
  getList, idFactory, insertStmt, INIT_LIST, locateStmt, LOOP_LIST, moveStmt, programFromSchematic, removeBranch, removeStmt,
  renameIdentifier, replaceStmt, setInterruptConfig, setLoopEnabled, syncWithSchematic, updateList, updateSignal,
  updateVariable,
} from './model';

const REPO = new URL('../../../', import.meta.url);
const templateProgram = (id: string): Program => parseProgramJson(readFileSync(new URL(`templates/${id}.program.json`, REPO), 'utf8'));
const templateSchematic = (id: string) => parseSchematicJson(readFileSync(new URL(`templates/${id}.schematic.json`, REPO), 'utf8'));

function demo(): Program {
  const p = emptyProgram('Démo');
  p.signals = [
    { id: 'l0', name: 'L0', pin: 'RA0', dir: 'in', label: 'Interrupteur L0', activeLevel: 1, device: 'logicstate' },
    { id: 'd0', name: 'D0', pin: 'RB0', dir: 'out', label: 'Led D0', activeLevel: 1, device: 'led' },
    { id: 'd1', name: 'D1', pin: 'RB1', dir: 'out', label: 'Led D1', activeLevel: 1, device: 'led' },
  ];
  p.variables = [{ name: 'x', type: 'unsigned char' }];
  p.init = [b.off('d0'), b.off('d1')];
  p.loop = [b.when(b.pin('l0', 1), [b.on('d0'), b.delay(500)], [b.off('d0')]), b.incr('x')];
  return ensureIds(p);
}

describe('asProgram', () => {
  it('normalizes untrusted values and caches by identity', () => {
    const raw = JSON.parse(JSON.stringify(templateProgram('tp-status')));
    const a = asProgram(raw);
    expect(a?.title).toContain('STATUS');
    expect(asProgram(raw)).toBe(a);
    expect(asProgram({ nope: true })).toBeNull();
    expect(asProgram(null)).toBeNull();
  });

  it('returns a committed program as is', () => {
    const p = finalizeProgram(demo(), 1_000_000);
    expect(asProgram(p)).toBe(p);
  });
});

describe('list addressing', () => {
  it('finds nested lists and statements', () => {
    const p = demo();
    const ifStmt = p.loop![0];
    expect(ifStmt.kind).toBe('if');
    if (ifStmt.kind !== 'if') return;
    const thenKey = branchList(ifStmt.id, ifStmt.branches[0].id);
    expect(getList(p, thenKey)?.map((s) => s.kind)).toEqual(['set', 'delay']);
    expect(getList(p, branchList(ifStmt.id, ifStmt.otherwise!.id))?.length).toBe(1);
    const delay = ifStmt.branches[0].body[1];
    expect(locateStmt(p, delay.id)).toMatchObject({ key: thenKey, index: 1 });
  });

  it('keeps untouched parts by reference', () => {
    const p = demo();
    const next = updateList(p, INIT_LIST, (list) => [...list, b.delay(10)]);
    expect(next.init).toHaveLength(3);
    expect(next.loop).toBe(p.loop);
    expect(next.functions).toBe(p.functions);
    expect(updateList(p, 'unknown', (l) => l)).toBe(p);
  });
});

describe('statement editing', () => {
  it('inserts, moves, replaces and removes', () => {
    let p = demo();
    const newId = idFactory(p);
    const d = { ...b.delay(100), id: newId('s') };
    p = insertStmt(p, LOOP_LIST, 1, d);
    expect(p.loop!.map((s) => s.kind)).toEqual(['if', 'delay', 'incr']);
    p = moveStmt(p, d.id, 1);
    expect(p.loop!.map((s) => s.kind)).toEqual(['if', 'incr', 'delay']);
    expect(moveStmt(p, d.id, 1)).toBe(p); // already last
    p = replaceStmt(p, d.id, (s) => (s.kind === 'delay' ? { ...s, ms: 250 } : s));
    expect(p.loop![2]).toMatchObject({ kind: 'delay', ms: 250 });
    p = removeStmt(p, d.id);
    expect(p.loop!.map((s) => s.kind)).toEqual(['if', 'incr']);
  });

  it('duplicates with fresh ids, nested ones included', () => {
    const p = demo();
    const ifId = p.loop![0].id;
    const { program, id } = duplicateStmt(p, ifId);
    expect(program.loop).toHaveLength(3);
    const copy = program.loop![1];
    expect(copy.id).toBe(id);
    expect(copy.id).not.toBe(ifId);
    const ids: string[] = [];
    const collect = (list: readonly Stmt[]) => list.forEach((s) => {
      ids.push(s.id);
      if (s.kind === 'if') s.branches.concat(s.otherwise ? [{ ...s.otherwise, cond: b.pin('l0') }] : []).forEach((br) => { ids.push(br.id); collect(br.body); });
    });
    collect(program.loop!);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('adds and removes branches', () => {
    let p = demo();
    const ifId = p.loop![0].id;
    const r = addElseIf(p, ifId, b.flag('Z', 1));
    p = r.program;
    const s = p.loop![0];
    if (s.kind !== 'if') throw new Error('if attendu');
    expect(s.branches).toHaveLength(2);
    expect(s.branches[1]).toMatchObject({ id: r.branchId, cond: { kind: 'flag', flag: 'Z' } });
    // The else exists already: addElse returns it.
    expect(addElse(p, ifId).branchId).toBe(s.otherwise!.id);
    p = removeBranch(p, ifId, s.otherwise!.id);
    expect((p.loop![0] as typeof s).otherwise).toBeNull();
    p = removeBranch(p, ifId, s.branches[0].id);
    expect((p.loop![0] as typeof s).branches).toHaveLength(1);
    // The last « si » branch stays.
    expect(removeBranch(p, ifId, (p.loop![0] as typeof s).branches[0].id)).toBe(p);
  });

  it('creates every block type with valid statements on a TP program', () => {
    const base = templateProgram('tp-vote');
    for (const type of ['on', 'off', 'toggle', 'setAll', 'display', 'delay', 'waitPress', 'waitRelease', 'if', 'while', 'repeat', 'assign', 'incr', 'decr', 'comment'] as const) {
      const { program, stmt } = createBlock(base, type);
      const next = finalizeProgram(insertStmt(program, LOOP_LIST, 0, stmt), base.clockHz);
      const errors = validate(next).filter((i) => i.severity === 'error');
      expect(errors, type).toEqual([]);
      expect(() => generate(next)).not.toThrow();
      expect(blockSummary(next, stmt).label.length).toBeGreaterThan(0);
    }
  });

  it('creates a counter variable for « Répéter » when needed', () => {
    const p = demo();
    const { program, stmt } = createBlock(p, 'repeat');
    expect(stmt).toMatchObject({ kind: 'repeat', counter: 'i', times: 3 });
    expect(program.variables.map((v) => v.name)).toEqual(['x', 'i']);
  });
});

describe('signals and variables', () => {
  it('counts usage', () => {
    const u = computeUsage(demo());
    expect(u.signals.get('d0')).toBe(3);
    expect(u.signals.get('l0')).toBe(1);
    expect(u.names.get('x')).toBe(1);
  });

  it('adds a signal on a free pin with unique names', () => {
    const { program, id } = addSignal(demo());
    const s = program.signals.find((x) => x.id === id)!;
    expect(s.pin).toBe('RB2');
    expect(s.name).toBe('LED_RB2');
    expect(validate(program).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('switches the device wording when the direction changes', () => {
    const p = updateSignal(demo(), 'd1', { dir: 'in' });
    expect(p.signals.find((s) => s.id === 'd1')).toMatchObject({ dir: 'in', device: 'input' });
  });

  it('renames variables everywhere', () => {
    let p = demo();
    p = addVariable(p, 'y').program;
    p = { ...p, loop: [...p.loop!, { ...b.assign(b.v('y'), b.sub(b.v('x'), b.num(1))), id: 's99' }, { ...b.whileLoop(b.cmp(b.v('X'), '<', b.num(3)), []), id: 's98' }] };
    p = updateVariable(p, 'x', { name: 'compte' });
    expect(p.variables.map((v) => v.name)).toEqual(['compte', 'y']);
    const src = generate(finalizeProgram(p, 1_000_000));
    expect(src).toContain('compte++');
    expect(src).toContain('y = compte - 1;');
    expect(src).toContain('while (compte < 3)');
    expect(src).not.toMatch(/\bx\b/);
    expect(renameIdentifier(p, 'nothing', 'other').loop).toBe(p.loop);
  });
});

describe('schematic sync', () => {
  it('builds a program from a circuit (outputs off at start)', () => {
    const io = deriveSignals(templateSchematic('tp-status'));
    const p = programFromSchematic(io, 'Essai', 1_000_000);
    expect(p.signals.map((s) => s.pin)).toEqual(['RB0', 'RB1', 'RB2']);
    expect(p.init.every((s) => s.kind === 'set' && s.value === 0)).toBe(true);
    expect(p.loop).toEqual([]);
    expect(compile(generate(p)).ok).toBe(true);
  });

  it('keeps names and labels, updates hardware, adds and removes', () => {
    const io = deriveSignals(templateSchematic('tp1-demux'));
    let p = demo();
    // L0 on RA0 exists (same pin): kept with its name. D1 (RB1) unused after removing its statements → updated.
    p = updateSignal(p, 'l0', { label: 'Mon interrupteur' });
    const { program, report } = syncWithSchematic(p, io);
    const l0 = program.signals.find((s) => s.pin === 'RA0')!;
    expect(l0).toMatchObject({ id: 'l0', name: 'L0', label: 'Mon interrupteur', dir: 'in' });
    expect(program.signals.map((s) => s.pin).sort()).toEqual(['RA0', 'RA1', 'RB0', 'RB1', 'RB2', 'RB3']);
    expect(report.added.length).toBe(3);
    const names = program.signals.map((s) => s.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps used signals whose pin is no longer wired', () => {
    const io = deriveSignals(templateSchematic('tp-status')); // RB0..RB2 only
    const p = demo(); // L0 on RA0 is used by the loop
    const { program, report } = syncWithSchematic(p, io);
    expect(program.signals.some((s) => s.id === 'l0')).toBe(true);
    expect(report.kept).toEqual(['L0']);
  });
});

describe('loop and interrupts', () => {
  it('turns the main loop off and back on', () => {
    const p = demo();
    const off = setLoopEnabled(p, false);
    expect(off.loop).toBeNull();
    expect(off.init).toHaveLength(4);
    expect(setLoopEnabled(off, true).loop).toEqual([]);
  });

  it('creates the interrupt routine with one block per enabled source and removes the bare skeleton', () => {
    let p = demo();
    p = setInterruptConfig(p, { int: { edge: 'rising' }, gie: true });
    const isr = p.functions.find((f) => f.kind === 'interrupt')!;
    expect(isr.body).toHaveLength(1);
    expect(isr.body[0]).toMatchObject({ kind: 'if', branches: [{ cond: { kind: 'flag', flag: 'INTF' } }] });
    p = setInterruptConfig(p, { int: { edge: 'rising' }, rbChange: true, gie: true });
    expect(p.functions[0].body).toHaveLength(2);
    const fin = finalizeProgram(p, 1_000_000);
    const src = generate(fin);
    expect(src).toContain('void interrupt()');
    expect(src).toContain('INTCON.INTF = 0;');
    expect(src).toContain('INTCON.RBIE = 1;');
    p = setInterruptConfig(fin, undefined);
    expect(p.functions).toEqual([]);
    expect(p.interrupts).toBeUndefined();
  });

  it('assigns fresh ids that never collide (bodyList keys work on new loops)', () => {
    let p = demo();
    const r = createBlock(p, 'while');
    p = insertStmt(r.program, LOOP_LIST, 0, r.stmt);
    const inner = createBlock(p, 'delay');
    p = insertStmt(inner.program, bodyList(r.stmt.id), 0, inner.stmt);
    expect(getList(p, bodyList(r.stmt.id))).toHaveLength(1);
    const fin = finalizeProgram(p, 1_000_000);
    expect(fin.loop![0].id).toBe(r.stmt.id);
  });
});
