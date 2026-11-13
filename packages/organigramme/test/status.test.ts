// The STATUS template must give her slide-6 organigramme (TP « Manipulation du status », research 06 §3), with the
// corrections the research asks for:
//   - nesting: the « Boucle infinie » re-enters ABOVE the first loop box (her slide re-enters below « Z= x-y » while
//     her code recomputes it inside while(1); research 00 §4.2), and the INITIALISATION → loop arrow she forgot is drawn;
//   - wording from the program model: correct accents (« supérieur », C1.8), the variable as in the code (« z= x-y »,
//     she wrote « Z= x-y »), « x=5 et y=6 » without her stray spaces, « // x= y » with the space of the other two notes;
//   - CONFIGURATION names the pins the program uses, as she does (« RB0,RB1 et RB2 sont des sorties », although the
//     code writes `TRISB = 0x00;`), and status.c's `STATUS=0;` closes the INITIALISATION.
import { describe, expect, it } from 'vitest';
import { layout, type Diagram, type DiagramEdge, type DiagramNode } from '../src';
import { allProblems, nodeById, visible } from './geometry';
import { loadTemplate } from './support';

const program = loadTemplate('tp-status');

const texts = (n: DiagramNode) => n.lines.map((l) => l.text);
const byText = (d: Diagram, first: string): DiagramNode => {
  const n = visible(d).find((x) => x.lines[0]?.text === first);
  if (!n) throw new Error(`no node starting with « ${first} »`);
  return n;
};
const edgeBetween = (d: Diagram, from: DiagramNode, to: DiagramNode): DiagramEdge => {
  const e = d.edges.find((x) => x.from === from.id && x.to === to.id);
  if (!e) throw new Error(`no edge ${from.id} → ${to.id}`);
  return e;
};
const cx = (n: DiagramNode) => n.box.x + n.box.w / 2;
const cy = (n: DiagramNode) => n.box.y + n.box.h / 2;
const bottom = (n: DiagramNode) => n.box.y + n.box.h;

