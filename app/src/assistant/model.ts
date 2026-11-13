// Pure editing operations on the Program model for the assistant drawer. Every function returns a new Program and
// keeps the untouched parts by reference (so memoized rows do not re-render), never mutating its input.
//
// Statement lists are addressed by a ListKey:
//   'init' | 'loop' | 'fn:<functionId>'   top-level lists
//   '<ifId>/<branchId>'                    body of an if / else-if / else branch
//   '<stmtId>/body'                        body of a while / repeat / for loop
import {
  busPins, checkProgramShape, cloneProgram, emptyProgram, ensureIds, interruptRoutine, normalizeProgram,
  pinPort, stmtConds, stmtExprs, walkCond, walkExpr, walkStmts, ALL_PINS,
  type Bus, type Cond, type Constant, type DerivedIo, type ElseBranch, type Expr, type FunctionDef, type IfBranch,
  type IfStmt, type InterruptConfig, type Level, type PinName, type Program, type Signal, type Stmt, type Variable,
  type VarType,
} from '@pic/program-model';

// ------------------------------------------------------------------------------------------------ program value

const programCache = new WeakMap<object, Program | null>();

/**
 * The store keeps the program as `unknown` (project files are untrusted JSON). Returns a normalized Program, or null
 * when the value is not a usable program. Cached by object identity: the same stored value gives the same Program.
 */
export function asProgram(value: unknown): Program | null {
  if (typeof value !== 'object' || value === null) return null;
  const hit = programCache.get(value);
  if (hit !== undefined) return hit;
  let result: Program | null = null;
  if (checkProgramShape(value).length === 0) {
    try {
      result = normalizeProgram(cloneProgram(value as Program));
    } catch {
      result = null;
    }
  }
  programCache.set(value, result);
  return result;
}

/** Mark a program built by the assistant as already normalized (asProgram returns it as is). */
export function rememberProgram(program: Program): void {
  programCache.set(program, program);
}

/** Last step before storing: the project clock, and ids for anything created without one. */
export function finalizeProgram(program: Program, clockHz: number): Program {
  const out: Program = program.clockHz === clockHz ? { ...program } : { ...program, clockHz };
  ensureIds(out);
  rememberProgram(out);
  return out;
}

// ------------------------------------------------------------------------------------------------ ids

export type IdPrefix = 's' | 'b' | 'f';
export type IdFactory = (prefix: IdPrefix) => string;

/** Fresh ids ('s12', 'b4', 'f2') above every id already used in `program`. */
export function idFactory(program: Program): IdFactory {
  const next: Record<IdPrefix, number> = { s: 1, b: 1, f: 1 };
  const see = (id: string | undefined) => {
    const m = id ? /^([sbf])(\d+)$/.exec(id) : null;
    if (m) {
      const p = m[1] as IdPrefix;
      next[p] = Math.max(next[p], Number(m[2]) + 1);
    }
  };
  const visit = (list: readonly Stmt[]) => walkStmts(list, (s) => {
    see(s.id);
    if (s.kind === 'if') {
      s.branches.forEach((b) => see(b.id));
      see(s.otherwise?.id);
    } else if (s.kind === 'for') {
      see(s.init.id);
      see(s.update.id);
    }
  });
  program.functions.forEach((f) => { see(f.id); visit(f.body); });
  visit(program.init);
  if (program.loop) visit(program.loop);
  return (prefix) => `${prefix}${next[prefix]++}`;
}

// ------------------------------------------------------------------------------------------------ list addressing

export type ListKey = string;
export const INIT_LIST: ListKey = 'init';
export const LOOP_LIST: ListKey = 'loop';
export const fnList = (functionId: string): ListKey => `fn:${functionId}`;
export const branchList = (ifId: string, branchId: string): ListKey => `${ifId}/${branchId}`;
export const bodyList = (stmtId: string): ListKey => `${stmtId}/body`;

/** Visit every statement list with its key (outer lists first). */
export function forEachList(program: Program, fn: (key: ListKey, list: readonly Stmt[]) => void): void {
  const visit = (key: ListKey, list: readonly Stmt[]) => {
    fn(key, list);
    for (const s of list) {
      if (s.kind === 'if') {
        for (const b of s.branches) visit(branchList(s.id, b.id), b.body);
        if (s.otherwise) visit(branchList(s.id, s.otherwise.id), s.otherwise.body);
      } else if (s.kind === 'while' || s.kind === 'repeat' || s.kind === 'for') {
        visit(bodyList(s.id), s.body);
      }
    }
  };
  visit(INIT_LIST, program.init);
  if (program.loop) visit(LOOP_LIST, program.loop);
  for (const f of program.functions) visit(fnList(f.id), f.body);
}

