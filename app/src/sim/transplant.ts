// Helpers for "updateSchematic": the circuit was edited during a pause, the program keeps running in the new one.
//
// SimSession has no way to swap its circuit, so the worker builds a new session for the new schematic and copies
// the complete core state (registers, RAM, stack, timer, EEPROM, sleep / interrupt state) from the old core into
// the new one. Both cores are Pic16F84A instances with the same program, so a structural copy of their own fields
// is an exact clone; functions (the session's onIoChange hook) are left alone.
import { buildNetlist, type ComponentVisual, type Interaction, type Schematic, type SimSession } from '@pic/circuit';

type Pic16F84A = SimSession['mcu'];

type Fields = Record<string, unknown>;

function copyFields(from: Fields, to: Fields, depth: number): void {
  for (const key of Object.keys(from)) {
    const a = from[key];
    const b = to[key];
    if (typeof a === 'function' || typeof b === 'function') continue;
    if (ArrayBuffer.isView(a)) {
      if (ArrayBuffer.isView(b) && a.constructor === b.constructor && a.byteLength === b.byteLength) {
        (b as unknown as Uint8Array).set(a as unknown as Uint8Array);
      }
      continue;
    }
    if (Array.isArray(a)) {
      to[key] = a.slice();
      continue;
    }
    if (a !== null && typeof a === 'object') {
      if (b !== null && typeof b === 'object' && depth < 4) copyFields(a as Fields, b as Fields, depth + 1);
      continue;
    }
    to[key] = a;
  }
}

/** Make `to` an exact copy of `from` (same program loaded in both). */
export function cloneCoreState(from: Pic16F84A, to: Pic16F84A): void {
  copyFields(from as unknown as Fields, to as unknown as Fields, 0);
}

/**
 * A string that changes only when the circuit changes electrically: parts, their values/properties and which pins
 * share a net. Moving parts, relabelling them or re-routing wires keeps it.
 */
export function electricalSignature(schematic: Schematic): string {
  const parts = schematic.components
    .map((c) => {
      const props = Object.keys(c.props).sort().map((k) => `${k}=${String(c.props[k])}`).join(',');
      return `${c.id}|${c.kind}|${c.value ?? ''}|${props}`;
    })
    .sort();
  const nets = buildNetlist(schematic).nets
    .map((n) => n.pins.map((p) => `${p.componentId}:${p.pin}`).sort().join(' '))
    .sort();
  return `${schematic.clockHz}\n${parts.join('\n')}\n--\n${nets.join('\n')}`;
}

/** Interactions that bring `next`'s sources (LOGICSTATE, TORCH_LDR, BUTTON) to the states they had in `prev`. */
export function carriedInteractions(
  prevSchematic: Schematic,
  prev: SimSession,
  nextSchematic: Schematic,
  next: SimSession,
): { id: string; action: Interaction }[] {
  const before = new Map(prevSchematic.components.map((c) => [c.id, c] as const));
  const out: { id: string; action: Interaction }[] = [];
  for (const c of nextSchematic.components) {
    const old = before.get(c.id);
    // A part whose properties were edited starts from its new initial state.
    if (!old || old.kind !== c.kind || JSON.stringify(old.props) !== JSON.stringify(c.props)) continue;
    let was: ComponentVisual;
    let now: ComponentVisual;
    try {
      was = prev.circuit.visual(c.id);
      now = next.circuit.visual(c.id);
    } catch {
      continue;
    }
    if (was.kind === 'LOGICSTATE' && now.kind === 'LOGICSTATE' && was.state !== now.state) {
      out.push({ id: c.id, action: { type: 'toggle' } });
    } else if (was.kind === 'TORCH_LDR' && now.kind === 'TORCH_LDR' && was.level !== now.level) {
      out.push({ id: c.id, action: { type: 'setLevel', level: was.level } });
    } else if (was.kind === 'BUTTON' && now.kind === 'BUTTON' && was.pressed !== now.pressed) {
      out.push({ id: c.id, action: { type: was.pressed ? 'press' : 'release' } });
    }
  }
  return out;
}
