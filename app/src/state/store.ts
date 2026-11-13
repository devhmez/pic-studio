// The app store (contract: ./types.ts). Panels read it with `useApp(selector)` and call its actions; non-React code
// uses `getApp()` / `appStore`. The store owns:
//  - the project (autosaved to localStorage, restored on start; first launch opens the 'tp-status' template),
//  - the compile result (built synchronously with @pic/compiler; marked stale when the source or the clock changes),
//  - the simulation state, fed by the Web Worker through a SimDriver (see ../sim/client.ts).
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { compile, type CompileResultEx } from '@pic/compiler';
import { validateSchematic, type ComponentInstance, type Schematic } from '@pic/circuit';
import type { FromWorker, ToWorker } from '../sim/protocol';
import { remapAddresses, sameProgram } from './builds';
import type { AppState, AppStore, OrganigrammeStyle, PanelId, Project, SimState } from './types';

// ------------------------------------------------------------------------------------------------ constants

/** Configuration word of the prof's ISIS files: RC oscillator, WDT off, PWRT off, CP off. */
export const DEFAULT_CONFIG = 0x3ffb;
export const DEFAULT_CLOCK_HZ = 1_000_000;
/** Template opened on first launch. */
export const FIRST_TEMPLATE_ID = 'tp-status';
/** Source used when a template ships no C file. */
export const MINIMAL_SOURCE = 'void main() {\n}\n';
export const PROJECT_STORAGE_KEY = 'pic-studio.project.v1';
export const PREFS_STORAGE_KEY = 'pic-studio.prefs.v1';
/** Speed multiplier meaning "as fast as possible". */
export const SPEED_MAX = Number.POSITIVE_INFINITY;

// ------------------------------------------------------------------------------------------------ templates

export interface TemplateEntry {
  id: string;
  title: string;
  /** Course chapter ("Chapitre 3"...), when known. */
  chapter: string | null;
  description: string;
  clockHz: number;
  schematic: Schematic;
  /** Parsed .program.json (assistant program model), or null. */
  program: unknown | null;
  /** C source (LF line endings). */
  source: string;
}

/** Raw template files, keyed by file name (e.g. 'tp-status.schematic.json'). */
export interface TemplateFiles {
  /** Parsed templates/index.json, or undefined when the file does not exist. */
  index?: unknown;
  schematics: Readonly<Record<string, unknown>>;
  programs: Readonly<Record<string, unknown>>;
  sources: Readonly<Record<string, string>>;
}

/** Display order of the course templates when the catalog is derived from the files. */
const KNOWN_ORDER = [
  'tp0-exemple1', 'tp0-exemple2', 'tp1-demux', 'tp-status', 'tp-vote', 'tp-traffic', 'tp-pupitre', 'tp5-int-rb0', 'tp6-rbie',
];
const KNOWN_CHAPTERS: Readonly<Record<string, string>> = {
  'tp0-exemple1': 'Chapitre 1', 'tp0-exemple2': 'Chapitre 1', 'tp1-demux': 'Chapitre 2',
  'tp-status': 'Chapitre 3', 'tp-vote': 'Chapitre 3', 'tp-traffic': 'Chapitre 4', 'tp-pupitre': 'Chapitre 4',
  'tp5-int-rb0': 'Chapitre 5', 'tp6-rbie': 'Chapitre 6',
};

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const normalizeNewlines = (s: string): string => s.replace(/\r\n?/g, '\n');
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const positive = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

function readSchematic(value: unknown): Schematic | null {
  const { schematic } = validateSchematic(value);
  return schematic;
}

/** Resolve an index field that is either a file name (looked up in `files`) or the inline value itself. */
function resolveRef<T>(ref: unknown, files: Readonly<Record<string, T>>): T | unknown | undefined {
  if (typeof ref === 'string') {
    const hit = files[basename(ref)];
    return hit;
  }
  return ref ?? undefined;
}

function indexEntries(index: unknown): unknown[] {
  if (Array.isArray(index)) return index;
  if (isRecord(index) && Array.isArray(index.templates)) return index.templates;
  return [];
}

