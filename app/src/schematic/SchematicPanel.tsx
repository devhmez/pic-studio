// Schéma panel: ISIS-style schematic editor with live simulation (see Canvas.tsx for the interactions).
import { memo, useEffect } from 'react';
import { appStore, useApp } from '../state/store';
import { PanelHeaderActions } from '../shell/Panel';
import { Icon, type IconName } from '../shell/icons';
import { MOD } from '../shell/format';
import { SchematicCanvas } from './Canvas';
import { deleteSelected, fitToView, rotateOrMirror } from './commands';
import { isEmptySelection } from './editing';
import {
  cancelTool, isOwnSchematic, patchEditor, pruneSelection, redo, resetHistory, setPaletteOpen, undo, useEditor,
} from './editorStore';
import { Palette } from './Palette';
import './schematic.css';

function HeaderButton({ icon, label, shortcut, onClick, disabled, pressed }: {
  icon: IconName; label: string; shortcut?: string; onClick(): void; disabled?: boolean; pressed?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-button sch-header-button${pressed ? ' is-pressed' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      title={shortcut ? `${label} (${shortcut})` : label}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}

const HeaderActions = memo(function HeaderActions() {
  const tool = useEditor((s) => s.tool);
  const hasSelection = useEditor((s) => s.selection.components.length > 0);
  const anySelection = useEditor((s) => !isEmptySelection(s.selection));
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const paletteOpen = useEditor((s) => s.paletteOpen);
  const locked = useApp((s) => s.sim.status === 'running');
  return (
    <PanelHeaderActions>
      {locked && <span className="sch-lock-badge" title="Mettez en pause (F6) ou arrêtez la simulation pour modifier le schéma"><Icon name="lock" size={12} /> Verrouillé</span>}
      <div className="sch-header-group">
        <HeaderButton icon="sidebar" label={paletteOpen ? 'Masquer la palette' : 'Afficher la palette de composants'} pressed={paletteOpen} onClick={() => setPaletteOpen(!paletteOpen)} />
      </div>
      <div className="sch-header-group">
        <HeaderButton icon="select" label="Sélection" shortcut="V" pressed={tool === 'select'} onClick={cancelTool} />
        <HeaderButton icon="wire" label="Fil (ou cliquer sur une broche)" shortcut="W" pressed={tool === 'wire'} disabled={locked}
          onClick={() => patchEditor({ tool: 'wire', placing: null, ghostAt: null })} />
      </div>
      <div className="sch-header-group">
        <HeaderButton icon="rotate" label="Pivoter de 90°" shortcut="R" disabled={locked || !hasSelection} onClick={() => rotateOrMirror('rotate')} />
        <HeaderButton icon="mirror" label="Miroir" shortcut="M" disabled={locked || !hasSelection} onClick={() => rotateOrMirror('mirror')} />
        <HeaderButton icon="trash" label="Supprimer" shortcut="⌫" disabled={locked || !anySelection} onClick={deleteSelected} />
      </div>
      <div className="sch-header-group">
        <HeaderButton icon="undo" label="Annuler" shortcut={`${MOD}Z`} disabled={locked || !canUndo} onClick={undo} />
        <HeaderButton icon="redo" label="Rétablir" shortcut={`⇧${MOD}Z`} disabled={locked || !canRedo} onClick={redo} />
      </div>
      <HeaderButton icon="fit" label="Ajuster à la fenêtre" shortcut="F" onClick={fitToView} />
    </PanelHeaderActions>
  );
});

/** External schematic changes (template, opened file, assistant): new history, and a new view for a new drawing. */
function useExternalSchematicChanges(): void {
  useEffect(() => appStore.subscribe((s, prev) => {
    const next = s.project.schematic;
    const before = prev.project.schematic;
    if (next === before || isOwnSchematic(next)) return;
    resetHistory();
    pruneSelection(next);
    const kept = new Set(before.components);
    const same = next.components.filter((c) => kept.has(c)).length;
    if (same < Math.max(1, Math.ceil(before.components.length / 2))) fitToView();
  }), []);
}

export function SchematicPanel() {
  useExternalSchematicChanges();
  const paletteOpen = useEditor((s) => s.paletteOpen);
  const stopped = useApp((s) => s.sim.status === 'stopped');
  // Leaving the stopped state cancels a wire or a placement in progress.
  useEffect(() => {
    if (!stopped) patchEditor({ wireDraft: null, preview: null, marquee: null });
  }, [stopped]);
  return (
    <div className="sch-panel">
      <HeaderActions />
      {paletteOpen && <Palette />}
      <SchematicCanvas />
    </div>
  );
}
