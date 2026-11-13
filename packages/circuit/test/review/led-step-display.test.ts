// While single-stepping (Ch4 debugger: "step by C line or by instruction"), the simulator is advanced by a few
// microseconds per instruction. Proteus lights an LED once it has been on for TLITMIN = 0.1 ms (LED-RED/GREEN/
// BLUE/YELLOW library default, research 05 §4.1). Here the brightness only changes when a whole 20 ms window
// completes (5000 instructions at 1 MHz), so visual().lit says true while brightness stays 0 and the package's
// own activeLayers() draws nothing: the LED that was just switched on is shown dark.
import { describe, expect, it } from 'vitest';
import { importDsn } from '../../src/dsn';
import { createCircuitSimulator } from '../../src/simulator';
import { activeLayers } from '../../src/symbols';
import { FakeMcu, readBytes } from '../helpers';

describe('LED display while stepping', () => {
  it('an LED switched on and kept on for 1 ms (10 × TLITMIN) is drawn lit', () => {
    const s = importDsn(readBytes('cours/EXEMPLE1.DSN'));
    const d1 = s.components.find((c) => c.id === 'D1')!;
    const mcu = new FakeMcu();
    const sim = createCircuitSimulator(s, mcu, 'U1');
    // 100 ms with RA0 low (e.g. running up to a breakpoint), then RA0 = 1 and 250 instruction steps at 1 MHz.
    sim.advance(0.1);
    mcu.drive.set('RA0', 1);
    sim.solve();
    for (let i = 0; i < 250; i++) sim.advance(4e-6);

    const visual = sim.visual('D1');
    expect(visual).toMatchObject({ kind: 'LED', lit: true });
    const layers = activeLayers(d1, visual).map((l) => l.name);
    expect(layers).toContain('lit');
    expect(layers).toContain('emission');
  });
});
