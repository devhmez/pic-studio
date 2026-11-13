// The schematic canvas: infinite pan/zoom SVG, ISIS look, editing (place, select, move, wire) and live simulation
// (pin levels, LEDs, displays, clickable LOGICSTATE / BUTTON / torch).
import {
  useCallback, useEffect, useMemo, useRef,
  type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  buildNetlist, interactionFor, LDR_LEVEL_OHMS, pointsEqual, type Point, type Schematic,
} from '@pic/circuit';
import { getApp, useApp } from '../state/store';
import { IS_MAC } from '../shell/format';
import { notify } from '../shell/toast';
import {
  addComponent, addWire, draftRoute, duplicateSelection, EMPTY_SELECTION, isEmptySelection, makeComponent,
  MOVE_REFUSED_MESSAGE, moveSelection, rectFrom, selectInRect, simplifyPolyline, snapToGrid, updateComponent, type Selection,
} from './editing';
import { deleteSelected, fitToView, rotateOrMirror, zoomBy } from './commands';
import {
  cancelTool, commit, editor, patchEditor, redo, setSelection, setUserView, undo, useEditor,
} from './editorStore';
import { hitActuator, hitComponent, hitPin, hitWire } from './hit';
import {
  ComponentsLayer, DanglingLayer, GhostLayer, GridLayer, HoverLayer, JunctionsLayer, LiveLayer,
  MarqueeLayer, SelectionLayer, WireDraftLayer, WiresLayer,
} from './layers';
import { ActuatorButtons } from './ActuatorButtons';
import { LdrSliders } from './LdrSliders';
import { PropertiesPopover } from './PropertiesPopover';
import { toWorld, zoomAt, type View } from './viewport';

/** One-line help at the bottom of the sheet while a tool is active (calm, never covers the drawing's centre). */
function ToolHint({ empty }: { empty: boolean }) {
  const tool = useEditor((s) => s.tool);
  const drafting = useEditor((s) => s.wireDraft !== null);
  let text: string | null = null;
  if (tool === 'place') text = 'Cliquez pour placer · R pivoter · M miroir · ⇧-clic pour en placer plusieurs · Échap annuler';
  else if (drafting) text = 'Cliquez pour faire un coude · terminez sur une broche ou un fil · double-clic pour finir · ⌫ dernier coude · Échap annuler';
  else if (tool === 'wire') text = 'Cliquez sur une broche, un fil ou le schéma pour commencer un fil · Échap pour revenir à la sélection';
  else if (empty) text = 'Schéma vide : glissez un PIC16F84A depuis la palette pour commencer.';
  if (!text) return null;
  return <div className="sch-tool-hint" role="status">{text}</div>;
}

type Drag =
  | { kind: 'pan'; sx: number; sy: number; view: View }
  /** `click`: what a click without movement does (LOGICSTATE toggle, torch +/-); the selection changes only on a real move. */
  | { kind: 'move'; origin: Point; base: Schematic; selection: Selection; delta: Point; click?: () => void; refused?: boolean }
  | { kind: 'marquee'; origin: Point; additive: boolean; base: Selection }
  | { kind: 'press'; componentId: string };

/** Pick tolerance: about 7 screen pixels, never more than half a grid step. */
const tolerance = (k: number): number => Math.min(0.5, 7 / k);

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

