// Program → placed Diagram, in the prof's layout (research 06 §4, 00 §4 + "Critic corrections"):
//   - one vertical spine under Début; every spine arrow points down;
//   - Début → CONFIGURATION → INITIALISATION → loop body inside « Boucle infinie » → Fin (Fin drawn even after while(1));
//   - decisions: `oui` exits DOWN (label right of the line), `non` exits RIGHT then down (label above the line);
//     an if / else-if / else chain cascades one column right and a little lower per test;
//   - branches come back to the spine with left-pointing arrowheads, on staggered rows (not one bus);
//   - while(1): return line on the LEFT, leaving the spine below the last merge and re-entering just above the
//     loop's first element (corrected nesting: her slide 6 re-enters below « Z= x-y », which contradicts her code),
//     with the green « Boucle infinie » callout touching it.
//
// Constructs she never drew (ASSUMPTIONS, research 06 §7 / 00 §4.5), kept in her palette and her oui/non rules:
//   - busy wait `while (X == 1);` (waitFor): a diamond with the condition that ENDS the wait (« X==0 ») whose `non`
//     exit leaves RIGHT and comes back above the diamond; `oui` continues down (her rule: oui down, non right).
//     Option waits: 'loop' writes the C loop condition instead, `oui` looping back;
//   - while (cond) { … }: diamond, `oui` down into the body, return line on the LEFT back above the diamond (a return
//     on the right would have to cross the `non` exit; on the left, nested loops nest as concentric returns);
//     `non` leaves right, runs down past the body and turns down into the spine below the loop (no arrowhead: the
//     spine continues from it, nothing merges there);
//   - repeat N: ONE action box (« Led verte clignote 3 fois (0,5 s / 0,5 s) », « Décompte de 9 à 0 sur l'afficheur
//     (1 s par chiffre) », research 00 §4.5), merged with the simple statements around it; option counters: 'loop'
//     (and every `for`) draws the explicit counter loop: box « i=0 », test « i<3 », update box « i=i+1 »;
//   - a long if / else-if chain (4 columns or more, or too wide for a page) stacks its tests down the right side:
//     each test sits below the previous branch, one step to the right, and each branch merges back right below
//     itself (research 00 C4: the diagonal cascade of 4 columns no longer fits a portrait A4 page);
//   - delays: a line of the green action box (« Temporisation 0,5 s », or folded into « … pendant 0,5 s » /
//     « … clignote (0,5 s / 0,5 s) » by the program-model's wording);
//   - a call: ISO « sous-programme » box (double vertical sides) in the green palette;
//   - a program without while(1) (EXEMPLE1): straight to Fin, no loop and no tag;
//   - an empty loop or function body: one box « Aucune instruction »;
//   - function / interrupt charts: Début → body → « Retour » (the routine returns to its caller).
//
// Everything is deterministic: text widths come from fixed tables (text.ts), ids from the program's own ids.
import {
  branchNote, describeActions, describeBranchCond, describeConfiguration, describeFor, describeInitialisation,
  describeRepeat, describeStmt, describeWait, describeWhile, isSimpleStmt, segmentStmts, walkStmts,
  type CounterLoopProse, type DescribeOptions, type ForStmt, type FunctionDef, type IfStmt, type Program, type ProseLine,
  type RepeatStmt, type Stmt, type StmtSegment, type WaitStmt, type WhileStmt,
} from '@pic/program-model';
import { FONTS, METRICS as M } from './theme';
import { textWidth, wrapText } from './text';
import type {
  BoxRole, Diagram, DiagramEdge, DiagramLabel, DiagramNode, DiagramStyle, EdgeKind, LayoutOptions, Point, Rect, TextFont,
  TextLine,
} from './types';

// ---------------------------------------------------------------------------------------------------------------
// Context and small geometry helpers

interface Ctx {
  style: DiagramStyle;
  program: Program;
  describe: DescribeOptions;
  counters: 'box' | 'loop';
  usedIds: Set<string>;
  junctions: number;
  edges: number;
}

/**
 * A laid-out piece of flow in local coordinates: the spine is x = 0, the entry's top is at y = 0 and the exit's bottom
 * at y = height. `left` / `right` bound everything drawn (labels included).
 */
interface Fragment {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  entry: DiagramNode;
  exit: DiagramNode;
  /** Label of the line that will leave `exit` (a busy wait's `non`), drawn by whoever connects it. */
  exitLabel?: 'oui' | 'non';
  height: number;
  left: number;
  right: number;
}

type Control = Extract<Stmt, { kind: 'if' | 'while' | 'repeat' | 'for' | 'waitFor' }>;

const even = (v: number) => 2 * Math.ceil(v / 2 - 1e-9);
const isJunction = (n: DiagramNode) => n.shape === 'junction';

function uid(ctx: Ctx, base: string): string {
  let id = base;
  for (let k = 2; ctx.usedIds.has(id); k++) id = `${base}~${k}`;
  ctx.usedIds.add(id);
  return id;
}

function lineWidth(line: TextLine, font: TextFont): number {
  const f = FONTS[font];
  return textWidth(line.text, line.bold || f.bold ? f.boldFace : f.face, f.size);
}

/** Estimated box of a text whose baseline starts at (x, y). */
function textBox(text: string, x: number, y: number, anchor: DiagramLabel['anchor'], font: TextFont): Rect {
  const f = FONTS[font];
  const w = textWidth(text, f.bold ? f.boldFace : f.face, f.size);
  const left = anchor === 'start' ? x : anchor === 'middle' ? x - w / 2 : x - w;
  return { x: left, y: y - f.size * 0.82, w, h: f.lineHeight };
}