describe.each(['prof', 'bw'] as const)('TP STATUS organigramme (%s)', (style) => {
  const d = layout(program, { style });

  it('passes every layout invariant', () => {
    expect(allProblems(d)).toEqual([]);
  });

  it('has exactly her shapes and texts, top to bottom', () => {
    const shapes = visible(d).map((n) => ({
      shape: n.shape,
      ...(n.role ? { role: n.role } : {}),
      text: style === 'prof' && (n.shape === 'start' || n.shape === 'end') ? [n.label!.text] : texts(n),
    }));
    expect(shapes).toEqual([
      { shape: 'start', text: ['Début'] },
      { shape: 'process', role: 'config', text: ['CONFIGURATION', 'RB0,RB1 et RB2 sont des sorties', 'Déclaration des variables'] },
      { shape: 'process', role: 'init', text: ['INITIALISATION', 'x=5 et y=6', 'Les Leds sont éteintes', 'STATUS=0'] },
      { shape: 'process', role: 'action', text: ['Les Leds sont éteintes', 'z= x-y'] },
      { shape: 'decision', text: ['ZERO==1'] },
      { shape: 'process', role: 'action', text: ['// x= y', 'Led égalité allumée'] },
      { shape: 'decision', text: ['CARRY==1'] },
      { shape: 'process', role: 'action', text: ['// x> y', 'Led supérieur allumée'] },
      { shape: 'process', role: 'action', text: ['// x<y', 'Led inférieur allumée'] },
      { shape: 'tag', text: ['Boucle infinie'] },
      { shape: 'end', text: ['Fin'] },
    ]);
  });

  it('writes the headings in bold and only the INITIALISATION « Les Leds sont éteintes » in red', () => {
    const config = nodeById(d, 'config');
    const init = nodeById(d, 'init');
    expect(config.lines[0]).toEqual({ text: 'CONFIGURATION', bold: true });
    expect(init.lines[0]).toEqual({ text: 'INITIALISATION', bold: true });
    expect(init.lines[2]).toEqual({ text: 'Les Leds sont éteintes', emphasis: 'off' });
    const loopBox = byText(d, 'Les Leds sont éteintes');
    expect(loopBox.lines.every((l) => !l.emphasis && !l.bold)).toBe(true);
    // CONFIGURATION and INITIALISATION are wide and share one width; the loop boxes are narrower.
    expect(config.box.w).toBe(init.box.w);
    expect(config.box.w).toBeGreaterThanOrEqual(231);
    expect(loopBox.box.w).toBeLessThan(config.box.w);
  });

  it('chains the sections on one spine: Début → CONFIGURATION → INITIALISATION → loop', () => {
    const start = nodeById(d, 'start');
    const config = nodeById(d, 'config');
    const init = nodeById(d, 'init');
    const first = byText(d, 'Les Leds sont éteintes');
    const spine = cx(start);
    for (const n of [config, init, first, byText(d, 'ZERO==1'), byText(d, '// x= y'), nodeById(d, 'end')]) expect(cx(n)).toBe(spine);
    expect(edgeBetween(d, start, config).arrow).toBe(true);
    expect(edgeBetween(d, config, init).arrow).toBe(true);
    // INITIALISATION → loop re-entry junction → first loop box (the arrow she forgot on her slide).
    const intoLoop = d.edges.find((e) => e.from === init.id)!;
    const entry = nodeById(d, intoLoop.to);
    expect(entry.shape).toBe('junction');
    expect(edgeBetween(d, entry, first).arrow).toBe(true);
  });

  it('cascades the else-if chain: oui down, non right then down, one column per test', () => {
    const zero = byText(d, 'ZERO==1');
    const carry = byText(d, 'CARRY==1');
    const egal = byText(d, '// x= y');
    const sup = byText(d, '// x> y');
    const inf = byText(d, '// x<y');
    // ZERO==1: oui straight down into « // x= y », labelled right of the line.
    const zOui = edgeBetween(d, zero, egal);
    expect(zOui.label?.text).toBe('oui');
    expect(zOui.points).toEqual([{ x: cx(zero), y: bottom(zero) }, { x: cx(egal), y: egal.box.y }]);
    expect(zOui.label!.box.x).toBeGreaterThan(cx(zero));
    // ZERO==1: non from the right vertex, right to the CARRY column, then down into CARRY==1, labelled above the line.
    const zNon = edgeBetween(d, zero, carry);
    expect(zNon.label?.text).toBe('non');
    expect(zNon.points).toEqual([
      { x: zero.box.x + zero.box.w, y: cy(zero) }, { x: cx(carry), y: cy(zero) }, { x: cx(carry), y: carry.box.y },
    ]);
    expect(zNon.label!.box.y + zNon.label!.box.h).toBeLessThanOrEqual(cy(zero));
    // The second test is one column right and a little lower (below ZERO's mid line, above its bottom).
    expect(carry.box.x).toBeGreaterThan(zero.box.x + zero.box.w);
    expect(carry.box.y).toBeGreaterThan(cy(zero));
    expect(carry.box.y).toBeLessThan(bottom(zero));
    // CARRY==1: oui down into « // x> y »; non right then down into « // x<y », a third column on the same row.
    expect(edgeBetween(d, carry, sup).label?.text).toBe('oui');
    expect(cx(sup)).toBe(cx(carry));
    const cNon = edgeBetween(d, carry, inf);
    expect(cNon.label?.text).toBe('non');
    expect(cNon.points).toHaveLength(3);
    expect(inf.box.x).toBeGreaterThan(sup.box.x + sup.box.w);
    expect(inf.box.y).toBe(sup.box.y);
    expect(egal.box.y).toBeLessThan(sup.box.y);
  });

  it('merges the right-hand branches back with left arrows on staggered rows', () => {
    const egal = byText(d, '// x= y');
    const sup = byText(d, '// x> y');
    const inf = byText(d, '// x<y');
    const spine = cx(egal);
    const mergeOf = (n: DiagramNode) => d.edges.find((e) => e.from === n.id)!;
    const ms = mergeOf(sup);
    const mi = mergeOf(inf);
    for (const [m, box] of [[ms, sup], [mi, inf]] as const) {
      expect(m.kind).toBe('merge');
      expect(m.arrow).toBe(true);
      expect(m.points).toHaveLength(3);
      expect(m.points[0]).toEqual({ x: cx(box), y: bottom(box) });
      expect(m.points[2].x).toBe(spine); // arrives on the spine…
      expect(m.points[1].x).toBeGreaterThan(spine); // …from the right (left-pointing arrowhead)
      expect(m.points[2].y).toBeGreaterThan(bottom(box));
    }
    expect(mi.points[2].y).toBeGreaterThan(ms.points[2].y); // staggered: the farther column merges lower
    // « // x= y » continues down the spine (no arrowhead into the junction).
    const down = mergeOf(egal);
    expect(down.arrow).toBe(false);
    expect(down.points.every((p) => p.x === spine)).toBe(true);
  });

  it('loops back on the left above the first loop box, with the « Boucle infinie » tag on the return line', () => {
    const first = byText(d, 'Les Leds sont éteintes');
    const init = nodeById(d, 'init');
    const end = nodeById(d, 'end');
    const loop = d.edges.find((e) => e.kind === 'loop')!;
    const [p0, p1, p2, p3] = loop.points;
    expect(loop.points).toHaveLength(4);
    expect(loop.arrow).toBe(true);
    const spine = cx(first);
    // Leaves the spine below the last merge and above Fin…
    const lastMerge = Math.max(...d.edges.filter((e) => e.kind === 'merge').map((e) => e.points[2].y));
    expect(p0.x).toBe(spine);
    expect(p0.y).toBeGreaterThan(lastMerge);
    expect(p0.y).toBeLessThan(end.box.y);
    // …goes left of every loop shape, up, and right back into the spine above the first loop box.
    const loopShapes = visible(d).filter((n) => n.box.y > bottom(init) && n.shape !== 'tag' && n.shape !== 'end');
    expect(p1.x).toBeLessThan(Math.min(...loopShapes.map((n) => n.box.x)));
    expect(p2.x).toBe(p1.x);
    expect(p3.x).toBe(spine);
    expect(p3.y).toBeLessThan(first.box.y);
    expect(p3.y).toBeGreaterThan(bottom(init));
    // The tag's tip touches the vertical return line, between its ends.
    const tag = visible(d).find((n) => n.shape === 'tag')!;
    expect(tag.box.x + tag.box.w).toBe(p1.x);
    expect(cy(tag)).toBeGreaterThan(p2.y);
    expect(cy(tag)).toBeLessThan(p1.y);
    // Fin is still drawn after the infinite loop.
    const intoEnd = d.edges.find((e) => e.to === end.id)!;
    expect(intoEnd.from).toBe(loop.from);
    expect(intoEnd.arrow).toBe(true);
  });

  it('links every node with the program statements it stands for', () => {
    expect(nodeById(d, 'init').refs).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
    expect(byText(d, 'Les Leds sont éteintes').refs).toEqual(['s7', 's8', 's9', 's10']);
    expect(byText(d, 'ZERO==1').refs).toEqual(['s11', 'b1']);
    expect(byText(d, 'CARRY==1').refs).toEqual(['s11', 'b2']);
    expect(byText(d, '// x= y').refs).toEqual(['b1', 's12']);
    expect(byText(d, '// x<y').refs).toEqual(['b3', 's14']);
  });
});

