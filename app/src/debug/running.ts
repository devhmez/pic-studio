// What the simulated core is executing, as the panels must show it. While the student edits the code during a
// simulation, compile.result is the new build but the core still runs the loaded one (sim.loadedBuild): the PC,
// the stack and the RAM addresses refer to the loaded build, and its C line must be mapped onto the edited text.
import type { CompileResultEx } from '@pic/compiler';
import { mapLine } from '../state/builds';
import type { AppState } from '../state/types';
import { execLineFor } from './listing';

/** Build whose listing, symbols and addresses match the core: the loaded one while simulating, else compile.result. */
export function selectShownBuild(s: AppState): CompileResultEx | null {
  return s.sim.status !== 'stopped' && s.sim.loadedBuild ? s.sim.loadedBuild : s.compile.result;
}

/** True while the panels show the running program instead of the current build (the code was edited). */
export function selectShowingRunningProgram(s: AppState): boolean {
  return s.sim.status !== 'stopped' && s.sim.loadedBuild !== null && s.sim.loadedBuild !== s.compile.result;
}

/**
 * C line the paused core is on, numbered like compile.result (the text in the editor), or null while running,
 * stopped, or when that statement no longer exists in the edited code.
 */
export function selectPausedLine(s: AppState): number | null {
  const { status, debug } = s.sim;
  const current = s.compile.result;
  const running = selectShownBuild(s);
  if (status !== 'paused' || !debug || !running?.ok || !current?.ok) return null;
  const line = execLineFor(debug.pc, debug.stack, running.addrToLine);
  return running === current ? line : mapLine(line, running, current);
}