function entryFromIndex(raw: unknown, files: TemplateFiles): TemplateEntry | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  if (!id) return null;
  const schematicFile = files.schematics[`${id}.schematic.json`];
  const schematic = readSchematic(resolveRef(raw.schematic, files.schematics) ?? schematicFile);
  if (!schematic) return null;
  // Source: file reference, inline C text, or the conventional <id>.c next to the schematic.
  let source: string | undefined;
  if (typeof raw.source === 'string') {
    source = files.sources[basename(raw.source)] ?? (raw.source.includes('\n') ? raw.source : undefined);
  }
  source ??= files.sources[`${id}.c`];
  const program = raw.program === null ? null : resolveRef(raw.program, files.programs) ?? files.programs[`${id}.program.json`] ?? null;
  const meta = isRecord(schematicFile) ? schematicFile : {};
  const clockHz = positive(raw.clockHz) ?? schematic.clockHz;
  return {
    id,
    title: str(raw.title) ?? str(meta.name) ?? id,
    chapter: typeof raw.chapter === 'number' ? `Chapitre ${raw.chapter}` : str(raw.chapter) ?? KNOWN_CHAPTERS[id] ?? null,
    description: str(raw.description) ?? str(meta.description) ?? '',
    clockHz,
    schematic: { ...schematic, clockHz },
    program: program ?? null,
    source: normalizeNewlines(source ?? MINIMAL_SOURCE),
  };
}

function entryFromSchematicFile(fileName: string, files: TemplateFiles): TemplateEntry | null {
  const id = fileName.replace(/\.schematic\.json$/, '');
  const raw = files.schematics[fileName];
  const schematic = readSchematic(raw);
  if (!schematic) return null;
  const meta = isRecord(raw) ? raw : {};
  return {
    id,
    title: str(meta.name) ?? id,
    chapter: KNOWN_CHAPTERS[id] ?? null,
    description: str(meta.description) ?? '',
    clockHz: schematic.clockHz,
    schematic,
    program: files.programs[`${id}.program.json`] ?? null,
    source: normalizeNewlines(files.sources[`${id}.c`] ?? MINIMAL_SOURCE),
  };
}

const orderOf = (id: string): number => {
  const i = KNOWN_ORDER.indexOf(id);
  return i < 0 ? KNOWN_ORDER.length : i;
};

/**
 * Build the template list. templates/index.json drives it when present; otherwise (or when it yields nothing usable)
 * the list is derived from the *.schematic.json files, each with its matching .c (else a minimal main) and
 * .program.json (else null).
 */
export function buildTemplateCatalog(files: TemplateFiles): TemplateEntry[] {
  const fromIndex = indexEntries(files.index)
    .map((e) => entryFromIndex(e, files))
    .filter((e): e is TemplateEntry => e !== null);
  if (fromIndex.length > 0) return fromIndex;
  return Object.keys(files.schematics)
    .filter((f) => f.endsWith('.schematic.json'))
    .map((f) => entryFromSchematicFile(f, files))
    .filter((e): e is TemplateEntry => e !== null)
    .sort((a, b) => orderOf(a.id) - orderOf(b.id) || a.id.localeCompare(b.id));
}

function byBasename<T>(modules: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [path, value] of Object.entries(modules)) out[basename(path)] = value;
  return out;
}

/** The template files bundled by Vite (repo /templates). Missing files simply give empty maps. */
function bundledTemplateFiles(): TemplateFiles {
  const index = import.meta.glob('../../../templates/index.json', { eager: true, import: 'default' });
  const schematics = import.meta.glob('../../../templates/*.schematic.json', { eager: true, import: 'default' });
  const programs = import.meta.glob('../../../templates/*.program.json', { eager: true, import: 'default' });
  const sources = import.meta.glob<string>('../../../templates/*.c', { eager: true, query: '?raw', import: 'default' });
  return {
    index: Object.values(index)[0],
    schematics: byBasename(schematics),
    programs: byBasename(programs),
    sources: byBasename(sources),
  };
}

let bundledCatalog: TemplateEntry[] | null = null;

/** Templates bundled with the app (TP0, demux, STATUS, vote, traffic, pupitre...), in course order. */
export function listTemplates(): readonly TemplateEntry[] {
  bundledCatalog ??= buildTemplateCatalog(bundledTemplateFiles());
  return bundledCatalog;
}

// ------------------------------------------------------------------------------------------------ projects

/** ISIS CLOCK property text for a frequency: 1MHz, 4MHz, 32.768kHz. */
export function formatClockProp(hz: number): string {
  if (hz >= 1e6) return `${Math.round((hz / 1e6) * 1000) / 1000}MHz`;
  if (hz >= 1e3) return `${Math.round((hz / 1e3) * 1000) / 1000}kHz`;
  return `${hz}Hz`;
}

