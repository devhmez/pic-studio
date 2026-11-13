// Editor commands shared by the canvas keyboard handler, the panel header buttons and the properties popover.
import { notify } from '../shell/toast';
import { getApp } from '../state/store';
import {
  deleteSelection, EMPTY_SELECTION, isEmptySelection, mirrorComponents, ROTATE_REFUSED_MESSAGE, rotateComponents, schematicExtent,
} from './editing';
import { commit, editor, patchEditor, setUserView } from './editorStore';
import { fitRect, zoomAt } from './viewport';

/** Fit the whole drawing in the canvas. */
export function fitToView(): void {
  const { size } = editor();
  if (size.w <= 0 || size.h <= 0) {
    patchEditor({ fitPending: true });
    return;
  }
  const s = getApp().project.schematic;
  patchEditor({ view: fitRect(schematicExtent(s), size.w, size.h), fitPending: false, autoFit: true });
}

export function zoomBy(factor: number): void {
  const { view, size } = editor();
  setUserView(zoomAt(view, size.w / 2, size.h / 2, factor));
}

/** R / M on the selection or on the part being placed. */
export function rotateOrMirror(op: 'rotate' | 'rotateBack' | 'mirror'): void {
  const st = editor();
  if (st.tool === 'place' && st.placing) {
    const spec = { ...st.placing };
    if (op === 'mirror') spec.mirror = !spec.mirror;
    else spec.rotation = (((spec.rotation ?? 0) + (op === 'rotate' ? 90 : 270)) % 360) as 0 | 90 | 180 | 270;
    patchEditor({ placing: spec });
    return;
  }
  if (getApp().sim.status === 'running' || st.selection.components.length === 0) return;
  const s = getApp().project.schematic;
  const next = op === 'mirror' ? mirrorComponents(s, st.selection.components) : rotateComponents(s, st.selection.components, op === 'rotate' ? 90 : 270);
  // Refused: the wires could not follow the pins without touching other pins (or being cut).
  if (next === s) { notify(ROTATE_REFUSED_MESSAGE, 'info'); return; }
  commit(next);
}

export function deleteSelected(): void {
  const { selection } = editor();
  if (getApp().sim.status === 'running' || isEmptySelection(selection)) return;
  commit(deleteSelection(getApp().project.schematic, selection), EMPTY_SELECTION);
  patchEditor({ popoverFor: null });
}
