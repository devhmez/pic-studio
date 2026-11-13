// Symbol library: one ISIS-looking symbol per ComponentKind, plus helpers to pick state layers from a ComponentVisual.
import type { ComponentInstance, ComponentKind, ComponentVisual, Interaction } from './api';
import { type LedColor, type SevenSegColor } from './parts/colors';
import { BCD_GLYPHS, SEGMENTS, sevenSegBcdSymbol, sevenSegCcSymbol, TRAFFIC_LIGHTS_SYMBOL } from './parts/displays';
import { ledSymbol } from './parts/led';
import { CAP_SYMBOL, CRYSTAL_SYMBOL, LDR_LEVEL_OHMS, RES_SYMBOL, TORCH_LDR_SYMBOL } from './parts/passives';
import { PIC16F84A_SYMBOL } from './parts/pic';
import { BUTTON_SYMBOL, LOGICSTATE_SYMBOL } from './parts/sources';
import { GROUND_SYMBOL, POWER_SYMBOL } from './parts/terminals';
import type { Actuator, SymbolDef, SymbolPin } from './parts/types';

export * from './parts/types';
export {
  ISIS_COLORS, LED_COLORS, LOGICSTATE_COLORS, SEVEN_SEG_COLORS, TRAFFIC_COLORS,
  type LedColor, type SevenSegColor,
} from './parts/colors';
export { BCD_GLYPHS, SEGMENTS, segmentPolygons, type Segment } from './parts/displays';
export { LDR_LEVEL_OHMS } from './parts/passives';
export { PIC_GPIO_PINS } from './parts/pic';

export const LED_COLOR_NAMES: readonly LedColor[] = ['RED', 'GREEN', 'BLUE', 'YELLOW'];
export const SEVEN_SEG_COLOR_NAMES: readonly SevenSegColor[] = ['RED', 'BLUE', 'GREEN'];

const LED_SYMBOLS = Object.fromEntries(LED_COLOR_NAMES.map((c) => [c, ledSymbol(c)])) as Record<LedColor, SymbolDef>;
const BCD_SYMBOLS = Object.fromEntries(
  SEVEN_SEG_COLOR_NAMES.map((c) => [c, sevenSegBcdSymbol(c)]),
) as Record<SevenSegColor, SymbolDef>;
const CC_SYMBOLS = Object.fromEntries(
  SEVEN_SEG_COLOR_NAMES.map((c) => [c, sevenSegCcSymbol(c)]),
) as Record<SevenSegColor, SymbolDef>;

/** Default variant of every kind (LED-RED, red 7SEG-BCD...). */
export const SYMBOLS: Readonly<Record<ComponentKind, SymbolDef>> = {
  PIC16F84A: PIC16F84A_SYMBOL,
  LED: LED_SYMBOLS.RED,
  LOGICSTATE: LOGICSTATE_SYMBOL,
  BUTTON: BUTTON_SYMBOL,
  RES: RES_SYMBOL,
  '7SEG-BCD': BCD_SYMBOLS.RED,
  '7SEG-CC': CC_SYMBOLS.RED,
  TRAFFIC_LIGHTS: TRAFFIC_LIGHTS_SYMBOL,
  TORCH_LDR: TORCH_LDR_SYMBOL,
  CAP: CAP_SYMBOL,
  CRYSTAL: CRYSTAL_SYMBOL,
  POWER: POWER_SYMBOL,
  GROUND: GROUND_SYMBOL,
};

export const COMPONENT_KINDS = Object.keys(SYMBOLS) as ComponentKind[];

export function isLedColor(v: unknown): v is LedColor {
  return typeof v === 'string' && (LED_COLOR_NAMES as readonly string[]).includes(v);
}

export function isSevenSegColor(v: unknown): v is SevenSegColor {
  return typeof v === 'string' && (SEVEN_SEG_COLOR_NAMES as readonly string[]).includes(v);
}

/** Symbol for a kind, resolving the colour variant from props.color (LED, 7-segment displays). */
export function getSymbol(kind: ComponentKind, props: Readonly<Record<string, string | number>> = {}): SymbolDef {
  const color = props.color;
  switch (kind) {
    case 'LED': return isLedColor(color) ? LED_SYMBOLS[color] : LED_SYMBOLS.RED;
    case '7SEG-BCD': return isSevenSegColor(color) ? BCD_SYMBOLS[color] : BCD_SYMBOLS.RED;
    case '7SEG-CC': return isSevenSegColor(color) ? CC_SYMBOLS[color] : CC_SYMBOLS.RED;
    default: return SYMBOLS[kind];
  }
}

