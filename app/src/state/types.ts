// Contract of the app store (implemented in ./store.ts with zustand). Panels read state through
// `useApp(selector)` and call the actions; they never talk to the simulation worker directly.
import type { Schematic, SessionSnapshot, Interaction } from '@pic/circuit';
import type { CompileResultEx } from '@pic/compiler';

export type PanelId = 'schema' | 'code' | 'asm' | 'organigramme';
export type OrganigrammeStyle = 'prof' | 'bw';
export type SimStatus = 'stopped' | 'running' | 'paused';

/** Everything saved in a project file (.picproj JSON). */
export interface Project {
  name: string;
  schematic: Schematic;
  /** C source as edited in the app (exported to MikroC as CP1252 + CRLF). */
  source: string;
  /** PIC oscillator in Hz; shared by Delay_ms code generation and the simulation. */
  clockHz: number;
  /** Configuration word (default 0x3FFB: RC osc, WDT off). */
  config: number;
  /**
   * Program model built with the assistant (from @pic/program-model), or null when the code is hand-written.
   * Typed as unknown here so the store does not depend on the model package's internals.
   */
  program: unknown | null;
  /** 'generated' while the source is exactly what the assistant produced; becomes 'manual' on the first hand edit. */
  sourceOrigin: 'generated' | 'manual';
  organigrammeStyle: OrganigrammeStyle;
  /** Template the project was created from, if any (e.g. 'tp-status'). */
  templateId?: string;
}

/** Register-level view of the core for the Assembleur / registres panel (sent by the worker when paused or ~10×/s while running). */
export interface DebugSnapshot {
  pc: number;
  w: number;
  status: number;
  /** 256 bank-mapped file registers (index = address 0x00–0xFF). */
  file: number[];
  /** Hardware stack, bottom..top. */
  stack: number[];
  eeprom: number[];
  cycles: number;
  /** Simulated seconds. */
  time: number;
  sleeping: boolean;
  halted: boolean;
  /** True when the last step was the forced interrupt-entry cycle (PC just jumped to 0004h). */
  interruptEntry: boolean;
}

export interface SimState {
  status: SimStatus;
  /** Latest visuals (LEDs, 7-seg, pin levels) for the schematic. */
  snapshot: SessionSnapshot | null;
  debug: DebugSnapshot | null;
  /** Measured simulated-time / wall-time ratio while running (1 = real time). */
  realtimeRatio: number;
  /** Requested speed multiplier (1 = real time, 0.1 = slow motion). */
  speed: number;
  /**
   * Program-memory addresses with a breakpoint, numbered like the last build that compiled (compile.result when it
   * is ok). While the simulator still runs an older program, the store translates them for the worker.
   */
  breakpoints: number[];
  error: string | null;
  /**
   * Build the simulator is running (null while stopped). It differs from compile.result while the student has
   * edited the code and the new program is not reloaded yet: the PC, the stack and the RAM refer to this build.
   */
  loadedBuild: CompileResultEx | null;
}

export interface AppState {
  project: Project;
  /** Path or file handle name the project was last saved to (null = never saved). */
  fileName: string | null;
  dirty: boolean;

  compile: { result: CompileResultEx | null; stale: boolean };
  sim: SimState;

  ui: {
    focusedPanel: PanelId;
    /** Panel shown maximized, or null for the 4-panel grid. */
    maximized: PanelId | null;
    assistantOpen: boolean;
    /** « Comprendre » drawer (French explanations). Only one drawer is open at a time. */
    learnOpen: boolean;
    /** « Copilote » drawer (French chat that builds the project). */
    copilotOpen: boolean;
    templatePickerOpen: boolean;
    /** Component selected in the schematic (id), shared so the code/organigramme can highlight related lines. */
    selectedComponentId: string | null;
    theme: 'light' | 'dark' | 'system';
  };
}

export interface AppActions {
  // project
  newProject(): void;
  loadProject(project: Project, fileName?: string | null): void;
  loadTemplate(templateId: string): Promise<void>;
  setSchematic(update: Schematic | ((prev: Schematic) => Schematic)): void;
  /** Hand edit of the C source (marks sourceOrigin 'manual'). */
  setSource(source: string): void;
  /** Set the assistant program model; regenerates the source in the prof's style and marks sourceOrigin 'generated'. */
  setProgram(program: unknown, generatedSource: string): void;
  setClock(hz: number): void;
  setOrganigrammeStyle(style: OrganigrammeStyle): void;
  renameProject(name: string): void;
  markSaved(fileName: string): void;

  // build
  /** Compile project.source with project.clockHz/config; returns the result and stores it. */
  build(): CompileResultEx;

  // simulation (builds first if the compile result is stale)
  run(): void;
  pause(): void;
  stop(): void;
  /** One instruction. */
  stepInstruction(): void;
  /** Until the next C source line (uses addrToLine). */
  stepLine(): void;
  reset(): void;
  setSpeed(multiplier: number): void;
  toggleBreakpoint(addr: number): void;
  interact(componentId: string, action: Interaction): void;

  // ui
  focusPanel(panel: PanelId): void;
  toggleMaximize(panel: PanelId): void;
  setAssistantOpen(open: boolean): void;
  setTemplatePickerOpen(open: boolean): void;
  setLearnOpen(open: boolean): void;
  setCopilotOpen(open: boolean): void;
  selectComponent(id: string | null): void;
  setTheme(theme: AppState['ui']['theme']): void;
}

export type AppStore = AppState & AppActions;
