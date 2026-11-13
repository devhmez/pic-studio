// Values the explanations evaluate conditions with: the live registers of a paused simulation, or, without a
// simulation, the starting values (switch positions on the schematic, constants assigned before the main loop).
import type { SymbolInfo, TranslationUnit } from '@pic/compiler';
import type { PinName, Program } from '@pic/program-model';
import { allVisits, isAlwaysTrue, statementWrites, type EvalEnv } from './ast';
import type { PinInfo } from './cline';
import { buttonWiring, ldrLevels, ledWiring, ohmsOf, partName, partsOnPin, Topology, type WiringOptions } from './circuit';
import { ADDR, portOfPin, readRegister, variableAddresses, type CpuState } from './cpu';

/** Registers and variables of a debugger snapshot. */
export function liveEnv(cpu: CpuState, symbols: readonly SymbolInfo[] | undefined): EvalEnv {
  const vars = variableAddresses(symbols);
  return {
    reg: (addr) => readRegister(cpu, addr),
    variable: (name) => {
      const s = vars.get(name.toLowerCase());
      if (!s || /\(bit \d\)/.test(s.type)) return undefined;
      const size = Math.min(Math.max(1, s.size), 2);
      let v = 0;
      for (let i = size - 1; i >= 0; i--) v = v * 256 + readRegister(cpu, s.addr + i);
      return v;
    },
  };
}

/**
 * True when the program clears OPTION_REG.RBPU (bit 7), which turns PORTB's weak pull-ups on (they are off after
 * reset: OPTION_REG = 0xFF).
 */
export function rbPullupsEnabled(unit: TranslationUnit | null | undefined): boolean {
  if (!unit) return false;
  for (const v of allVisits(unit)) {
    for (const w of statementWrites(v.stmt, unit)) {
      const t = w.target;
      if (t.kind !== 'reg' || t.addr !== ADDR.OPTION_REG) continue;
      const lit = w.value && (w.value.kind === 'NumberLiteral' || w.value.kind === 'CharLiteral') ? w.value.value : undefined;
      if (lit === undefined) continue;
      if (t.bit === 7 && w.op === '=' && lit === 0) return true;
      if (t.bit === undefined && (w.op === '=' || w.op === '&=') && (lit & 0x80) === 0) return true;
    }
  }
  return false;
}

/** Wiring options that depend on the program (PORTB pull-ups). */
export function wiringOptions(unit: TranslationUnit | null | undefined): WiringOptions {
  return { rbPullups: rbPullupsEnabled(unit) };
}

/** Level the schematic imposes on each input pin before the simulation starts. */
export function schematicInputs(topo: Topology, opts: WiringOptions = {}): Map<PinName, 0 | 1> {
  const out = new Map<PinName, 0 | 1>();
  for (const c of topo.schematic.components) {
    if (c.kind === 'LOGICSTATE') {
      const pin = topo.picPinOn(c.id, 'Q0');
      if (pin) out.set(pin, Number(c.props.state ?? 0) ? 1 : 0);
    } else if (c.kind === 'BUTTON') {
      // A floating input (no pull resistor, PORTB pull-ups off) has no known level.
      const w = buttonWiring(topo, c.id, opts);
      if (w.pin && w.activeLevel !== undefined && !w.problem) out.set(w.pin, (1 - w.activeLevel) as 0 | 1);
    } else if (c.kind === 'TORCH_LDR') {
      for (const node of ['1', '2']) {
        const pin = topo.picPinOn(c.id, node);
        if (!pin) continue;
        const fixed = topo.railResistors(c.id, node)[0];
        if (!fixed) continue;
        const onTop = topo.rail(c.id, node === '1' ? '2' : '1') === 'VDD';
        const level = Math.max(0, Math.min(9, Math.round(Number(c.props.level ?? 0))));
        const reads = ldrLevels(ohmsOf(fixed.res), onTop)[level].reads;
        if (reads !== 'garde') out.set(pin, reads === '1' ? 1 : 0);
      }
    }
  }
  return out;
}

/**
 * Constants assigned to variables in main() before the main loop and never written again
 * (`x = 5; y = 6;` in the TP STATUS): their value is known before the simulation runs.
 */