/** Schematic with its clock (and the PIC CLOCK property) set to `hz`. */
export function withClock(schematic: Schematic, hz: number): Schematic {
  const clock = formatClockProp(hz);
  const needsProp = schematic.components.some((c) => c.kind === 'PIC16F84A' && c.props.clock !== clock);
  if (schematic.clockHz === hz && !needsProp) return schematic;
  return {
    ...schematic,
    clockHz: hz,
    components: needsProp
      ? schematic.components.map((c): ComponentInstance => (c.kind === 'PIC16F84A' && c.props.clock !== clock
        ? { ...c, props: { ...c.props, clock } } : c))
      : schematic.components,
  };
}

function cloneSchematic(s: Schematic): Schematic {
  return {
    clockHz: s.clockHz,
    components: s.components.map((c) => ({ ...c, at: { ...c.at }, props: { ...c.props } })),
    wires: s.wires.map((w) => ({ ...w, points: w.points.map((p) => ({ ...p })) })),
  };
}

export function projectFromTemplate(t: TemplateEntry): Project {
  return {
    name: t.title,
    schematic: withClock(cloneSchematic(t.schematic), t.clockHz),
    source: t.source,
    clockHz: t.clockHz,
    config: DEFAULT_CONFIG,
    program: t.program ?? null,
    sourceOrigin: 'generated',
    organigrammeStyle: 'prof',
    templateId: t.id,
  };
}

/** A new, empty project: one PIC16F84A at the origin and a minimal main(). */
export function blankProject(): Project {
  const pic: ComponentInstance = {
    id: 'U1', kind: 'PIC16F84A', ref: 'U1', value: 'PIC16F84A', at: { x: 0, y: 0 }, rotation: 0,
    props: { clock: formatClockProp(DEFAULT_CLOCK_HZ), cfgword: '0x3FFB' },
  };
  return {
    name: 'Nouveau projet',
    schematic: { clockHz: DEFAULT_CLOCK_HZ, components: [pic], wires: [] },
    source: MINIMAL_SOURCE,
    clockHz: DEFAULT_CLOCK_HZ,
    config: DEFAULT_CONFIG,
    program: null,
    sourceOrigin: 'manual',
    organigrammeStyle: 'prof',
  };
}

const ORGANIGRAMME_STYLES: readonly OrganigrammeStyle[] = ['prof', 'bw'];

/**
 * Check an untrusted project (parsed JSON from a file or localStorage). Returns null when the schematic or the
 * source is unusable; other fields fall back to their defaults.
 */
export function sanitizeProject(value: unknown): Project | null {
  if (!isRecord(value)) return null;
  const schematic = readSchematic(value.schematic);
  if (!schematic || typeof value.source !== 'string') return null;
  const clockHz = positive(value.clockHz) ?? schematic.clockHz;
  const config = typeof value.config === 'number' && Number.isInteger(value.config) ? value.config & 0x3fff : DEFAULT_CONFIG;
  const style = ORGANIGRAMME_STYLES.includes(value.organigrammeStyle as OrganigrammeStyle)
    ? value.organigrammeStyle as OrganigrammeStyle : 'prof';
  const project: Project = {
    name: str(value.name)?.trim() || 'Sans titre',
    schematic: withClock(schematic, clockHz),
    source: normalizeNewlines(value.source),
    clockHz,
    config,
    program: value.program ?? null,
    sourceOrigin: value.sourceOrigin === 'generated' ? 'generated' : 'manual',
    organigrammeStyle: style,
  };
  const templateId = str(value.templateId);
  if (templateId) project.templateId = templateId;
  return project;
}

/** On-disk .picproj content. */
export function serializeProject(project: Project): string {
  return `${JSON.stringify({ format: 'pic-studio-project', version: 1, project }, null, 2)}\n`;
}

/** Parse a .picproj text (or a bare Project JSON). Throws a French message on failure. */
export function parseProjectFile(text: string): Project {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Fichier de projet illisible : JSON invalide.');
  }
  const candidate = isRecord(raw) && isRecord(raw.project) ? raw.project : raw;
  const project = sanitizeProject(candidate);
  if (!project) throw new Error('Ce fichier ne contient pas de projet PIC Studio valide (schéma ou code manquant).');
  return project;
}