export function getList(program: Program, key: ListKey): readonly Stmt[] | null {
  let found: readonly Stmt[] | null = null;
  forEachList(program, (k, list) => { if (found === null && k === key) found = list; });
  return found;
}

export interface StmtLocation {
  key: ListKey;
  index: number;
  list: readonly Stmt[];
}

/** Where statement `id` lives. */
export function locateStmt(program: Program, id: string): StmtLocation | null {
  let found: StmtLocation | null = null;
  forEachList(program, (key, list) => {
    if (found) return;
    const index = list.findIndex((s) => s.id === id);
    if (index >= 0) found = { key, index, list };
  });
  return found;
}

export function findStmtById(program: Program, id: string): Stmt | null {
  const loc = locateStmt(program, id);
  return loc ? loc.list[loc.index] : null;
}

type ListFn = (list: Stmt[]) => Stmt[];

function mapList(list: Stmt[], key: ListKey, target: ListKey, fn: ListFn): Stmt[] {
  if (key === target) return fn(list);
  let changed = false;
  const out = list.map((s) => {
    const n = mapNested(s, target, fn);
    if (n !== s) changed = true;
    return n;
  });
  return changed ? out : list;
}

function mapNested(s: Stmt, target: ListKey, fn: ListFn): Stmt {
  if (!target.startsWith(`${s.id}/`) && !hasNestedLists(s)) return s;
  switch (s.kind) {
    case 'if': {
      let changed = false;
      const branches = s.branches.map((b) => {
        const body = mapList(b.body, branchList(s.id, b.id), target, fn);
        if (body === b.body) return b;
        changed = true;
        return { ...b, body };
      });
      let otherwise = s.otherwise;
      if (otherwise) {
        const body = mapList(otherwise.body, branchList(s.id, otherwise.id), target, fn);
        if (body !== otherwise.body) {
          changed = true;
          otherwise = { ...otherwise, body };
        }
      }
      return changed ? { ...s, branches, otherwise } : s;
    }
    case 'while':
    case 'repeat':
    case 'for': {
      const body = mapList(s.body, bodyList(s.id), target, fn);
      return body === s.body ? s : { ...s, body };
    }
    default:
      return s;
  }
}

const hasNestedLists = (s: Stmt): boolean => s.kind === 'if' || s.kind === 'while' || s.kind === 'repeat' || s.kind === 'for';

/** Replace the list `key` with fn(list). Unknown keys leave the program unchanged. */
export function updateList(program: Program, key: ListKey, fn: ListFn): Program {
  const init = mapList(program.init, INIT_LIST, key, fn);
  const loop = program.loop ? mapList(program.loop, LOOP_LIST, key, fn) : null;
  let fnChanged = false;
  const functions = program.functions.map((f) => {
    const body = mapList(f.body, fnList(f.id), key, fn);
    if (body === f.body) return f;
    fnChanged = true;
    return { ...f, body };
  });
  if (init === program.init && loop === program.loop && !fnChanged) return program;
  return { ...program, init, loop, functions: fnChanged ? functions : program.functions };
}

// ------------------------------------------------------------------------------------------------ statements

export function insertStmt(program: Program, key: ListKey, index: number, stmt: Stmt): Program {
  return updateList(program, key, (list) => {
    const at = Math.max(0, Math.min(list.length, index));
    return [...list.slice(0, at), stmt, ...list.slice(at)];
  });
}

export function removeStmt(program: Program, id: string): Program {
  const loc = locateStmt(program, id);
  if (!loc) return program;
  return updateList(program, loc.key, (list) => list.filter((s) => s.id !== id));
}

/** Move a statement up (-1) or down (+1) inside its list. */
export function moveStmt(program: Program, id: string, delta: -1 | 1): Program {
  const loc = locateStmt(program, id);
  if (!loc) return program;
  const to = loc.index + delta;
  if (to < 0 || to >= loc.list.length) return program;
  return updateList(program, loc.key, (list) => {
    const out = [...list];
    [out[loc.index], out[to]] = [out[to], out[loc.index]];
    return out;
  });
}

