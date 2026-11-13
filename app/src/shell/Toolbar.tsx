// Top bar: project name, Modèles / Assistant, simulation controls, speed and clock, build status, export, theme.
// On narrow windows the secondary controls move into a « ⋯ » menu so the bar stays on one row:
//   ≤ 1240 px: Nouveau / Ouvrir / Enregistrer, Copilote, Comprendre and the theme;
//   ≤ 980 px: also the speed and clock selectors.
import {
  memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent,
} from 'react';
import { continueOrPause, SHORTCUTS, stepInstruction, stepLine } from '../debug/commands';
import { ExportMenu } from '../export/ExportMenu';
import { getApp, SPEED_MAX, useApp } from '../state/store';
import type { AppState } from '../state/types';
import { CLOCK_OPTIONS, formatClock, formatCount, formatSpeed, MOD, plural } from './format';
import { Icon, type IconName } from './icons';
import { newProject, openProject, saveProject } from './projectFiles';

const SPEED_OPTIONS: readonly number[] = [0.1, 0.25, 1, 2, 10, SPEED_MAX];

// ------------------------------------------------------------------------------------------------ project name

const ProjectName = memo(function ProjectName() {
  const name = useApp((s) => s.project.name);
  const dirty = useApp((s) => s.dirty);
  const fileName = useApp((s) => s.fileName);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);

  const commit = () => getApp().renameProject(draft);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur();
    else if (e.key === 'Escape') {
      const input = e.currentTarget;
      setDraft(name);
      requestAnimationFrame(() => input.blur());
    }
  };

  return (
    <div className="project-name">
      <input
        className="project-name-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        size={Math.max(8, Math.min(40, draft.length + 1))}
        aria-label="Nom du projet"
        title={fileName ? `Projet enregistré dans ${fileName} — cliquer pour renommer` : 'Projet non enregistré (⌘S) — cliquer pour renommer'}
        spellCheck={false}
      />
      {dirty && <span className="dirty-dot" title={`Modifications non enregistrées (${MOD}S)`} aria-label="Modifications non enregistrées" />}
    </div>
  );
});

// ------------------------------------------------------------------------------------------------ buttons

interface ToolButtonProps {
  icon: IconName;
  label: string;
  /** Visible text next to the icon (hidden on narrow windows); defaults to icon only. */
  text?: string;
  shortcut?: string;
  onClick(): void;
  disabled?: boolean;
  pressed?: boolean;
  variant?: 'primary' | 'ghost';
  className?: string;
}

