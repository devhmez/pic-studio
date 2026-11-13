// Local state of the schematic editor (tool, selection, view, drag previews, undo/redo history).
// Kept out of the app store: it is UI-only and changes at pointer-move rate.
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { Point, Schematic } from '@pic/circuit';
import { getApp } from '../state/store';
import { EMPTY_SELECTION, type PartSpec, type Rect, type Selection } from './editing';
import { DEFAULT_VIEW, type View } from './viewport';

export type Tool = 'select' | 'wire' | 'place';

export interface WireDraft {
  /** Committed vertices; the first one is where the wire starts. */
  points: Point[];
  /** Snapped cursor. */
  cursor: Point;
  /** Direction of the first leg, from the pin the wire starts on. */
  startDir: 'h' | 'v' | null;
}

export interface EditorState {
  tool: Tool;
  /** Part being placed (tool 'place'), with its pending rotation / mirror. */
  placing: PartSpec | null;
  /** Snapped position of the part being placed, or null when the cursor is outside the canvas. */
  ghostAt: Point | null;
  selection: Selection;
  view: View;
  size: { w: number; h: number };
  /** Schematic shown while dragging (not yet committed), or null. */
  preview: Schematic | null;
  /** Marquee rectangle in world units. */
  marquee: Rect | null;
  wireDraft: WireDraft | null;
  /** Pin tip or wire point under the cursor (wiring affordance). */
  hoverPoint: Point | null;
  /** Component whose properties popover is open. */
  popoverFor: string | null;
  paletteOpen: boolean;
  /** Fit the drawing to the view as soon as the canvas has a size (first show, template loaded). */
  fitPending: boolean;
  /** The view is still the automatic fit (the student has not panned or zoomed): resizing the panel refits. */
  autoFit: boolean;
  past: Schematic[];
  future: Schematic[];
}

const HISTORY_LIMIT = 100;

function readPaletteOpen(): boolean {
  try {
    return localStorage.getItem('pic-studio.schematic.palette') !== 'closed';
  } catch {
    return true;
  }
}

export const editorStore = createStore<EditorState>(() => ({
  tool: 'select',
  placing: null,
  ghostAt: null,
  selection: EMPTY_SELECTION,
  view: DEFAULT_VIEW,
  size: { w: 0, h: 0 },
  preview: null,
  marquee: null,
  wireDraft: null,
  hoverPoint: null,
  popoverFor: null,
  paletteOpen: readPaletteOpen(),
  fitPending: true,
  autoFit: true,
  past: [],
  future: [],
}));

export function useEditor<T>(selector: (s: EditorState) => T): T {
  return useStore(editorStore, selector);
}

export const editor = (): EditorState => editorStore.getState();

export function patchEditor(patch: Partial<EditorState>): void {
  editorStore.setState(patch);
}

/** A pan or zoom made by the student (stops the automatic refit on resize). */
export function setUserView(view: View): void {
  editorStore.setState({ view, autoFit: false });
}

/** The schematic the editor last wrote to the app store (to tell its own edits from external ones). */
let lastCommitted: Schematic | null = null;

export function isOwnSchematic(s: Schematic): boolean {
  return s === lastCommitted;
}

/** Write an edit to the app store and record it for undo. */
export function commit(next: Schematic, selection?: Selection): void {
  const current = getApp().project.schematic;
  if (next === current) return;
  const past = [...editor().past, current].slice(-HISTORY_LIMIT);
  lastCommitted = next;
  patchEditor({ past, future: [], preview: null, ...(selection ? { selection } : {}) });
  getApp().setSchematic(next);
  syncSelectedComponent();
}

export function undo(): void {
  const { past, future } = editor();
  const prev = past[past.length - 1];
  if (!prev) return;
  const current = getApp().project.schematic;
  lastCommitted = prev;
  patchEditor({ past: past.slice(0, -1), future: [current, ...future].slice(0, HISTORY_LIMIT), preview: null });
  getApp().setSchematic(prev);
  pruneSelection(prev);
}

export function redo(): void {
  const { past, future } = editor();
  const next = future[0];
  if (!next) return;
  const current = getApp().project.schematic;
  lastCommitted = next;
  patchEditor({ past: [...past, current].slice(-HISTORY_LIMIT), future: future.slice(1), preview: null });
  getApp().setSchematic(next);
  pruneSelection(next);
}

/** Forget the history (another project or template was loaded). */
export function resetHistory(): void {
  patchEditor({ past: [], future: [], preview: null, wireDraft: null, marquee: null, popoverFor: null });
}

export function setSelection(selection: Selection): void {
  const cur = editor().selection;
  if (cur.components.join() === selection.components.join() && cur.wires.join() === selection.wires.join()) return;
  patchEditor({ selection });
  syncSelectedComponent();
}

/** Drop selected ids that no longer exist. */
export function pruneSelection(s: Schematic): void {
  const { selection, popoverFor } = editor();
  const ids = new Set(s.components.map((c) => c.id));
  const wires = new Set(s.wires.map((w) => w.id));
  const components = selection.components.filter((id) => ids.has(id));
  const ws = selection.wires.filter((id) => wires.has(id));
  if (components.length !== selection.components.length || ws.length !== selection.wires.length) {
    patchEditor({ selection: { components, wires: ws } });
  }
  if (popoverFor && !ids.has(popoverFor)) patchEditor({ popoverFor: null });
  syncSelectedComponent();
}

/** ui.selectedComponentId follows a single selected part. */
function syncSelectedComponent(): void {
  const { components, wires } = editor().selection;
  const id = components.length === 1 && wires.length === 0 ? components[0] : null;
  getApp().selectComponent(id);
}

export function setPaletteOpen(open: boolean): void {
  patchEditor({ paletteOpen: open });
  try {
    localStorage.setItem('pic-studio.schematic.palette', open ? 'open' : 'closed');
  } catch {
    // not remembered
  }
}

/** Back to the selection tool, dropping any wire or placement in progress. */
export function cancelTool(): void {
  patchEditor({ tool: 'select', placing: null, ghostAt: null, wireDraft: null, marquee: null, preview: null });
}