export function replaceStmt(program: Program, id: string, next: Stmt | ((s: Stmt) => Stmt)): Program {
  const loc = locateStmt(program, id);
  if (!loc) return program;
  const current = loc.list[loc.index];
  const replacement = typeof next === 'function' ? next(current) : next;
  if (replacement === current) return program;
  return updateList(program, loc.key, (list) => list.map((s) => (s.id === id ? replacement : s)));
}

/** Deep copy of a statement with fresh ids for it and everything inside. */
export function cloneStmtWithIds(stmt: Stmt, newId: IdFactory): Stmt {
  const copy = JSON.parse(JSON.stringify(stmt)) as Stmt;
  const renumber = (s: Stmt) => {
    s.id = newId('s');
    if (s.kind === 'if') {
      for (const b of s.branches) { b.id = newId('b'); b.body.forEach(renumber); }
      if (s.otherwise) { s.otherwise.id = newId('b'); s.otherwise.body.forEach(renumber); }
    } else if (s.kind === 'while' || s.kind === 'repeat') {
      s.body.forEach(renumber);
    } else if (s.kind === 'for') {
      s.init.id = newId('s');
      s.update.id = newId('s');
      s.body.forEach(renumber);
    }
  };
  renumber(copy);
  return copy;
}

/** Insert a copy right after the statement. Returns the copy's id. */
export function duplicateStmt(program: Program, id: string): { program: Program; id: string | null } {
  const loc = locateStmt(program, id);
  if (!loc) return { program, id: null };
  const copy = cloneStmtWithIds(loc.list[loc.index], idFactory(program));
  return { program: insertStmt(program, loc.key, loc.index + 1, copy), id: copy.id };
}

// ------------------------------------------------------------------------------------------------ if branches

function updateIf(program: Program, ifId: string, fn: (s: IfStmt) => IfStmt): Program {
  return replaceStmt(program, ifId, (s) => (s.kind === 'if' ? fn(s) : s));
}

/** Add an « sinon si » branch (before the final « sinon »). */
export function addElseIf(program: Program, ifId: string, cond: Cond): { program: Program; branchId: string } {
  const branchId = idFactory(program)('b');
  return {
    program: updateIf(program, ifId, (s) => ({ ...s, branches: [...s.branches, { id: branchId, cond, body: [] }] })),
    branchId,
  };
}

/** Add the final « sinon » branch (no-op when it exists). */
export function addElse(program: Program, ifId: string): { program: Program; branchId: string } {
  const branchId = idFactory(program)('b');
  let created = branchId;
  const next = updateIf(program, ifId, (s) => {
    if (s.otherwise) {
      created = s.otherwise.id;
      return s;
    }
    return { ...s, otherwise: { id: branchId, body: [] } };
  });
  return { program: next, branchId: created };
}

/** Remove a branch; the last remaining « si » branch cannot be removed (delete the block instead). */
export function removeBranch(program: Program, ifId: string, branchId: string): Program {
  return updateIf(program, ifId, (s) => {
    if (s.otherwise?.id === branchId) return { ...s, otherwise: null };
    if (s.branches.length <= 1) return s;
    return { ...s, branches: s.branches.filter((b) => b.id !== branchId) };
  });
}

export function updateBranch(
  program: Program,
  ifId: string,
  branchId: string,
  patch: Partial<Pick<IfBranch, 'cond' | 'comment' | 'note' | 'text'>>,
): Program {
  return updateIf(program, ifId, (s) => {
    if (s.otherwise?.id === branchId) {
      const { cond: _cond, text: _text, ...rest } = patch;
      return { ...s, otherwise: cleanOptional({ ...s.otherwise, ...rest }) as ElseBranch };
    }
    return { ...s, branches: s.branches.map((b) => (b.id === branchId ? cleanOptional({ ...b, ...patch }) as IfBranch : b)) };
  });
}

/** Drop optional text fields set to '' or undefined (keeps the JSON clean and the generator quiet). */
export function cleanOptional<T extends object>(o: T): T {
  const out = { ...o } as Record<string, unknown>;
  for (const k of ['comment', 'lead', 'text', 'note'] as const) {
    if (k in out && (out[k] === undefined || out[k] === '')) delete out[k];
  }
  return out as T;
}

// ------------------------------------------------------------------------------------------------ usage

