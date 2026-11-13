import type { IntType } from '../ast';
import { canonicalAddress, GPR_END, GPR_START } from '../device';
import { Codes, type DiagnosticBag } from '../diagnostics';
import type { Semantics } from '../sema/checker';
import type { FuncSymbol, VarSymbol } from '../sema/symbols';
import { byteOf, pattern, typeToString } from '../sema/types';
import { Emitter, LabelFactory } from './emitter';
import { ExprGen } from './expr';
import { at, type FileRef, type Frame, R, sfr, type Slot, slotRef } from './ir';
import { type ExecContext, Runtime } from './runtime';
import type { ProgramServices } from './services';
import { StmtGen } from './stmt';
import { addSlot, type CodeUnit, newFrame } from './units';
import { TempPool } from './values';

export interface GenOptions {
  clockHz: number;
  xtalFreq?: number;
}

/** A declared `sbit`: no storage of its own, listed in CompileResult.symbols at the byte holding its bit. */
export interface SbitAlias {
  name: string;
  scope: string;
  ref: FileRef;
  bit: number;
}

export interface GeneratedProgram {
  units: CodeUnit[];
  globals: Frame;
  sbits: SbitAlias[];
  /** Name of the reset unit (fixed at 0x0000) and of the interrupt unit (0x0004), if any. */
  resetUnit: string;
  isrUnit?: string;
}

const RESET = '__reset';
const START = '__start';
const ISR = '_interrupt';

export function generate(sem: Semantics, opts: GenOptions, diags: DiagnosticBag): GeneratedProgram {
  return new ProgramGen(sem, opts, diags).run();
}

class ProgramGen implements ProgramServices {
  readonly labels = new LabelFactory();
  readonly runtime: Runtime;
  readonly clockHz: number;
  readonly xtalFreq?: number;
  private readonly globalsFrame = newFrame('__globals');
  private readonly frames = new Map<FuncSymbol, Frame>();
  private readonly storage = new Map<VarSymbol, FileRef>();
  private readonly bits = new Map<VarSymbol, { f: FileRef; b: number }>();
  private globalBitByte: Slot | null = null;
  private globalBitCount = 0;
  private readonly returns = new Map<FuncSymbol, FileRef>();
  private readonly tables = new Map<string, CodeUnit>();
  private readonly tableNames = new Map<VarSymbol, string>();
  private readonly contexts = new Map<FuncSymbol, ExecContext>();
  private readonly units: CodeUnit[] = [];

  constructor(
    readonly sem: Semantics,
    opts: GenOptions,
    readonly diags: DiagnosticBag,
  ) {
    this.clockHz = opts.clockHz;
    this.xtalFreq = opts.xtalFreq;
    this.runtime = new Runtime(this.labels, opts.clockHz);
  }

  run(): GeneratedProgram {
    const reachable = this.computeContexts();
    for (const fn of this.sem.functions) this.frames.set(fn, newFrame(this.functionLabel(fn)));
    // Slots in declaration order, so addresses follow the source (x at 0x0C, y at 0x0D…).
    for (const g of this.sem.globals) this.reserve(g);
    for (const fn of this.sem.functions) {
      if (!reachable.has(fn)) continue;
      fn.params.forEach((p) => this.varRef(p));
      fn.locals.forEach((l) => this.reserve(l));
    }

    const reset: CodeUnit = this.newUnit(RESET, 'reset', newFrame(RESET));
    reset.fixedAddress = 0;
    this.units.push(reset);

    let isrName: string | undefined;
    if (this.sem.isr) {
      this.units.push(this.isrUnit(this.sem.isr));
      isrName = ISR;
    }
    const start = this.startupUnit();
    const resetEm = new Emitter(this.labels, 'reset');
    resetEm.goto(start ? START : this.mainLabel());
    reset.code.push(...resetEm.code);
    reset.jumps.add(start ? START : this.mainLabel());
    if (start) this.units.push(start);

    for (const fn of this.sem.functions) {
      if (fn === this.sem.isr || !reachable.has(fn)) continue;
      this.units.push(this.functionUnit(fn));
    }
    this.units.push(...this.runtime.units, ...this.tables.values());
    return { units: this.units, globals: this.globalsFrame, sbits: this.sbitAliases(), resetUnit: RESET, isrUnit: isrName };
  }