function makeLabel(text: string, x: number, y: number, anchor: DiagramLabel['anchor'], font: TextFont): DiagramLabel {
  return { text, x, y, anchor, font, box: textBox(text, x, y, anchor, font) };
}

/** `oui` / `non` right of a line going down from `p`. */
const downLabel = (text: string, p: Point) => makeLabel(text, p.x + 7, p.y + 14, 'start', 'branch');
/** `oui` / `non` above a line going right from `p`. */
const rightLabel = (text: string, p: Point) => makeLabel(text, p.x + 6, p.y - 5, 'start', 'branch');
const branchLabelWidth = (text: string) => textWidth(text, FONTS.branch.face, FONTS.branch.size);
/** Room needed right of a vertex for a `non` / `oui` written above a horizontal exit. */
const rightLabelRoom = (text: string) => Math.ceil(6 + branchLabelWidth(text) + 8);

export function topPort(n: DiagramNode): Point {
  return isJunction(n) ? { x: n.box.x, y: n.box.y } : { x: n.box.x + n.box.w / 2, y: n.box.y };
}
export function bottomPort(n: DiagramNode): Point {
  return isJunction(n) ? { x: n.box.x, y: n.box.y } : { x: n.box.x + n.box.w / 2, y: n.box.y + n.box.h };
}
export function rightPort(n: DiagramNode): Point {
  return { x: n.box.x + n.box.w, y: n.box.y + n.box.h / 2 };
}

function edge(
  ctx: Ctx, kind: EdgeKind, from: DiagramNode, to: DiagramNode, points: Point[], arrow: boolean, label?: DiagramLabel,
): DiagramEdge {
  const e: DiagramEdge = { id: `e${++ctx.edges}`, kind, from: from.id, to: to.id, points, arrow };
  if (label) e.label = label;
  return e;
}

const kindOfLabel = (label: 'oui' | 'non' | undefined): EdgeKind => (label === 'oui' ? 'yes' : label === 'non' ? 'no' : 'flow');

function junction(ctx: Ctx, x: number, y: number): DiagramNode {
  return { id: `j${++ctx.junctions}`, shape: 'junction', box: { x, y, w: 0, h: 0 }, lines: [], font: 'body', refs: [] };
}

function moveRect(r: Rect, dx: number, dy: number): void {
  r.x += dx;
  r.y += dy;
}

function translate(f: Fragment, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  for (const n of f.nodes) {
    moveRect(n.box, dx, dy);
    if (n.label) {
      n.label.x += dx;
      n.label.y += dy;
      moveRect(n.label.box, dx, dy);
    }
  }
  for (const e of f.edges) {
    for (const p of e.points) {
      p.x += dx;
      p.y += dy;
    }
    if (e.label) {
      e.label.x += dx;
      e.label.y += dy;
      moveRect(e.label.box, dx, dy);
    }
  }
  f.left += dx;
  f.right += dx;
}

function single(node: DiagramNode, extraRight = 0): Fragment {
  return {
    nodes: [node], edges: [], entry: node, exit: node, height: node.box.h,
    left: node.box.x, right: Math.max(node.box.x + node.box.w, extraRight),
  };
}

const labelRight = (l: DiagramLabel | undefined) => (l ? l.box.x + l.box.w : -Infinity);

// ---------------------------------------------------------------------------------------------------------------
// Nodes

/** A rectangle centred on the spine, sized to its (word-wrapped) text. */
function processNode(
  ctx: Ctx, base: string, role: BoxRole, prose: readonly TextLine[], refs: string[], section = false, shape: 'process' | 'subroutine' = 'process',
): DiagramNode {
  const f = FONTS.body;
  const maxTextW = section ? M.sectionMaxTextW : M.actionMaxTextW;
  const lines: TextLine[] = [];
  for (const l of prose) {
    for (const t of wrapText(l.text, l.bold ? f.boldFace : f.face, f.size, maxTextW)) lines.push({ ...l, text: t });
  }
  const textW = Math.max(0, ...lines.map((l) => lineWidth(l, 'body')));
  const bars = shape === 'subroutine' ? 2 * M.subroutineBar : 0;
  const w = even(Math.max(section ? M.sectionMinW : M.actionMinW, textW + 2 * M.padX + bars));
  const h = even(Math.max(M.actionMinH, lines.length * f.lineHeight + 2 * M.padY));
  return { id: uid(ctx, base), shape, role, box: { x: -w / 2, y: 0, w, h }, lines, font: 'body', refs };
}

/** Diamond text, wrapped at « et » / « ou » when a compound condition is long. */
function decisionLines(text: string): TextLine[] {
  const f = FONTS.decision;
  const explicit = text.split('\n');
  if (explicit.length > 1) return explicit.map((t) => ({ text: t }));
  if (textWidth(text, f.face, f.size) <= 200) return [{ text }];
  const parts = text.split(/(?<= et | ou )/);
  if (parts.length === 1) return [{ text }];
  const lines: string[] = [];
  let current = '';
  for (const part of parts) {
    const candidate = current + part;
    if (current !== '' && textWidth(candidate.trimEnd(), f.face, f.size) > 170) {
      lines.push(current.trimEnd());
      current = part;
    } else current = candidate;
  }
  if (current !== '') lines.push(current.trimEnd());
  return lines.map((t) => ({ text: t }));
}