export interface Usage {
  /** Signal id → number of statements using it. */
  signals: Map<string, number>;
  buses: Map<string, number>;
  /** Lower-case variable / constant name → number of statements using it. */
  names: Map<string, number>;
}

export function computeUsage(program: Program): Usage {
  const usage: Usage = { signals: new Map(), buses: new Map(), names: new Map() };
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  const visit = (list: readonly Stmt[]) => walkStmts(list, (s) => {
    const signals = new Set<string>();
    const buses = new Set<string>();
    const names = new Set<string>();
    const onExpr = (e: Expr) => walkExpr(e, (x) => {
      if (x.kind === 'signal') signals.add(x.id);
      else if (x.kind === 'bus') buses.add(x.id);
      else if (x.kind === 'var') names.add(x.name.toLowerCase());
    });
    switch (s.kind) {
      case 'set':
      case 'toggle': signals.add(s.signal); break;
      case 'setAll': s.signals.forEach((id) => signals.add(id)); break;
      case 'display': buses.add(s.bus); break;
      case 'incr':
      case 'decr': names.add(s.variable.toLowerCase()); break;
      case 'repeat': names.add(s.counter.toLowerCase()); break;
      case 'for':
        if (s.update.kind === 'incr' || s.update.kind === 'decr') names.add(s.update.variable.toLowerCase());
        break;
      default: break;
    }
    stmtExprs(s).forEach(onExpr);
    for (const c of stmtConds(s)) walkCond(c, (x) => { if (x.kind === 'pin') signals.add(x.signal); }, onExpr);
    signals.forEach((id) => bump(usage.signals, id));
    buses.forEach((id) => bump(usage.buses, id));
    names.forEach((n) => bump(usage.names, n));
  });
  visit(program.init);
  if (program.loop) visit(program.loop);
  program.functions.forEach((f) => visit(f.body));
  return usage;
}

// ------------------------------------------------------------------------------------------------ signals & buses

/** Pins already taken by a signal or a bus (optionally ignoring one signal / bus id). */
export function takenPins(program: Program, ignoreId?: string): Set<PinName> {
  const taken = new Set<PinName>();
  for (const s of program.signals) if (s.id !== ignoreId) taken.add(s.pin);
  for (const b of program.buses) if (b.id !== ignoreId) busPins(b).forEach((p) => taken.add(p));
  return taken;
}

