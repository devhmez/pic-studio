// Drawing model of a schematic symbol. All coordinates are local, in grid units (0.1 in), Y axis DOWN,
// before the component's mirror/rotation/translation (see geometry.ts).
import type { ComponentKind, PinDef, Point } from '../api';

export interface Paint {
  stroke?: string;
  fill?: string;
  /** Stroke width in grid units (ISIS thin lines ≈ 0.08). */
  strokeWidth?: number;
}

export type TextAnchor = 'start' | 'middle' | 'end';
export type TextBaseline = 'top' | 'middle' | 'bottom';

export interface TextPrimitive {
  type: 'text';
  at: Point;
  text: string;
  /** Font size (em) in grid units. */
  size: number;
  anchor: TextAnchor;
  baseline: TextBaseline;
  color?: string;
  bold?: boolean;
  /** Draw a bar over the text (MCLR). */
  overbar?: boolean;
}

/**
 * A drawing primitive. Text is always rendered upright (ISIS never draws mirrored or upside-down text):
 * only its anchor point follows the component transform.
 */
export type Primitive =
  | ({ type: 'line'; from: Point; to: Point } & Paint)
  | ({ type: 'rect'; x: number; y: number; w: number; h: number } & Paint)
  | ({ type: 'circle'; center: Point; r: number } & Paint)
  /** Arc from startDeg to endDeg, angles measured clockwise from +X (Y down), swept clockwise. */
  | ({ type: 'arc'; center: Point; r: number; startDeg: number; endDeg: number } & Paint)
  | ({ type: 'polyline'; points: Point[]; closed?: boolean } & Paint)
  | TextPrimitive;

export interface SymbolPin extends PinDef {
  /** Where the pin line meets the body. The pin is drawn from `base` to `tip`; equal for terminals. */
  base: Point;
  /** Centre of the ISIS pin-state square (red 1 / blue 0 / grey floating) shown while simulating. */
  marker: Point;
  /** Hidden power pins (PIC VDD/VSS): not drawn and not part of any net. */
  hidden?: boolean;
  /** Name drawn inside the body (IC pins). */
  showName?: boolean;
  /** Number drawn next to the pin line (IC pins). */
  showNumber?: boolean;
  /** Pin name drawn with an overbar (MCLR). */
  overbar?: boolean;
}

export interface LabelSpec {
  at: Point;
  anchor: TextAnchor;
  baseline: TextBaseline;
  size: number;
}

/** Where ISIS prints the reference (U1), the value (PIC16F84A, 220) and the `<TEXT>` placeholder. */
export interface SymbolLabels {
  ref: LabelSpec;
  value: LabelSpec;
  text: LabelSpec;
}

/** A click target that triggers an Interaction (LOGICSTATE toggle, BUTTON press, TORCH +/-). */
export interface Actuator {
  action: 'toggle' | 'press' | 'increment' | 'decrement';
  center: Point;
  r: number;
}

export interface Rect { x: number; y: number; w: number; h: number }

export interface SymbolDef {
  kind: ComponentKind;
  /** Proteus library part name for this variant (LED-RED, 7SEG-BCD-BLUE, TRAFFIC LIGHTS...). */
  isisName: string;
  /** Reference prefix (U, D, R, LDR, C, X). Empty when ISIS shows no reference by default. */
  refPrefix: string;
  /** Whether the value text is shown by default (LED-RED, 220, PIC16F84A). */
  showValue: boolean;
  /** Whether the `<TEXT>` placeholder is shown. */
  showText: boolean;
  pins: SymbolPin[];
  /** Static graphics, including pin lines, pin names and numbers. */
  body: Primitive[];
  /**
   * Named state layers drawn over the body while simulating:
   * LED `lit` (opacity = brightness) and `emission`; LOGICSTATE `state-0`/`state-1`;
   * BUTTON `released`/`pressed`; 7-segment `seg-a`..`seg-g`, `seg-dp`;
   * TRAFFIC_LIGHTS `red-on`/`amber-on`/`green-on`; TORCH_LDR `torch-0`..`torch-9` and `beam-0`..`beam-9`.
   */
  layers: Readonly<Record<string, Primitive[]>>;
  /** Local bounding box of the graphics (labels excluded), for selection and hit-testing. */
  bounds: Rect;
  labels: SymbolLabels;
  actuators: Actuator[];
  defaultValue?: string;
  defaultProps: Readonly<Record<string, string | number>>;
}