  /** Declared sbits whose target has an address (an SFR, or a variable that got RAM). */
  private sbitAliases(): SbitAlias[] {
    const out: SbitAlias[] = [];
    for (const sb of this.sem.sbits.values()) {
      const t = sb.target;
      const scope = sb.fn ? sb.fn.name : 'global';
      if (t.kind === 'sfr') out.push({ name: sb.name, scope, ref: sfr(t.def.addr), bit: t.bit });
      else if (this.storage.has(t.sym)) out.push({ name: sb.name, scope, ref: at(this.varRef(t.sym), t.bit >> 3), bit: t.bit & 7 });
    }
    return out;
  }

  /** Allocate the slot of a used variable that lives in RAM. */
  private reserve(v: VarSymbol): void {
    if (v.reads + v.writes === 0 || v.constValue !== undefined || v.romData) return;
    if (v.type.kind === 'bit') this.bitRef(v);
    else if (v.type.kind === 'int' || v.type.kind === 'array') this.varRef(v);
  }

  private newUnit(name: string, kind: CodeUnit['kind'], frame: Frame): CodeUnit {
    return { name, kind, code: [], frame, callees: new Set(), jumps: new Set() };
  }

  private mainLabel(): string {
    return this.sem.main ? this.functionLabel(this.sem.main) : '_main';
  }

  /** Execution context of each user function; reports recursion and functions shared with the interrupt. */
  private computeContexts(): Set<FuncSymbol> {
    const reach = (root: FuncSymbol | null): Set<FuncSymbol> => {
      const seen = new Set<FuncSymbol>();
      const visit = (f: FuncSymbol) => {
        if (seen.has(f)) return;
        seen.add(f);
        f.callees.forEach(visit);
      };
      if (root) visit(root);
      return seen;
    };
    const fromMain = reach(this.sem.main);
    const fromIsr = reach(this.sem.isr);
    for (const fn of this.sem.functions) {
      if (fromIsr.has(fn) && !fromMain.has(fn)) this.contexts.set(fn, 'isr');
      else this.contexts.set(fn, 'main');
      if (fromIsr.has(fn) && fromMain.has(fn) && fn !== this.sem.isr) {
        this.diags.warning(
          Codes.REENTRANT,
          `La fonction '${fn.name}' est appelée depuis main et depuis l'interruption : ses variables ne sont pas réentrantes`,
          fn.decl?.nameSpan,
        );
      }
    }
    // Recursion (direct or indirect) cannot work with static frames and the 8-level hardware stack.
    const state = new Map<FuncSymbol, 1 | 2>();
    const dfs = (f: FuncSymbol, path: FuncSymbol[]) => {
      state.set(f, 1);
      for (const c of f.callees) {
        if (state.get(c) === 1) {
          const cycle = [...path.slice(path.indexOf(c)), c].map((x) => x.name).join(' → ');
          this.diags.error(Codes.RECURSION, `Récursivité non supportée : ${cycle}`, c.decl?.nameSpan);
        } else if (!state.has(c)) dfs(c, [...path, c]);
      }
      state.set(f, 2);
    };
    for (const fn of this.sem.functions) if (!state.has(fn)) dfs(fn, [fn]);
    return new Set([...fromMain, ...fromIsr]);
  }

  // ---------------------------------------------------------------------------------------------------------
  // ProgramServices

  functionLabel(fn: FuncSymbol): string {
    return fn.isInterrupt ? ISR : `_${fn.name}`;
  }

  contextOf(fn: FuncSymbol): ExecContext {
    return this.contexts.get(fn) ?? 'main';
  }

