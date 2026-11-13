// Test helper (imported by *.test.ts only): the course templates compiled, with their program model and circuit.
import { readFileSync } from 'node:fs';
import { parseSchematicJson, type Schematic } from '@pic/circuit';
import { compile, type CompileResultEx } from '@pic/compiler';
import { parseProgramJson, type Program } from '@pic/program-model';

const REPO = new URL('../../../../', import.meta.url);
const read = (f: string) => readFileSync(new URL(`templates/${f}`, REPO), 'utf8');

export const TEMPLATE_IDS = [
  'tp0-exemple1', 'tp0-exemple2', 'tp1-demux', 'tp-status', 'tp-vote', 'tp-traffic', 'tp-pupitre',
  'tp4-inte', 'ch5-manip-rb0', 'tp-traffic-int', 'tp5-int-rb0', 'ch6-exo-rbie', 'tp6-rbie',
] as const;

export interface LoadedTemplate {
  id: string;
  source: string;
  clockHz: number;
  build: CompileResultEx;
  program: Program;
  schematic: Schematic;
}

export function loadTemplate(id: string): LoadedTemplate {
  const index = JSON.parse(read('index.json')) as { id: string; clockHz: number }[];
  const clockHz = index.find((t) => t.id === id)?.clockHz ?? 1_000_000;
  const source = read(`${id}.c`);
  const build = compile(source, { clockHz });
  if (!build.ok) throw new Error(`${id} ne compile pas : ${build.diagnostics.map((d) => d.message).join(' ; ')}`);
  return { id, source, clockHz, build, program: parseProgramJson(read(`${id}.program.json`)), schematic: parseSchematicJson(read(`${id}.schematic.json`)) };
}

/** 1-based line of the first source line containing `text`. */
export function lineOf(source: string, text: string, from = 1): number {
  const lines = source.split(/\r\n?|\n/);
  for (let i = from - 1; i < lines.length; i++) if (lines[i].includes(text)) return i + 1;
  throw new Error(`ligne introuvable : ${text}`);
}