describe('TP STATUS terminals', () => {
  it('prof: hollow circle « Début » and bullseye « Fin », the words written to the right', () => {
    const d = layout(program);
    const start = nodeById(d, 'start');
    const end = nodeById(d, 'end');
    expect(start.box.w).toBe(9);
    expect(end.box.w).toBe(16);
    expect(start.lines).toEqual([]);
    expect(start.label?.text).toBe('Début');
    expect(start.label!.box.x).toBeGreaterThan(start.box.x + start.box.w);
    expect(end.label?.text).toBe('Fin');
    expect(end.label!.box.x).toBeGreaterThan(end.box.x + end.box.w);
  });

  it('bw: rounded terminals with the word inside', () => {
    const d = layout(program, { style: 'bw' });
    expect(nodeById(d, 'start').lines).toEqual([{ text: 'Début' }]);
    expect(nodeById(d, 'start').label).toBeUndefined();
    expect(nodeById(d, 'end').lines).toEqual([{ text: 'Fin' }]);
  });

  it('generic wording gives her « Organigramme général » lines', () => {
    const d = layout(program, { wording: 'generic' });
    expect(texts(nodeById(d, 'config'))).toEqual(['CONFIGURATION', 'Configurer les sorties.', 'Déclaration des variables']);
    expect(texts(nodeById(d, 'init'))).toEqual(['INITIALISATION', 'x=5 et y=6', 'Initialiser les sorties', 'STATUS=0']);
  });
});
