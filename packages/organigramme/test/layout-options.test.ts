// Layout choices for the constructs she never drew (research 06 §7, 00 §4.5 and C4), and their options.
import { describe, expect, it } from 'vitest';
import { layout, layoutFunction, METRICS, renderSvg, type Diagram, type DiagramEdge, type DiagramNode } from '../src';
import { allProblems, visible } from './geometry';
import { EXTRA_PROGRAMS, loadTemplate, TEMPLATE_IDS } from './support';

const texts = (n: DiagramNode) => n.lines.map((l) => l.text);
const node = (d: Diagram, first: string): DiagramNode => {
  const n = visible(d).find((x) => x.lines[0]?.text === first);
  if (!n) throw new Error(`no node « ${first} »`);
  return n;
};
const exits = (d: Diagram, n: DiagramNode): Record<string, DiagramEdge> =>
  Object.fromEntries(d.edges.filter((e) => e.from === n.id && e.label).map((e) => [e.label!.text, e]));

describe('busy waits', () => {
  it('hold the condition that ends the wait: `oui` continues down, `non` loops back on the right', () => {
    const d = layout(loadTemplate('tp-vote'));
    const wait = node(d, 'VOTE_A==0');
    const { oui, non } = exits(d, wait);
    const cx = wait.box.x + wait.box.w / 2;
    expect(oui.points[0]).toEqual({ x: cx, y: wait.box.y + wait.box.h });
    expect(oui.points[1].x).toBe(cx);
    expect(non.kind).toBe('loop');
    expect(non.points[0]).toEqual({ x: wait.box.x + wait.box.w, y: wait.box.y + wait.box.h / 2 });
    // Back above the diamond, on the spine.
    expect(non.points.at(-1)).toEqual({ x: cx, y: wait.box.y - METRICS.loopEntry });
    // pupitre: « DEMARRER==1 » to start, « DEMARRER==0 » before the next game.
    const p = layout(loadTemplate('tp-pupitre'));
    expect(visible(p).filter((n) => n.shape === 'decision').map((n) => texts(n)[0])).toEqual([
      'DEMARRER==1', 'essais>0 et reussi==0', 'VALIDER==1', 'REPONSES==REPONSE_CORRECTE', 'VALIDER==0', 'reussi==0', 'DEMARRER==0',
    ]);
  });

  it("option waits: 'loop' writes the C loop condition, `oui` looping back", () => {
    const d = layout(loadTemplate('tp-vote'), { waits: 'loop' });
    const wait = visible(d).filter((n) => n.lines[0]?.text === 'VOTE_A==1')[1];
    expect(exits(d, wait).oui.kind).toBe('loop');
    expect(allProblems(d)).toEqual([]);
  });
});

describe('repetitions', () => {
  it('are one action box by default, merged with the statements around them', () => {
    const p = loadTemplate('tp-vote');
    const d = layout(p);
    const box = node(d, '// var1= var2');
    expect(texts(box)).toEqual(['// var1= var2', "Afficher la lettre 'E'", 'Led verte clignote 3 fois (0,5 s / 0,5 s)']);
    expect(visible(d).some((n) => texts(n).includes('i<3'))).toBe(false);
    // The box stands for the loop body too (the paused line inside the loop highlights it).
    const chain = p.loop![2].kind === 'if' ? p.loop![2].branches[0].body[1] : null;
    const repeat = chain?.kind === 'if' ? chain.branches[0].body[1] : null;
    expect(repeat?.kind).toBe('repeat');
    if (repeat?.kind !== 'repeat') return;
    expect(box.refs).toEqual(expect.arrayContaining([repeat.id, ...repeat.body.map((s) => s.id)]));
  });

  it('traffic: one box per step, the countdowns said in words, about half the old height', () => {
    const d = layout(loadTemplate('tp-traffic'));
    expect(texts(node(d, 'Feu orange allumé'))).toEqual([
      'Feu orange allumé', 'Les autres feux sont éteints', "Décompte de 2 à 0 sur l'afficheur (1 s par chiffre)",
    ]);
    expect(d.height).toBeLessThan(700);
    expect(JSON.stringify(d)).not.toMatch(/compte=compte|9-compte/);
  });

  it("option counters: 'loop' draws the explicit counter loop (init, test, update)", () => {
    const d = layout(loadTemplate('tp-traffic'), { counters: 'loop' });
    expect(visible(d).filter((n) => texts(n)[0] === 'compte<10')).toHaveLength(2);
    expect(visible(d).some((n) => texts(n).includes('compte=compte+1'))).toBe(true);
    expect(allProblems(d)).toEqual([]);
  });
});

