// Style tokens. Geometry (fonts, paddings, gaps) is shared by both styles so a chart keeps its layout when the
// student switches between her colours and black & white; only the terminals (Début / Fin) differ in shape.
//
// Prof colours, from research 06 §3–§5 with the 00 "Critic corrections" (C1.15: INITIALISATION is #F79546, not
// #F79646). Her slide colours are semi-transparent over a white slide; they are composited here to opaque colours so
// the SVG looks the same on any background and exports cleanly:
//   CONFIGURATION  #FFC000 @60 %  → #FFD966, border #FFC000 1.2 pt
//   INITIALISATION #F79546 @70 %  → #F9B57E, border #E26C09 1.2 pt
//   action boxes   #A9D18E @70 %  → #C3DFB0, border #385723 1.2 pt
//   decisions      #5B9BD5 opaque, outline accent1 shade 15 % = #0E1720 (dark navy) 1 pt, white text
//   Boucle infinie #C2D59B @80 %  → #CEDDAF, border #76923B 1.2 pt
//   connectors     black, filled triangle arrowheads (her 0.5 pt is thin on screen: 1 px, research 06 §4.7)
import type { MetricsFace } from './text';
import type { BoxRole, DiagramStyle, TextFont } from './types';

export interface FontSpec {
  /** CSS font-family stack written in the SVG. */
  family: string;
  /** Width table used to measure the text (see text.ts). */
  face: MetricsFace;
  /** Face used for bold lines. */
  boldFace: MetricsFace;
  size: number;
  lineHeight: number;
  italic?: boolean;
  bold?: boolean;
}

const GEORGIA = "Georgia, 'Times New Roman', Times, serif";
// Her diamonds and oui/non use the Office theme font Calibri; macOS falls back to Carlito or Arial.
const CALIBRI = "Calibri, Carlito, 'Helvetica Neue', Arial, Helvetica, sans-serif";
const TIMES = "'Times New Roman', Times, Georgia, serif";

export const FONTS: Readonly<Record<TextFont, FontSpec>> = {
  body: { family: GEORGIA, face: 'serif', boldFace: 'serifBold', size: 12, lineHeight: 15 },
  decision: { family: CALIBRI, face: 'sans', boldFace: 'sansBold', size: 13, lineHeight: 16 },
  branch: { family: CALIBRI, face: 'sans', boldFace: 'sansBold', size: 13, lineHeight: 15 },
  terminal: { family: GEORGIA, face: 'serif', boldFace: 'serifBold', size: 11, lineHeight: 14 },
  // Her TP chart uses Times New Roman italic 18 pt; 14 balances better with 12 px boxes (research 06 §5 note).
  tag: { family: TIMES, face: 'serifItalic', boldFace: 'serifItalic', size: 14, lineHeight: 17, italic: true },
  title: { family: GEORGIA, face: 'serifBold', boldFace: 'serifBold', size: 15, lineHeight: 19, bold: true },
};