/**
 * Flat diamond centred on the spine. The text rectangle (half sizes a, b with padding) must fit inside the rhombus:
 * a/A + b/B ≤ 1. Short tests use the minimum-area rhombus A = 2a, B = 2b (that is her ≈147×37 pt for « ZERO==1 »);
 * long ones trade some height for width (k up to 3) so the diamond stays readable without becoming huge.
 */
function decisionNode(ctx: Ctx, base: string, text: string, refs: string[]): DiagramNode {
  const f = FONTS.decision;
  const lines = decisionLines(text);
  const tw = Math.max(...lines.map((l) => lineWidth(l, 'decision')));
  const a = tw / 2 + 4;
  const b = (lines.length * f.lineHeight) / 2 + 1;
  const k = Math.min(3, Math.max(2, 2 + (tw - 100) / 120));
  const A = (a * k) / (k - 1);
  const B = b * k;
  const w = even(Math.max(M.decisionMinW, 2 * A));
  const h = even(Math.max(M.decisionMinH, 2 * B));
  return { id: uid(ctx, base), shape: 'decision', box: { x: -w / 2, y: 0, w, h }, lines, font: 'decision', refs };
}

// ---------------------------------------------------------------------------------------------------------------
// Sequences

/** Vertical gap between two consecutive fragments. */
function gapBetween(prev: Fragment, next: Fragment): number {
  if (prev.exitLabel) return M.gapLabelled;
  // A merge arrow landing on the previous exit and a loop return landing on the next entry: keep the two
  // arrowheads apart.
  if (isJunction(prev.exit) && isJunction(next.entry)) return M.mergeStagger + 4;
  return isJunction(next.entry) ? M.gapJunction : M.gapShape;
}