function uniqueIn(base: string, used: ReadonlySet<string>, sep = '_'): string {
  let name = base;
  for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base}${sep}${k}`;
  return name;
}

/** Upper-case names (signals, buses, constants, variables) already used: MikroC is case-insensitive. */
export function usedNames(program: Program): Set<string> {
  return new Set([
    ...program.signals.map((s) => s.name.toLowerCase()),
    ...program.buses.map((b) => b.name.toLowerCase()),
    ...program.constants.map((c) => c.name.toLowerCase()),
    ...program.variables.map((v) => v.name.toLowerCase()),
  ]);
}

/** A new output (LED) on the first free pin, port B first. */
export function addSignal(program: Program, dir: Signal['dir'] = 'out'): { program: Program; id: string } {
  const taken = takenPins(program);
  const order = [...ALL_PINS.filter((p) => pinPort(p) === 'B'), ...ALL_PINS.filter((p) => pinPort(p) === 'A')];
  const pin = order.find((p) => !taken.has(p)) ?? 'RB0';
  const base = dir === 'out' ? `LED_${pin}` : `ENTREE_${pin}`;
  const name = uniqueIn(base, usedNames(program));
  const ids = new Set(program.signals.map((s) => s.id));
  const id = uniqueIn(name.toLowerCase(), ids);
  const signal: Signal = {
    id,
    name,
    pin,
    dir,
    label: dir === 'out' ? `Led ${pin}` : `Interrupteur ${pin}`,
    activeLevel: 1,
    device: dir === 'out' ? 'led' : 'logicstate',
  };
  return { program: { ...program, signals: [...program.signals, signal] }, id };
}

export function updateSignal(program: Program, id: string, patch: Partial<Omit<Signal, 'id'>>): Program {
  let changed = false;
  const signals = program.signals.map((s) => {
    if (s.id !== id) return s;
    const next = { ...s, ...patch };
    // A direction change makes the device wording wrong (« Led » on an input): fall back to a neutral device.
    if (patch.dir && patch.dir !== s.dir && patch.device === undefined) {
      next.device = patch.dir === 'out' ? 'output' : 'input';
    }
    changed = true;
    return cleanOptional(next);
  });
  return changed ? { ...program, signals } : program;
}

export function removeSignal(program: Program, id: string): Program {
  return { ...program, signals: program.signals.filter((s) => s.id !== id) };
}

export function addBus(program: Program): { program: Program; id: string } {
  const taken = takenPins(program);
  // A 7SEG-BCD on four consecutive free pins, RB0..RB3 first.
  let port: 'A' | 'B' = 'B';
  let lsb = 0;
  search: for (const p of ['B', 'A'] as const) {
    const width = p === 'A' ? 5 : 8;
    for (let start = 0; start + 4 <= width; start++) {
      if ([0, 1, 2, 3].every((k) => !taken.has(`R${p}${start + k}` as PinName))) {
        port = p;
        lsb = start;
        break search;
      }
    }
  }
  const name = uniqueIn('AFFICHEUR', usedNames(program), '');
  const ids = new Set(program.buses.map((b) => b.id));
  const id = uniqueIn(name.toLowerCase(), ids);
  const bus: Bus = { id, name, port, lsb, width: 4, dir: 'out', label: 'Afficheur 7 segments BCD', device: 'bcd' };
  return { program: { ...program, buses: [...program.buses, bus] }, id };
}

export function updateBus(program: Program, id: string, patch: Partial<Omit<Bus, 'id'>>): Program {
  return { ...program, buses: program.buses.map((b) => (b.id === id ? cleanOptional({ ...b, ...patch }) : b)) };
}

export function removeBus(program: Program, id: string): Program {
  return { ...program, buses: program.buses.filter((b) => b.id !== id) };
}

export interface SyncReport {
  added: string[];
  updated: string[];
  removed: string[];
  /** Used by the program although the schematic has nothing on their pin. */
  kept: string[];
}

const sameSignalHardware = (a: Signal, b: Signal) =>
  a.dir === b.dir && a.device === b.device && a.componentId === b.componentId && a.activeLevel === b.activeLevel;

/**
 * Merge the I/O derived from the schematic (deriveSignals) into the program. The schematic decides the hardware
 * (pin, direction, device, active level, component); the student's names, labels and comments are kept. Unused
 * signals whose pin is no longer wired are removed; used ones are kept (validate() then flags them).
 */
export function syncWithSchematic(program: Program, derived: DerivedIo): { program: Program; report: SyncReport } {
  const report: SyncReport = { added: [], updated: [], removed: [], kept: [] };
  const usage = computeUsage(program);
  const derivedBusPins = new Set(derived.buses.flatMap((b) => busPins(b)));

  // Buses first (their pins are not individual signals).
  const consumedBuses = new Set<Bus>();
  const buses: Bus[] = [];
  for (const b of program.buses) {
    const pins = new Set(busPins(b));
    const d = derived.buses.find((x) => !consumedBuses.has(x) && ((b.componentId && x.componentId === b.componentId) || busPins(x).some((p) => pins.has(p))));
    if (d) {
      consumedBuses.add(d);
      const next: Bus = { ...b, port: d.port, lsb: d.lsb, width: d.width, dir: d.dir, device: d.device, componentId: d.componentId };
      if (next.port !== b.port || next.lsb !== b.lsb || next.width !== b.width || next.dir !== b.dir || next.device !== b.device || next.componentId !== b.componentId) {
        report.updated.push(b.name);
      }
      buses.push(cleanOptional(next));
    } else if ((usage.buses.get(b.id) ?? 0) > 0) {
      report.kept.push(b.name);
      buses.push(b);
    } else {
      report.removed.push(b.name);
    }
  }

  const consumed = new Set<Signal>();
  const signals: Signal[] = [];
  for (const s of program.signals) {
    const d = derived.signals.find((x) => !consumed.has(x) && x.pin === s.pin);
    if (d) {
      consumed.add(d);
      const next: Signal = { ...s, dir: d.dir, device: d.device, componentId: d.componentId, activeLevel: d.activeLevel };
      if (!sameSignalHardware(s, next)) report.updated.push(s.name);
      signals.push(cleanOptional(next));
    } else if ((usage.signals.get(s.id) ?? 0) > 0) {
      report.kept.push(s.name);
      signals.push(s);
    } else {
      report.removed.push(s.name);
    }
  }

  const names = new Set([
    ...signals.map((s) => s.name.toLowerCase()), ...buses.map((b) => b.name.toLowerCase()),
    ...program.constants.map((c) => c.name.toLowerCase()), ...program.variables.map((v) => v.name.toLowerCase()),
  ]);
  const signalIds = new Set(signals.map((s) => s.id));
  const pinsTaken = new Set<PinName>([...signals.map((s) => s.pin), ...buses.flatMap((b) => busPins(b))]);
  for (const d of derived.buses) {
    if (consumedBuses.has(d) || busPins(d).some((p) => pinsTaken.has(p))) continue;
    const name = uniqueIn(d.name, names, '');
    names.add(name.toLowerCase());
    const id = uniqueIn(name.toLowerCase(), new Set(buses.map((b) => b.id)));
    buses.push({ ...d, id, name });
    busPins(d).forEach((p) => pinsTaken.add(p));
    report.added.push(name);
  }
  for (const d of derived.signals) {
    if (consumed.has(d) || pinsTaken.has(d.pin) || derivedBusPins.has(d.pin)) continue;
    const name = uniqueIn(d.name, names);
    names.add(name.toLowerCase());
    const id = uniqueIn(name.toLowerCase(), signalIds);
    signalIds.add(id);
    signals.push({ ...d, id, name });
    pinsTaken.add(d.pin);
    report.added.push(name);
  }
  return { program: { ...program, signals, buses }, report };
}

/** French one-liner for a sync report (toast). */
export function syncSummary(r: SyncReport): string {
  const parts: string[] = [];
  const n = (k: number, one: string, many: string) => `${k} ${k > 1 ? many : one}`;
  if (r.added.length) parts.push(n(r.added.length, 'broche ajoutée', 'broches ajoutées'));
  if (r.updated.length) parts.push(n(r.updated.length, 'mise à jour', 'mises à jour'));
  if (r.removed.length) parts.push(n(r.removed.length, 'retirée', 'retirées'));
  if (r.kept.length) parts.push(`${r.kept.join(', ')} conservé${r.kept.length > 1 ? 's' : ''} (utilisé${r.kept.length > 1 ? 's' : ''} par le programme, mais plus câblé${r.kept.length > 1 ? 's' : ''})`);
  return parts.length ? `Synchronisé avec le schéma : ${parts.join(', ')}.` : 'Les broches correspondent déjà au schéma.';
}

/** A new program built from the circuit: its I/O, every output switched off at start, an empty main loop. */
export function programFromSchematic(derived: DerivedIo, title: string, clockHz: number): Program {
  const program = emptyProgram(title, clockHz);
  program.signals = derived.signals.map((s) => ({ ...s }));
  program.buses = derived.buses.map((b) => ({ ...b }));
  const newId = idFactory(program);
  program.init = program.signals
    .filter((s) => s.dir === 'out')
    .map((s): Stmt => ({ id: newId('s'), kind: 'set', signal: s.id, value: (1 - s.activeLevel) as Level }));
  program.loop = [];
  return ensureIds(program);
}

// ------------------------------------------------------------------------------------------------ variables & constants

const VAR_DEFAULTS = ['x', 'y', 'z', 'compteur', 'i', 'j', 'k'];

export function addVariable(program: Program, name?: string, type: VarType = 'unsigned char'): { program: Program; name: string } {
  const used = usedNames(program);
  const base = name ?? VAR_DEFAULTS.find((n) => !used.has(n)) ?? 'var';
  const unique = used.has(base.toLowerCase()) ? uniqueIn(base, used, '') : base;
  const variable: Variable = { name: unique, type };
  return { program: { ...program, variables: [...program.variables, variable] }, name: unique };
}

export function addConstant(program: Program): { program: Program; name: string } {
  const name = uniqueIn('VALEUR', usedNames(program), '');
  const constant: Constant = { name, value: 0, radix: 16 };
  return { program: { ...program, constants: [...program.constants, constant] }, name };
}

/** Rewrite every reference to variable / constant `from` (case-insensitive, as MikroC) into `to`. */
export function renameIdentifier(program: Program, from: string, to: string): Program {
  if (from === to) return program;
  const match = (n: string) => n.toLowerCase() === from.toLowerCase();
  const expr = (e: Expr): Expr => {
    switch (e.kind) {
      case 'var': return match(e.name) ? { kind: 'var', name: to } : e;
      case 'bin': {
        const left = expr(e.left);
        const right = expr(e.right);
        return left === e.left && right === e.right ? e : { ...e, left, right };
      }
      case 'unary': {
        const arg = expr(e.arg);
        return arg === e.arg ? e : { ...e, arg };
      }
      default: return e;
    }
  };
  const cond = (c: Cond): Cond => {
    switch (c.kind) {
      case 'compare': {
        const left = expr(c.left);
        const right = expr(c.right);
        return left === c.left && right === c.right ? c : { ...c, left, right };
      }
      case 'and':
      case 'or': {
        const items = c.items.map(cond);
        return items.every((x, i) => x === c.items[i]) ? c : { ...c, items };
      }
      case 'not': {
        const inner = cond(c.cond);
        return inner === c.cond ? c : { ...c, cond: inner };
      }
      default: return c;
    }
  };
  const list = (stmts: Stmt[]): Stmt[] => {
    let changed = false;
    const out = stmts.map((s) => {
      const n = stmt(s);
      if (n !== s) changed = true;
      return n;
    });
    return changed ? out : stmts;
  };
  const stmt = (s: Stmt): Stmt => {
    switch (s.kind) {
      case 'incr':
      case 'decr': return match(s.variable) ? { ...s, variable: to } : s;
      case 'assign': {
        const target = expr(s.target) as typeof s.target;
        const value = expr(s.value);
        return target === s.target && value === s.value ? s : { ...s, target, value };
      }
      case 'display': {
        const value = expr(s.value);
        return value === s.value ? s : { ...s, value };
      }
      case 'waitFor': {
        const c = cond(s.cond);
        return c === s.cond ? s : { ...s, cond: c };
      }
      case 'if': {
        let changed = false;
        const branches = s.branches.map((b) => {
          const c = cond(b.cond);
          const body = list(b.body);
          if (c === b.cond && body === b.body) return b;
          changed = true;
          return { ...b, cond: c, body };
        });
        let otherwise = s.otherwise;
        if (otherwise) {
          const body = list(otherwise.body);
          if (body !== otherwise.body) { changed = true; otherwise = { ...otherwise, body }; }
        }
        return changed ? { ...s, branches, otherwise } : s;
      }
      case 'while': {
        const c = cond(s.cond);
        const body = list(s.body);
        return c === s.cond && body === s.body ? s : { ...s, cond: c, body };
      }
      case 'repeat': {
        const body = list(s.body);
        const counter = match(s.counter) ? to : s.counter;
        return counter === s.counter && body === s.body ? s : { ...s, counter, body };
      }
      case 'for': {
        const init = stmt(s.init) as typeof s.init;
        const update = stmt(s.update) as typeof s.update;
        const c = cond(s.cond);
        const body = list(s.body);
        return init === s.init && update === s.update && c === s.cond && body === s.body ? s : { ...s, init, update, cond: c, body };
      }
      default: return s;
    }
  };
  const loop = program.loop ? list(program.loop) : null;
  return {
    ...program,
    init: list(program.init),
    loop,
    functions: program.functions.map((f) => {
      const body = list(f.body);
      return body === f.body ? f : { ...f, body };
    }),
  };
}

export function updateVariable(program: Program, name: string, patch: Partial<Variable>): Program {
  const renamed = patch.name && patch.name !== name ? renameIdentifier(program, name, patch.name) : program;
  return {
    ...renamed,
    variables: renamed.variables.map((v) => (v.name === name ? cleanOptional({ ...v, ...patch }) : v)),
  };
}

export function removeVariable(program: Program, name: string): Program {
  return { ...program, variables: program.variables.filter((v) => v.name !== name) };
}

export function updateConstant(program: Program, name: string, patch: Partial<Constant>): Program {
  const renamed = patch.name && patch.name !== name ? renameIdentifier(program, name, patch.name) : program;
  return {
    ...renamed,
    constants: renamed.constants.map((c) => (c.name === name ? cleanOptional({ ...c, ...patch }) : c)),
  };
}

export function removeConstant(program: Program, name: string): Program {
  return { ...program, constants: program.constants.filter((c) => c.name !== name) };
}

// ------------------------------------------------------------------------------------------------ main loop

/**
 * `while(1)` on or off. Turning it off moves the loop's blocks to the end of the initialisation (the program then
 * runs once and stops, like EXEMPLE1).
 */
export function setLoopEnabled(program: Program, enabled: boolean): Program {
  if (enabled) return program.loop ? program : { ...program, loop: [] };
  if (!program.loop) return program;
  return { ...program, init: [...program.init, ...program.loop], loop: null };
}

// ------------------------------------------------------------------------------------------------ interrupts

type IsrFlag = 'INTF' | 'RBIF' | 'T0IF';

export const isInterruptEnabled = (cfg: InterruptConfig | undefined): boolean => !!cfg && (!!cfg.int || !!cfg.rbChange || !!cfg.tmr0);

const FLAG_COMMENT: Readonly<Record<IsrFlag, string>> = {
  INTF: 'Interruption RB0/INT',
  RBIF: "Changement d'état sur RB4 à RB7",
  T0IF: 'Débordement du TMR0',
};

function enabledFlags(cfg: InterruptConfig | undefined): IsrFlag[] {
  if (!cfg) return [];
  const out: IsrFlag[] = [];
  if (cfg.int) out.push('INTF');
  if (cfg.rbChange) out.push('RBIF');
  if (cfg.tmr0) out.push('T0IF');
  return out;
}

function testsFlag(body: readonly Stmt[], flag: IsrFlag): boolean {
  let found = false;
  walkStmts(body, (s) => {
    for (const c of stmtConds(s)) walkCond(c, (x) => { if (x.kind === 'flag' && x.flag === flag) found = true; });
  });
  return found;
}

/** An interrupt routine holding nothing but the generated « if (flag) { clear flag } » skeleton. */
export function isSkeletonIsr(fn: FunctionDef): boolean {
  return fn.body.every((s) => s.kind === 'if' && !s.otherwise && s.branches.every((b) => b.body.every((x) => x.kind === 'clearFlag')));
}

/**
 * New interrupt set-up. Enabling a source creates `void interrupt()` if needed and adds an
 * `if (INTCON.xIF == 1) { … INTCON.xIF = 0; }` block for it; disabling every source removes a routine that is
 * still the bare skeleton (one with student code is kept, and validate() warns that it is never called).
 */
export function setInterruptConfig(program: Program, cfg: InterruptConfig | undefined): Program {
  const enabled = isInterruptEnabled(cfg);
  let functions = program.functions;
  const isr = interruptRoutine(program);
  if (enabled) {
    const newId = idFactory(program);
    let routine: FunctionDef = isr ?? { id: newId('f'), name: 'interrupt', kind: 'interrupt', body: [] };
    for (const flag of enabledFlags(cfg)) {
      if (testsFlag(routine.body, flag)) continue;
      const block: IfStmt = {
        id: newId('s'),
        kind: 'if',
        branches: [{
          id: newId('b'),
          cond: { kind: 'flag', flag, value: 1 },
          body: [{ id: newId('s'), kind: 'clearFlag', flag, comment: `Effacer le drapeau ${flag}` }],
          comment: FLAG_COMMENT[flag],
        }],
        otherwise: null,
      };
      routine = { ...routine, body: [...routine.body, block] };
    }
    functions = isr ? functions.map((f) => (f === isr ? routine : f)) : [routine, ...functions];
  } else if (isr && isSkeletonIsr(isr)) {
    functions = functions.filter((f) => f !== isr);
  }
  const next: Program = { ...program, functions };
  if (enabled && cfg) next.interrupts = cfg;
  else delete next.interrupts;
  return next;
}

export function removeFunction(program: Program, id: string): Program {
  return { ...program, functions: program.functions.filter((f) => f.id !== id) };
}

// ------------------------------------------------------------------------------------------------ helpers for the UI

/** Outputs first sorted like the pins; handy for selects. */
export function outputs(program: Program): Signal[] {
  return program.signals.filter((s) => s.dir === 'out');
}

export function inputs(program: Program): Signal[] {
  return program.signals.filter((s) => s.dir === 'in');
}

/** Pins a bus would occupy, or null when it does not fit its port. */
export function busRange(port: 'A' | 'B', lsb: number, width: number): PinName[] | null {
  const max = port === 'A' ? 5 : 8;
  if (lsb < 0 || width < 1 || lsb + width > max) return null;
  return busPins({ port, lsb, width });
}

/** « RB0 à RB3 ». */
export function busPinsText(bus: Pick<Bus, 'port' | 'lsb' | 'width'>): string {
  const pins = busPins(bus);
  if (pins.length === 0) return '';
  if (pins.length === 1) return pins[0];
  return `${pins[0]} à ${pins[pins.length - 1]}`;
}
