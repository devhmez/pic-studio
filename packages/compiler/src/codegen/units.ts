import type { Frame, Instr, Slot } from './ir';

export type UnitKind = 'reset' | 'isr' | 'startup' | 'function' | 'helper' | 'table';

/** A relocatable block of code with its RAM frame. */
export interface CodeUnit {
  /** Entry label (also the unit's unique name). */
  name: string;
  kind: UnitKind;
  code: Instr[];
  frame: Frame;
  /** Units called with CALL (stack levels). */
  callees: Set<string>;
  /** Units reached with GOTO (no stack level), e.g. startup → main. */
  jumps: Set<string>;
  /** Placement constraint (reset vector 0x0000, interrupt vector 0x0004). */
  fixedAddress?: number;
}

export function newFrame(name: string): Frame {
  return { name, slots: [] };
}

export function addSlot(frame: Frame, name: string, size: number, extra: Partial<Slot> = {}): Slot {
  const slot: Slot = { name, size, frame, ...extra };
  frame.slots.push(slot);
  return slot;
}
