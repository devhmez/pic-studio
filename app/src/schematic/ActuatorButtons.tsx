// Keyboard access to the interactive parts while simulating: one focusable (but mouse-transparent) button over
// each LOGICSTATE and BUTTON of the schematic. Tab reaches them; Entrée / Espace toggles a LOGICSTATE, and holding
// Espace (or Entrée) on a BUTTON keeps it pressed until the key is released. Mouse clicks still go to the canvas.
import { memo, useMemo, useRef, type KeyboardEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { componentBounds, type ComponentInstance } from '@pic/circuit';
import { getApp, useApp } from '../state/store';
import { useEditor } from './editorStore';
import { toScreen } from './viewport';

const isActivation = (e: KeyboardEvent): boolean => e.key === ' ' || e.key === 'Enter';

/** Current level of each interactive part: live while simulating, else the schematic's initial state. */
function useStates(parts: readonly ComponentInstance[]): (0 | 1)[] {
  return useApp(useShallow((s) => parts.map((c): 0 | 1 => {
    const v = s.sim.snapshot?.visuals[c.id];
    if (v?.kind === 'LOGICSTATE') return v.state;
    if (v?.kind === 'BUTTON') return v.pressed ? 1 : 0;
    return c.kind === 'LOGICSTATE' && Number(c.props.state) === 1 ? 1 : 0;
  })));
}

export const ActuatorButtons = memo(function ActuatorButtons() {
  const schematic = useApp((s) => s.project.schematic);
  const parts = useMemo(() => schematic.components.filter((c) => c.kind === 'LOGICSTATE' || c.kind === 'BUTTON'), [schematic]);
  const view = useEditor((s) => s.view);
  const states = useStates(parts);
  /** BUTTONs held down from the keyboard (released on keyup or when focus leaves). */
  const held = useRef(new Set<string>());

  if (parts.length === 0) return null;

  const release = (id: string) => {
    if (!held.current.delete(id)) return;
    getApp().interact(id, { type: 'release' });
  };

  return (
    <div className="sch-actuators" role="group" aria-label="Entrées du circuit (simulation)">
      {parts.map((c, i) => {
        const b = componentBounds(c);
        const tl = toScreen(view, { x: b.x, y: b.y });
        const br = toScreen(view, { x: b.x + b.w, y: b.y + b.h });
        const name = c.ref || c.id;
        const state = states[i] ?? 0;
        const style = { left: tl.x, top: tl.y, width: Math.max(12, br.x - tl.x), height: Math.max(12, br.y - tl.y) };
        // Keys must not reach the canvas (Espace would start panning, Entrée open the properties).
        if (c.kind === 'LOGICSTATE') {
          return (
            <button
              key={c.id}
              type="button"
              className="sch-actuator"
              style={style}
              aria-pressed={state === 1}
              aria-label={`Interrupteur ${name} : ${state}. Entrée ou Espace pour le basculer`}
              title={`${name} = ${state} — Entrée ou Espace pour basculer`}
              onClick={() => getApp().interact(c.id, { type: 'toggle' })}
              onKeyDown={(e) => { if (isActivation(e)) e.stopPropagation(); }}
              onKeyUp={(e) => { if (isActivation(e)) e.stopPropagation(); }}
            />
          );
        }
        return (
          <button
            key={c.id}
            type="button"
            className="sch-actuator"
            style={style}
            aria-pressed={state === 1}
            aria-label={`Bouton poussoir ${name}${state === 1 ? ' (appuyé)' : ''}. Maintenir Espace ou Entrée pour appuyer`}
            title={`${name} — maintenir Espace ou Entrée pour appuyer`}
            onKeyDown={(e) => {
              if (!isActivation(e)) return;
              e.preventDefault();
              e.stopPropagation();
              if (e.repeat || held.current.has(c.id)) return;
              held.current.add(c.id);
              getApp().interact(c.id, { type: 'press' });
            }}
            onKeyUp={(e) => {
              if (!isActivation(e)) return;
              e.preventDefault();
              e.stopPropagation();
              release(c.id);
            }}
            onBlur={() => release(c.id)}
          />
        );
      })}
    </div>
  );
});