export function SchematicCanvas() {
  const schematic = useApp((s) => s.project.schematic);
  const status = useApp((s) => s.sim.status);
  const simulating = status !== 'stopped';
  const locked = status === 'running';
  // Rest states (LOGICSTATE digit, released BUTTON) stay drawn until the first live snapshot replaces them.
  const live = useApp((s) => s.sim.status !== 'stopped' && s.sim.snapshot !== null);
  const preview = useEditor((s) => s.preview);
  const view = useEditor((s) => s.view);
  const size = useEditor((s) => s.size);
  const selection = useEditor((s) => s.selection);
  const tool = useEditor((s) => s.tool);
  const shown = preview ?? schematic;
  const netlist = useMemo(() => buildNetlist(shown), [shown]);
  const liveNetlist = useMemo(() => (simulating ? buildNetlist(schematic) : null), [simulating, schematic]);
  const hasPic = useMemo(() => schematic.components.some((c) => c.kind === 'PIC16F84A'), [schematic]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const space = useRef(false);
  /** The double-click that ended a wire must not also open the properties of the part under it. */
  const wireJustFinished = useRef(false);

  // Size of the canvas, and the pending fit once it is known.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const w = Math.round(width);
      const h = Math.round(height);
      const prev = editor().size;
      if (prev.w === w && prev.h === h) return;
      patchEditor({ size: { w, h } });
      if ((editor().fitPending || editor().autoFit) && w > 0 && h > 0) fitToView();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Two-finger scroll pans, pinch or ⌘/Ctrl + scroll zooms (native listener: React's wheel handler is passive).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
      const v = editor().view;
      if (e.ctrlKey || e.metaKey) {
        const speed = e.ctrlKey && !e.metaKey ? 0.01 : 0.0025; // pinch deltas are small
        setUserView(zoomAt(v, e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * unit * speed)));
      } else {
        setUserView({ ...v, x: v.x - e.deltaX * unit, y: v.y - e.deltaY * unit });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const local = useCallback((e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  }, []);

  const setCursor = (cursor: string) => {
    if (wrapRef.current && wrapRef.current.dataset.cursor !== cursor) wrapRef.current.dataset.cursor = cursor;
  };

  // ---------------------------------------------------------------- pointer

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.sch-overlay-ui')) return; // popover, sliders
    wrapRef.current?.focus({ preventScroll: true });
    const { sx, sy } = local(e);
    const st = editor();
    const p = toWorld(st.view, sx, sy);
    const s = snapToGrid(p);
    const app = getApp();
    const sch = app.project.schematic;
    const status = app.sim.status;
    const simulating = status !== 'stopped';
    const locked = status === 'running';
    const tol = tolerance(st.view.k);

    if (e.button === 1 || (e.button === 0 && space.current)) {
      drag.current = { kind: 'pan', sx, sy, view: st.view };
      e.currentTarget.setPointerCapture(e.pointerId);
      setCursor('grabbing');
      return;
    }
    if (e.button === 2) {
      if (st.wireDraft || st.tool === 'place') cancelTool();
      return;
    }
    if (e.button !== 0) return;
    if (st.popoverFor) patchEditor({ popoverFor: null });

    // Place the part being dragged from the palette.
    if (st.tool === 'place' && st.placing) {
      if (locked) return;
      if (st.placing.kind === 'PIC16F84A' && sch.components.some((c) => c.kind === 'PIC16F84A')) {
        notify('Un seul PIC16F84A par schéma : le simulateur n’en utilise qu’un.', 'info');
        return;
      }
      const c = makeComponent(sch, st.placing, s);
      commit(addComponent(sch, c), { components: [c.id], wires: [] });
      if (!e.shiftKey) patchEditor({ tool: 'select', placing: null, ghostAt: null });
      return;
    }

    // Interactive parts. Running: a click acts at once. Paused or stopped: a click acts (live state while paused,
    // initial state while stopped) and a drag moves the part, so LOGICSTATEs stay movable.
    const act = st.wireDraft ? null : hitActuator(sch, p);
    if (act) {
      const { component: c, actuator } = act;
      let click: (() => void) | null = null;
      if (simulating && actuator.action === 'press') {
        app.interact(c.id, { type: 'press' });
        drag.current = { kind: 'press', componentId: c.id };
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
      if (simulating) {
        const action = interactionFor(actuator.action, app.sim.snapshot?.visuals[c.id]);
        click = () => getApp().interact(c.id, action);
      } else if (c.kind === 'LOGICSTATE' && actuator.action === 'toggle') {
        click = () => commit(updateComponent(getApp().project.schematic, c.id, (x) => ({ ...x, props: { ...x.props, state: Number(x.props.state) === 1 ? 0 : 1 } })));
      } else if (c.kind === 'TORCH_LDR' && (actuator.action === 'increment' || actuator.action === 'decrement')) {
        const level = Math.max(0, Math.min(LDR_LEVEL_OHMS.length - 1, Number(c.props.level ?? 0) + (actuator.action === 'increment' ? 1 : -1)));
        click = () => commit(updateComponent(getApp().project.schematic, c.id, (x) => ({ ...x, props: { ...x.props, level } })));
      }
      if (click) {
        if (locked) {
          click();
          return;
        }
        const sel: Selection = st.selection.components.includes(c.id) ? st.selection : { components: [c.id], wires: [] };
        drag.current = { kind: 'move', origin: p, base: sch, selection: sel, delta: { x: 0, y: 0 }, click };
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
    }

    if (st.wireDraft) {
      draftClick(p, s, e.detail >= 2);
      return;
    }

    if (locked) {
      const c = hitComponent(sch, p);
      setSelection(c ? { components: [c.id], wires: [] } : EMPTY_SELECTION);
      return;
    }

    // Start a wire on a pin tip (or anywhere with the wire tool).
    const pin = hitPin(sch, p, tol);
    if (pin) {
      patchEditor({ wireDraft: { points: [pin.at], cursor: pin.at, startDir: pin.dir }, hoverPoint: null });
      return;
    }
    if (st.tool === 'wire') {
      const onWire = hitWire(sch, p, tol);
      const start = onWire ? onWire.at : s;
      patchEditor({ wireDraft: { points: [start], cursor: start, startDir: null } });
      return;
    }

    const c = hitComponent(sch, p);
    const w = c ? null : hitWire(sch, p, tol);
    if (c || w) {
      const inSel = c ? st.selection.components.includes(c.id) : st.selection.wires.includes(w!.id);
      if (e.shiftKey || e.metaKey) {
        const toggle = (list: readonly string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
        setSelection(c
          ? { components: toggle(st.selection.components, c.id), wires: st.selection.wires }
          : { components: st.selection.components, wires: toggle(st.selection.wires, w!.id) });
        return;
      }
      const sel: Selection = inSel ? st.selection : c ? { components: [c.id], wires: [] } : { components: [], wires: [w!.id] };
      setSelection(sel);
      drag.current = { kind: 'move', origin: p, base: sch, selection: sel, delta: { x: 0, y: 0 } };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }

    if (!e.shiftKey) setSelection(EMPTY_SELECTION);
    drag.current = { kind: 'marquee', origin: p, additive: e.shiftKey, base: e.shiftKey ? st.selection : EMPTY_SELECTION };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const { sx, sy } = local(e);
    const d = drag.current;
    const st = editor();
    if (d?.kind === 'pan') {
      setUserView({ ...d.view, x: d.view.x + sx - d.sx, y: d.view.y + sy - d.sy });
      return;
    }
    const p = toWorld(st.view, sx, sy);
    if (d?.kind === 'move') {
      const delta = { x: Math.round(p.x - d.origin.x), y: Math.round(p.y - d.origin.y) };
      if (delta.x === d.delta.x && delta.y === d.delta.y) return;
      d.delta = delta;
      if (d.click) setSelection(d.selection);
      const next = delta.x === 0 && delta.y === 0 ? null : moveSelection(d.base, d.selection, delta);
      if (next === d.base) {
        // Refused here (the wires would short other pins): the parts stay at the last good place; say it once.
        if (!d.refused) notify(MOVE_REFUSED_MESSAGE, 'info');
        d.refused = true;
      } else {
        patchEditor({ preview: next });
      }
      setCursor('grabbing');
      return;
    }
    if (d?.kind === 'marquee') {
      patchEditor({ marquee: rectFrom(d.origin, p) });
      return;
    }
    if (d) return;
    hover(p, e.target);
  };

  const hover = (p: Point, target: EventTarget | null) => {
    if ((target as HTMLElement | null)?.closest?.('.sch-overlay-ui')) return;
    const st = editor();
    const app = getApp();
    const sch = app.project.schematic;
    const s = snapToGrid(p);
    const tol = tolerance(st.view.k);
    const locked = app.sim.status === 'running';
    if (space.current) {
      setCursor('grab');
      return;
    }
    if (st.tool === 'place') {
      if (!st.ghostAt || !pointsEqual(st.ghostAt, s)) patchEditor({ ghostAt: s });
      setCursor('copy');
      return;
    }
    if (st.wireDraft) {
      const pin = hitPin(sch, p, tol);
      const onWire = pin ? null : hitWire(sch, p, tol);
      const cursor = pin?.at ?? onWire?.at ?? s;
      if (!pointsEqual(st.wireDraft.cursor, cursor)) patchEditor({ wireDraft: { ...st.wireDraft, cursor }, hoverPoint: pin || onWire ? cursor : null });
      setCursor('crosshair');
      return;
    }
    const act = hitActuator(sch, p);
    // While stopped, a click on a LOGICSTATE or on the torch +/- sets the initial state (BUTTON has none).
    if (act && (app.sim.status !== 'stopped' || act.actuator.action !== 'press')) {
      updateHover(null);
      setCursor('pointer');
      return;
    }
    if (!locked) {
      const pin = hitPin(sch, p, tol);
      if (pin) {
        updateHover(pin.at);
        setCursor('crosshair');
        return;
      }
      if (st.tool === 'wire') {
        updateHover(hitWire(sch, p, tol)?.at ?? null);
        setCursor('crosshair');
        return;
      }
    }
    updateHover(null);
    setCursor(!locked && (hitComponent(sch, p) || hitWire(sch, p, tol)) ? 'move' : '');
  };

  const updateHover = (pt: Point | null) => {
    const cur = editor().hoverPoint;
    if (cur === pt || (cur && pt && pointsEqual(cur, pt))) return;
    patchEditor({ hoverPoint: pt });
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.kind === 'pan') setCursor(space.current ? 'grab' : '');
    else if (d.kind === 'press') getApp().interact(d.componentId, { type: 'release' });
    else if (d.kind === 'move') {
      const preview = editor().preview;
      if (preview && (d.delta.x !== 0 || d.delta.y !== 0)) commit(preview, d.selection);
      else {
        patchEditor({ preview: null });
        d.click?.();
      }
      setCursor(d.click ? 'pointer' : 'move');
    } else if (d.kind === 'marquee') {
      const r = editor().marquee;
      patchEditor({ marquee: null });
      if (!r || (r.w < 0.2 && r.h < 0.2)) return;
      const picked = selectInRect(getApp().project.schematic, r);
      const merge = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];
      setSelection(d.additive
        ? { components: merge(d.base.components, picked.components), wires: merge(d.base.wires, picked.wires) }
        : picked);
    }
  };

  const onPointerLeave = () => {
    if (drag.current) return;
    const st = editor();
    if (st.ghostAt || st.hoverPoint) patchEditor({ ghostAt: null, hoverPoint: null });
  };

  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.sch-overlay-ui')) return;
    if (wireJustFinished.current) {
      wireJustFinished.current = false;
      return;
    }
    const st = editor();
    if (st.wireDraft || st.tool !== 'select') return;
    const { sx, sy } = local(e);
    const p = toWorld(st.view, sx, sy);
    const sch = getApp().project.schematic;
    if (getApp().sim.status !== 'stopped' && hitActuator(sch, p)) return;
    const c = hitComponent(sch, p);
    if (c) {
      setSelection({ components: [c.id], wires: [] });
      patchEditor({ popoverFor: c.id });
    }
  };

  // ---------------------------------------------------------------- keyboard

  /** BUTTON held down with Entrée on the canvas (released on keyup or blur). */
  const keyPressed = useRef<string | null>(null);
  const simulatingNow = () => getApp().sim.status !== 'stopped';
  /** Operate the selected interactive part from the keyboard; false when it is not one. */
  const actOnSelected = (id: string, repeat: boolean): boolean => {
    const c = getApp().project.schematic.components.find((x) => x.id === id);
    if (c?.kind === 'LOGICSTATE') {
      if (!repeat) getApp().interact(id, { type: 'toggle' });
      return true;
    }
    if (c?.kind === 'BUTTON') {
      if (!repeat && keyPressed.current !== id) {
        keyPressed.current = id;
        getApp().interact(id, { type: 'press' });
      }
      return true;
    }
    return false;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (isTyping(e.target)) return;
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    const st = editor();
    const locked = getApp().sim.status === 'running';
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    let handled = true;
    if (key === ' ') {
      if (!space.current) {
        space.current = true;
        setCursor('grab');
      }
    } else if (key === 'Escape') {
      if (st.wireDraft || st.tool !== 'select') cancelTool();
      else if (st.popoverFor) patchEditor({ popoverFor: null });
      else setSelection(EMPTY_SELECTION);
    } else if (key === 'Backspace' || key === 'Delete') {
      if (st.wireDraft) {
        if (st.wireDraft.points.length > 1) patchEditor({ wireDraft: { ...st.wireDraft, points: st.wireDraft.points.slice(0, -1) } });
        else cancelTool();
      } else deleteSelected();
    } else if (mod && key === 'z') {
      if (!locked) (e.shiftKey ? redo : undo)();
    } else if (mod && key === 'y') {
      if (!locked) redo();
    } else if (mod && key === 'a') {
      const s = getApp().project.schematic;
      setSelection({ components: s.components.map((c) => c.id), wires: s.wires.map((w) => w.id) });
    } else if (mod && key === 'd') {
      if (!locked && !isEmptySelection(st.selection)) {
        const r = duplicateSelection(getApp().project.schematic, st.selection, { x: 2, y: 2 });
        commit(r.schematic, r.selection);
      }
    } else if (mod) {
      handled = false;
    } else if (key === 'r') {
      rotateOrMirror(e.shiftKey ? 'rotateBack' : 'rotate');
    } else if (key === 'm') {
      rotateOrMirror('mirror');
    } else if (key === 'w') {
      if (!locked) patchEditor({ tool: 'wire', placing: null, ghostAt: null });
    } else if (key === 'v' || key === 's') {
      cancelTool();
    } else if (key === 'f') {
      fitToView();
    } else if (key === '+' || key === '=') {
      zoomBy(1.25);
    } else if (key === '-') {
      zoomBy(0.8);
    } else if (key.startsWith('Arrow') && !isEmptySelection(st.selection) && !locked) {
      const step = e.shiftKey ? 5 : 1;
      const delta = { x: key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0, y: key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0 };
      const base = getApp().project.schematic;
      const next = moveSelection(base, st.selection, delta);
      if (next === base) notify(MOVE_REFUSED_MESSAGE, 'info');
      else commit(next);
    } else if (key === 'Enter' && st.selection.components.length === 1 && simulatingNow() && actOnSelected(st.selection.components[0], e.repeat)) {
      // While simulating, Entrée on a selected LOGICSTATE toggles it, and on a BUTTON presses it until keyup.
    } else if (key === 'Enter' && st.selection.components.length === 1) {
      patchEditor({ popoverFor: st.selection.components[0] });
    } else {
      handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && keyPressed.current) {
      getApp().interact(keyPressed.current, { type: 'release' });
      keyPressed.current = null;
    }
    if (e.key === ' ') {
      space.current = false;
      setCursor('');
    }
  };

  // ---------------------------------------------------------------- drag & drop from the palette

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('application/x-pic-part')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const { sx, sy } = local(e);
    const s = snapToGrid(toWorld(editor().view, sx, sy));
    const g = editor().ghostAt;
    if (!g || !pointsEqual(g, s)) patchEditor({ ghostAt: s });
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const st = editor();
    if (!e.dataTransfer.types.includes('application/x-pic-part') || !st.placing) return;
    e.preventDefault();
    const { sx, sy } = local(e);
    const s = snapToGrid(toWorld(st.view, sx, sy));
    const sch = getApp().project.schematic;
    if (getApp().sim.status === 'running') {
      notify('Arrêtez ou mettez en pause la simulation pour modifier le schéma.', 'info');
    } else if (st.placing.kind === 'PIC16F84A' && sch.components.some((c) => c.kind === 'PIC16F84A')) {
      notify('Un seul PIC16F84A par schéma : le simulateur n’en utilise qu’un.', 'info');
    } else {
      const c = makeComponent(sch, st.placing, s);
      commit(addComponent(sch, c), { components: [c.id], wires: [] });
    }
    patchEditor({ tool: 'select', placing: null, ghostAt: null });
    wrapRef.current?.focus({ preventScroll: true });
  };

  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    if (editor().ghostAt) patchEditor({ ghostAt: null });
  };

  const tip = locked
    ? 'Simulation en cours : le schéma est verrouillé. Cliquez sur les interrupteurs logiques, boutons et torches pour agir, ou atteignez-les avec Tab puis Entrée / Espace.'
    : 'Glissez un composant depuis la palette · cliquez sur une broche pour tirer un fil · R pivoter · M miroir · ⌫ supprimer · F ajuster';

  return (
    <div
      ref={wrapRef}
      className={`sch-canvas-wrap tool-${tool}${locked ? ' is-locked' : ''}`}
      tabIndex={0}
      role="application"
      aria-label={`Schéma du circuit. ${tip}`}
      aria-roledescription="éditeur de schéma"
      data-autofocus
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerLeave}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={() => {
        space.current = false;
        if (keyPressed.current) {
          getApp().interact(keyPressed.current, { type: 'release' });
          keyPressed.current = null;
        }
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragLeave={onDragLeave}
    >
      <svg
        ref={svgRef}
        className="sch-canvas"
        width={size.w || '100%'}
        height={size.h || '100%'}
        style={{ '--zoom': view.k } as CSSProperties}
        fontFamily="Arial, Helvetica, sans-serif"
      >
        <defs>
          <filter id="sch-glow" x="-1" y="-1" width="3" height="3">
            <feGaussianBlur stdDeviation="0.7" />
          </filter>
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          <GridLayer view={view} w={size.w} h={size.h} />
          <WiresLayer wires={shown.wires} />
          <JunctionsLayer points={netlist.junctions} />
          <ComponentsLayer components={shown.components} rest={!live} />
          {live && liveNetlist && <LiveLayer schematic={schematic} netlist={liveNetlist} />}
          <SelectionLayer schematic={shown} selection={selection} />
          {!simulating && <DanglingLayer points={netlist.dangling} />}
          <WireDraftLayer />
          <HoverLayer />
          <GhostLayer schematicHasPic={hasPic} />
          <MarqueeLayer />
        </g>
      </svg>
      {simulating && <ActuatorButtons />}
      {simulating && <LdrSliders />}
      <PropertiesPopover />
      <ToolHint empty={schematic.components.length === 0} />
    </div>
  );

  /** Click while a wire is being drawn: add a corner, or finish on a pin / a wire / a double-click. */
  function draftClick(p: Point, s: Point, double: boolean): void {
    const st = editor();
    const d = st.wireDraft!;
    const sch = getApp().project.schematic;
    const tol = tolerance(st.view.k);
    const pin = hitPin(sch, p, tol);
    const onWire = pin ? null : hitWire(sch, p, tol);
    const target = pin?.at ?? onWire?.at ?? s;
    const start = d.points[0];
    if (d.points.length === 1 && pointsEqual(target, start)) {
      if (double) cancelTool();
      return; // clicked the start again
    }
    const pts = [...d.points, ...draftRoute(d, target).slice(1)];
    if (pin || onWire || double) {
      wireJustFinished.current = double;
      const next = addWire(sch, pts);
      patchEditor({ wireDraft: null, hoverPoint: null });
      if (next !== sch) commit(next);
      return;
    }
    patchEditor({ wireDraft: { ...d, points: simplifyPolyline(pts), cursor: target } });
  }
}
