import { describe, expect, it } from 'vitest';
import type { Schematic, SessionSnapshot } from '@pic/circuit';
import type { ToWorker } from '../sim/protocol';
import {
  buildTemplateCatalog, createAppStore, listTemplates, MINIMAL_SOURCE, parseProjectFile, PROJECT_STORAGE_KEY,
  serializeProject, SPEED_MAX, type KeyValueStorage, type TemplateEntry,
} from './store';

class MemoryStorage implements KeyValueStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const PIC = {
  id: 'U1', kind: 'PIC16F84A' as const, ref: 'U1', value: 'PIC16F84A', at: { x: 0, y: 0 }, rotation: 0 as const,
  props: { clock: '1MHz' },
};
const SCHEMATIC: Schematic = { clockHz: 1_000_000, components: [PIC], wires: [] };
const GOOD_SOURCE = 'void main() {\n  TRISB = 0;\n  while (1) {\n    PORTB = 1;\n    PORTB = 0;\n  }\n}\n';
const BAD_SOURCE = 'void main() {\n  x = ;\n}\n';

function entry(id: string, source = GOOD_SOURCE, clockHz = 1_000_000): TemplateEntry {
  return {
    id, title: `Modèle ${id}`, chapter: null, description: '', clockHz,
    schematic: { ...SCHEMATIC, clockHz }, program: null, source,
  };
}

const TEMPLATES = [entry('tp-status'), entry('tp-traffic', GOOD_SOURCE, 8_000_000)];

function setup(storage: MemoryStorage | null = new MemoryStorage()) {
  const store = createAppStore({ storage, templates: TEMPLATES, autosaveDelayMs: 0 });
  const posted: ToWorker[] = [];
  store.attachSim({ post: (m) => posted.push(m) });
  return { store, posted, storage, app: () => store.getState(), types: () => posted.map((m) => m.type) };
}

const snapshot = (time: number): SessionSnapshot => ({
  time, cycles: time * 250_000, cpu: { pc: 3, w: 0, status: 0x18, sleeping: false, halted: false }, visuals: {}, nets: {},
});

describe('store: projects and templates', () => {
  it('opens tp-status on first launch, compiled', () => {
    const { app } = setup();
    expect(app().project.templateId).toBe('tp-status');
    expect(app().project.sourceOrigin).toBe('generated');
    expect(app().compile.stale).toBe(false);
    expect(app().compile.result?.ok).toBe(true);
    expect(app().sim.status).toBe('stopped');
  });

  it('loads a template: circuit, source, clock and PIC CLOCK property', async () => {
    const { app } = setup();
    app().setTemplatePickerOpen(true);
    await app().loadTemplate('tp-traffic');
    const { project, ui } = app();
    expect(project.templateId).toBe('tp-traffic');
    expect(project.clockHz).toBe(8_000_000);
    expect(project.schematic.clockHz).toBe(8_000_000);
    expect(project.schematic.components[0].props.clock).toBe('8MHz');
    expect(project.program).toBeNull();
    expect(ui.templatePickerOpen).toBe(false);
    await expect(app().loadTemplate('nope')).rejects.toThrow(/introuvable/);
  });

  it('marks the compile stale on source and clock changes, build() clears it', () => {
    const { app } = setup();
    app().setSource(GOOD_SOURCE.replace('PORTB = 1', 'PORTB = 3'));
    expect(app().compile.stale).toBe(true);
    expect(app().project.sourceOrigin).toBe('manual');
    expect(app().dirty).toBe(true);
    const r = app().build();
    expect(r.ok).toBe(true);
    expect(app().compile).toEqual({ result: r, stale: false });
    app().setClock(4_000_000);
    expect(app().compile.stale).toBe(true);
    expect(app().project.schematic.clockHz).toBe(4_000_000);
    expect(app().project.schematic.components[0].props.clock).toBe('4MHz');
  });

  it('setProgram stores the model and the generated source', () => {
    const { app } = setup();
    app().setSource('// à la main\n' + GOOD_SOURCE);
    app().setProgram({ kind: 'model' }, GOOD_SOURCE);
    expect(app().project.program).toEqual({ kind: 'model' });
    expect(app().project.sourceOrigin).toBe('generated');
    expect(app().project.source).toBe(GOOD_SOURCE);
  });

  it('autosaves the project and restores it on the next start', () => {
    const storage = new MemoryStorage();
    const first = setup(storage);
    first.app().renameProject('Mon TP');
    first.app().setSource(GOOD_SOURCE + '// fin\n');
    expect(storage.map.has(PROJECT_STORAGE_KEY)).toBe(true);
    const second = setup(storage);
    expect(second.app().project.name).toBe('Mon TP');
    expect(second.app().project.source).toBe(GOOD_SOURCE + '// fin\n');
    expect(second.app().compile.result?.ok).toBe(true);
  });

  it('ignores a corrupted autosave', () => {
    const storage = new MemoryStorage();
    storage.setItem(PROJECT_STORAGE_KEY, '{"project": {"name": 3}');
    expect(setup(storage).app().project.templateId).toBe('tp-status');
    storage.setItem(PROJECT_STORAGE_KEY, JSON.stringify({ project: { name: 'x', source: 1 } }));
    expect(setup(storage).app().project.templateId).toBe('tp-status');
  });

  it('round-trips a .picproj file', () => {
    const { app } = setup();
    const text = serializeProject(app().project);
    expect(parseProjectFile(text)).toEqual(app().project);
    expect(() => parseProjectFile('{')).toThrow(/JSON/);
    expect(() => parseProjectFile('{"project": {}}')).toThrow(/valide/);
  });

  it('newProject gives one PIC and a minimal main', () => {
    const { app } = setup();
    app().newProject();
    expect(app().project.schematic.components.map((c) => c.kind)).toEqual(['PIC16F84A']);
    expect(app().project.source).toBe(MINIMAL_SOURCE);
    expect(app().compile.result?.ok).toBe(true);
  });
});

