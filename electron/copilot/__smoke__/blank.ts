// An empty project (one PIC16F84A at 1 MHz, empty main) for the smoke test, without the app store.
import type { ProjectState } from '../../../app/src/copilot/core/verify';

export function blankProjectState(): ProjectState {
  return {
    name: 'Smoke',
    clockHz: 1_000_000,
    source: 'void main() {\n}\n',
    schematic: {
      clockHz: 1_000_000,
      components: [{ id: 'U1', kind: 'PIC16F84A', ref: 'U1', value: 'PIC16F84A', at: { x: 0, y: 0 }, rotation: 0, props: { clock: '1MHz', cfgword: '0x3FFB' } }],
      wires: [],
    },
  };
}