  varRef(sym: VarSymbol): FileRef {
    const existing = this.storage.get(sym);
    if (existing) return existing;
    let ref: FileRef;
    const size = sym.type.kind === 'int' ? sym.type.size : sym.type.kind === 'array' ? sym.type.elem.size * sym.type.length : 1;
    const scope = sym.fn && sym.storage !== 'global' ? sym.fn.name : 'global';
    const typeText = typeToString(sym.type);
    if (sym.absolute !== undefined) {
      const addr = canonicalAddress(sym.absolute);
      const low = addr & 0x7f;
      if (low >= GPR_START && low <= GPR_END) {
        ref = slotRef(addSlot(this.globalsFrame, sym.name, size, { fixed: low, scope, typeText }));
      } else {
        // An absolute address on a SFR makes the variable an alias of that register.
        ref = sfr(addr);
        addSlot(this.globalsFrame, sym.name, 0, { fixed: addr, scope, typeText });
      }
    } else if (sym.storage === 'global' || sym.storage === 'static' || !sym.fn) {
      ref = slotRef(addSlot(this.globalsFrame, sym.name, size, { scope, typeText }));
    } else {
      const frame = this.frames.get(sym.fn) ?? this.globalsFrame;
      ref = slotRef(addSlot(frame, sym.name, size, { scope, typeText }));
    }
    this.storage.set(sym, ref);
    return ref;
  }

  bitRef(sym: VarSymbol): { f: FileRef; b: number } {
    const existing = this.bits.get(sym);
    if (existing) return existing;
    let loc: { f: FileRef; b: number };
    if (sym.storage === 'local' && sym.fn) {
      const frame = this.frames.get(sym.fn) ?? this.globalsFrame;
      loc = { f: slotRef(addSlot(frame, sym.name, 1, { scope: sym.fn.name, typeText: 'bit' })), b: 0 };
    } else {
      if (!this.globalBitByte || this.globalBitCount === 8) {
        const n = this.globalsFrame.slots.filter((x) => x.bitNames).length;
        this.globalBitByte = addSlot(this.globalsFrame, n ? `__bits${n}` : '__bits', 1, { bitNames: [] });
        this.globalBitCount = 0;
      }
      this.globalBitByte.bitNames![this.globalBitCount] = sym.name;
      loc = { f: slotRef(this.globalBitByte), b: this.globalBitCount++ };
    }
    this.bits.set(sym, loc);
    return loc;
  }

  returnRef(fn: FuncSymbol): FileRef {
    const existing = this.returns.get(fn);
    if (existing) return existing;
    const size = fn.returnType.kind === 'int' ? fn.returnType.size : 1;
    const frame = this.frames.get(fn) ?? this.globalsFrame;
    const ref = slotRef(addSlot(frame, `${this.functionLabel(fn)}.ret`, size));
    this.returns.set(fn, ref);
    return ref;
  }

  romTable(sym: VarSymbol, byte: number): string {
    const elem = (sym.type as { elem: IntType }).elem;
    const base = this.tableBaseName(sym);
    const name = elem.size > 1 ? `${base}_b${byte}` : base;
    if (this.tables.has(name)) return name;
    const unit = this.newUnit(name, 'table', newFrame(name));
    const em = new Emitter(this.labels, name);
    em.line = sym.decl.span.line;
    em.label(name);
    for (const v of sym.romData ?? []) em.retlw(byteOf(pattern(v, elem.size), byte));
    unit.code.push(...em.code);
    if ((sym.romData?.length ?? 0) > 256) {
      this.diags.error(Codes.UNSUPPORTED, `Le tableau constant '${sym.name}' est limité à 256 éléments`, sym.decl.span);
    }
    this.tables.set(name, unit);
    return name;
  }