describe('store: simulation', () => {
  it('builds, loads the worker and runs', () => {
    const { app, posted, types } = setup();
    app().run();
    expect(types()).toEqual(['load', 'setBreakpoints', 'setSpeed', 'run']);
    expect(app().sim.status).toBe('running');
    const load = posted[0] as Extract<ToWorker, { type: 'load' }>;
    expect(load.program).toBe(app().compile.result!.program);
    expect(load.clockHz).toBe(1_000_000);
    app().run();
    expect(types()).toHaveLength(4);
  });

  it('pauses, steps without reloading, and resumes', () => {
    const { app, types } = setup();
    app().run();
    app().pause();
    expect(app().sim.status).toBe('paused');
    app().stepInstruction();
    app().stepLine();
    expect(types().slice(4)).toEqual(['pause', 'stepInstruction', 'stepLine']);
    app().run();
    expect(types().at(-1)).toBe('run');
  });

  it('steps from the stopped state by loading first', () => {
    const { app, types, posted } = setup();
    app().stepLine();
    expect(types()).toEqual(['load', 'setBreakpoints', 'setSpeed', 'stepLine']);
    const step = posted[3] as Extract<ToWorker, { type: 'stepLine' }>;
    expect(step.addrToLine.length).toBeGreaterThan(0);
    expect(app().sim.status).toBe('paused');
  });

  it('rebuilds a stale program and reloads the worker', () => {
    const { app, types } = setup();
    app().run();
    app().pause();
    app().setSource(GOOD_SOURCE.replace('PORTB = 0', 'PORTB = 2'));
    app().stepInstruction();
    expect(app().compile.stale).toBe(false);
    expect(types().slice(-4)).toEqual(['load', 'setBreakpoints', 'setSpeed', 'stepInstruction']);
  });

  it('sends circuit edits made during a pause to the worker', () => {
    const { app, posted } = setup();
    app().run();
    app().pause();
    app().setSchematic((s) => ({ ...s, components: s.components.map((c) => ({ ...c, at: { x: 5, y: 5 } })) }));
    const msg = posted.at(-1) as Extract<ToWorker, { type: 'updateSchematic' }>;
    expect(msg.type).toBe('updateSchematic');
    expect(msg.schematic).toBe(app().project.schematic);
  });

  it('refuses to run a program that does not compile and points at the code', () => {
    const { app, types } = setup();
    app().setSource(BAD_SOURCE);
    app().run();
    expect(types()).toEqual([]);
    expect(app().sim.status).toBe('stopped');
    expect(app().sim.error).toMatch(/erreur/);
    expect(app().ui.focusedPanel).toBe('code');
  });

  it('refuses a circuit without PIC', () => {
    const { app } = setup();
    app().setSchematic({ ...SCHEMATIC, components: [] });
    app().run();
    expect(app().sim.error).toMatch(/PIC16F84A/);
  });

  it('reports a missing worker', () => {
    const store = createAppStore({ storage: null, templates: TEMPLATES });
    store.getState().run();
    expect(store.getState().sim.error).toMatch(/simulateur/i);
  });

  it('takes worker snapshots while simulating, ignores them once stopped', () => {
    const { store, app } = setup();
    app().run();
    store.receive({ type: 'snapshot', snapshot: snapshot(0.5), debug: null, running: true, realtimeRatio: 0.98 });
    expect(app().sim.snapshot?.time).toBe(0.5);
    expect(app().sim.realtimeRatio).toBe(0.98);
    app().stop();
    expect(app().sim).toMatchObject({ status: 'stopped', snapshot: null, debug: null });
    store.receive({ type: 'snapshot', snapshot: snapshot(0.6), debug: null, running: true, realtimeRatio: 1 });
    expect(app().sim.snapshot).toBeNull();
  });

  it('a breakpoint pauses the run; a worker error stops it', () => {
    const { store, app, types } = setup();
    app().run();
    store.receive({ type: 'breakpoint', pc: 7 });
    expect(app().sim.status).toBe('paused');
    expect(types().at(-1)).toBe('pause');
    store.receive({ type: 'error', message: 'boum' });
    expect(app().sim).toMatchObject({ status: 'stopped', error: 'boum' });
    // The next run reloads from scratch.
    app().run();
    expect(types().slice(-4)).toEqual(['load', 'setBreakpoints', 'setSpeed', 'run']);
  });

  it('stops the simulation when the clock changes', () => {
    const { app } = setup();
    app().run();
    app().setClock(8_000_000);
    expect(app().sim.status).toBe('stopped');
  });

  it('forwards speed, breakpoints and interactions', () => {
    const { app, posted } = setup();
    app().interact('LS1', { type: 'toggle' }); // stopped: ignored
    expect(posted).toHaveLength(0);
    app().run();
    app().setSpeed(SPEED_MAX);
    app().toggleBreakpoint(5);
    app().toggleBreakpoint(3);
    app().interact('LS1', { type: 'toggle' });
    expect(posted.slice(4)).toEqual([
      { type: 'setSpeed', speed: SPEED_MAX },
      { type: 'setBreakpoints', addrs: [5] },
      { type: 'setBreakpoints', addrs: [3, 5] },
      { type: 'interact', componentId: 'LS1', action: { type: 'toggle' } },
    ]);
    app().toggleBreakpoint(5);
    expect(app().sim.breakpoints).toEqual([3]);
  });

  it('moves breakpoints with their C line when the program is rebuilt', () => {
    const { app } = setup();
    const before = app().compile.result!;
    app().toggleBreakpoint(before.lineToAddr.get(5)!); // PORTB = 0;
    // Line 4 now takes more instructions, so line 5 starts at a later address.
    app().setSource(GOOD_SOURCE.replace('PORTB = 1;', 'PORTB = 1; PORTB = 2; PORTB = 3;'));
    const after = app().build();
    expect(after.lineToAddr.get(5)).not.toBe(before.lineToAddr.get(5));
    expect(app().sim.breakpoints).toEqual([after.lineToAddr.get(5)]);
  });
});

