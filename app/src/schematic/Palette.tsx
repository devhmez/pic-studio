// Component palette: search, click to place (then click on the sheet), or drag onto the sheet.
import { memo, useMemo, useState, type DragEvent } from 'react';
import { getSymbol } from '@pic/circuit';
import { Icon } from '../shell/icons';
import { useApp } from '../state/store';
import { cancelTool, editor, patchEditor, setPaletteOpen, useEditor } from './editorStore';
import { searchPalette, type PaletteItem } from './parts';
import { SymbolThumb } from './SymbolGraphic';

const PaletteEntry = memo(function PaletteEntry({ item, active, disabled }: { item: PaletteItem; active: boolean; disabled: boolean }) {
  const symbol = useMemo(() => getSymbol(item.spec.kind, item.spec.props), [item]);
  const pick = () => {
    if (active) cancelTool();
    else patchEditor({ tool: 'place', placing: { ...item.spec }, wireDraft: null, popoverFor: null });
    (document.querySelector('.sch-canvas-wrap') as HTMLElement | null)?.focus({ preventScroll: true });
  };
  const onDragStart = (e: DragEvent<HTMLButtonElement>) => {
    e.dataTransfer.setData('application/x-pic-part', item.key);
    e.dataTransfer.effectAllowed = 'copy';
    patchEditor({ tool: 'place', placing: { ...item.spec }, wireDraft: null, popoverFor: null });
  };
  const onDragEnd = () => {
    // Dropped outside the sheet: forget the placement started by the drag.
    if (editor().tool === 'place' && !editor().ghostAt) cancelTool();
  };
  return (
    <li>
      <button
        type="button"
        className={`palette-item${active ? ' is-active' : ''}`}
        draggable={!disabled}
        disabled={disabled}
        onClick={pick}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        aria-pressed={active}
        title={`${item.label} (${item.isis}) — cliquer puis cliquer sur le schéma, ou glisser`}
      >
        <SymbolThumb symbol={symbol} size={30} />
        <span className="palette-text">
          <span className="palette-label">{item.label}</span>
          <span className="palette-isis">{item.isis}</span>
        </span>
      </button>
    </li>
  );
});

export const Palette = memo(function Palette() {
  const [query, setQuery] = useState('');
  const items = useMemo(() => searchPalette(query), [query]);
  const placing = useEditor((s) => (s.tool === 'place' ? s.placing : null));
  const locked = useApp((s) => s.sim.status === 'running');
  const activeKey = placing
    ? items.find((i) => i.spec.kind === placing.kind && (i.spec.props?.color ?? null) === (placing.props?.color ?? null))?.key
    : undefined;

  const groups = useMemo(() => {
    const out = new Map<string, PaletteItem[]>();
    for (const item of items) out.set(item.group, [...(out.get(item.group) ?? []), item]);
    return [...out.entries()];
  }, [items]);

  return (
    <aside className="sch-palette" aria-label="Composants">
      <div className="palette-search">
        <Icon name="search" size={13} />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
            if (e.key === 'Enter' && items[0] && !locked) patchEditor({ tool: 'place', placing: { ...items[0].spec } });
          }}
          placeholder="Rechercher (LED, bouton…)"
          aria-label="Rechercher un composant"
          spellCheck={false}
        />
        <button type="button" className="icon-button" onClick={() => setPaletteOpen(false)} aria-label="Masquer la palette" title="Masquer la palette">
          <Icon name="sidebar" size={13} />
        </button>
      </div>
      {locked && <p className="palette-note"><Icon name="lock" size={12} /> Schéma verrouillé pendant la simulation</p>}
      <div className="palette-scroll">
        {groups.map(([group, list]) => (
          <section key={group}>
            <h3 className="palette-group">{group}</h3>
            <ul>
              {list.map((item) => <PaletteEntry key={item.key} item={item} active={item.key === activeKey} disabled={locked} />)}
            </ul>
          </section>
        ))}
        {items.length === 0 && <p className="palette-empty">Aucun composant ne correspond à « {query} ».</p>}
      </div>
    </aside>
  );
});