  /**
   * Label prefix of a const array's tables, unique per declaration: each `const` array is its own object, so a local
   * `T` in f(), another in g() and a global `T` get three tables (`_tbl_f_T`, `_tbl_g_T`, `_tbl_T`).
   */
  private tableBaseName(sym: VarSymbol): string {
    const existing = this.tableNames.get(sym);
    if (existing) return existing;
    const owner = sym.fn && sym.storage !== 'global' ? `${sym.fn.name}_` : '';
    const wanted = `_tbl_${owner}${sym.name}`;
    const taken = new Set([...this.tableNames.values()].map((n) => n.toLowerCase()));
    let name = wanted;
    for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${wanted}_${k}`;
    this.tableNames.set(sym, name);
    return name;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Units

  /** Global initialisers, then jump to main. Null when nothing needs initialising. */
  private startupUnit(): CodeUnit | null {
    const inits = this.sem.globals.filter((g) => g.initData && !g.romData && g.constValue === undefined);
    if (inits.length === 0) return null;
    const unit = this.newUnit(START, 'startup', newFrame(START));
    const em = new Emitter(this.labels, 'start');
    em.label(START);
    for (const g of inits) {
      em.line = g.decl.span.line;
      const base = this.varRef(g);
      const elemSize = g.type.kind === 'array' ? g.type.elem.size : g.type.kind === 'int' ? g.type.size : 1;
      g.initData!.forEach((v, i) => {
        for (let b = 0; b < elemSize; b++) {
          const f = at(base, i * elemSize + b);
          const byte = byteOf(pattern(v, elemSize), b);
          if (byte === 0) em.clrf(f);
          else {
            em.movlw(byte);
            em.movwf(f);
          }
        }
      });
    }
    em.line = undefined;
    em.goto(this.mainLabel());
    unit.code.push(...em.code);
    unit.jumps.add(this.mainLabel());
    return unit;
  }

  private functionUnit(fn: FuncSymbol): CodeUnit {
    const label = this.functionLabel(fn);
    const frame = this.frames.get(fn)!;
    const unit = this.newUnit(label, 'function', frame);
    const em = new Emitter(this.labels, fn.name);
    const temps = new TempPool(addSlot(frame, `${label}.tmp`, 0));
    const ex = new ExprGen(this, em, temps, unit, this.contextOf(fn));
    const exit = em.newLabel();
    const sg = new StmtGen(ex, fn, exit);
    em.line = fn.decl?.span.line;
    em.label(label);
    sg.body(fn.decl?.body?.body ?? []);
    em.line = fn.decl?.body?.span.endLine;
    em.label(exit);
    if (fn === this.sem.main) {
      // MikroC parks the CPU when main returns: the outputs keep their state.
      em.goto({ rel: 0 });
    } else {
      em.none('RETURN');
    }
    unit.code.push(...em.code);
    return unit;
  }

  /** Interrupt routine at 0x0004 with W, STATUS, PCLATH and FSR saved and restored (MikroC P16 behaviour). */
  private isrUnit(fn: FuncSymbol): CodeUnit {
    const frame = this.frames.get(fn)!;
    const unit = this.newUnit(ISR, 'isr', frame);
    unit.fixedAddress = 4;
    const save = (n: string) => slotRef(addSlot(frame, n, 1));
    const wSave = save('__w_save');
    const statusSave = save('__status_save');
    const pclathSave = save('__pclath_save');
    const fsrSave = save('__fsr_save');
    const em = new Emitter(this.labels, 'interrupt', null);
    const temps = new TempPool(addSlot(frame, `${ISR}.tmp`, 0));
    const ex = new ExprGen(this, em, temps, unit, 'isr');
    const exit = em.newLabel();
    const sg = new StmtGen(ex, fn, exit);
    em.line = fn.decl?.span.line;
    em.raw = true;
    em.label(ISR);
    em.movwf(wSave);
    em.file('SWAPF', sfr(R.STATUS), 0); // SWAPF leaves Z untouched, unlike MOVF
    em.clrf(sfr(R.STATUS)); // bank 0
    em.movwf(statusSave);
    em.movf(sfr(R.PCLATH), 0);
    em.movwf(pclathSave);
    em.clrf(sfr(R.PCLATH));
    em.movf(sfr(R.FSR), 0);
    em.movwf(fsrSave);
    em.raw = false;
    sg.body(fn.decl?.body?.body ?? []);
    em.line = fn.decl?.body?.span.endLine;
    em.label(exit);
    em.raw = true;
    em.movf(fsrSave, 0);
    em.movwf(sfr(R.FSR));
    em.movf(pclathSave, 0);
    em.movwf(sfr(R.PCLATH));
    em.file('SWAPF', statusSave, 0);
    em.movwf(sfr(R.STATUS));
    em.file('SWAPF', wSave, 1);
    em.file('SWAPF', wSave, 0);
    em.none('RETFIE');
    unit.code.push(...em.code);
    return unit;
  }
}