describe('long if / else-if chains', () => {
  it('demux (4 columns) stacks its tests down the right side and stays much narrower', () => {
    const d = layout(loadTemplate('tp1-demux'));
    const tests = visible(d).filter((n) => n.shape === 'decision');
    expect(tests).toHaveLength(3);
    for (let k = 1; k < tests.length; k++) {
      // Each test is lower than the previous one's branch box and one step to the right.
      const prevBranch = node(d, `Led D${k - 1} allumée`);
      expect(tests[k].box.y).toBeGreaterThan(prevBranch.box.y + prevBranch.box.h);
      expect(tests[k].box.x + tests[k].box.w / 2).toBeGreaterThan(tests[k - 1].box.x + tests[k - 1].box.w / 2);
    }
    expect(d.width).toBeLessThan(800);
    expect(allProblems(d)).toEqual([]);
  });

  it('her 3-column STATUS chain keeps the diagonal cascade of slide 6', () => {
    const d = layout(loadTemplate('tp-status'));
    const carry = node(d, 'CARRY==1');
    const egal = node(d, '// x= y');
    expect(carry.box.y).toBeLessThan(egal.box.y + egal.box.h);
  });
});

describe('loops and arrowheads', () => {
  it('a while loop exit turns down into the spine with no arrowhead (nothing merges there)', () => {
    const d = layout(loadTemplate('tp-pupitre'));
    const loop = node(d, 'essais>0 et reussi==0');
    const non = exits(d, loop).non;
    expect(non.arrow).toBe(false);
    const last = non.points.at(-1)!;
    const next = d.edges.find((e) => e.from === non.to)!;
    expect(next.points[0]).toEqual(last);
    expect(next.points[1].y).toBeGreaterThan(last.y);
  });

  it('keeps stacked arrowheads on the spine at least mergeStagger apart', () => {
    for (const id of TEMPLATE_IDS) {
      const d = layout(loadTemplate(id));
      const spine = visible(d).find((n) => n.shape === 'start')!;
      const x = spine.box.x + spine.box.w / 2;
      const tips = d.edges.filter((e) => e.arrow && e.points.at(-1)!.x === x && e.points.at(-2)!.y === e.points.at(-1)!.y)
        .map((e) => e.points.at(-1)!.y).sort((a, b) => a - b);
      for (let k = 1; k < tips.length; k++) expect(tips[k] - tips[k - 1], `${id} at y=${tips[k]}`).toBeGreaterThanOrEqual(METRICS.mergeStagger);
    }
  });

  it('arrowheads end exactly on their target (marker centred on the shortened line end)', () => {
    const svg = renderSvg(layout(loadTemplate('tp-status')));
    expect(svg).toContain(`refX="${METRICS.arrowLength / 2}"`);
  });

  it('every option combination still satisfies the layout invariants', () => {
    for (const id of TEMPLATE_IDS) {
      const p = loadTemplate(id);
      for (const options of [{ counters: 'loop' as const }, { waits: 'loop' as const }, { counters: 'loop' as const, waits: 'loop' as const, style: 'bw' as const }]) {
        expect(allProblems(layout(p, options)), `${id} ${JSON.stringify(options)}`).toEqual([]);
        for (const f of p.functions) expect(allProblems(layoutFunction(p, f, options))).toEqual([]);
      }
    }
    for (const [name, p] of Object.entries(EXTRA_PROGRAMS)) {
      expect(allProblems(layout(p, { counters: 'loop', waits: 'loop' })), name).toEqual([]);
    }
  });
});

describe('interrupt charts', () => {
  it('say what happens in French: colour LEDs, one line for the RB4..RB7 copy', () => {
    const p5 = loadTemplate('tp5-int-rb0');
    expect(visible(layout(p5)).some((n) => texts(n).includes('Led verte clignote (0,5 s / 0,5 s)'))).toBe(true);
    expect(visible(layoutFunction(p5, p5.functions[0])).some((n) => texts(n).includes('Led rouge inversée'))).toBe(true);
    const p6 = loadTemplate('tp6-rbie');
    const isr = visible(layoutFunction(p6, p6.functions[0]));
    expect(isr.some((n) => texts(n).includes('Recopier RB4 à RB7 sur RA0 à RA3'))).toBe(true);
    expect(JSON.stringify(isr)).not.toMatch(/LED0= INTER4/);
  });
});
