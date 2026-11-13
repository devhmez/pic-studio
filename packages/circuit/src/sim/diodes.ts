// Piecewise-linear DC model of the LEDs, after the Proteus LEDA model: a switch that closes above the forward
// voltage VF, in series with RS when on, and ROFF across the diode when off.
import { solveResistive, type Conductance } from './resistive';

export interface DiodeModel {
  /** Forward voltage (V). */
  vf: number;
  /** Series resistance when conducting (Ω). */
  rs: number;
  /** Resistance when blocking (Ω). */
  roff: number;
  /** Full drive current (A): brightness is current / IMAX in Proteus. */
  imax: number;
}

/** LED-RED / GREEN / BLUE / YELLOW instance values in the prof's DSNs (research 05 §4.1). */
export const LED_MODEL: DiodeModel = { vf: 2.2, rs: 3, roff: 100e3, imax: 10e-3 };

/**
 * Forward current from which an LED counts as lit: 1 % of IMAX (0.1 mA). It is twice the most a blocking LED's ROFF
 * can leak from 5 V (50 µA), so an LED in series with a reversed one stays dark; a 10k pull-up (0.28 mA) still
 * lights it, as the simplified "anode at 1 through a resistor" rule of the spec does.
 */
export function minLitCurrent(model: DiodeModel): number {
  return model.imax / 100;
}

/** A diode between two node indices of the network. */
export interface Diode { anode: number; cathode: number }

/**
 * Forward current (A) of each diode in a resistive network (`fixed` as for solveResistive); 0 for a blocking diode.
 * Every diode starts blocking; each pass solves the network and flips the diodes whose state contradicts the
 * result (blocking with more than VF across, or conducting with a reverse current, i.e. less than VF across),
 * until the states are consistent. ROFF keeps the nodes between blocking diodes defined, so a chain of LEDs is
 * decided as a whole: two LEDs in series conduct from 5 V (2 × 2.2 V), three do not.
 */
export function diodeCurrents(
  nodeCount: number,
  resistors: readonly Conductance[],
  diodes: readonly Diode[],
  fixed: Float64Array,
  model: DiodeModel = LED_MODEL,
): Float64Array {
  const on = diodes.map(() => false);
  const current = new Float64Array(diodes.length);
  const gOn = 1 / model.rs;
  const gOff = 1 / model.roff;
  const maxPasses = 2 * diodes.length + 4;
  for (let pass = 0; pass < maxPasses; pass++) {
    const edges = [...resistors];
    const inject = new Float64Array(nodeCount);
    diodes.forEach((d, i) => {
      edges.push({ a: d.anode, b: d.cathode, g: on[i] ? gOn : gOff });
      if (on[i]) {
        // Norton form of VF in series with RS: gOn·VF flows from the cathode node to the anode node.
        inject[d.anode] += gOn * model.vf;
        inject[d.cathode] -= gOn * model.vf;
      }
    });
    const v = solveResistive(nodeCount, edges, fixed, inject);
    let changed = false;
    diodes.forEach((d, i) => {
      const forward = v[d.anode] - v[d.cathode];
      const conducts = forward > model.vf; // NaN (floating side) → false
      current[i] = conducts && on[i] ? (forward - model.vf) * gOn : 0;
      if (conducts !== on[i]) {
        on[i] = conducts;
        changed = true;
      }
    });
    if (!changed) break;
  }
  return current;
}
