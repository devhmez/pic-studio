// Review: unsaved work restored from the autosave must still count as unsaved (else « Modèles » / ⌘N / ⌘O replace
// it without asking, and the next autosave erases the only copy).
import { describe, expect, it } from 'vitest';
import type { Schematic } from '@pic/circuit';
import { createAppStore, type KeyValueStorage, type TemplateEntry } from '../state/store';

class MemoryStorage implements KeyValueStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
}

const PIC = {
  id: 'U1', kind: 'PIC16F84A' as const, ref: 'U1', value: 'PIC16F84A', at: { x: 0, y: 0 }, rotation: 0 as const,
  props: { clock: '1MHz' },
};
const SCHEMATIC: Schematic = { clockHz: 1_000_000, components: [PIC], wires: [] };
const SOURCE = 'void main() {\n  TRISB = 0;\n}\n';
const T: TemplateEntry = { id: 'tp-status', title: 'x', chapter: null, description: '', clockHz: 1e6, schematic: SCHEMATIC, program: null, source: SOURCE };

describe('autosave restore', () => {
  it('keeps never-saved work marked as unsaved after a relaunch', () => {
    const storage = new MemoryStorage();
    const first = createAppStore({ storage, templates: [T], autosaveDelayMs: 0 });
    first.getState().setSource('void main() {\n  TRISB = 0;\n  PORTB = 0x55; // mon travail\n}\n');
    expect(first.getState().dirty).toBe(true);
    expect(first.getState().fileName).toBeNull();

    // Relaunch.
    const second = createAppStore({ storage, templates: [T], autosaveDelayMs: 0 });
    expect(second.getState().project.source).toContain('mon travail');
    expect(second.getState().dirty).toBe(true);
  });
});