/** Stack fragments on the spine, joined by straight arrows (no arrowhead into an invisible junction). */
function seq(ctx: Ctx, parts: readonly (Fragment | null)[]): Fragment | null {
  const frags = parts.filter((f): f is Fragment => f !== null);
  if (frags.length === 0) return null;
  const out: Fragment = {
    nodes: [...frags[0].nodes], edges: [...frags[0].edges], entry: frags[0].entry, exit: frags[0].exit,
    exitLabel: frags[0].exitLabel, height: frags[0].height, left: frags[0].left, right: frags[0].right,
  };
  for (let i = 1; i < frags.length; i++) {
    const f = frags[i];
    const prev = out;
    const y = prev.height + gapBetween(prev, f);
    translate(f, 0, y);
    const from = bottomPort(prev.exit);
    const to = topPort(f.entry);
    const label = prev.exitLabel ? downLabel(prev.exitLabel, from) : undefined;
    out.edges.push(edge(ctx, kindOfLabel(prev.exitLabel), prev.exit, f.entry, [from, to], !isJunction(f.entry), label));
    out.nodes.push(...f.nodes);
    out.edges.push(...f.edges);
    out.exit = f.exit;
    out.exitLabel = f.exitLabel;
    out.height = y + f.height;
    out.left = Math.min(out.left, f.left);
    out.right = Math.max(out.right, f.right, labelRight(label));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Statement blocks

interface Note {
  text: string;
  refs: string[];
}

const toLines = (prose: readonly ProseLine[], keepEmphasis: boolean): TextLine[] =>
  prose.map((l) => (keepEmphasis && l.emphasis ? { text: l.text, emphasis: l.emphasis } : { text: l.text }));

/**
 * A run of simple statements: green boxes (orange in the initialisation section), with each call in its own
 * « sous-programme » box.
 */
function actionFragments(ctx: Ctx, stmts: readonly Stmt[], note: Note | null, role: BoxRole = 'action'): Fragment[] {
  const out: Fragment[] = [];
  let pendingNote = note;
  const flush = (run: Stmt[]) => {
    const prose = describeActions(ctx.program, run, ctx.describe);
    const lines = role === 'init' ? toLines(genericInit(prose, ctx.describe), true) : toLines(prose, false);
    if (pendingNote) lines.unshift({ text: pendingNote.text });
    if (lines.length === 0) return;
    const refs = [...(pendingNote?.refs ?? []), ...stmtRefs(run)];
    const base = run[0]?.id ? `box-${run[0].id}` : pendingNote?.refs[0] ? `note-${pendingNote.refs[0]}` : 'box';
    out.push(single(processNode(ctx, base, role, lines, refs)));
    pendingNote = null;
  };
  let run: Stmt[] = [];
  for (const s of stmts) {
    // A comment line above a statement starts a new step of the program: a new box (traffic: rouge / orange / vert).
    if (s.lead !== undefined && run.length > 0) {
      flush(run);
      run = [];
    }
    if (s.kind === 'call') {
      if (run.length > 0 || pendingNote) flush(run);
      run = [];
      const lines = toLines(describeStmt(ctx.program, s, ctx.describe), false);
      out.push(single(processNode(ctx, s.id ? `call-${s.id}` : 'call', role, lines, s.id ? [s.id] : [], false, 'subroutine')));
    } else run.push(s);
  }
  if (run.length > 0 || pendingNote) flush(run);
  return out;
}

/** A `repeat` drawn as one action box (counters: 'box') when its body has no control statement. */
function collapsible(ctx: Ctx, s: Stmt): boolean {
  if (s.kind !== 'repeat' || ctx.counters === 'loop') return false;
  return s.body.every((x) => isSimpleStmt(x) && x.kind !== 'call');
}

/** segmentStmts, with collapsible repeats kept inside the runs of simple statements (they are one box line). */
function segments(ctx: Ctx, stmts: readonly Stmt[]): StmtSegment[] {
  const out: StmtSegment[] = [];
  for (const seg of segmentStmts(stmts)) {
    const last = out[out.length - 1];
    if (seg.kind === 'control' && collapsible(ctx, seg.stmt)) {
      if (last?.kind === 'actions') last.stmts.push(seg.stmt);
      else out.push({ kind: 'actions', stmts: [seg.stmt] });
    } else if (seg.kind === 'actions' && last?.kind === 'actions') last.stmts.push(...seg.stmts);
    else out.push(seg);
  }
  return out;
}

/** Ids a box stands for: its statements and, for a collapsed repeat, every statement of its body. */
function stmtRefs(stmts: readonly Stmt[]): string[] {
  const out: string[] = [];
  walkStmts(stmts, (s) => { if (s.id !== '') out.push(s.id); });
  return out;
}

/** Statements drawn in order on the spine. `note` (a branch's « // x= y ») heads the first box. */
function blockFragment(ctx: Ctx, stmts: readonly Stmt[], note: Note | null = null): Fragment | null {
  const parts: Fragment[] = [];
  let pendingNote = note;
  for (const seg of segments(ctx, stmts)) {
    if (seg.kind === 'actions') {
      parts.push(...actionFragments(ctx, seg.stmts, pendingNote));
      pendingNote = null;
    } else if (pendingNote && (seg.stmt.kind === 'repeat' || seg.stmt.kind === 'for')) {
      // The note heads the counter box (« // x= y » / « i=0 »): it is the branch's first box anyway.
      parts.push(controlFragment(ctx, seg.stmt, pendingNote));
      pendingNote = null;
    } else {
      if (pendingNote) {
        parts.push(...actionFragments(ctx, [], pendingNote));
        pendingNote = null;
      }
      parts.push(controlFragment(ctx, seg.stmt));
    }
  }
  if (pendingNote) parts.push(...actionFragments(ctx, [], pendingNote));
  return seq(ctx, parts);
}

/** `note` is only used by counter loops (it heads their counter box). */
function controlFragment(ctx: Ctx, s: Control, note: Note | null = null): Fragment {
  switch (s.kind) {
    case 'if': return ifFragment(ctx, s);
    case 'waitFor': return waitFragment(ctx, s);
    case 'while': return whileFragment(ctx, s);
    case 'repeat':
      if (collapsible(ctx, s)) return actionFragments(ctx, [s], note)[0];
      return counterFragment(ctx, s, describeRepeat(ctx.program, s, ctx.describe), [s.id], [s.id], [s.id], note);
    case 'for': return counterFragment(ctx, s, describeFor(ctx.program, s, ctx.describe), [s.id, s.init.id], [s.id], [s.update.id], note);
  }
}

const refsOf = (...ids: string[]) => ids.filter((id) => id !== '');

// ---------------------------------------------------------------------------------------------------------------
// if / else if / else: the diagonal cascade

interface Column {
  /** Diamond of this column (none for the else column). */
  dec: DiagramNode | null;
  body: Fragment | null;
  /** Centre x of the column. */
  x: number;
  /** Extents relative to x. */
  left: number;
  right: number;
  /** Top of the body, in the if fragment's local coordinates (first diamond's top = 0). */
  bodyTop: number;
}

function ifFragment(ctx: Ctx, s: IfStmt): Fragment {
  const { program } = ctx;
  if (s.branches.length === 0) {
    const body = s.otherwise ? blockFragment(ctx, s.otherwise.body) : null;
    return body ?? single(processNode(ctx, s.id ? `box-${s.id}` : 'box', 'action', [{ text: 'Aucune instruction' }], refsOf(s.id)));
  }
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const n = s.branches.length;
  const ouiW = branchLabelWidth('oui');

  // Columns 1..n: a diamond and its `oui` body.
  const cols: Column[] = s.branches.map((br) => {
    const dec = decisionNode(ctx, br.id ? `dec-${br.id}` : 'dec', describeBranchCond(program, br, ctx.describe), refsOf(s.id, br.id));
    const noteText = branchNote(br);
    const body = blockFragment(ctx, br.body, noteText ? { text: noteText, refs: refsOf(br.id) } : null);
    const left = Math.min(dec.box.x, body?.left ?? 0);
    const right = Math.max(dec.box.x + dec.box.w, body?.right ?? 0, 7 + ouiW);
    return { dec, body, x: 0, left, right, bodyTop: 0 };
  });
  // Column n+1: the else body, or the empty `non` path of the last test.
  const other = s.otherwise;
  const elseNote = other ? branchNote(other) : undefined;
  const elseBody = other ? blockFragment(ctx, other.body, elseNote ? { text: elseNote, refs: refsOf(other.id) } : null) : null;
  const elseCol: Column = { dec: null, body: elseBody, x: 0, left: elseBody?.left ?? 0, right: elseBody?.right ?? 0, bodyTop: 0 };

  const all = [...cols, elseCol];
  const lastCol = cols[n - 1];
  const last = lastCol.dec!;
  const bottomOf = (c: Column): number => {
    if (c.body) return c.bodyTop + c.body.height;
    if (c.dec) return c.dec.box.y + c.dec.box.h;
    return last.box.y + last.box.h / 2; // empty else path starts at the last test's mid line
  };
  const dropOf = (c: Column): number => {
    if (c.body) return c.body.exitLabel ? M.gapLabelled : M.mergeDrop;
    return c.dec ? M.gapLabelled : M.mergeDrop; // an empty `oui` carries its label on the drop
  };
  const mergeY: number[] = []; // mergeY[k] for columns k = 1..n (0-based index into `all`)

  // Her diagonal cascade: each test one step lower than the previous one's mid line, each column right of all
  // the previous ones, merges staggered below every column.
  for (let k = 0; k < n; k++) {
    const dec = cols[k].dec!;
    const top = k === 0 ? 0 : cols[k - 1].dec!.box.y + cols[k - 1].dec!.box.h / 2 + M.cascadeDrop;
    dec.box.y = top;
    cols[k].bodyTop = top + dec.box.h + M.gapLabelled;
  }
  elseCol.bodyTop = last.box.y + last.box.h + M.gapLabelled;
  let maxRight = cols[0].right;
  for (let k = 1; k < n; k++) {
    const prev = cols[k - 1];
    const prevDec = prev.dec!;
    cols[k].x = Math.ceil(Math.max(
      maxRight + M.columnGap - cols[k].left,
      prev.x + prevDec.box.w / 2 + rightLabelRoom('non'),
    ));
    maxRight = Math.max(maxRight, cols[k].x + cols[k].right);
  }
  elseCol.x = Math.ceil(elseBody
    ? Math.max(maxRight + M.columnGap - elseCol.left, lastCol.x + last.box.w / 2 + rightLabelRoom('non'))
    : Math.max(maxRight + M.exitOffset, lastCol.x + last.box.w / 2 + rightLabelRoom('non')));
  const columns = n + (other ? 1 : 0);
  const cascadeWidth = (elseBody ? elseCol.x + elseCol.right : elseCol.x) - Math.min(...cols.map((c) => c.x + c.left));

  if (columns >= M.stackColumns || cascadeWidth > M.cascadeMaxW) {
    // Too wide for a page: stack the tests down the right side. Column k sits below column k-1 (below its merge row),
    // one step right of it: the previous `non` drops beside the previous branch, and each branch merges back to the
    // spine right below itself.
    let floor = bottomOf(cols[0]);
    for (let k = 1; k < all.length; k++) {
      const c = all[k];
      const prev = all[k - 1];
      const prevDec = prev.dec!;
      c.x = Math.ceil(Math.max(
        prev.x + Math.max(prev.right + M.columnGap, prevDec.box.w / 2 + rightLabelRoom('non')),
        M.columnGap - (c.body || c.dec ? c.left : 0),
      ));
      const top = floor + M.gapShape;
      if (c.dec) {
        c.dec.box.y = top;
        c.bodyTop = top + c.dec.box.h + M.gapLabelled;
      } else {
        c.bodyTop = top;
      }
      const bottom = c.body || c.dec ? bottomOf(c) : top - M.gapShape;
      mergeY[k] = Math.max(bottom + dropOf(c), k > 1 ? mergeY[k - 1] + M.mergeStagger : 0);
      floor = mergeY[k];
    }
  } else {
    // Merge rows (staggered, each one below every column it crosses).
    let lowest = bottomOf(all[0]) + dropOf(all[0]);
    for (let k = 1; k < all.length; k++) {
      lowest = Math.max(lowest, bottomOf(all[k]) + dropOf(all[k]));
      mergeY[k] = k === 1 ? lowest : Math.max(mergeY[k - 1] + M.mergeStagger, lowest);
    }
  }

  // Place diamonds and bodies; nodes are listed in flow order (each test, then its branch).
  for (const c of all) {
    if (c.dec) {
      c.dec.box.x += c.x;
      nodes.push(c.dec);
    }
    if (c.body) {
      translate(c.body, c.x, c.bodyTop);
      nodes.push(...c.body.nodes);
    }
  }

  const joins: DiagramNode[] = [];
  for (let k = 1; k < all.length; k++) joins[k] = junction(ctx, 0, mergeY[k]);

  // Column 1: the `oui` of the first test continues the spine.
  const first = cols[0];
  const firstDec = first.dec!;
  if (first.body) {
    const from = bottomPort(firstDec);
    edges.push(edge(ctx, 'yes', firstDec, first.body.entry, [from, topPort(first.body.entry)], !isJunction(first.body.entry), downLabel('oui', from)));
    edges.push(...first.body.edges);
    const b = bottomPort(first.body.exit);
    const lbl = first.body.exitLabel ? downLabel(first.body.exitLabel, b) : undefined;
    edges.push(edge(ctx, kindOfLabel(first.body.exitLabel), first.body.exit, joins[1], [b, { x: 0, y: mergeY[1] }], false, lbl));
  } else {
    const from = bottomPort(firstDec);
    edges.push(edge(ctx, 'yes', firstDec, joins[1], [from, { x: 0, y: mergeY[1] }], false, downLabel('oui', from)));
  }

  // `non` exits: right, then down into the next test (or the else body / the empty path).
  for (let k = 0; k < n; k++) {
    const dec = cols[k].dec!;
    const from = rightPort(dec);
    const label = rightLabel('non', from);
    const nextX = all[k + 1].x;
    if (k < n - 1) {
      const next = cols[k + 1].dec!;
      edges.push(edge(ctx, 'no', dec, next, [from, { x: nextX, y: from.y }, topPort(next)], true, label));
    } else if (elseBody) {
      const to = topPort(elseBody.entry);
      edges.push(edge(ctx, 'no', dec, elseBody.entry, [from, { x: nextX, y: from.y }, to], !isJunction(elseBody.entry), label));
    } else {
      const y = mergeY[n];
      edges.push(edge(ctx, 'no', dec, joins[n], [from, { x: nextX, y: from.y }, { x: nextX, y }, { x: 0, y }], true, label));
    }
  }

  // Columns 2..n (+ else): the `oui` into the body, then the merge back to the spine.
  for (let k = 1; k < all.length; k++) {
    const c = all[k];
    const y = mergeY[k];
    if (c.dec && !c.body) {
      const from = bottomPort(c.dec);
      edges.push(edge(ctx, 'yes', c.dec, joins[k], [from, { x: from.x, y }, { x: 0, y }], true, downLabel('oui', from)));
      continue;
    }
    if (!c.body) continue; // empty else path: already drawn with the last `non`
    if (c.dec) {
      const from = bottomPort(c.dec);
      edges.push(edge(ctx, 'yes', c.dec, c.body.entry, [from, topPort(c.body.entry)], !isJunction(c.body.entry), downLabel('oui', from)));
    }
    edges.push(...c.body.edges);
    const b = bottomPort(c.body.exit);
    const lbl = c.body.exitLabel ? downLabel(c.body.exitLabel, b) : undefined;
    edges.push(edge(ctx, 'merge', c.body.exit, joins[k], [b, { x: b.x, y }, { x: 0, y }], true, lbl));
  }

  // The spine through the merge points.
  for (let k = 1; k < all.length - 1; k++) {
    edges.push(edge(ctx, 'flow', joins[k], joins[k + 1], [topPort(joins[k]), topPort(joins[k + 1])], false));
  }
  for (let k = 1; k < all.length; k++) nodes.push(joins[k]);

  const left = Math.min(...cols.map((c) => c.x + c.left), elseBody ? elseCol.x + elseCol.left : 0);
  const right = Math.max(...cols.map((c) => c.x + c.right), elseBody ? elseCol.x + elseCol.right : elseCol.x);
  return { nodes, edges, entry: firstDec, exit: joins[all.length - 1], height: mergeY[all.length - 1], left, right };
}

// ---------------------------------------------------------------------------------------------------------------
// Loops

/**
 * Busy wait `while (X == 1);`: diamond with the condition that ends the wait (« X==0 »); `non` loops back above it on
 * the right, `oui` continues down. (waits: 'loop': the C loop condition, `oui` looping back.)
 */
function waitFragment(ctx: Ctx, s: WaitStmt): Fragment {
  const entry = junction(ctx, 0, 0);
  const wait = describeWait(ctx.program, s, ctx.describe);
  const dec = decisionNode(ctx, s.id ? `dec-${s.id}` : 'dec', wait.text, refsOf(s.id));
  dec.box.y = M.loopEntry;
  const from = rightPort(dec);
  const xR = from.x + Math.max(M.waitLoop, rightLabelRoom(wait.loopOn));
  const loop = edge(ctx, 'loop', dec, entry, [from, { x: xR, y: from.y }, { x: xR, y: 0 }, { x: 0, y: 0 }], true, rightLabel(wait.loopOn, from));
  const enter = edge(ctx, 'flow', entry, dec, [{ x: 0, y: 0 }, topPort(dec)], true);
  return {
    nodes: [entry, dec], edges: [enter, loop], entry, exit: dec, exitLabel: wait.loopOn === 'oui' ? 'non' : 'oui',
    height: dec.box.y + dec.box.h, left: dec.box.x, right: xR,
  };
}

/**
 * Pre-tested loop: junction J, diamond, `oui` down into `body`, return on the left back to J; `non` right, down past
 * everything and back to the spine below.
 */
function testedLoop(ctx: Ctx, dec: DiagramNode, body: Fragment | null): Fragment {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const entry = junction(ctx, 0, 0);
  dec.box.y = M.loopEntry;
  nodes.push(entry, dec);
  edges.push(edge(ctx, 'flow', entry, dec, [{ x: 0, y: 0 }, topPort(dec)], true));
  const decBottom = bottomPort(dec);
  const ouiLabel = downLabel('oui', decBottom);
  let left = dec.box.x;
  let right = Math.max(dec.box.x + dec.box.w, labelRight(ouiLabel));
  let yRet: number;
  if (body) {
    translate(body, 0, decBottom.y + M.gapLabelled);
    nodes.push(...body.nodes);
    edges.push(...body.edges);
    edges.push(edge(ctx, 'yes', dec, body.entry, [decBottom, topPort(body.entry)], !isJunction(body.entry), ouiLabel));
    left = Math.min(left, body.left);
    right = Math.max(right, body.right);
    const b = bottomPort(body.exit);
    yRet = b.y + (body.exitLabel ? M.gapLabelled : M.mergeDrop);
    const xL = Math.floor(left - M.loopOffset);
    const lbl = body.exitLabel ? downLabel(body.exitLabel, b) : undefined;
    edges.push(edge(ctx, 'loop', body.exit, entry, [b, { x: 0, y: yRet }, { x: xL, y: yRet }, { x: xL, y: 0 }, { x: 0, y: 0 }], true, lbl));
    right = Math.max(right, labelRight(lbl));
    left = xL;
  } else {
    yRet = decBottom.y + M.gapLabelled;
    const xL = Math.floor(left - M.loopOffset);
    edges.push(edge(ctx, 'loop', dec, entry, [decBottom, { x: 0, y: yRet }, { x: xL, y: yRet }, { x: xL, y: 0 }, { x: 0, y: 0 }], true, ouiLabel));
    left = xL;
  }
  const from = rightPort(dec);
  const xR = Math.ceil(Math.max(right + M.exitOffset, from.x + rightLabelRoom('non')));
  const yExit = yRet + M.mergeStagger;
  const exit = junction(ctx, 0, yExit);
  nodes.push(exit);
  // No arrowhead: the `non` line turns down into the spine (which continues from here); an arrow pointing at the
  // top of the next segment would read as a loose wire, since the loop's own line turned left just above.
  edges.push(edge(ctx, 'no', dec, exit, [from, { x: xR, y: from.y }, { x: xR, y: yExit }, { x: 0, y: yExit }], false, rightLabel('non', from)));
  return { nodes, edges, entry, exit, height: yExit, left, right: xR };
}

function whileFragment(ctx: Ctx, s: WhileStmt): Fragment {
  const dec = decisionNode(ctx, s.id ? `dec-${s.id}` : 'dec', describeWhile(ctx.program, s, ctx.describe).text, refsOf(s.id));
  return testedLoop(ctx, dec, blockFragment(ctx, s.body));
}

/** for / repeat: counter box, then the tested loop with the update box closing the body. */
function counterFragment(
  ctx: Ctx, s: RepeatStmt | ForStmt, prose: CounterLoopProse, initRefs: string[], testRefs: string[], updateRefs: string[],
  note: Note | null,
): Fragment {
  const initLines: TextLine[] = note ? [{ text: note.text }, { text: prose.init }] : [{ text: prose.init }];
  const refs = refsOf(...(note?.refs ?? []), ...initRefs);
  const init = single(processNode(ctx, s.id ? `init-${s.id}` : 'init-loop', 'action', initLines, refs));
  const dec = decisionNode(ctx, s.id ? `dec-${s.id}` : 'dec', prose.test, refsOf(...testRefs));
  const update = single(processNode(ctx, s.id ? `update-${s.id}` : 'update', 'action', [{ text: prose.update }], refsOf(...updateRefs)));
  const body = seq(ctx, [blockFragment(ctx, s.body), update]);
  return seq(ctx, [init, testedLoop(ctx, dec, body)])!;
}

/** while(1): left return line from below the body back above its first element, with « Boucle infinie ». */
function infiniteLoop(ctx: Ctx, body: Fragment): Fragment {
  const entry = junction(ctx, 0, 0);
  translate(body, 0, M.loopEntry);
  const nodes: DiagramNode[] = [entry, ...body.nodes];
  const edges: DiagramEdge[] = [
    edge(ctx, 'flow', entry, body.entry, [{ x: 0, y: 0 }, topPort(body.entry)], !isJunction(body.entry)),
    ...body.edges,
  ];
  const b = bottomPort(body.exit);
  const yExit = b.y + (body.exitLabel ? M.gapLabelled : M.gapJunction);
  const exit = junction(ctx, 0, yExit);
  const lbl = body.exitLabel ? downLabel(body.exitLabel, b) : undefined;
  edges.push(edge(ctx, kindOfLabel(body.exitLabel), body.exit, exit, [b, { x: 0, y: yExit }], false, lbl));
  const xL = Math.floor(body.left - M.loopOffset);
  edges.push(edge(ctx, 'loop', exit, entry, [{ x: 0, y: yExit }, { x: xL, y: yExit }, { x: xL, y: 0 }, { x: 0, y: 0 }], true));
  // The callout: a rectangle whose wedge tip touches the vertical return line, half-way up.
  const f = FONTS.tag;
  const text = 'Boucle infinie';
  const w = even(textWidth(text, f.face, f.size) + 2 * M.tagPadX + M.tagTip);
  const h = M.tagH;
  const tag: DiagramNode = {
    id: uid(ctx, 'loop-tag'), shape: 'tag', box: { x: xL - w, y: yExit / 2 - h / 2, w, h },
    lines: [{ text }], font: 'tag', refs: [],
  };
  nodes.push(exit, tag);
  return {
    nodes, edges, entry, exit, height: yExit, left: xL - w, right: Math.max(body.right, labelRight(lbl)),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Terminals and section boxes

function terminal(ctx: Ctx, kind: 'start' | 'end', word: string, refs: string[]): Fragment {
  if (ctx.style === 'bw') {
    const f = FONTS.body;
    const w = even(textWidth(word, f.face, f.size) + 2 * M.terminalPadX);
    const node: DiagramNode = {
      id: uid(ctx, kind), shape: kind, box: { x: -w / 2, y: 0, w, h: M.terminalH }, lines: [{ text: word }], font: 'body', refs,
    };
    return single(node);
  }
  const d = kind === 'start' ? M.startGlyph : M.endGlyph;
  const label = makeLabel(word, d / 2 + M.terminalLabelGap, d / 2 + FONTS.terminal.size * 0.35, 'start', 'terminal');
  const node: DiagramNode = {
    id: uid(ctx, kind), shape: kind, box: { x: -d / 2, y: 0, w: d, h: d }, lines: [], font: 'terminal', label, refs,
  };
  return single(node, labelRight(label));
}

function sectionBox(ctx: Ctx, base: 'config' | 'init', heading: string, lines: TextLine[], refs: string[]): Fragment {
  return single(processNode(ctx, base, base, [{ text: heading, bold: true }, ...lines], refs, true));
}

/**
 * INITIALISATION: the orange section box holds the leading simple statements of init(). When init() also has
 * control statements (a wait for a start button…), they follow as normal flow and its later simple statements stay
 * orange, so the whole section reads as one. An empty init() draws no box.
 */
function initialisation(ctx: Ctx): Fragment[] {
  const { program } = ctx;
  const segs = segments(ctx, program.init);
  if (segs.length === 0) return [];
  let lines: TextLine[] = [];
  let refs: string[] = [];
  let rest = segs;
  if (segs[0].kind === 'actions') {
    const stmts = segs[0].stmts;
    const prose = segs.length === 1
      ? describeInitialisation(program, ctx.describe)
      : genericInit(describeActions(program, stmts, ctx.describe), ctx.describe);
    lines = toLines(prose, true);
    refs = stmtRefs(stmts);
    rest = segs.slice(1);
  }
  const out: Fragment[] = [sectionBox(ctx, 'init', 'INITIALISATION', lines, refs)];
  for (const seg of rest) {
    if (seg.kind === 'actions') out.push(...actionFragments(ctx, seg.stmts, null, 'init'));
    else out.push(controlFragment(ctx, seg.stmt));
  }
  return out;
}

function genericInit(lines: ProseLine[], opts: DescribeOptions): ProseLine[] {
  if (opts.wording !== 'generic') return lines;
  return lines.map((l) => (l.emphasis === 'off' ? { text: 'Initialiser les sorties', emphasis: 'off' } : l));
}

const emptyBox = (ctx: Ctx, base: string, refs: string[] = []) =>
  single(processNode(ctx, base, 'action', [{ text: 'Aucune instruction' }], refs));

// ---------------------------------------------------------------------------------------------------------------
// Charts

function newCtx(program: Program, options: LayoutOptions): Ctx {
  const describe: DescribeOptions = {};
  if (options.logic) describe.logic = options.logic;
  if (options.wording) describe.wording = options.wording;
  if (options.waits) describe.waits = options.waits;
  return {
    style: options.style ?? 'prof', program, describe, counters: options.counters ?? 'box', usedIds: new Set(), junctions: 0, edges: 0,
  };
}

/** Translate the chart into positive coordinates (with margins and an optional title) and measure it. */
function finish(ctx: Ctx, chart: Fragment, title: string | undefined): Diagram {
  const nodes = chart.nodes;
  const edges = chart.edges;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const addRect = (r: Rect) => {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  };
  for (const n of nodes) {
    addRect(n.box);
    if (n.label) addRect(n.label.box);
  }
  for (const e of edges) {
    for (const p of e.points) addRect({ x: p.x, y: p.y, w: 0, h: 0 });
    if (e.label) addRect(e.label.box);
  }
  const titleH = title ? FONTS.title.lineHeight + 14 : 0;
  const dx = Math.round(M.margin - minX);
  const dy = Math.round(M.margin + titleH - minY);
  translate(chart, dx, dy);
  let width = Math.ceil(maxX - minX + 2 * M.margin);
  const height = Math.ceil(maxY - minY + 2 * M.margin + titleH);
  const out: Diagram = { style: ctx.style, width, height, nodes, edges };
  if (title) {
    const f = FONTS.title;
    const w = Math.ceil(textWidth(title, f.boldFace, f.size));
    nodes.unshift({
      id: uid(ctx, 'title'), shape: 'title', box: { x: M.margin, y: M.margin, w, h: f.lineHeight },
      lines: [{ text: title, bold: true }], font: 'title', refs: [],
    });
    width = Math.max(width, w + 2 * M.margin);
    out.width = width;
    out.title = title;
  }
  return out;
}

/** Give two single-box fragments the width of the wider one (still centred on the spine). */
function widenTogether(a: Fragment, b: Fragment): void {
  const w = Math.max(a.entry.box.w, b.entry.box.w);
  for (const f of [a, b]) {
    f.entry.box.w = w;
    f.entry.box.x = -w / 2;
    f.left = Math.min(f.left, -w / 2);
    f.right = Math.max(f.right, w / 2);
  }
}

/** The main program's organigramme: Début, CONFIGURATION, INITIALISATION, the « Boucle infinie », Fin. */
export function layout(program: Program, options: LayoutOptions = {}): Diagram {
  const ctx = newCtx(program, options);
  const config = sectionBox(ctx, 'config', 'CONFIGURATION', toLines(describeConfiguration(program, ctx.describe), false), []);
  let loop: Fragment | null = null;
  if (program.loop) {
    const body = blockFragment(ctx, program.loop) ?? emptyBox(ctx, 'empty-loop');
    loop = infiniteLoop(ctx, body);
  }
  const init = initialisation(ctx);
  // CONFIGURATION and INITIALISATION are drawn with one common width, as on her slides.
  const initBox = init[0]?.entry.role === 'init' ? init[0] : null;
  if (initBox) widenTogether(config, initBox);
  const chart = seq(ctx, [terminal(ctx, 'start', 'Début', []), config, ...init, loop, terminal(ctx, 'end', 'Fin', [])])!;
  return finish(ctx, chart, options.title);
}

/** The organigramme of one function or of the interrupt routine: Début → body → Retour. */
export function layoutFunction(program: Program, fn: FunctionDef | string, options: LayoutOptions = {}): Diagram {
  const f = typeof fn === 'string' ? program.functions.find((x) => x.id === fn || x.name === fn) : fn;
  if (!f) throw new Error(`Fonction introuvable : ${String(fn)}`);
  const ctx = newCtx(program, options);
  const refs = refsOf(f.id);
  const body = blockFragment(ctx, f.body) ?? emptyBox(ctx, `empty-${f.id || f.name}`);
  const chart = seq(ctx, [terminal(ctx, 'start', 'Début', refs), body, terminal(ctx, 'end', 'Retour', refs)])!;
  return finish(ctx, chart, options.title);
}
