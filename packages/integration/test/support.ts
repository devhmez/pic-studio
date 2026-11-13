/// <reference types="node" />
// Shared helpers of the end-to-end scenarios: template schematic + compiled prof program + live simulation.
import { readFileSync } from 'node:fs';
import { ledFrame, parseSchematicJson, SimSession, type ComponentVisual, type Schematic } from '@pic/circuit';
import { compile, decodeSource, type CompileResult } from '@pic/compiler';

const REPO = new URL('../../../', import.meta.url);

/** The UI worker's slice length: 10 ms of simulated time. */
export const SLICE_S = 0.01;

export function template(name: string): Schematic {
  return parseSchematicJson(readFileSync(new URL(`templates/${name}.schematic.json`, REPO), 'utf8'));
}

/** Raw bytes of a C file of packages/compiler/test/fixtures (CP1252 + CRLF, like the prof's files). */
export function fixture(name: string): Uint8Array {
  return readFileSync(new URL(`packages/compiler/test/fixtures/${name}`, REPO));
}

export function fixtureText(name: string): string {
  return decodeSource(fixture(name));
}

export function compileOk(source: string | Uint8Array, clockHz: number): CompileResult {
  const r = compile(source, { clockHz });
  if (!r.ok || !r.program) {
    const lines = r.diagnostics.map((d) => `${d.line}:${d.col} ${d.code} ${d.message}`);
    throw new Error(`compilation échouée :\n${lines.join('\n')}`);
  }
  return r;
}

export interface Tp {
  session: SimSession;
  compiled: CompileResult;
  schematic: Schematic;
}

/** Compile `source` for the template's clock and start it inside the template's circuit (power-on). */
export function startTp(templateName: string, source: string | Uint8Array): Tp {
  const schematic = template(templateName);
  const compiled = compileOk(source, schematic.clockHz);
  const session = new SimSession(schematic, compiled.program!, schematic.clockHz, { config: compiled.config });
  return { session, compiled, schematic };
}

/** Run in worker-sized slices until the simulated clock reaches `t` seconds. */
export function runUntil(session: SimSession, t: number): void {
  while (session.time < t - 1e-9) {
    const r = session.runFor(Math.min(SLICE_S, t - session.time));
    if (r.cycles === 0 && r.breakpoint === null) break; // less than one instruction cycle left
  }
}

export function runFor(session: SimSession, seconds: number): void {
  runUntil(session, session.time + seconds);
}

function visualOf<K extends ComponentVisual['kind']>(session: SimSession, id: string, kind: K): Extract<ComponentVisual, { kind: K }> {
  const v = session.circuit.visual(id);
  if (v.kind !== kind) throw new Error(`${id} : visuel ${v.kind}, ${kind} attendu`);
  return v as Extract<ComponentVisual, { kind: K }>;
}

/** What ISIS draws: an LED counts as lit from the first of its 7 brightness frames on (duty-cycle averaged). */
export function ledShown(session: SimSession, id: string): boolean {
  return ledFrame(visualOf(session, id, 'LED').brightness) > 0;
}

export function ledBrightness(session: SimSession, id: string): number {
  return visualOf(session, id, 'LED').brightness;
}

/** Ids of the LEDs drawn lit, among `ids`. */
export function shownLeds(session: SimSession, ids: readonly string[]): string[] {
  return ids.filter((id) => ledShown(session, id));
}

export function sevenSeg(session: SimSession, id: string): number | null {
  return visualOf(session, id, '7SEG-BCD').value;
}

/** Traffic lights as 'R--', '-A-', '--G' (lit lamps). */
export function lamps(session: SimSession, id: string): string {
  const v = visualOf(session, id, 'TRAFFIC_LIGHTS');
  return `${v.red ? 'R' : '-'}${v.amber ? 'A' : '-'}${v.green ? 'G' : '-'}`;
}