function ToolButton({ icon, label, text, shortcut, onClick, disabled, pressed, variant = 'ghost', className = '' }: ToolButtonProps) {
  return (
    <button
      type="button"
      className={`tool-button ${variant}${text ? ' has-text' : ''} ${className}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      title={shortcut ? `${label} (${shortcut})` : label}
    >
      <Icon name={icon} size={15} />
      {text && <span className="tool-text">{text}</span>}
    </button>
  );
}

const SimControls = memo(function SimControls() {
  const status = useApp((s) => s.sim.status);
  const app = getApp;
  const running = status === 'running';
  return (
    <div className="tool-group sim-controls" role="group" aria-label="Simulation">
      {running ? (
        <ToolButton icon="pause" label="Mettre en pause" text="Pause" shortcut={SHORTCUTS.pause.label} variant="primary" className="run" onClick={continueOrPause} />
      ) : (
        <ToolButton icon="play" label={status === 'paused' ? 'Continuer la simulation' : 'Lancer la simulation'} text={status === 'paused' ? 'Continuer' : 'Lancer'}
          shortcut={`${SHORTCUTS.run.label} ou ${MOD}R`} variant="primary" className="run" onClick={continueOrPause} />
      )}
      <ToolButton icon="stop" label="Arrêter la simulation" shortcut="⇧F5" disabled={status === 'stopped'} onClick={() => app().stop()} />
      <span className="tool-sep" aria-hidden="true" />
      <ToolButton icon="stepLine" label="Pas à pas : ligne C suivante" text="Ligne" shortcut={`${SHORTCUTS.stepLine.label}, ou fn+${SHORTCUTS.stepLine.label} sur Mac`} onClick={stepLine} />
      <ToolButton icon="stepInstr" label="Pas à pas : instruction suivante" text="Instr." shortcut={`${SHORTCUTS.stepInstruction.label}, ou fn+${SHORTCUTS.stepInstruction.label} sur Mac`} onClick={stepInstruction} />
      <ToolButton icon="reset" label="Réinitialiser le PIC (reset)" disabled={status === 'stopped'} onClick={() => app().reset()} />
    </div>
  );
});

const SpeedSelect = memo(function SpeedSelect() {
  const speed = useApp((s) => s.sim.speed);
  const options = SPEED_OPTIONS.includes(speed) ? SPEED_OPTIONS : [...SPEED_OPTIONS, speed].sort((a, b) => a - b);
  return (
    <label className="tool-select" title="Vitesse de simulation (×1 = temps réel)">
      <span className="tool-select-label">Vitesse</span>
      <select
        value={Number.isFinite(speed) ? String(speed) : 'max'}
        onChange={(e) => getApp().setSpeed(e.target.value === 'max' ? SPEED_MAX : Number(e.target.value))}
        aria-label="Vitesse de simulation"
      >
        {options.map((v) => (
          <option key={String(v)} value={Number.isFinite(v) ? String(v) : 'max'}>
            {Number.isFinite(v) ? formatSpeed(v) : 'max'}{v === 1 ? ' (temps réel)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
});

const ClockSelect = memo(function ClockSelect() {
  const clockHz = useApp((s) => s.project.clockHz);
  const options = CLOCK_OPTIONS.includes(clockHz) ? CLOCK_OPTIONS : [...CLOCK_OPTIONS, clockHz].sort((a, b) => a - b);
  return (
    <label className="tool-select" title="Horloge du PIC (Delay_ms et simulation utilisent la même valeur)">
      <span className="tool-select-label">Horloge</span>
      <select value={String(clockHz)} onChange={(e) => getApp().setClock(Number(e.target.value))} aria-label="Horloge du PIC">
        {options.map((hz) => <option key={hz} value={String(hz)}>{formatClock(hz)}</option>)}
      </select>
    </label>
  );
});

// ------------------------------------------------------------------------------------------------ build chip

interface BuildInfo {
  stale: boolean;
  ok: boolean | null;
  errors: number;
  warnings: number;
  words: number;
  ram: number;
}

// Selectors run on every store update (30 per second while simulating): count diagnostics once per compile.
const buildInfoCache = new WeakMap<AppState['compile'], BuildInfo>();

const selectBuild = (s: AppState): BuildInfo => {
  const cached = buildInfoCache.get(s.compile);
  if (cached) return cached;
  const r = s.compile.result;
  let errors = 0;
  let warnings = 0;
  for (const d of r?.diagnostics ?? []) {
    if (d.severity === 'error') errors++;
    else if (d.severity === 'warning') warnings++;
  }
  const info = { stale: s.compile.stale, ok: r ? r.ok : null, errors, warnings, words: r?.usage.rom ?? 0, ram: r?.usage.ram ?? 0 };
  buildInfoCache.set(s.compile, info);
  return info;
};

const BuildChip = memo(function BuildChip() {
  const b = useApp(selectBuild);
  let kind: 'stale' | 'ok' | 'warn' | 'error';
  let text: string;
  let title: string;
  if (b.stale || b.ok === null) {
    kind = 'stale';
    text = 'Modifié';
    title = `Le code a changé depuis la dernière compilation (${MOD}B pour compiler)`;
  } else if (!b.ok) {
    kind = 'error';
    text = plural(Math.max(1, b.errors), 'erreur');
    title = 'La compilation a échoué — cliquer pour voir les erreurs dans le panneau Code';
  } else {
    kind = b.warnings > 0 ? 'warn' : 'ok';
    text = `Compilé · ${plural(b.words, 'mot')}${b.warnings > 0 ? ` · ${plural(b.warnings, 'avertissement')}` : ''}`;
    title = `Programme : ${formatCount(b.words)} mots sur 1024 · RAM : ${formatCount(b.ram)} octets sur 68 — cliquer pour voir le code`;
  }
  const icon: IconName = kind === 'error' ? 'error' : kind === 'warn' ? 'warning' : kind === 'ok' ? 'check' : 'dot';
  return (
    <button
      type="button"
      className={`build-chip is-${kind}`}
      onClick={() => {
        if (kind === 'stale') getApp().build();
        getApp().focusPanel('code');
      }}
      title={title}
      aria-label={`État de la compilation : ${text}`}
    >
      <Icon name={icon} size={13} />
      <span>{text}</span>
    </button>
  );
});

// ------------------------------------------------------------------------------------------------ responsive

/** Window widths below which the secondary controls move into the « ⋯ » menu. */
export const TOOLBAR_COMPACT_QUERY = '(max-width: 1240px)';
export const TOOLBAR_NARROW_QUERY = '(max-width: 980px)';

function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const list = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query) : null;
    list?.addEventListener('change', onChange);
    return () => list?.removeEventListener('change', onChange);
  }, [query]);
  return useSyncExternalStore(
    subscribe,
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}

/** Open state of a toolbar popover: closes on a click outside `wrapRef` and on Escape. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, wrapRef };
}

// ------------------------------------------------------------------------------------------------ export, theme

const ExportButton = memo(function ExportButton() {
  const { open, setOpen, wrapRef } = usePopover();
  const [empty, setEmpty] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (open) setEmpty((menuRef.current?.childElementCount ?? 0) === 0);
  }, [open]);

  return (
    <div className="popover-anchor" ref={wrapRef}>
      <ToolButton icon="export" label="Exporter (.c, .hex, images…)" text="Exporter" pressed={open} onClick={() => setOpen((o) => !o)} />
      {open && (
        <div
          className="popover export-popover"
          role="dialog"
          aria-label="Exporter"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('button, a, [role="menuitem"]')) setOpen(false);
          }}
        >
          <div ref={menuRef} className="export-slot"><ExportMenu /></div>
          {empty && <p className="popover-hint">Les exports (.c pour MikroC, .hex pour ISIS, organigramme, schéma) arrivent bientôt.</p>}
        </div>
      )}
    </div>
  );
});

const THEME_NEXT: Record<AppState['ui']['theme'], AppState['ui']['theme']> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_LABEL: Record<AppState['ui']['theme'], string> = { system: 'Système', light: 'Clair', dark: 'Sombre' };
const THEME_ICON: Record<AppState['ui']['theme'], IconName> = { system: 'system', light: 'sun', dark: 'moon' };

const ThemeToggle = memo(function ThemeToggle() {
  const theme = useApp((s) => s.ui.theme);
  return (
    <ToolButton
      icon={THEME_ICON[theme]}
      label={`Thème : ${THEME_LABEL[theme]} — cliquer pour passer à « ${THEME_LABEL[THEME_NEXT[theme]]} »`}
      onClick={() => getApp().setTheme(THEME_NEXT[theme])}
    />
  );
});

/** Nouveau / Ouvrir / Enregistrer, next to the project name (also on ⌘N, ⌘O, ⌘S). */
const FileButtons = memo(function FileButtons() {
  return (
    <div className="tool-group" role="group" aria-label="Fichier">
      <ToolButton icon="fileNew" label="Nouveau projet : un PIC16F84A et un main() vide" shortcut={`${MOD}N`} onClick={newProject} />
      <ToolButton
        icon="folder"
        label="Ouvrir un projet (.picproj), ou importer un programme MikroC (.c) ou un schéma ISIS (.DSN)…"
        shortcut={`${MOD}O`}
        onClick={() => void openProject()}
      />
      <ToolButton icon="save" label={`Enregistrer le projet — ⇧${MOD}S : enregistrer sous…`} shortcut={`${MOD}S`} onClick={() => void saveProject(false)} />
    </div>
  );
});

/** Modèles and Assistant always; Copilote and Comprendre move to the « ⋯ » menu on a narrow window (unless open). */
const DrawerToggles = memo(function DrawerToggles({ compact }: { compact: boolean }) {
  const assistantOpen = useApp((s) => s.ui.assistantOpen);
  const copilotOpen = useApp((s) => s.ui.copilotOpen);
  const learnOpen = useApp((s) => s.ui.learnOpen);
  return (
    <div className="tool-group" role="group" aria-label="Projet">
      <ToolButton icon="templates" label="Choisir un modèle de TP" text="Modèles" className="text-mid" onClick={() => getApp().setTemplatePickerOpen(true)} />
      <ToolButton icon="assistant" label={assistantOpen ? 'Fermer l’assistant' : 'Ouvrir l’assistant'} text="Assistant" className="text-mid"
        pressed={assistantOpen} onClick={() => getApp().setAssistantOpen(!assistantOpen)} />
      {(!compact || copilotOpen) && (
        <ToolButton icon="chat" label={copilotOpen ? 'Fermer le copilote' : 'Ouvrir le copilote : décrivez votre TP en français'} text="Copilote" className="text-low"
          pressed={copilotOpen} onClick={() => getApp().setCopilotOpen(!copilotOpen)} />
      )}
      {(!compact || learnOpen) && (
        <ToolButton icon="book" label={learnOpen ? 'Fermer « Comprendre »' : 'Comprendre : explications en français'} text="Comprendre" className="text-low"
          pressed={learnOpen} onClick={() => getApp().setLearnOpen(!learnOpen)} />
      )}
    </div>
  );
});

// ------------------------------------------------------------------------------------------------ « ⋯ » menu

interface MenuItemProps {
  icon: IconName;
  label: string;
  shortcut?: string;
  /** Drawer toggles show a check mark while open. */
  checked?: boolean;
  /** Keep the menu open after the click (theme: click again to cycle). */
  keepOpen?: boolean;
  /** Tooltip with more detail. */
  title?: string;
  onClick(): void;
}

function MenuItem({ icon, label, shortcut, checked, keepOpen, title, onClick }: MenuItemProps) {
  const handle = (e: MouseEvent<HTMLButtonElement>) => {
    if (keepOpen) e.stopPropagation();
    onClick();
  };
  return (
    <button
      type="button"
      className="overflow-item"
      role={checked === undefined ? undefined : 'switch'}
      aria-checked={checked}
      title={title}
      onClick={handle}
    >
      <Icon name={icon} size={15} />
      <span className="overflow-label">{label}</span>
      {shortcut && <kbd className="overflow-shortcut">{shortcut}</kbd>}
      {checked !== undefined && <span className={`overflow-check${checked ? ' is-on' : ''}`} aria-hidden="true"><Icon name="check" size={13} /></span>}
    </button>
  );
}

const MoreIcon = () => (
  <svg width={15} height={15} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor">
    <circle cx="5" cy="12" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="19" cy="12" r="1.9" />
  </svg>
);

/** Secondary controls of a narrow window: file actions, the Copilote / Comprendre drawers, the theme (and the selectors). */
const OverflowMenu = memo(function OverflowMenu({ narrow }: { narrow: boolean }) {
  const { open, setOpen, wrapRef } = usePopover();
  const copilotOpen = useApp((s) => s.ui.copilotOpen);
  const learnOpen = useApp((s) => s.ui.learnOpen);
  const theme = useApp((s) => s.ui.theme);
  return (
    <div className="popover-anchor" ref={wrapRef}>
      <button
        type="button"
        className="tool-button ghost overflow-button"
        aria-label="Plus d’actions : fichier, aides, thème"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-pressed={open}
        title="Plus d’actions : fichier, aides, thème"
        onClick={() => setOpen((o) => !o)}
      >
        <MoreIcon />
      </button>
      {open && (
        <div
          className="popover overflow-popover"
          role="dialog"
          aria-label="Plus d’actions"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('button')) setOpen(false);
          }}
        >
          <p className="overflow-heading">Fichier</p>
          <MenuItem icon="fileNew" label="Nouveau projet" shortcut={`${MOD}N`} onClick={newProject} />
          <MenuItem icon="folder" label="Ouvrir…" shortcut={`${MOD}O`} title="Ouvrir un projet (.picproj), ou importer un programme MikroC (.c) ou un schéma ISIS (.DSN)" onClick={() => void openProject()} />
          <MenuItem icon="save" label="Enregistrer" shortcut={`${MOD}S`} onClick={() => void saveProject(false)} />
          <p className="overflow-heading">Aides</p>
          <MenuItem icon="chat" label="Copilote" title="Décrivez votre TP en français" checked={copilotOpen} onClick={() => getApp().setCopilotOpen(!copilotOpen)} />
          <MenuItem icon="book" label="Comprendre" title="Explications en français" checked={learnOpen} onClick={() => getApp().setLearnOpen(!learnOpen)} />
          {narrow && (
            <>
              <p className="overflow-heading">Simulation</p>
              <div className="overflow-selects">
                <SpeedSelect />
                <ClockSelect />
              </div>
            </>
          )}
          <p className="overflow-heading">Affichage</p>
          <MenuItem
            icon={THEME_ICON[theme]}
            label={`Thème : ${THEME_LABEL[theme]}`}
            shortcut={`→ ${THEME_LABEL[THEME_NEXT[theme]]}`}
            title={`Cliquer pour passer au thème « ${THEME_LABEL[THEME_NEXT[theme]]} »`}
            keepOpen
            onClick={() => getApp().setTheme(THEME_NEXT[theme])}
          />
        </div>
      )}
    </div>
  );
});

export function Toolbar() {
  const compact = useMediaQuery(TOOLBAR_COMPACT_QUERY);
  const narrow = useMediaQuery(TOOLBAR_NARROW_QUERY);
  return (
    <header className={`app-toolbar${compact ? ' is-compact' : ''}${narrow ? ' is-narrow' : ''}`} role="toolbar" aria-label="Barre d’outils">
      <div className="toolbar-start">
        <span className="brand" aria-hidden="true">PIC Studio</span>
        <ProjectName />
        {!compact && <FileButtons />}
        <DrawerToggles compact={compact} />
      </div>
      <div className="toolbar-center">
        <SimControls />
        {!narrow && <SpeedSelect />}
        {!narrow && <ClockSelect />}
      </div>
      <div className="toolbar-end">
        <BuildChip />
        <ExportButton />
        {compact ? <OverflowMenu narrow={narrow} /> : <ThemeToggle />}
      </div>
    </header>
  );
}