export function constantVariables(unit: TranslationUnit): Map<string, number> {
  const known = new Map<string, number>();
  const writtenLater = new Set<string>();
  const main = unit.body.find((t) => t.kind === 'FunctionDeclaration' && t.name.toLowerCase() === 'main' && t.body);
  const loop = main && main.kind === 'FunctionDeclaration'
    ? main.body!.body.find((s) => s.kind === 'WhileStatement' && isAlwaysTrue(s.test))
    : undefined;
  for (const v of allVisits(unit)) {
    const before = v.fn === main && !v.inMainLoop && v.stmt !== loop && v.path.length === 0 && (!loop || v.stmt.span.line < loop.span.line);
    for (const w of statementWrites(v.stmt, unit)) {
      if (w.target.kind !== 'var' || w.target.bit !== undefined) continue;
      const key = w.target.name.toLowerCase();
      const lit = w.value && (w.value.kind === 'NumberLiteral' || w.value.kind === 'CharLiteral') ? w.value.value : undefined;
      if (before && w.op === '=' && lit !== undefined) known.set(key, lit & 0xff);
      else writtenLater.add(key);
    }
  }
  for (const k of writtenLater) known.delete(k);
  return known;
}

/** Starting values: input pins from the schematic, variables from the initialisation constants. */
export function staticEnv(unit: TranslationUnit | null | undefined, topo: Topology | null): EvalEnv {
  const inputs = topo ? schematicInputs(topo, wiringOptions(unit)) : new Map<PinName, 0 | 1>();
  const vars = unit ? constantVariables(unit) : new Map<string, number>();
  const portValue = (addr: number): number | undefined => {
    const width = addr === ADDR.PORTA ? 5 : 8;
    let v = 0;
    for (let b = width - 1; b >= 0; b--) {
      const pin = (addr === ADDR.PORTA ? `RA${b}` : `RB${b}`) as PinName;
      const level = inputs.get(pin);
      if (level === undefined) return undefined;
      v = (v << 1) | level;
    }
    return v;
  };
  return {
    reg: (addr) => (addr === ADDR.PORTA || addr === ADDR.PORTB ? portValue(addr) : undefined),
    bit: (addr, bit) => {
      if (addr !== ADDR.PORTA && addr !== ADDR.PORTB) return undefined;
      const pin = (addr === ADDR.PORTA ? `RA${bit}` : `RB${bit}`) as PinName;
      return inputs.get(pin);
    },
    variable: (name) => vars.get(name.toLowerCase()),
  };
}

/** What is wired to each pin, for the wording: the program's signal label, else the schematic part. */
export function pinInfoLookup(program: Program | null | undefined, topo: Topology | null): (pin: PinName) => PinInfo | undefined {
  return (pin) => {
    const s = program?.signals.find((x) => x.pin === pin);
    if (s) {
      const kind = s.device === 'led' ? 'led' : s.device === 'lamp' ? 'lamp' : s.dir === 'in' ? 'input' : 'other';
      return { label: s.label, kind, activeLevel: s.activeLevel };
    }
    if (!topo) return undefined;
    const parts = partsOnPin(topo, pin);
    const led = parts.find((p) => p.kind === 'LED');
    if (led) {
      const w = ledWiring(topo, led.id);
      return { label: partName(led), kind: 'led', activeLevel: w.activeLevel ?? 1 };
    }
    const lamps = parts.find((p) => p.kind === 'TRAFFIC_LIGHTS');
    if (lamps) {
      const which = (['R', 'A', 'G'] as const).find((p) => topo.picPinOn(lamps.id, p) === pin);
      return { label: which === 'R' ? 'Feu rouge' : which === 'A' ? 'Feu orange' : 'Feu vert', kind: 'lamp', activeLevel: 1 };
    }
    const seg = parts.find((p) => p.kind === '7SEG-BCD');
    if (seg) return { label: 'afficheur 7 segments BCD', kind: 'display' };
    const input = parts.find((p) => p.kind === 'LOGICSTATE' || p.kind === 'BUTTON' || p.kind === 'TORCH_LDR');
    if (input) return { label: partName(input), kind: 'input' };
    return undefined;
  };
}

/** Teaching name of a pin for the change list: « LED_EGAL (LED verte EGALITE) ». */
export function pinLabelLookup(program: Program | null | undefined, topo: Topology | null): (pin: PinName) => string | undefined {
  const info = pinInfoLookup(program, topo);
  return (pin) => {
    const s = program?.signals.find((x) => x.pin === pin);
    const i = info(pin);
    if (s && i) return `${s.name}, ${i.label}`;
    return i?.label ?? s?.name;
  };
}

/** Level of a pin in a snapshot (helper for the UI). */
export function pinLevel(cpu: CpuState, pin: PinName): 0 | 1 {
  const { portAddr, bit } = portOfPin(pin);
  return ((readRegister(cpu, portAddr) >> bit) & 1) as 0 | 1;
}