describe('store: autosave and the unsaved flag', () => {
  it('restores the unsaved flag of never-saved work, and the saved state after ⌘S', () => {
    const storage = new MemoryStorage();
    const first = createAppStore({ storage, templates: TEMPLATES, autosaveDelayMs: 0 });
    first.getState().setSource(GOOD_SOURCE.replace('PORTB = 1;', 'PORTB = 3;'));
    expect(createAppStore({ storage, templates: TEMPLATES }).getState().dirty).toBe(true);
    first.getState().markSaved('mon-projet.picproj');
    const again = createAppStore({ storage, templates: TEMPLATES }).getState();
    expect(again.dirty).toBe(false);
    expect(again.fileName).toBe('mon-projet.picproj');
  });

  it('treats an old autosave (no flag) as unsaved unless it is still the untouched template', () => {
    const storage = new MemoryStorage();
    const fresh = createAppStore({ storage: null, templates: TEMPLATES }).getState().project;
    storage.setItem(PROJECT_STORAGE_KEY, JSON.stringify({ version: 1, project: fresh, fileName: null }));
    expect(createAppStore({ storage, templates: TEMPLATES }).getState().dirty).toBe(false);
    storage.setItem(PROJECT_STORAGE_KEY, JSON.stringify({ version: 1, project: { ...fresh, source: `${fresh.source}// à moi\n` }, fileName: null }));
    expect(createAppStore({ storage, templates: TEMPLATES }).getState().dirty).toBe(true);
  });
});