// ------------------------------------------------------------------------------------------------ store

/** Minimal key-value storage (localStorage in the app, a Map in tests). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Channel to the simulation worker (../sim/client.ts in the app, a fake in tests). */
export interface SimDriver {
  post(message: ToWorker): void;
}

export interface AppStoreOptions {
  /** Persistence for the autosave and the preferences; null disables both. */
  storage?: KeyValueStorage | null;
  /** Template list; defaults to the bundled templates. */
  templates?: readonly TemplateEntry[];
  /** Autosave debounce in ms (default 800). */
  autosaveDelayMs?: number;
}

/** The zustand store plus the plumbing the app shell wires up (simulation driver, autosave). */
export interface AppStoreApi extends StoreApi<AppStore> {
  /** Attach (or detach with null) the worker channel. */
  attachSim(driver: SimDriver | null): void;
  /** Feed a worker message into the store. */
  receive(message: FromWorker): void;
  /** Write the pending autosave now (page hide, tests). */
  flushAutosave(): void;
  /**
   * True while a simulation runs (or is paused) a program that differs from the current build: the student
   * changed the code (an edit that gives the very same machine code, such as a comment, does not count). The next
   * run or step reloads the program from a power-on reset. Pure function of the state: usable inside selectors.
   */
  isProgramOutdated(state: AppState): boolean;
  /**
   * The build `sim.breakpoints` are numbered in: the last one that compiled (it changes only together with
   * compile.result). Panels showing another build translate through it with remapAddresses().
   */
  breakpointBuild(): CompileResultEx | null;
  /** Template list this store loads from. */
  readonly templates: readonly TemplateEntry[];
}

interface Prefs { theme: AppState['ui']['theme']; speed: number }

const SPEEDS_ALLOWED = (v: unknown): v is number => typeof v === 'number' && (v === SPEED_MAX || (Number.isFinite(v) && v > 0));

function readJson(storage: KeyValueStorage | null, key: string): unknown {
  if (!storage) return undefined;
  try {
    const text = storage.getItem(key);
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(storage: KeyValueStorage | null, key: string, value: unknown): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage blocked: the autosave is a convenience, never an error for the student.
  }
}

function readPrefs(storage: KeyValueStorage | null): Prefs {
  const raw = readJson(storage, PREFS_STORAGE_KEY);
  const prefs: Prefs = { theme: 'system', speed: 1 };
  if (isRecord(raw)) {
    if (raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'system') prefs.theme = raw.theme;
    // JSON has no Infinity: "max" is stored as the string 'max'.
    const speed = raw.speed === 'max' ? SPEED_MAX : raw.speed;
    if (SPEEDS_ALLOWED(speed)) prefs.speed = speed;
  }
  return prefs;
}

/** True when `project` is still exactly what its template opened (nothing the student could lose). */
function isPristineTemplate(project: Project, templates: readonly TemplateEntry[]): boolean {
  const t = project.templateId ? templates.find((x) => x.id === project.templateId) : undefined;
  if (!t) return false;
  const fresh = projectFromTemplate(t);
  return project.source === fresh.source && project.clockHz === fresh.clockHz
    && JSON.stringify(project.schematic) === JSON.stringify(fresh.schematic);
}

interface StartState { project: Project; fileName: string | null; dirty: boolean }

function initialProject(storage: KeyValueStorage | null, templates: readonly TemplateEntry[]): StartState {
  const saved = readJson(storage, PROJECT_STORAGE_KEY);
  if (isRecord(saved)) {
    const project = sanitizeProject(saved.project);
    if (project) {
      const fileName = str(saved.fileName) ?? null;
      // The autosave may be the only copy of the work: restore the unsaved flag so « Modèles », ⌘N and ⌘O ask
      // before replacing it. Older autosaves lack the flag: never-saved work that differs from its template counts.
      const dirty = typeof saved.dirty === 'boolean' ? saved.dirty : fileName === null && !isPristineTemplate(project, templates);
      return { project, fileName, dirty };
    }
  }
  const first = templates.find((t) => t.id === FIRST_TEMPLATE_ID) ?? templates[0];
  return { project: first ? projectFromTemplate(first) : blankProject(), fileName: null, dirty: false };
}

function compileProject(project: Project): CompileResultEx {
  return compile(project.source, { clockHz: project.clockHz, config: project.config });
}

