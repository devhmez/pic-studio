import { afterEach, describe, expect, it } from 'vitest';
import type { ToWorker } from '../sim/protocol';
import { appStore, getApp } from '../state/store';
import { RELOAD_QUESTION, runDebugKey, setConfirmHandler, stepLine } from './commands';

const SOURCE = 'void main() {\n  TRISB = 0;\n  while (1) {\n    PORTB = 1;\n    PORTB = 0;\n  }\n}\n';

function setup() {
  getApp().newProject();
  getApp().setSource(SOURCE);
  getApp().build();
  const posted: ToWorker['type'][] = [];
  appStore.attachSim({ post: (m) => posted.push(m.type) });
  return posted;
}

afterEach(() => {
  setConfirmHandler(null);
  appStore.attachSim(null);
});

describe('reload guard before a step or a run', () => {
  it('does not ask for a comment-only edit', () => {
    const posted = setup();
    const asked: string[] = [];
    setConfirmHandler((m) => { asked.push(m); return false; });
    stepLine();
    getApp().setSource(SOURCE.replace('PORTB = 1;', 'PORTB = 1; // LED'));
    posted.length = 0;
    stepLine(); // the pending auto-build runs first
    expect(asked).toEqual([]);
    expect(posted).toEqual(['stepLine']);
  });

  it('asks before reloading a changed program, and does nothing when declined', () => {
    const posted = setup();
    stepLine();
    getApp().setSource(SOURCE.replace('PORTB = 0;', 'PORTB = 2;'));
    const asked: string[] = [];
    setConfirmHandler((m) => { asked.push(m); return false; });
    posted.length = 0;
    stepLine();
    expect(asked).toEqual([RELOAD_QUESTION]);
    expect(posted).toEqual([]);
    expect(getApp().sim.status).toBe('paused');

    setConfirmHandler(() => true);
    runDebugKey({ key: 'F8', shiftKey: false });
    expect(posted[0]).toBe('load');
    expect(posted.at(-1)).toBe('stepLine');
  });

  it('binds F7 / F11 to the instruction step and F8 / F10 to the line step', () => {
    const posted = setup();
    for (const key of ['F7', 'F11', 'F8', 'F10']) expect(runDebugKey({ key, shiftKey: false })).toBe(true);
    expect(posted.filter((t) => t.startsWith('step'))).toEqual(['stepInstruction', 'stepInstruction', 'stepLine', 'stepLine']);
    expect(runDebugKey({ key: 'F12', shiftKey: false })).toBe(false);
  });
});
