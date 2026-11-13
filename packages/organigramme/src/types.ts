// The Diagram: a fully placed organigramme (nodes with their boxes, orthogonal edges, labels), independent of how it
// is drawn. layout() builds it from a Program; renderSvg() draws it. Units are SVG user units (1 unit = 1 px at 100 %).

/** 'prof': her colour style (research 06). 'bw': classic black and white ISO 5807 look, printer-friendly. */
export type DiagramStyle = 'prof' | 'bw';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * - start / end: Début and Fin (prof: hollow circle and bullseye with the word to the right; bw: rounded terminals)
 * - process: rectangle (CONFIGURATION, INITIALISATION, green action boxes)
 * - decision: flat diamond (if, while, waitFor, for / repeat test)
 * - subroutine: rectangle with double vertical sides (ISO « sous-programme », for a call)
 * - tag: the « Boucle infinie » callout pointing at the loop's return line
 * - title: chart title written above Début (only when asked)
 * - junction: invisible zero-size point where lines meet on the spine (merges, loop re-entry and exit)
 */
export type NodeShape = 'start' | 'end' | 'process' | 'decision' | 'subroutine' | 'tag' | 'title' | 'junction';

/** Colour role of a process box in the prof style. */
export type BoxRole = 'config' | 'init' | 'action';

/** Text roles, each with its own font in the theme. */
export type TextFont = 'body' | 'decision' | 'branch' | 'terminal' | 'tag' | 'title';

export interface TextLine {
  text: string;
  /** Bold (section headings CONFIGURATION / INITIALISATION). */
  bold?: boolean;
  /** 'off': « Les Leds sont éteintes » in the INITIALISATION box, drawn red (#FF0000) in the prof style. */
  emphasis?: 'off';
}

/** A text placed next to a shape or an edge (Début, Fin, oui, non). */
export interface DiagramLabel {
  text: string;
  /** Anchor point; `y` is the text baseline. */
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
  font: TextFont;
  /** Estimated bounding box of the text (for hit-testing and overlap checks). */
  box: Rect;
}

export interface DiagramNode {
  /** Stable id: 'start', 'config', 'init', 'end', 'loop-tag', 'box-s6', 'dec-b1', 'dec-s12', 'call-s3', 'j3'… */
  id: string;
  shape: NodeShape;
  /** Colour role of a process / subroutine box. */
  role?: BoxRole;
  /** Shape bounds. For a junction: a zero-size rect at the join point. */
  box: Rect;
  /** Centred text lines drawn inside the shape. */
  lines: TextLine[];
  /** Font of `lines`. */
  font: TextFont;
  /** Text drawn outside the shape (Début / Fin right of the prof's glyphs). */
  label?: DiagramLabel;
  /**
   * Program ids this node stands for: statement ids, if-branch ids (diamonds and branch boxes), the function id on a
   * function chart's terminals. Use them to link a node with the C code (style-c's SourceMap uses the same ids).
   */
  refs: string[];
}

/**
 * - flow: plain sequence arrow
 * - yes / no: the `oui` / `non` exits of a decision
 * - merge: a branch coming back to the spine (left-pointing arrowhead on the spine)
 * - loop: a return line (« Boucle infinie », while / for loops, busy waits)
 */
export type EdgeKind = 'flow' | 'yes' | 'no' | 'merge' | 'loop';

export interface DiagramEdge {
  id: string;
  kind: EdgeKind;
  /** Node ids (junctions included). */
  from: string;
  to: string;
  /** Orthogonal polyline: consecutive points share x or y. The first point lies on `from`, the last on `to`. */
  points: Point[];
  /** Filled triangle arrowhead at the last point. */
  arrow: boolean;
  /** `oui` / `non` written next to the line. */
  label?: DiagramLabel;
}

export interface Diagram {
  /** Style the geometry was laid out for (terminal glyphs differ between the styles). */
  style: DiagramStyle;
  width: number;
  height: number;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** Chart title, when one was asked for (also drawn as a 'title' node). */
  title?: string;
}

export interface LayoutOptions {
  /** Default 'prof'. */
  style?: DiagramStyle;
  /** Diamond text: `&&` / `||` written « et » / « ou » ('words', default) or as in the C code ('c'). */
  logic?: 'words' | 'c';
  /**
   * 'tp' (default): her TP chart wording, naming the pins (« RB0,RB1 et RB2 sont des sorties »).
   * 'generic': her « Organigramme général » wording (« Configurer les entrées. », « Initialiser les sorties »).
   */
  wording?: 'tp' | 'generic';
  /**
   * Busy waits: 'exit' (default) writes the condition that ends the wait (`oui` continues down, `non` loops back on
   * the right); 'loop' writes the C loop condition (`oui` loops back).
   */
  waits?: 'exit' | 'loop';
  /**
   * `for (i = 0; i < N; i++)` repetitions: 'box' (default) draws one action box (« Led verte clignote 3 fois
   * (0,5 s / 0,5 s) »); 'loop' draws the explicit counter loop (« i=0 », « i<3 », « i=i+1 »).
   */
  counters?: 'box' | 'loop';
  /** Title written above Début (e.g. « Programme d'interruption »). Omitted: no title. */
  title?: string;
}

export interface SvgOptions {
  /** Colours to draw with. Default: the diagram's own style. Terminal geometry always follows the diagram's layout. */
  style?: DiagramStyle;
  /** Prefix of the ids inside the SVG (arrowhead marker), to keep several inlined charts apart. Default 'org'. */
  idPrefix?: string;
  /** Program ids (statement / branch ids) whose nodes get a selection outline. */
  highlight?: readonly string[];
  /** Accessible name (`aria-label` and `<title>`). Default: the diagram title, else « Organigramme ». */
  ariaLabel?: string;
}

export interface ChartOptions extends Omit<LayoutOptions, 'title'> {
  /**
   * Draw each chart's title above Début. Default: only when the program has functions (several charts), so the
   * usual single-chart TP looks exactly like her slide.
   */
  showTitles?: boolean;
  /** Passed to renderSvg; each chart gets its own id prefix derived from it. Default 'org'. */
  idPrefix?: string;
  highlight?: readonly string[];
}

export interface ProgramChart {
  /** 'main', or the function id. */
  id: string;
  /** 'Programme Principal', "Programme d'interruption", 'Sous-programme temporisation()'. */
  title: string;
  diagram: Diagram;
  svg: string;
}
