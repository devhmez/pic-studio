// App window: toolbar, 2×2 panel grid, assistant drawer, status bar, template picker modal, toasts.
import { lazy, memo, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getApp, appStore, useApp } from '../state/store';
import { Icon } from './icons';
import { PanelGrid } from './PanelGrid';
import { StatusBar } from './StatusBar';
import { Toolbar } from './Toolbar';
import { dismissToast, notify, useToasts } from './toast';
import { useAutoBuild, useAutosaveFlush, useGlobalShortcuts, useThemeAttribute } from './shortcuts';
import './shell.css';

// Drawers and the template picker are closed at start-up: each loads in its own chunk the first time it opens.
const AssistantPanel = lazy(() => import('../assistant/AssistantPanel').then((m) => ({ default: m.AssistantPanel })));
const LearnPanel = lazy(() => import('../learn/LearnPanel').then((m) => ({ default: m.LearnPanel })));
const CopilotPanel = lazy(() => import('../copilot/CopilotPanel').then((m) => ({ default: m.CopilotPanel })));
const TemplatePicker = lazy(() => import('../templates/TemplatePicker').then((m) => ({ default: m.TemplatePicker })));

/** Placeholder while a lazy part loads (an element, so the template modal never looks empty). */
const loading = <div className="panel-loading" role="status">Chargement…</div>;

/** Built-in list shown only while the real template picker renders nothing (placeholder). */
function TemplateFallbackList() {
  const templates = appStore.templates;
  return (
    <div className="template-fallback">
      <h2>Modèles de TP</h2>
      <ul>
        {templates.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => {
                getApp().loadTemplate(t.id).catch((e: unknown) => notify(e instanceof Error ? e.message : String(e), 'error'));
              }}
            >
              <span className="template-fallback-title">{t.title}</span>
              {t.chapter && <span className="template-fallback-chapter">{t.chapter}</span>}
              {t.description && <span className="template-fallback-desc">{t.description}</span>}
            </button>
          </li>
        ))}
      </ul>
      <div className="template-fallback-actions">
        <button type="button" className="tool-button ghost" onClick={() => getApp().setTemplatePickerOpen(false)}>Fermer</button>
      </div>
    </div>
  );
}

const TemplateModal = memo(function TemplateModal() {
  const open = useApp((s) => s.ui.templatePickerOpen);
  const dialogRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(false);

  useLayoutEffect(() => {
    if (open) setEmpty((slotRef.current?.childElementCount ?? 0) === 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus?.();
  }, [open]);

  if (!open) return null;
  const close = () => getApp().setTemplatePickerOpen(false);
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Modèles de TP"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            close();
          }
        }}
      >
        <div ref={slotRef} className="modal-slot"><Suspense fallback={loading}><TemplatePicker /></Suspense></div>
        {empty && <TemplateFallbackList />}
      </div>
    </div>
  );
});

const AssistantDrawer = memo(function AssistantDrawer() {
  const open = useApp((s) => s.ui.assistantOpen);
  if (!open) return null;
  return (
    <aside className="assistant-drawer" aria-label="Assistant">
      <Suspense fallback={loading}><AssistantPanel /></Suspense>
    </aside>
  );
});

const LearnDrawer = memo(function LearnDrawer() {
  const open = useApp((s) => s.ui.learnOpen);
  if (!open) return null;
  return (
    <aside className="assistant-drawer learn-drawer" aria-label="Comprendre">
      <Suspense fallback={loading}><LearnPanel /></Suspense>
    </aside>
  );
});

const CopilotDrawer = memo(function CopilotDrawer() {
  const open = useApp((s) => s.ui.copilotOpen);
  if (!open) return null;
  return (
    <aside className="assistant-drawer copilot-drawer" aria-label="Copilote">
      <Suspense fallback={loading}><CopilotPanel /></Suspense>
    </aside>
  );
});

const Toasts = memo(function Toasts() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast is-${t.kind}`}>
          <Icon name={t.kind === 'error' ? 'warning' : t.kind === 'success' ? 'check' : 'dot'} size={14} />
          <span>{t.message}</span>
          {t.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                dismissToast(t.id);
                t.action?.run();
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className="icon-button" onClick={() => dismissToast(t.id)} aria-label="Fermer le message">
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
});

export function Shell() {
  useThemeAttribute();
  useGlobalShortcuts();
  useAutoBuild();
  useAutosaveFlush();

  return (
    <div className="shell">
      <Toolbar />
      <div className="shell-body">
        <PanelGrid />
        <AssistantDrawer />
        <LearnDrawer />
        <CopilotDrawer />
      </div>
      <StatusBar />
      <TemplateModal />
      <Toasts />
    </div>
  );
}
