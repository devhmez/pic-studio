/// <reference types="node" />
// Loads the TP templates from /templates (index.json + <id>.program.json) for the organigramme tests.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { blocks as b, emptyProgram, ensureIds, parseProgramJson, type Program } from '@pic/program-model';

export interface TemplateEntry {
  id: string;
  title: string;
  chapter: number;
  program: string;
}

export const templatePath = (file: string): string =>
  fileURLToPath(new URL(`../../../templates/${file}`, import.meta.url));

export const TEMPLATE_INDEX: readonly TemplateEntry[] = JSON.parse(readFileSync(templatePath('index.json'), 'utf8'));

export function loadTemplate(id: string): Program {
  const entry = TEMPLATE_INDEX.find((t) => t.id === id);
  if (!entry) throw new Error(`unknown template ${id}`);
  return parseProgramJson(readFileSync(templatePath(entry.program), 'utf8'));
}

export const TEMPLATE_IDS: readonly string[] = TEMPLATE_INDEX.map((t) => t.id);

// ---------------------------------------------------------------------------------------------------------------
// Programs exercising constructs the templates do not use (empty bodies, deep cascades, loops in every column,
// busy waits at block edges, calls, long compound conditions). Keys are file-name friendly.

const TEST_SIGNALS: Program['signals'] = [
  { id: 'btn', name: 'BTN', pin: 'RA0', dir: 'in', label: 'Bouton', activeLevel: 1, device: 'button' },
  { id: 'sw', name: 'SW', pin: 'RA1', dir: 'in', label: 'Interrupteur', activeLevel: 1, device: 'logicstate' },
  { id: 'led', name: 'LED', pin: 'RB0', dir: 'out', label: 'Led rouge', activeLevel: 1, device: 'led' },
  { id: 'led2', name: 'LED2', pin: 'RB1', dir: 'out', label: 'Led verte', activeLevel: 1, device: 'led' },
];

function testProgram(build: (p: Program) => void): Program {
  const p = emptyProgram('Essai');
  p.signals = TEST_SIGNALS.map((s) => ({ ...s }));
  p.variables = [{ name: 'i', type: 'unsigned char' }, { name: 'n', type: 'unsigned char' }];
  build(p);
  return ensureIds(p);
}

export const EXTRA_PROGRAMS: Readonly<Record<string, Program>> = {
  'empty-program': emptyProgram(),
  'no-loop-no-init': (() => { const p = emptyProgram(); p.loop = null; return p; })(),
  'if-without-else-empty-bodies': testProgram((p) => {
    p.loop = [b.when(b.pin('btn'), []), b.ifChain([b.branch(b.pin('sw'), [])], b.otherwise([b.on('led')]))];
  }),
  'deep-chain-nested-loops': testProgram((p) => {
    p.loop = [b.ifChain([
      b.branch(b.pin('btn'), [b.repeat(3, 'i', [b.on('led'), b.delay(100), b.off('led'), b.delay(100)])], { note: 'premier' }),
      b.branch(b.pin('sw'), [b.whileLoop(b.cmp(b.v('n'), '<', b.num(10)), [b.incr('n'), b.waitFor(b.pin('btn', 0))])]),
      b.branch(b.and(b.pin('btn', 0), b.pin('sw', 0)), [b.waitFor(b.pin('sw'))]),
    ], b.otherwise([b.when(b.pin('btn'), [b.on('led2')], [b.off('led2')])], { note: 'sinon' }))];
  }),
  'waits-calls-comments': testProgram((p) => {
    p.init = [b.waitFor(b.pin('btn')), b.off('led'), b.call('clignoter')];
    p.loop = [b.waitFor(b.pin('btn')), b.call('clignoter'), b.comment('rien'), b.waitFor(b.pin('btn', 0))];
    p.functions = [b.fn('clignoter', [b.toggle('led'), b.delay(250)]), b.fn('vide', [])];
  }),
  'for-with-while-long-conditions': testProgram((p) => {
    p.loop = [b.forLoop(b.assign(b.v('i'), 9), b.cmp(b.v('i'), '>', b.num(0)), b.decr('i'), [
      b.whileLoop(b.and(b.cmp(b.v('n'), '!=', b.v('i')), b.pin('btn'), b.pin('sw', 0), b.cmp(b.v('i'), '>=', b.num(2))), []),
      b.raw('asm nop;'),
    ])];
  }),
};