/** Layout metrics (px). */
export const METRICS = {
  margin: 20,
  /** Inner padding of process boxes. */
  padX: 10,
  padY: 6,
  /** Her loop boxes are ≈147×34 pt; CONFIGURATION / INITIALISATION ≈231 pt wide. */
  actionMinW: 148,
  actionMinH: 34,
  sectionMinW: 232,
  /** Longest line before word wrap. */
  actionMaxTextW: 280,
  sectionMaxTextW: 340,
  /** Diamonds: ≈147×37 pt, flat. */
  decisionMinW: 140,
  decisionMinH: 38,
  /** Double bars of a subroutine box. */
  subroutineBar: 7,
  /** Arrow between two shapes. */
  gapShape: 20,
  /** Line into an invisible junction. */
  gapJunction: 10,
  /** A down exit carrying `oui` / `non` (room for the word). */
  gapLabelled: 24,
  /** Loop re-entry junction → first shape of the loop. */
  loopEntry: 16,
  /** Decision mid line → top of the next diamond of an else-if cascade (her 15 pt). */
  cascadeDrop: 18,
  /** Lowest branch bottom → first merge row (her 20 pt). */
  mergeDrop: 20,
  /** Staggered merge rows (her ≈11 pt). */
  mergeStagger: 12,
  /** Horizontal gap between two columns of a cascade. */
  columnGap: 28,
  /**
   * An if / else-if chain with this many columns (tests + else), or wider than cascadeMaxW, stacks its tests down the
   * right side instead of cascading (research 00 C4: 4 columns ≈ 700 pt no longer fit a portrait A4 page).
   */
  stackColumns: 4,
  cascadeMaxW: 760,
  /** Return line of a loop, left of its content (her 27 pt). */
  loopOffset: 26,
  /** `non` exit of a while / for loop, right of its content. */
  exitOffset: 24,
  /** Right-hand self loop of a busy wait. */
  waitLoop: 36,
  /** Prof terminals: Début circle Ø9, Fin bullseye Ø16 (inner Ø11). */
  startGlyph: 9,
  endGlyph: 16,
  endInner: 11,
  /** bw terminals: rounded rectangle height and side padding. */
  terminalH: 26,
  terminalPadX: 16,
  /** Gap between a glyph and its word (Début / Fin). */
  terminalLabelGap: 7,
  /** « Boucle infinie » callout: wedge length and inner padding. */
  tagTip: 14,
  tagPadX: 10,
  tagH: 30,
  /** Arrowhead (filled triangle). */
  arrowLength: 8,
  arrowWidth: 7,
} as const;

export interface BoxPaint {
  fill: string;
  stroke: string;
  strokeWidth: number;
}

export interface Palette {
  background: string;
  line: string;
  lineWidth: number;
  text: string;
  /** « Les Leds sont éteintes » in INITIALISATION. */
  offText: string;
  box: Readonly<Record<BoxRole, BoxPaint>>;
  decision: BoxPaint & { text: string };
  tag: BoxPaint & { text: string };
  terminal: { stroke: string; strokeWidth: number; fill: string; dot: string };
  highlight: string;
}

export const PALETTES: Readonly<Record<DiagramStyle, Palette>> = {
  prof: {
    background: '#FFFFFF',
    line: '#000000',
    lineWidth: 1,
    text: '#000000',
    offText: '#FF0000',
    box: {
      config: { fill: '#FFD966', stroke: '#FFC000', strokeWidth: 1.25 },
      init: { fill: '#F9B57E', stroke: '#E26C09', strokeWidth: 1.25 },
      action: { fill: '#C3DFB0', stroke: '#385723', strokeWidth: 1.25 },
    },
    decision: { fill: '#5B9BD5', stroke: '#0E1720', strokeWidth: 1, text: '#FFFFFF' },
    tag: { fill: '#CEDDAF', stroke: '#76923B', strokeWidth: 1.25, text: '#000000' },
    terminal: { stroke: '#000000', strokeWidth: 1.5, fill: '#FFFFFF', dot: '#000000' },
    highlight: '#0A84FF',
  },
  bw: {
    background: '#FFFFFF',
    line: '#000000',
    lineWidth: 1,
    text: '#000000',
    offText: '#000000',
    box: {
      config: { fill: '#FFFFFF', stroke: '#000000', strokeWidth: 1.25 },
      init: { fill: '#FFFFFF', stroke: '#000000', strokeWidth: 1.25 },
      action: { fill: '#FFFFFF', stroke: '#000000', strokeWidth: 1 },
    },
    decision: { fill: '#FFFFFF', stroke: '#000000', strokeWidth: 1, text: '#000000' },
    tag: { fill: '#FFFFFF', stroke: '#000000', strokeWidth: 1, text: '#000000' },
    terminal: { stroke: '#000000', strokeWidth: 1.25, fill: '#FFFFFF', dot: '#000000' },
    highlight: '#0A84FF',
  },
};
