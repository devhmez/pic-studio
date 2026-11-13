// Other packages import the emulator through the workspace name.
import { describe, expect, it } from 'vitest';
import * as emulator from '@pic/emulator';
import type { McuPins, PicCore } from '@pic/emulator/api';

describe('@pic/emulator entry point', () => {
  it('exports the core and the shared tools', () => {
    const core: PicCore = new emulator.Pic16F84A({ clockHz: 8_000_000 });
    const pins: McuPins = core;
    expect(core.clockHz).toBe(8_000_000);
    expect(core.tcy).toBeCloseTo(5e-7, 15);
    expect(pins.pinNames).toHaveLength(13);
    for (const name of ['assemble', 'disassemble', 'parseHex', 'writeHex', 'encode', 'decode', 'sfrAt']) {
      expect(typeof (emulator as Record<string, unknown>)[name]).toBe('function');
    }
    expect(emulator.SFR.STATUS).toBe(0x03);
    expect(emulator.DEFAULT_CONFIG).toBe(0x3ffb);
  });

  it('defaults to 1 MHz', () => {
    expect(new emulator.Pic16F84A().clockHz).toBe(1_000_000);
    expect(() => new emulator.Pic16F84A({ clockHz: 0 })).toThrow(/Fréquence d'horloge invalide/);
  });
});