const initialSim = (speed: number): SimState => ({
  status: 'stopped', snapshot: null, debug: null, realtimeRatio: 0, speed, breakpoints: [], error: null, loadedBuild: null,
});

const MSG_NO_DRIVER = 'Le simulateur n’est pas disponible (Web Worker non démarré).';
const MSG_NO_PIC = 'Le schéma ne contient aucun PIC16F84A : ajoutez-en un depuis la palette du schéma.';
const msgCompileErrors = (n: number): string =>
  `Le programme contient ${n} erreur${n > 1 ? 's' : ''} : corrigez-${n > 1 ? 'les' : 'la'} dans le panneau Code puis relancez.`;

/** What the worker currently holds, to decide between nothing, `updateSchematic` and a full `load`. */
interface LoadedSim { build: CompileResultEx; schematic: Schematic; clockHz: number; config: number }

export function createAppStore(options: AppStoreOptions = {}): AppStoreApi {
  const storage = options.storage ?? null;
  const templates = options.templates ?? listTemplates();
  const autosaveDelay = options.autosaveDelayMs ?? 800;
  const prefs = readPrefs(storage);
  const start = initialProject(storage, templates);

  let driver: SimDriver | null = null;
  let loaded: LoadedSim | null = null;
  const startResult = compileProject(start.project);
  /**
   * The build `sim.breakpoints` are numbered in: the last one that compiled. A failed build (the student is in
   * the middle of typing a line) keeps it, so the next good build remaps from real addresses.
   */
  let bpBuild: CompileResultEx | null = startResult.ok ? startResult : null;

  /** Breakpoints translated into the program the worker runs (they are numbered like `bpBuild`). */
  const workerBreakpoints = (bps: number[]): number[] => {
    if (!loaded || !bpBuild || bpBuild === loaded.build) return bps;
    return remapAddresses(bps, bpBuild, loaded.build);
  };
  /** Last list sent to the worker (avoids resending an identical one after each auto-build). */
  let postedBreakpoints: readonly number[] | null = null;
  const sameList = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

  const store = createStore<AppStore>()((set, get) => {
    const post = (message: ToWorker): void => driver?.post(message);

    const setSim = (patch: Partial<SimState>): void => set((s) => ({ sim: { ...s.sim, ...patch } }));

    const failSim = (message: string, focus?: PanelId): void => {
      set((s) => ({
        sim: { ...s.sim, error: message },
        ui: focus ? { ...s.ui, focusedPanel: focus, maximized: s.ui.maximized && s.ui.maximized !== focus ? focus : s.ui.maximized } : s.ui,
      }));
    };

    /** Stop the worker and forget what it holds (the next run starts from a power-on reset). */
    const halt = (): Partial<AppState> => {
      if (loaded) post({ type: 'pause' });
      loaded = null;
      return { sim: { ...get().sim, status: 'stopped', snapshot: null, debug: null, realtimeRatio: 0, error: null, loadedBuild: null } };
    };

    /** Send the breakpoint list to the worker, in the numbering of the program it runs, when it changed. */
    const syncBreakpoints = (bps: number[]): void => {
      const addrs = workerBreakpoints(bps);
      if (postedBreakpoints && sameList(postedBreakpoints, addrs)) return;
      postedBreakpoints = addrs;
      post({ type: 'setBreakpoints', addrs });
    };

    /**
     * A new build with the very same machine code as the loaded one (comment, blank line, renamed local...) is
     * adopted by the running session: no reload, the new line numbers apply at once.
     */
    const adopt = (result: CompileResultEx): boolean => {
      if (!loaded || loaded.build === result) return loaded !== null;
      if (!sameProgram(loaded.build, result) || loaded.clockHz !== get().project.clockHz) return false;
      loaded.build = result;
      setSim({ loadedBuild: result });
      return true;
    };

    /** Replace the whole project (new, template, file): stops the simulation and compiles at once. */
    const replaceProject = (project: Project, fileName: string | null, extraUi: Partial<AppState['ui']> = {}): void => {
      const stopped = halt();
      const result = compileProject(project);
      bpBuild = result.ok ? result : null;
      set((s) => ({
        ...stopped,
        project,
        fileName,
        dirty: false,
        compile: { result, stale: false },
        sim: { ...(stopped.sim as SimState), breakpoints: [] },
        ui: { ...s.ui, selectedComponentId: null, ...extraUi },
      }));
    };

    /** Build if needed, then make sure the worker runs the current program in the current circuit. */
    const ensureLoaded = (): boolean => {
      if (!driver) {
        failSim(MSG_NO_DRIVER);
        return false;
      }
      let { result, stale } = get().compile;
      if (stale || !result) {
        result = get().build();
        stale = false;
      }
      if (!result.ok || !result.program) {
        const errors = result.diagnostics.filter((d) => d.severity === 'error').length;
        failSim(msgCompileErrors(Math.max(1, errors)), 'code');
        return false;
      }
      const { schematic, clockHz } = get().project;
      if (!schematic.components.some((c) => c.kind === 'PIC16F84A')) {
        failSim(MSG_NO_PIC, 'schema');
        return false;
      }
      if (loaded && adopt(result)) {
        if (loaded.schematic !== schematic) {
          post({ type: 'updateSchematic', schematic });
          loaded.schematic = schematic;
        }
        return true;
      }
      const { breakpoints, speed } = get().sim;
      post({ type: 'load', schematic, program: result.program, clockHz, config: result.config });
      loaded = { build: result, schematic, clockHz, config: result.config };
      postedBreakpoints = null;
      syncBreakpoints(breakpoints);
      post({ type: 'setSpeed', speed });
      setSim({ loadedBuild: result, error: null });
      return true;
    };

    return {
      project: start.project,
      fileName: start.fileName,
      dirty: start.dirty,
      compile: { result: startResult, stale: false },
      sim: initialSim(prefs.speed),
      ui: {
        focusedPanel: 'schema',
        maximized: null,
        assistantOpen: false,
        learnOpen: false,
        copilotOpen: false,
        templatePickerOpen: false,
        selectedComponentId: null,
        theme: prefs.theme,
      },

      // ---------------------------------------------------------------- project
      newProject() {
        replaceProject(blankProject(), null);
      },

      loadProject(project, fileName = null) {
        const clean = sanitizeProject(project) ?? project;
        replaceProject(clean, fileName ?? null);
      },

      async loadTemplate(templateId) {
        const t = templates.find((x) => x.id === templateId);
        if (!t) throw new Error(`Modèle introuvable : « ${templateId} ».`);
        replaceProject(projectFromTemplate(t), null, { templatePickerOpen: false });
      },

      setSchematic(update) {
        const { project } = get();
        let next = typeof update === 'function' ? update(project.schematic) : update;
        if (next === project.schematic) return;
        if (next.clockHz !== project.clockHz) {
          // The circuit carries a new PIC clock (DSN import, assistant, undo of one): it becomes the project clock,
          // in the same update — the schematic editor recognises its own edits (undo history) by identity, so the
          // store must never hold an intermediate drawing.
          const hz = next.clockHz;
          next = withClock(next, hz);
          if (hz > 0) {
            // Delay_ms code depends on the clock: the running program is obsolete, stop it (as setClock does).
            const stopped = get().sim.status !== 'stopped' ? halt() : {};
            const schematic = next;
            set((s) => ({
              ...stopped,
              project: { ...s.project, clockHz: hz, schematic },
              compile: { ...s.compile, stale: true },
              dirty: true,
            }));
            return;
          }
        }
        set((s) => ({ project: { ...s.project, schematic: next }, dirty: true }));
        if (loaded && get().sim.status !== 'stopped') {
          post({ type: 'updateSchematic', schematic: next });
          loaded.schematic = next;
        }
      },

      setSource(source) {
        if (source === get().project.source) return;
        set((s) => ({
          project: { ...s.project, source, sourceOrigin: 'manual' },
          compile: { ...s.compile, stale: true },
          dirty: true,
        }));
      },

      setProgram(program, generatedSource) {
        set((s) => ({
          project: { ...s.project, program, source: generatedSource, sourceOrigin: 'generated' },
          compile: generatedSource === s.project.source ? s.compile : { ...s.compile, stale: true },
          dirty: true,
        }));
      },

      setClock(hz) {
        if (!(hz > 0) || hz === get().project.clockHz) return;
        // Delay_ms code depends on the clock: the running program is obsolete, stop it (ISIS needs a stop too).
        const stopped = get().sim.status !== 'stopped' ? halt() : {};
        set((s) => ({
          ...stopped,
          project: { ...s.project, clockHz: hz, schematic: withClock(s.project.schematic, hz) },
          compile: { ...s.compile, stale: true },
          dirty: true,
        }));
      },

      setOrganigrammeStyle(style) {
        if (style === get().project.organigrammeStyle) return;
        set((s) => ({ project: { ...s.project, organigrammeStyle: style }, dirty: true }));
      },

      renameProject(name) {
        const clean = name.trim() || 'Sans titre';
        if (clean === get().project.name) return;
        set((s) => ({ project: { ...s.project, name: clean }, dirty: true }));
      },

      markSaved(fileName) {
        set({ fileName, dirty: false });
      },

      // ---------------------------------------------------------------- build
      build() {
        const { project, sim } = get();
        const result = compileProject(project);
        let { breakpoints } = sim;
        if (result.ok) {
          // Breakpoints follow their statement (or stay put when the machine code is the same).
          if (bpBuild) breakpoints = remapAddresses(breakpoints, bpBuild, result);
          bpBuild = result;
        }
        set((s) => ({
          compile: { result, stale: false },
          sim: breakpoints === s.sim.breakpoints ? s.sim : { ...s.sim, breakpoints },
        }));
        if (loaded && result.ok) {
          // Same machine code: the session adopts the build. Otherwise the worker keeps the old program until the
          // next run/step reloads it, and gets the breakpoints in that program's numbering.
          adopt(result);
          syncBreakpoints(breakpoints);
        }
        return result;
      },

      // ---------------------------------------------------------------- simulation
      run() {
        if (get().sim.status === 'running') return;
        if (!ensureLoaded()) return;
        post({ type: 'run', speed: get().sim.speed });
        setSim({ status: 'running', error: null });
      },

      pause() {
        if (get().sim.status !== 'running') return;
        post({ type: 'pause' });
        setSim({ status: 'paused' });
      },

      stop() {
        if (get().sim.status === 'stopped' && !loaded) return;
        set(halt());
      },

      stepInstruction() {
        if (!ensureLoaded()) return;
        if (get().sim.status === 'running') post({ type: 'pause' });
        post({ type: 'stepInstruction' });
        setSim({ status: 'paused', error: null });
      },

      stepLine() {
        if (!ensureLoaded() || !loaded) return;
        if (get().sim.status === 'running') post({ type: 'pause' });
        post({ type: 'stepLine', addrToLine: [...loaded.build.addrToLine.entries()] });
        setSim({ status: 'paused', error: null });
      },

      reset() {
        if (get().sim.status === 'stopped' || !loaded) return;
        post({ type: 'reset' });
        setSim({ error: null });
      },

      setSpeed(multiplier) {
        if (!SPEEDS_ALLOWED(multiplier) || multiplier === get().sim.speed) return;
        setSim({ speed: multiplier });
        if (loaded) post({ type: 'setSpeed', speed: multiplier });
      },

      toggleBreakpoint(addr) {
        const current = get().sim.breakpoints;
        const breakpoints = current.includes(addr)
          ? current.filter((a) => a !== addr)
          : [...current, addr].sort((a, b) => a - b);
        setSim({ breakpoints });
        if (loaded) syncBreakpoints(breakpoints);
      },

      interact(componentId, action) {
        if (!loaded || get().sim.status === 'stopped') return;
        post({ type: 'interact', componentId, action });
      },

      // ---------------------------------------------------------------- ui
      focusPanel(panel) {
        const { ui } = get();
        const maximized = ui.maximized && ui.maximized !== panel ? panel : ui.maximized;
        if (ui.focusedPanel === panel && maximized === ui.maximized) return;
        set({ ui: { ...ui, focusedPanel: panel, maximized } });
      },

      toggleMaximize(panel) {
        set((s) => ({ ui: { ...s.ui, maximized: s.ui.maximized === panel ? null : panel, focusedPanel: panel } }));
      },

      setAssistantOpen(open) {
        if (get().ui.assistantOpen === open) return;
        set((s) => ({ ui: { ...s.ui, ...closedDrawers, assistantOpen: open } }));
      },

      setLearnOpen(open) {
        if (get().ui.learnOpen === open) return;
        set((s) => ({ ui: { ...s.ui, ...closedDrawers, learnOpen: open } }));
      },

      setCopilotOpen(open) {
        if (get().ui.copilotOpen === open) return;
        set((s) => ({ ui: { ...s.ui, ...closedDrawers, copilotOpen: open } }));
      },

      setTemplatePickerOpen(open) {
        if (get().ui.templatePickerOpen === open) return;
        set((s) => ({ ui: { ...s.ui, templatePickerOpen: open } }));
      },

      selectComponent(id) {
        if (get().ui.selectedComponentId === id) return;
        set((s) => ({ ui: { ...s.ui, selectedComponentId: id } }));
      },

      setTheme(theme) {
        if (get().ui.theme === theme) return;
        set((s) => ({ ui: { ...s.ui, theme } }));
      },
    };
  });

  // ---------------------------------------------------------------- worker messages
  const receive = (message: FromWorker): void => {
    const { sim } = store.getState();
    switch (message.type) {
      case 'snapshot':
        // Late snapshots after a stop belong to a discarded run.
        if (sim.status === 'stopped' || !loaded) return;
        store.setState({
          sim: {
            ...sim,
            snapshot: message.snapshot,
            debug: message.debug ?? sim.debug,
            realtimeRatio: message.realtimeRatio,
          },
        });
        return;
      case 'breakpoint':
        if (sim.status !== 'running') return;
        // Idempotent for the worker; heals the rare case of a breakpoint reported after a pause/run race.
        driver?.post({ type: 'pause' });
        store.setState({ sim: { ...sim, status: 'paused' } });
        return;
      case 'error':
        loaded = null;
        store.setState({ sim: { ...sim, status: 'stopped', snapshot: null, realtimeRatio: 0, error: message.message, loadedBuild: null } });
        return;
    }
  };

  // ---------------------------------------------------------------- persistence
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  const saveNow = (): void => {
    if (autosaveTimer !== null) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
    }
    const { project, fileName, dirty } = store.getState();
    writeJson(storage, PROJECT_STORAGE_KEY, { version: 1, project, fileName, dirty, savedAt: Date.now() });
  };

  if (storage) {
    store.subscribe((state, prev) => {
      if (state.project !== prev.project || state.fileName !== prev.fileName || state.dirty !== prev.dirty) {
        if (autosaveTimer !== null) clearTimeout(autosaveTimer);
        if (autosaveDelay <= 0) saveNow();
        else autosaveTimer = setTimeout(saveNow, autosaveDelay);
      }
      if (state.ui.theme !== prev.ui.theme || state.sim.speed !== prev.sim.speed) {
        const speed = state.sim.speed === SPEED_MAX ? 'max' : state.sim.speed;
        writeJson(storage, PREFS_STORAGE_KEY, { theme: state.ui.theme, speed });
      }
    });
  }

  return Object.assign(store, {
    attachSim(next: SimDriver | null) {
      if (driver === next) return;
      driver = next;
      // A new worker holds nothing: go back to the stopped state.
      loaded = null;
      const { sim } = store.getState();
      if (sim.status !== 'stopped' || sim.loadedBuild) {
        store.setState({ sim: { ...sim, status: 'stopped', snapshot: null, debug: null, realtimeRatio: 0, loadedBuild: null } });
      }
    },
    receive,
    flushAutosave() {
      if (autosaveTimer !== null) saveNow();
    },
    isProgramOutdated(state: AppState) {
      const running = state.sim.loadedBuild;
      // Identical rebuilds are adopted (they become the loaded build), so identity is enough here.
      return state.sim.status !== 'stopped' && running !== null && state.compile.result !== running;
    },
    breakpointBuild: () => bpBuild,
    templates,
  });
}

function browserStorage(): KeyValueStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probe = '__pic_studio_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

/** The app's store. */
/** Opening one side drawer closes the others. */
const closedDrawers = { assistantOpen: false, learnOpen: false, copilotOpen: false } as const;

export const appStore: AppStoreApi = createAppStore({ storage: browserStorage() });

/** Read the store from React with a selector (return primitives or stable references; use useShallow for objects). */
export function useApp<T>(selector: (state: AppStore) => T): T {
  return useStore(appStore, selector);
}

/** Current state + actions, for event handlers and non-React code. */
export function getApp(): AppStore {
  return appStore.getState();
}

// The store owns the worker channel and the autosave timer: a hot swap would leave the new instance without a
// simulator, so a change to this file reloads the page in development (after saving the project).
if (import.meta.hot) {
  import.meta.hot.dispose(() => appStore.flushAutosave());
  import.meta.hot.accept(() => location.reload());
}