describe('store: edits during a simulation', () => {
  it('adopts a rebuild with the same machine code: no reload, the new line numbers apply', () => {
    const { app, types, store } = setup();
    app().stepLine();
    const loaded = app().sim.loadedBuild;
    expect(loaded).toBe(app().compile.result);
    app().setSource(`// Mon programme\n${GOOD_SOURCE}`);
    const r = app().build();
    expect(app().sim.loadedBuild).toBe(r);
    expect(store.isProgramOutdated(app())).toBe(false);
    const before = types().length;
    app().stepLine();
    expect(types().slice(before)).toEqual(['stepLine']);
  });

  it('flags a real change, and keeps the worker breakpoints in the running program numbering', () => {
    const { app, posted, store } = setup();
    app().stepLine();
    const r0 = app().compile.result!;
    const bp = r0.lineToAddr.get(5)!; // PORTB = 0;
    app().toggleBreakpoint(bp);
    app().setSource(GOOD_SOURCE.replace('  TRISB = 0;\n', '  TRISA = 0;\n  TRISB = 0;\n'));
    const r1 = app().build();
    expect(store.isProgramOutdated(app())).toBe(true);
    expect(app().sim.loadedBuild).toBe(r0);
    // The list follows the statement in the new build...
    expect(app().sim.breakpoints).toEqual([r1.lineToAddr.get(6)]);
    // ...while the worker, still running r0, keeps the old address.
    const sent = posted.filter((m): m is Extract<ToWorker, { type: 'setBreakpoints' }> => m.type === 'setBreakpoints').at(-1)!;
    expect(sent.addrs).toEqual([bp]);
    expect(store.breakpointBuild()).toBe(r1);
    // A step reloads the new program, with the new addresses.
    app().stepLine();
    expect(app().sim.loadedBuild).toBe(r1);
    expect(store.isProgramOutdated(app())).toBe(false);
    const load = posted.map((m) => m.type).lastIndexOf('load');
    expect(posted[load + 1]).toEqual({ type: 'setBreakpoints', addrs: [r1.lineToAddr.get(6)] });
  });

  it('forgets the loaded build when the simulation stops', () => {
    const { app } = setup();
    app().run();
    expect(app().sim.loadedBuild).not.toBeNull();
    app().stop();
    expect(app().sim.loadedBuild).toBeNull();
  });
});

describe('store: ui', () => {
  it('focus, maximize, drawers', () => {
    const { app } = setup();
    app().toggleMaximize('schema');
    expect(app().ui.maximized).toBe('schema');
    app().focusPanel('code');
    expect(app().ui).toMatchObject({ focusedPanel: 'code', maximized: 'code' });
    app().toggleMaximize('code');
    expect(app().ui.maximized).toBeNull();
    app().setAssistantOpen(true);
    app().selectComponent('U1');
    app().setTheme('dark');
    expect(app().ui).toMatchObject({ assistantOpen: true, selectedComponentId: 'U1', theme: 'dark' });
  });
});

describe('template catalog', () => {
  const schematicFile = (name: string, clockHz = 1_000_000) => ({ name, description: `desc ${name}`, ...SCHEMATIC, clockHz });

  it('derives the list from the schematic files when index.json is missing', () => {
    const list = buildTemplateCatalog({
      schematics: {
        'tp-traffic.schematic.json': schematicFile('Feu', 8_000_000),
        'tp0-exemple1.schematic.json': schematicFile('Exemple 1'),
        'broken.schematic.json': { nope: true },
      },
      programs: { 'tp0-exemple1.program.json': { blocks: [] } },
      sources: { 'tp0-exemple1.c': 'void main() {\r\n}\r\n' },
    });
    expect(list.map((t) => t.id)).toEqual(['tp0-exemple1', 'tp-traffic']);
    const [ex1, traffic] = list;
    expect(ex1).toMatchObject({ title: 'Exemple 1', chapter: 'Chapitre 1', source: 'void main() {\n}\n', program: { blocks: [] } });
    expect(traffic).toMatchObject({ title: 'Feu', clockHz: 8_000_000, source: MINIMAL_SOURCE, program: null, description: 'desc Feu' });
  });

  it('follows index.json when present', () => {
    const list = buildTemplateCatalog({
      index: [
        { id: 'tp-status', title: 'STATUS', chapter: 3, description: 'Comparer x et y', schematic: 'tp-status.schematic.json', program: 'tp-status.program.json', source: 'tp-status.c', clockHz: 1_000_000 },
        { id: 'missing', schematic: 'missing.schematic.json' },
      ],
      schematics: { 'tp-status.schematic.json': schematicFile('x'), 'tp-vote.schematic.json': schematicFile('vote') },
      programs: { 'tp-status.program.json': { p: 1 } },
      sources: { 'tp-status.c': GOOD_SOURCE },
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'tp-status', title: 'STATUS', chapter: 'Chapitre 3', program: { p: 1 }, source: GOOD_SOURCE });
  });

  it('bundles the repository templates', () => {
    const list = listTemplates();
    expect(list.map((t) => t.id)).toContain('tp-status');
    for (const t of list) expect(t.schematic.components.length).toBeGreaterThan(0);
  });
});
