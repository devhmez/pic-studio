// One of the four panels: header (title, panel-specific actions, maximize) + body.
// Panels put their own buttons in the header with <PanelHeaderActions>…</PanelHeaderActions>.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { PanelId } from '../state/types';
import { getApp } from '../state/store';
import { MOD } from './format';
import { Icon } from './icons';

interface PanelContextValue {
  id: PanelId;
  /** Element of the header where <PanelHeaderActions> renders. */
  actionsSlot: HTMLElement | null;
}

const PanelContext = createContext<PanelContextValue | null>(null);

/** Id of the panel the calling component is rendered in (null outside a panel). */
export function usePanelId(): PanelId | null {
  return useContext(PanelContext)?.id ?? null;
}

/** Render children in the current panel's header, left of the maximize button. */
export function PanelHeaderActions({ children }: { children: ReactNode }) {
  const slot = useContext(PanelContext)?.actionsSlot;
  return slot ? createPortal(children, slot) : null;
}

export interface PanelProps {
  id: PanelId;
  title: string;
  /** ⌘ + this digit focuses the panel. */
  shortcut: number;
  focused: boolean;
  maximized: boolean;
  hidden: boolean;
  children: ReactNode;
}

export function Panel({ id, title, shortcut, focused, maximized, hidden, children }: PanelProps) {
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const context = useMemo(() => ({ id, actionsSlot }), [id, actionsSlot]);

  const onHeaderDoubleClick = useCallback((e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('button, input, select, textarea, a, [role="menu"]')) return;
    getApp().toggleMaximize(id);
  }, [id]);

  const focusSelf = useCallback(() => {
    const ui = getApp().ui;
    if (ui.focusedPanel !== id) getApp().focusPanel(id);
  }, [id]);

  return (
    <section
      className={`panel${focused ? ' is-focused' : ''}${maximized ? ' is-maximized' : ''}`}
      data-panel={id}
      aria-label={title}
      hidden={hidden}
      onPointerDownCapture={focusSelf}
      onFocusCapture={focusSelf}
    >
      <header className="panel-header" onDoubleClick={onHeaderDoubleClick}>
        <span className="panel-title" title={`${title} — ${MOD}${shortcut} · double-clic pour agrandir`}>{title}</span>
        <div className="panel-actions" ref={setActionsSlot} />
        <button
          type="button"
          className="icon-button panel-max"
          onClick={() => getApp().toggleMaximize(id)}
          aria-label={maximized ? `Réduire le panneau ${title}` : `Agrandir le panneau ${title}`}
          title={maximized ? 'Revenir aux quatre panneaux (double-clic sur l’en-tête)' : 'Agrandir (double-clic sur l’en-tête)'}
        >
          <Icon name={maximized ? 'minimize' : 'maximize'} size={14} />
        </button>
      </header>
      <div className="panel-body">
        <PanelContext.Provider value={context}>{children}</PanelContext.Provider>
      </div>
    </section>
  );
}
