// Light-level slider under each TORCH_LDR while simulating (ISIS uses the +/- markers; both work here).
import { memo, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { componentBounds, LDR_LEVEL_OHMS, formatValue } from '@pic/circuit';
import { getApp, useApp } from '../state/store';
import { useEditor } from './editorStore';
import { toScreen } from './viewport';

const MAX_LEVEL = LDR_LEVEL_OHMS.length - 1;

export const LdrSliders = memo(function LdrSliders() {
  const schematic = useApp((s) => s.project.schematic);
  const ldrs = useMemo(() => schematic.components.filter((c) => c.kind === 'TORCH_LDR'), [schematic]);
  const view = useEditor((s) => s.view);
  const levels = useApp(useShallow((s) => ldrs.map((c) => {
    const v = s.sim.snapshot?.visuals[c.id];
    return v?.kind === 'TORCH_LDR' ? v.level : Number(c.props.level ?? 0);
  })));
  if (ldrs.length === 0) return null;
  return (
    <>
      {ldrs.map((c, i) => {
        // Left of the torch, vertically centred on it: the space ISIS leaves free for the light source.
        const b = componentBounds(c);
        const pos = toScreen(view, { x: b.x - 0.6, y: b.y + b.h / 2 });
        const level = levels[i] ?? 0;
        const name = c.ref || c.id;
        return (
          // translate(-100%) puts the pill left of `left`: keep it inside the sheet.
          <div key={c.id} className="sch-overlay-ui sch-ldr-slider" style={{ left: Math.max(pos.x, 124), top: pos.y }}>
            <span className="sch-ldr-icon" aria-hidden="true">☀</span>
            <input
              type="range"
              min={0}
              max={MAX_LEVEL}
              step={1}
              value={level}
              onChange={(e) => getApp().interact(c.id, { type: 'setLevel', level: Number(e.target.value) })}
              aria-label={`Lumière sur ${name} (0 = nuit, ${MAX_LEVEL} = plein jour)`}
              title={`Lumière ${level}/${MAX_LEVEL} — LDR ≈ ${formatValue(LDR_LEVEL_OHMS[level])}Ω`}
            />
            <output>{level}</output>
          </div>
        );
      })}
    </>
  );
});
