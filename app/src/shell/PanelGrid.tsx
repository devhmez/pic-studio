// The 2×2 panel grid: left column Schéma / Assembleur, right column Code / Organigramme, with draggable splitters
// (persisted) and one panel maximized at a time.
import { lazy, Suspense, type ReactElement } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { SchematicPanel } from '../schematic/SchematicPanel';
import { DebugPanel } from '../debug/DebugPanel';
import { useApp } from '../state/store';
import type { PanelId } from '../state/types';
import { resetGridLayout, setGridLayout, useGridLayout } from './layout';
import { Panel } from './Panel';
import { PANELS, type PanelInfo } from './panels';
import { Splitter } from './Splitter';

// The code editor (CodeMirror) and the organigramme renderer load in their own chunks, right after the first paint.
const CodePanel = lazy(() => import('../code/CodePanel').then((m) => ({ default: m.CodePanel })));
const OrganigrammePanel = lazy(() => import('../organigramme/OrganigrammePanel').then((m) => ({ default: m.OrganigrammePanel })));

const loading = <div className="panel-loading" role="status">Chargement…</div>;

// Created once: the grid re-renders while a splitter moves, the panels themselves do not.
const CONTENT: Readonly<Record<PanelId, ReactElement>> = {
  schema: <SchematicPanel />,
  code: <Suspense fallback={loading}><CodePanel /></Suspense>,
  asm: <DebugPanel />,
  organigramme: <Suspense fallback={loading}><OrganigrammePanel /></Suspense>,
};

const INFO = Object.fromEntries(PANELS.map((p) => [p.id, p])) as Record<PanelId, PanelInfo>;

export function PanelGrid() {
  const layout = useGridLayout();
  const { focused, maximized } = useApp(useShallow((s) => ({ focused: s.ui.focusedPanel, maximized: s.ui.maximized })));

  const cell = (id: PanelId, basis: number | null) => {
    const hidden = maximized !== null && maximized !== id;
    const style = maximized === id || basis === null ? { flex: '1 1 0' } : { flex: `0 0 ${(basis * 100).toFixed(3)}%` };
    return (
      <div className="panel-cell" style={style} hidden={hidden}>
        <Panel
          id={id}
          title={INFO[id].title}
          shortcut={INFO[id].shortcut}
          focused={focused === id}
          maximized={maximized === id}
          hidden={hidden}
        >
          {CONTENT[id]}
        </Panel>
      </div>
    );
  };

  const leftHidden = maximized !== null && maximized !== 'schema' && maximized !== 'asm';
  const rightHidden = maximized !== null && maximized !== 'code' && maximized !== 'organigramme';
  const split = maximized === null;

  return (
    <main className="panel-grid">
      <div className="panel-column" style={rightHidden ? { flex: '1 1 0' } : { flex: `0 0 ${(layout.col * 100).toFixed(3)}%` }} hidden={leftHidden}>
        {cell('schema', layout.left)}
        {split && (
          <Splitter orientation="horizontal" value={layout.left} label="Séparation Schéma / Assembleur"
            onChange={(v) => setGridLayout({ left: v })} onReset={() => resetGridLayout('left')} />
        )}
        {cell('asm', null)}
      </div>
      {split && (
        <Splitter orientation="vertical" value={layout.col} label="Séparation des colonnes"
          onChange={(v) => setGridLayout({ col: v })} onReset={() => resetGridLayout('col')} />
      )}
      <div className="panel-column" style={{ flex: '1 1 0' }} hidden={rightHidden}>
        {cell('code', layout.right)}
        {split && (
          <Splitter orientation="horizontal" value={layout.right} label="Séparation Code / Organigramme"
            onChange={(v) => setGridLayout({ right: v })} onReset={() => resetGridLayout('right')} />
        )}
        {cell('organigramme', null)}
      </div>
    </main>
  );
}
