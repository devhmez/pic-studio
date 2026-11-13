// The simulation loop written directly against the three package contracts (no SimSession):
// compile → Pic16F84A with the template clock → createCircuitSimulator → step the MCU, solve() whenever
// ioChanged, advance() the visuals by the elapsed time. SimSession must give exactly the same picture.
import { describe, expect, it } from 'vitest';
import { createCircuitSimulator, type CircuitSimulator } from '@pic/circuit';
import { Pic16F84A } from '@pic/emulator';
import { compileOk, fixture, startTp, template } from './support';

function contractLoop(templateName: string, file: string) {
  const schematic = template(templateName);
  const compiled = compileOk(fixture(file), schematic.clockHz);
  const mcu = new Pic16F84A({ clockHz: schematic.clockHz });
  mcu.load(compiled.program!, undefined, compiled.config);
  const circuit = createCircuitSimulator(schematic, mcu, 'U1');
  let unaccounted = 0;
  let target = 0; // absolute, so the overshoot of a 2-cycle instruction is not repeated slice after slice
  const run = (seconds: number) => {
    target += Math.round((seconds * schematic.clockHz) / 4);
    while (mcu.cycles < target) {
      const before = mcu.cycles;
      const r = mcu.step();
      // Sleep steps report 0 cycles but still take simulated time: count time with the core's cycle counter.
      unaccounted += mcu.cycles - before;
      if (r.ioChanged) {
        circuit.advance(unaccounted * mcu.tcy); // time spent in the previous state
        unaccounted = 0;
        circuit.solve();
      }
    }
    circuit.advance(unaccounted * mcu.tcy);
    unaccounted = 0;
  };
  return { mcu, circuit, run };
}

const visuals = (c: CircuitSimulator, ids: readonly string[]) => ids.map((id) => c.visual(id));

describe('boucle de simulation écrite sur les contrats', () => {
  it('status.c: same LED duty cycles as SimSession', () => {
    const ids = ['X_SUPERIEUR', 'EGALITE', 'X_INFERIEUR'];
    const loop = contractLoop('tp-status', 'status.c');
    const { session } = startTp('tp-status', fixture('status.c'));
    for (let i = 0; i < 5; i++) {
      loop.run(0.01);
      session.runFor(0.01);
    }
    expect(session.cycles).toBe(loop.mcu.cycles);
    expect(visuals(session.circuit, ids)).toEqual(visuals(loop.circuit, ids));
    const [sup, egal, inf] = visuals(loop.circuit, ids) as { brightness: number }[];
    expect(sup.brightness).toBeGreaterThan(0.1);
    expect(egal.brightness).toBeGreaterThan(0.1);
    expect(inf.brightness).toBe(0);
  });

  it('EXEMPLE2: the LED follows the LOGICSTATE through both loops', () => {
    const loop = contractLoop('tp0-exemple2', 'EXEMPLE2.c');
    const { session } = startTp('tp0-exemple2', fixture('EXEMPLE2.c'));
    for (let k = 0; k < 3; k++) {
      loop.run(0.03);
      session.runFor(0.03);
      expect(session.circuit.visual('D1')).toEqual(loop.circuit.visual('D1'));
      expect(loop.circuit.visual('D1')).toMatchObject({ lit: k % 2 === 0 });
      loop.circuit.interact('LS1', { type: 'toggle' });
      session.interact('LS1', { type: 'toggle' });
    }
  });
});
