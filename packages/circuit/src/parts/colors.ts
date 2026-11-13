// ISIS colours, measured on the prof's captures and decoded from the DSN libraries (research 05 §4, 07 §4.2, 00 §5.3).

export const ISIS_COLORS = {
  /** Sheet background. */
  background: '#E0E0D0',
  /** Grid dots / lines (slightly darker than the sheet). */
  grid: '#C8C8B8',
  /** IC / generic component body fill. */
  body: '#C8C8AA',
  /** Component outline and pin lines. */
  outline: '#800000',
  /** Wires and junction dots. */
  wire: '#004000',
  /** Normal text (pin names, references, values). */
  text: '#000000',
  /** `<TEXT>` placeholders. */
  placeholder: '#808080',
  /** Pin-state squares while simulating: logic 1. */
  pinHigh: '#FF4040',
  /** Pin-state squares while simulating: logic 0. */
  pinLow: '#4040FF',
  /** Pin-state squares: floating / undriven / analog. */
  pinFloating: '#808080',
  /** Pin-state squares: contention (two strong drivers fighting). */
  pinContention: '#FFFF00',
  /** Red click markers (LOGICSTATE, BUTTON latch, TORCH +/-). */
  actuator: '#E00000',
} as const;

export type LedColor = 'RED' | 'GREEN' | 'BLUE' | 'YELLOW';
export type SevenSegColor = 'RED' | 'BLUE' | 'GREEN';

/** LED animation: frame 0 (off) body and frame 7 (full brightness) colour. */
export const LED_COLORS: Readonly<Record<LedColor, { off: string; on: string }>> = {
  RED: { off: '#400000', on: '#FF2020' },
  GREEN: { off: '#003000', on: '#20FF20' },
  BLUE: { off: '#000040', on: '#3030FF' },
  YELLOW: { off: '#403800', on: '#FFFF20' },
};

/** LOGICSTATE frames LS_0 / LS_1 (decoded from the DSN). */
export const LOGICSTATE_COLORS = { 0: '#0000C0', 1: '#C00000', digit: '#FFFFFF' } as const;

/** TRAFFIC LIGHTS lamp colours (decoded from TRAFFIC_n_m frames). */
export const TRAFFIC_COLORS = {
  red: { off: '#400000', on: '#E00000' },
  amber: { off: '#403000', on: '#E0A000' },
  green: { off: '#003000', on: '#00E000' },
} as const;

/** 7-segment displays: lit / unlit segment colours (decoded) and the dark display background. */
export const SEVEN_SEG_COLORS: Readonly<Record<SevenSegColor, { on: string; off: string; background: string }>> = {
  RED: { on: '#FF0000', off: '#800000', background: '#400000' },
  BLUE: { on: '#2D2DFF', off: '#0C1A78', background: '#400000' },
  GREEN: { on: '#00FF00', off: '#1D5A1D', background: '#400000' },
};