export function symbolFor(component: Pick<ComponentInstance, 'kind' | 'props'>): SymbolDef {
  return getSymbol(component.kind, component.props);
}

/** Proteus library part name for a component (LED-BLUE, 7SEG-BCD-BLUE, TRAFFIC LIGHTS, PIC16F84A...). */
export function isisPartName(component: Pick<ComponentInstance, 'kind' | 'props'>): string {
  return symbolFor(component).isisName;
}

/** Visible, connectable pins of a component (hidden PIC VDD/VSS excluded). */
export function visiblePins(component: Pick<ComponentInstance, 'kind' | 'props'>): SymbolPin[] {
  return symbolFor(component).pins.filter((p) => !p.hidden);
}

/** ISIS LED animation frame 0..7 for a brightness 0..1. */
export function ledFrame(brightness: number): number {
  return Math.max(0, Math.min(7, Math.round(brightness * 7)));
}

export interface ActiveLayer {
  name: string;
  /** 0..1; the LED `lit` layer uses the duty-cycle brightness. */
  opacity: number;
}

/** State layers to draw over the body for the current simulation visual (empty when not simulating). */
export function activeLayers(component: Pick<ComponentInstance, 'kind' | 'props'>, visual?: ComponentVisual): ActiveLayer[] {
  const on = (name: string, opacity = 1): ActiveLayer => ({ name, opacity });
  if (!visual) {
    switch (component.kind) {
      case 'LOGICSTATE': return [on(`state-${Number(component.props.state) === 1 ? 1 : 0}`)];
      case 'BUTTON': return [on('released')];
      case 'TORCH_LDR': return [on(`torch-${clampLevel(component.props.level)}`)];
      default: return [];
    }
  }
  switch (visual.kind) {
    case 'LED': {
      const frame = ledFrame(visual.brightness);
      if (frame === 0) return []; // ISIS frame 0 is the dark LED
      const layers = [on('lit', frame / 7)];
      return visual.lit ? [...layers, on('emission')] : layers;
    }
    case 'LOGICSTATE': return [on(`state-${visual.state}`)];
    case 'BUTTON': return [on(visual.pressed ? 'pressed' : 'released')];
    case 'TORCH_LDR': {
      const level = clampLevel(visual.level);
      return level > 0 ? [on(`beam-${level}`), on(`torch-${level}`)] : [on('torch-0')];
    }
    case 'TRAFFIC_LIGHTS': {
      const out: ActiveLayer[] = [];
      if (visual.red) out.push(on('red-on'));
      if (visual.amber) out.push(on('amber-on'));
      if (visual.green) out.push(on('green-on'));
      return out;
    }
    case '7SEG-BCD': {
      if (visual.value === null) return [];
      const mask = BCD_GLYPHS[visual.value & 0xf];
      return SEGMENTS.filter((_, i) => (mask >> i) & 1).map((s) => on(`seg-${s}`));
    }
    case '7SEG-CC': {
      const out = SEGMENTS.filter((_, i) => (visual.segments >> i) & 1).map((s) => on(`seg-${s}`));
      if ((visual.segments >> 7) & 1) out.push(on('seg-dp'));
      return out;
    }
    case 'NONE': return [];
  }
}

function clampLevel(level: unknown): number {
  const n = Math.round(Number(level));
  return Number.isFinite(n) ? Math.max(0, Math.min(LDR_LEVEL_OHMS.length - 1, n)) : 0;
}

/** The Interaction a click on an actuator triggers (BUTTON: send `release` yourself on mouse-up). */
export function interactionFor(action: Actuator['action'], visual?: ComponentVisual): Interaction {
  switch (action) {
    case 'toggle': return { type: 'toggle' };
    case 'press': return { type: 'press' };
    case 'increment':
    case 'decrement': {
      const level = visual?.kind === 'TORCH_LDR' ? visual.level : 0;
      return { type: 'setLevel', level: clampLevel(level + (action === 'increment' ? 1 : -1)) };
    }
  }
}
