// Voltage → logic level conversion with hysteresis.

export interface Thresholds {
  /** At or below: logic 0. */
  vil: number;
  /** At or above: logic 1. Between vil and vih the previous level is kept. */
  vih: number;
}

export const DEFAULT_VDD = 5;

/** PIC16F84A datasheet (DS35007) D030/D040, TTL input buffer (RA0-RA3, RB0-RB7) at VDD = 4.5-5.5 V. */
export const TTL_THRESHOLDS: Thresholds = { vil: 0.8, vih: 2.0 };

/** Datasheet D030A/D040A, Schmitt-trigger input buffer (RA4/T0CKI): 0.2·VDD and 0.8·VDD. */
export function schmittThresholds(vdd: number = DEFAULT_VDD): Thresholds {
  return { vil: 0.2 * vdd, vih: 0.8 * vdd };
}

/**
 * Proteus ITFMOD "PIC" interface model embedded in the prof's DSNs (VTL 0.8 V, VTH 2.5 V).
 * Real ISIS reads the traffic LDR divider with these: with R1 = 1k only torch level 9 gives a clean 1.
 */
export const PROTEUS_PIC_THRESHOLDS: Thresholds = { vil: 0.8, vih: 2.5 };

export type Bit = 0 | 1;

/** Classify a voltage; inside the undefined band keep `previous` (or the nearest side when there is none). */
export function classifyVoltage(v: number, t: Thresholds, previous: Bit | undefined): Bit {
  if (v <= t.vil) return 0;
  if (v >= t.vih) return 1;
  if (previous !== undefined) return previous;
  return v < (t.vil + t.vih) / 2 ? 0 : 1;
}
