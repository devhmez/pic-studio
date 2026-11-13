// What every « Comprendre » tab needs about the current project, derived once per (schematic, program, build):
// the build the simulator runs, the program model (the assistant's, or rebuilt from the C code), the circuit
// topology and the names of pins and parts.
import type { Schematic } from '@pic/circuit';
import type { CompileResultEx } from '@pic/compiler';
import { fromAstDetailed, type PinName, type Program } from '@pic/program-model';
import { useMemo } from 'react';
import { asProgram } from '../assistant/model';
import { selectShownBuild } from '../debug/running';
import { useApp } from '../state/store';
import type { Project } from '../state/types';
import {
  inputSourceOf, namingFromSymbols, partTitle, pinInfoLookup, pinLabelLookup, Topology,
  type Naming, type PinInfo,
} from './explain';

export interface LearnContext {
  /** Build whose listing / addresses match the simulator (the running one while simulating). */
  build: CompileResultEx | null;
  program: Program | null;
  /** Where the program model comes from. */
  programOrigin: 'assistant' | 'code' | null;
  schematic: Schematic;
  topo: Topology;
  clockHz: number;
  naming: Naming;
  pinLabel(pin: PinName): string | undefined;
  pinInfo(pin: PinName): PinInfo | undefined;
  inputSource(pin: PinName): string | undefined;
  partName(componentId: string): string;
}

const derivedPrograms = new WeakMap<CompileResultEx, Program | null>();

/** Program model rebuilt from the compiled C (hand-written code), cached per build. */
export function programFromBuild(build: CompileResultEx | null, title: string, clockHz: number): Program | null {
  if (!build?.ast) return null;
  if (derivedPrograms.has(build)) return derivedPrograms.get(build) ?? null;
  let program: Program | null = null;
  try {
    program = fromAstDetailed(build.ast, build.source, { title, clockHz }).program;
  } catch {
    program = null;
  }
  derivedPrograms.set(build, program);
  return program;
}

export function makeLearnContext(project: Project, build: CompileResultEx | null): LearnContext {
  const assistant = asProgram(project.program);
  const program = assistant ?? programFromBuild(build, project.name, project.clockHz);
  const topo = new Topology(project.schematic);
  const byId = new Map(project.schematic.components.map((c) => [c.id, c]));
  return {
    build,
    program,
    programOrigin: assistant ? 'assistant' : program ? 'code' : null,
    schematic: project.schematic,
    topo,
    clockHz: project.clockHz,
    naming: namingFromSymbols(build?.symbols),
    pinLabel: pinLabelLookup(program, topo),
    pinInfo: pinInfoLookup(program, topo),
    inputSource: (pin) => inputSourceOf(topo, pin),
    partName: (id) => {
      const c = byId.get(id);
      return c ? partTitle(c, topo) : id;
    },
  };
}

/** The learn context of the project shown in the app (recomputed when the project or the build changes). */
export function useLearnContext(): LearnContext {
  const project = useApp((s) => s.project);
  const build = useApp(selectShownBuild);
  const fallback = useApp((s) => s.compile.result);
  const shown = build ?? fallback;
  return useMemo(() => makeLearnContext(project, shown), [project.schematic, project.program, project.clockHz, project.name, shown]); // eslint-disable-line react-hooks/exhaustive-deps
}
