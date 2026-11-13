// Messages between the UI thread and the simulation Web Worker (./worker.ts). The worker owns one SimSession.
import type { Schematic, SessionSnapshot, Interaction } from '@pic/circuit';
import type { DebugSnapshot } from '../state/types';

export type ToWorker =
  | { type: 'load'; schematic: Schematic; program: Uint16Array; clockHz: number; config: number; eeprom?: Uint8Array }
  /** Start real-time pacing at `speed` × real time; the worker posts snapshots ~30×/s and debug ~10×/s. */
  | { type: 'run'; speed: number }
  | { type: 'pause' }
  | { type: 'setSpeed'; speed: number }
  | { type: 'stepInstruction' }
  /** Run until the PC reaches an address whose source line differs from the current one (addrToLine as [addr, line] pairs). */
  | { type: 'stepLine'; addrToLine: [number, number][] }
  | { type: 'reset' }
  | { type: 'interact'; componentId: string; action: Interaction }
  | { type: 'setBreakpoints'; addrs: number[] }
  /** Replace the circuit while keeping the program (schematic edited during a pause). */
  | { type: 'updateSchematic'; schematic: Schematic };

export type FromWorker =
  | { type: 'snapshot'; snapshot: SessionSnapshot; debug: DebugSnapshot | null; running: boolean; realtimeRatio: number }
  | { type: 'breakpoint'; pc: number }
  | { type: 'error'; message: string };
