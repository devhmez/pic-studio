// « Organigramme » panel: the charts of the current program in the prof's style (or black & white), one tab per
// chart (programme principal, interruption, sous-programmes), zoom / fit, click a box → its C lines in the Code panel,
// the box being executed outlined while the simulation is paused, and SVG / PNG / PDF exports.
import type { DiagramNode } from '@pic/organigramme';
import type { Program } from '@pic/program-model';
import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { selectPausedLine } from '../debug/running';
import { HeaderActions } from '../debug/PanelChrome';
import { useElementWidth } from '../debug/useElementWidth';
import { exportOrganigramme, type ChartFormat } from '../export/actions';
import { Icon } from '../shell/icons';
import { getApp, useApp } from '../state/store';
import type { AppStore, OrganigrammeStyle } from '../state/types';
import { codeLinkFor, codeRangeForRefs, refsAtLine, resolveChartSource, type ChartOrigin, type LineRange } from './charts';
import { revealCodeLines } from './codeLink';
import { chartsFor } from './render';
import { setChartPrefs, useChartPrefs } from './prefs';
import '../debug/chrome.css';
import './organigramme.css';

// ------------------------------------------------------------------------------------------------ selectors

const selectProjectFields = (s: AppStore) => ({
  program: s.project.program,
  sourceOrigin: s.project.sourceOrigin,
  name: s.project.name,
  clockHz: s.project.clockHz,
  source: s.project.source,
  style: s.project.organigrammeStyle,
  templateId: s.project.templateId ?? '',
  fileName: s.fileName ?? '',
});


// ------------------------------------------------------------------------------------------------ zoom

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2, 3];
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 4;
const PAD = 24;

type FitMode = 'width' | 'page' | null;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function useElementSize(ref: RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize((prev) => (prev.w === el.clientWidth && prev.h === el.clientHeight ? prev : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

// ------------------------------------------------------------------------------------------------ small controls

function SlidersIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </svg>
  );
}

interface PopoverButtonProps {
  label: string;
  title: string;
  icon: ReactNode;
  text?: string;
  children: (close: () => void) => ReactNode;
}

/**
 * Icon button opening a small menu below it; closes on outside click and Escape. The menu is portaled to <body>
 * with fixed positioning: the shell's panel header clips its overflow.
 */
function PopoverButton({ label, title, icon, text, children }: PopoverButtonProps) {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const open = pos !== null;
  const close = useCallback(() => setPos(null), []);
  const toggle = () => {
    if (open) { close(); return; }
    const r = button.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !button.current?.contains(t)) close();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
      button.current?.focus();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  }, [open]);
  return (
    <>
      <button ref={button} type="button" className="pcx-iconbtn" aria-label={label} title={title} aria-expanded={open} aria-haspopup="menu" onClick={toggle}>
        {icon}
        {text && <span>{text}</span>}
      </button>
      {pos && createPortal(
        <div ref={menu} className="org-pop" role="menu" aria-label={label} style={{ top: pos.top, right: pos.right }}>{children(close)}</div>,
        document.body,
      )}
    </>
  );
}

// ------------------------------------------------------------------------------------------------ panel

interface Display {
  program: Program;
  origin: ChartOrigin;
  notes: readonly string[];
  /** The code does not compile: this is the last chart that did (or the assistant's model). */
  greyed: boolean;
}

interface Selection {
  chartId: string;
  nodeId: string;
  refs: string[];
  range: LineRange | null;
}

export function OrganigrammePanel() {
  const f = useApp(useShallow(selectProjectFields));
  const result = useApp((s) => s.compile.result);
  // C line of the paused core, mapped onto the edited text when the simulator still runs the previous program.
  const execLine = useApp(selectPausedLine);
  const prefs = useChartPrefs();
  const rootRef = useRef<HTMLDivElement>(null);
  /** The header lives in the shell's panel header: shorten its labels in narrow panels. */
  const panelWidth = useElementWidth(rootRef);
  const compact = panelWidth > 0 && panelWidth < 560;
  /** Very narrow: the style switch moves into the options menu. */
  const tiny = panelWidth > 0 && panelWidth < 400;

  // ---- what to draw ------------------------------------------------------------------------------------------
  const resolved = useMemo(
    () => resolveChartSource({ program: f.program, sourceOrigin: f.sourceOrigin, name: f.name, clockHz: f.clockHz }, result),
    [f.program, f.sourceOrigin, f.name, f.clockHz, result],
  );
  const projectKey = `${f.fileName}|${f.templateId}`;
  const lastGood = useRef<{ key: string; display: Display } | null>(null);
  let display: Display | null = null;
  if (resolved && !resolved.stale) {
    display = { program: resolved.program, origin: resolved.origin, notes: resolved.notes, greyed: false };
    // Idempotent: remembered so a compile error keeps showing the last good chart (greyed).
    lastGood.current = { key: projectKey, display };
  } else if (lastGood.current?.key === projectKey) {
    display = { ...lastGood.current.display, greyed: true };
  } else if (resolved) {
    display = { program: resolved.program, origin: resolved.origin, notes: resolved.notes, greyed: true };
  }
  const program = display?.program ?? null;

  const charts = useMemo(() => (program ? chartsFor(program, f.style, prefs) : []), [program, f.style, prefs]);
  const [tab, setTab] = useState('main');
  const chart = charts.find((c) => c.id === tab) ?? charts[0] ?? null;

  // ---- chart ↔ code -----------------------------------------------------------------------------------------
  const link = useMemo(() => (program && !display?.greyed ? codeLinkFor(program, f.source) : null), [program, display?.greyed, f.source]);
  const [selection, setSelection] = useState<Selection | null>(null);

  const hadSelection = useRef(false);
  hadSelection.current = selection !== null;
  // A new program or another chart invalidates the selection (its ids may be gone): clear the editor lines too.
  useEffect(() => {
    if (!hadSelection.current) return;
    setSelection(null);
    revealCodeLines(null);
  }, [program, chart?.id]);
  useEffect(() => () => {
    if (hadSelection.current) revealCodeLines(null);
  }, []);

  /** Box of the statement being executed while the simulation is paused (innermost statement of the line). */
  const execNode = useMemo(() => {
    if (execLine === null || !chart) return null;
    for (const id of refsAtLine(link, execLine)) {
      const node = chart.diagram.nodes.find((n) => n.shape !== 'junction' && n.refs.includes(id));
      if (node) return node;
    }
    return null;
  }, [execLine, link, chart]);
  const selectedNode = selection && selection.chartId === chart?.id ? chart?.diagram.nodes.find((n) => n.id === selection.nodeId) ?? null : null;
  const svg = chart?.svg ?? '';

  const selectNode = useCallback((node: DiagramNode | null) => {
    if (!node || !chart || node.refs.length === 0) {
      setSelection(null);
      revealCodeLines(null);
      return;
    }
    const range = codeRangeForRefs(link, node.refs);
    setSelection({ chartId: chart.id, nodeId: node.id, refs: node.refs, range });
    revealCodeLines(range);
  }, [chart, link]);

  // ---- zoom -------------------------------------------------------------------------------------------------
  const viewportRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(viewportRef);
  const [fit, setFit] = useState<FitMode>('width');
  const [manualZoom, setManualZoom] = useState(1);
  const cw = chart?.diagram.width ?? 1;
  const ch = chart?.diagram.height ?? 1;
  const zoom = useMemo(() => {
    if (size.w === 0) return 1;
    if (fit === 'width') return clamp((size.w - 2 * PAD) / cw, 0.2, 1.25);
    if (fit === 'page') return clamp(Math.min((size.w - 2 * PAD) / cw, (size.h - 2 * PAD) / ch), ZOOM_MIN, 1.25);
    return manualZoom;
  }, [fit, manualZoom, size.w, size.h, cw, ch]);

  /** Anchor kept under the pointer while zooming with the wheel / pinch. */
  const anchor = useRef<{ x: number; y: number; cx: number; cy: number; from: number } | null>(null);
  const zoomTo = useCallback((next: number, at?: { clientX: number; clientY: number }) => {
    const vp = viewportRef.current;
    const z = clamp(next, ZOOM_MIN, ZOOM_MAX);
    if (vp && at) {
      const r = vp.getBoundingClientRect();
      anchor.current = { x: at.clientX - r.left, y: at.clientY - r.top, cx: vp.scrollLeft + at.clientX - r.left, cy: vp.scrollTop + at.clientY - r.top, from: zoom };
    }
    setFit(null);
    setManualZoom(z);
  }, [zoom]);
  useLayoutEffect(() => {
    const a = anchor.current;
    const vp = viewportRef.current;
    if (!a || !vp) return;
    anchor.current = null;
    const k = zoom / a.from;
    vp.scrollLeft = (a.cx - PAD) * k + PAD - a.x;
    vp.scrollTop = (a.cy - PAD) * k + PAD - a.y;
  }, [zoom]);

  const zoomIn = useCallback(() => zoomTo(ZOOM_STEPS.find((s) => s > zoom + 0.001) ?? ZOOM_MAX), [zoom, zoomTo]);
  const zoomOut = useCallback(() => zoomTo([...ZOOM_STEPS].reverse().find((s) => s < zoom - 0.001) ?? ZOOM_MIN), [zoom, zoomTo]);

  // Ctrl / ⌘ + wheel and trackpad pinch: native listener, React's wheel handlers are passive.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomTo(zoomRef.current * Math.exp(-e.deltaY * 0.0045), e);
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [zoomTo]);

  // ---- events -----------------------------------------------------------------------------------------------
  const nodesWithCode = useMemo(() => chart?.diagram.nodes.filter((n) => n.refs.length > 0 && n.shape !== 'junction') ?? [], [chart]);

  const onStageClick = useCallback((e: MouseEvent<HTMLDivElement>) => {
    const g = (e.target as Element).closest('[data-node]');
    const id = g?.getAttribute('data-node');
    selectNode(id ? chart?.diagram.nodes.find((n) => n.id === id) ?? null : null);
  }, [chart, selectNode]);

  const onViewportKey = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey) return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomIn(); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomOut(); }
    else if (e.key === '0') { e.preventDefault(); setFit('width'); }
    else if (e.key === '9') { e.preventDefault(); setFit('page'); }
    else if (e.key === 'Escape' && selection) { e.preventDefault(); selectNode(null); }
    else if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && nodesWithCode.length > 0) {
      e.preventDefault();
      const i = selection ? nodesWithCode.findIndex((n) => n.id === selection.nodeId) : -1;
      const next = e.key === 'ArrowDown' ? (i + 1) % nodesWithCode.length : (i <= 0 ? nodesWithCode.length - 1 : i - 1);
      selectNode(nodesWithCode[next]);
    }
  }, [zoomIn, zoomOut, selection, selectNode, nodesWithCode]);

  // Keep the selected box in view when it was chosen from the keyboard.
  useEffect(() => {
    if (!selection) return;
    const el = viewportRef.current?.querySelector(`[data-node="${CSS.escape(selection.nodeId)}"]`);
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [selection, svg]);

  const runExport = useCallback((format: ChartFormat, all: boolean) => {
    void exportOrganigramme(format, all ? undefined : chart?.id);
  }, [chart]);

  // ---- render -----------------------------------------------------------------------------------------------
  const style = f.style;
  return (
    <div className="pcx-panel org-panel" ref={rootRef}>
      <HeaderActions title="Organigramme">
        {!tiny && <StyleSwitch style={style} compact={compact} />}
        <span className="pcx-spacer" />
        <PopoverButton label="Options de l’organigramme" title="Options : style, écriture des conditions et des textes" icon={<SlidersIcon />}>
          {() => (
            <div className="org-options">
              {tiny && (
                <>
                  <p className="org-pop-title">Style</p>
                  <StyleSwitch style={style} compact={false} />
                </>
              )}
              <p className="org-pop-title">Conditions des losanges</p>
              <div className="pcx-seg" role="radiogroup" aria-label="Conditions des losanges">
                <button type="button" role="radio" aria-checked={prefs.logic === 'words'} onClick={() => setChartPrefs({ logic: 'words' })}>L0==1 et L1==0</button>
                <button type="button" role="radio" aria-checked={prefs.logic === 'c'} onClick={() => setChartPrefs({ logic: 'c' })}>L0==1 &amp;&amp; L1==0</button>
              </div>
              <p className="org-pop-title">Textes de CONFIGURATION / INITIALISATION</p>
              <div className="pcx-seg" role="radiogroup" aria-label="Textes des sections">
                <button type="button" role="radio" aria-checked={prefs.wording === 'tp'} onClick={() => setChartPrefs({ wording: 'tp' })} title="« RB0,RB1 et RB2 sont des sorties »">Broches nommées</button>
                <button type="button" role="radio" aria-checked={prefs.wording === 'generic'} onClick={() => setChartPrefs({ wording: 'generic' })} title="« Configurer les entrées. », « Initialiser les sorties »">Général</button>
              </div>
              <p className="org-pop-title">Attentes (while (X == 1);)</p>
              <div className="pcx-seg" role="radiogroup" aria-label="Losange des attentes">
                <button type="button" role="radio" aria-checked={prefs.waits === 'exit'} onClick={() => setChartPrefs({ waits: 'exit' })} title="Le losange porte la condition de sortie : oui continue, non reboucle (comme les autres losanges)">X==0, non reboucle</button>
                <button type="button" role="radio" aria-checked={prefs.waits === 'loop'} onClick={() => setChartPrefs({ waits: 'loop' })} title="Le losange recopie la condition du while : oui reboucle">X==1, oui reboucle</button>
              </div>
              <p className="org-pop-title">Boucles for (répéter N fois)</p>
              <div className="pcx-seg" role="radiogroup" aria-label="Dessin des boucles for">
                <button type="button" role="radio" aria-checked={prefs.counters === 'box'} onClick={() => setChartPrefs({ counters: 'box' })} title="Une seule case : « Led verte clignote 3 fois (0,5 s / 0,5 s) »">Une case</button>
                <button type="button" role="radio" aria-checked={prefs.counters === 'loop'} onClick={() => setChartPrefs({ counters: 'loop' })} title="Le compteur détaillé : i=0, i<3, i=i+1">Compteur détaillé</button>
              </div>
            </div>
          )}
        </PopoverButton>
        <PopoverButton label="Exporter l’organigramme" title="Exporter l’organigramme (PNG, PDF, SVG)" icon={<Icon name="export" size={15} />} text={compact ? undefined : 'Exporter'}>
          {(close) => (
            <ExportMenuItems
              hasChart={!!chart}
              several={charts.length > 1}
              currentTitle={chart?.title ?? ''}
              onExport={(format, all) => { close(); runExport(format, all); }}
            />
          )}
        </PopoverButton>
      </HeaderActions>

      {charts.length > 1 && (
        <div className="org-tabs" role="tablist" aria-label="Organigrammes du programme">
          {charts.map((c) => (
            <button key={c.id} type="button" role="tab" aria-selected={c.id === chart?.id} className="org-tab" onClick={() => setTab(c.id)}>
              {c.title}
            </button>
          ))}
        </div>
      )}

      {display?.greyed && (
        <div className="org-note is-warning" role="status">
          <Icon name="warning" size={13} />
          <span>Le code ne compile pas : voici le dernier organigramme valide. Corrigez le code pour le mettre à jour.</span>
        </div>
      )}
      {display && !display.greyed && display.origin === 'code' && (
        <OriginNote notes={display.notes} />
      )}

      {/* Always mounted: its size observer and wheel listener must outlive « no chart yet ». */}
      <div
        ref={viewportRef}
        className={`org-viewport${display?.greyed ? ' is-greyed' : ''}${chart ? '' : ' is-empty'}`}
        tabIndex={chart ? 0 : -1}
        role="group"
        aria-label={chart
          ? `${chart.title} — cliquer une case pour voir son code. Touches : + et − pour zoomer, 0 pour ajuster à la largeur, 9 pour tout afficher, Alt+↑/↓ pour passer d’une case à l’autre`
          : 'Organigramme'}
        onKeyDown={chart ? onViewportKey : undefined}
      >
        {chart ? (
          <div className="org-canvas" style={{ width: cw * zoom + 2 * PAD, height: ch * zoom + 2 * PAD }}>
            <div className="org-stage" style={{ width: cw * zoom, height: ch * zoom }} onClick={onStageClick}>
              {/* The SVG comes from @pic/organigramme (escaped text, no scripts). */}
              <div className="org-sheet" dangerouslySetInnerHTML={{ __html: svg }} />
              {(selectedNode || execNode) && (
                <svg className="org-overlay" viewBox={`0 0 ${cw} ${ch}`} preserveAspectRatio="none" aria-hidden="true">
                  {execNode && <NodeOutline node={execNode} kind="exec" />}
                  {selectedNode && <NodeOutline node={selectedNode} kind="selected" />}
                </svg>
              )}
            </div>
          </div>
        ) : (
          <EmptyState />
        )}
      </div>

      {chart && (
        <div className="org-footer">
          <span className="org-footer-text" aria-live="polite">
            {selection ? <SelectionText selection={selection} exact={!!link?.exact} /> : execNode ? 'Case entourée en orange : instruction en cours (simulation en pause).' : 'Cliquez sur une case pour voir ses lignes dans le code.'}
          </span>
          <div className="org-zoom" role="group" aria-label="Zoom">
            <button type="button" className="pcx-iconbtn" onClick={zoomOut} aria-label="Zoom arrière" title="Zoom arrière (−)"><Icon name="minus" size={13} /></button>
            <button type="button" className="pcx-iconbtn org-zoom-value pcx-mono" onClick={() => setFit(fit === 'width' ? 'page' : 'width')}
              aria-label={`Zoom ${Math.round(zoom * 100)} %. ${fit === 'width' ? 'Tout afficher' : 'Ajuster à la largeur'}`}
              title={fit === 'width' ? 'Tout afficher (9)' : 'Ajuster à la largeur (0)'}>
              {Math.round(zoom * 100)} %
            </button>
            <button type="button" className="pcx-iconbtn" onClick={zoomIn} aria-label="Zoom avant" title="Zoom avant (+)"><Icon name="plus" size={13} /></button>
            <button type="button" className={`pcx-iconbtn${fit === 'page' ? ' is-primary' : ''}`} onClick={() => setFit('page')} aria-label="Tout afficher" title="Tout afficher (9) — ⌘ + molette pour zoomer"><Icon name="fit" size={14} /></button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Outline drawn over a chart node: the selected box, or the one being executed. */
function NodeOutline({ node, kind }: { node: DiagramNode; kind: 'selected' | 'exec' }) {
  const { x, y, w, h } = node.box;
  const pad = 4;
  const cls = `org-outline is-${kind}`;
  if (node.shape === 'decision') {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const k = Math.hypot(w / 2, h / 2);
    const a = w / 2 + (pad * k) / (h / 2);
    const b = h / 2 + (pad * k) / (w / 2);
    return <polygon className={cls} points={`${cx},${cy - b} ${cx + a},${cy} ${cx},${cy + b} ${cx - a},${cy}`} vectorEffect="non-scaling-stroke" />;
  }
  return <rect className={cls} x={x - pad} y={y - pad} width={w + 2 * pad} height={h + 2 * pad} rx={4} vectorEffect="non-scaling-stroke" />;
}

function StyleSwitch({ style, compact }: { style: OrganigrammeStyle; compact: boolean }) {
  return (
    <div className="pcx-seg org-seg" role="radiogroup" aria-label="Style de l’organigramme">
      <StyleTab style="prof" current={style} label={compact ? 'Cours' : 'Style du cours'} title="Style du cours : CONFIGURATION jaune, INITIALISATION orange, losanges bleus" />
      <StyleTab style="bw" current={style} label={compact ? 'N&B' : 'Noir & blanc'} title="Noir et blanc, pour l’impression" />
    </div>
  );
}

const StyleTab = memo(function StyleTab({ style, current, label, title }: { style: OrganigrammeStyle; current: OrganigrammeStyle; label: string; title: string }) {
  return (
    <button type="button" role="radio" aria-checked={style === current} title={title} onClick={() => getApp().setOrganigrammeStyle(style)}>
      {label}
    </button>
  );
});

function ExportMenuItems({ hasChart, several, currentTitle, onExport }: { hasChart: boolean; several: boolean; currentTitle: string; onExport: (f: ChartFormat, all: boolean) => void }) {
  const item = (format: ChartFormat, all: boolean, label: string, hint: string) => (
    <button key={`${format}${all}`} type="button" role="menuitem" className="org-menu-item" disabled={!hasChart} onClick={() => onExport(format, all)}>
      <span>{label}</span>
      <span className="org-menu-hint">{hint}</span>
    </button>
  );
  return (
    <>
      {several && <p className="org-pop-title">{currentTitle}</p>}
      {item('png', false, 'Image PNG', '300 dpi, pour Word')}
      {item('pdf', false, 'PDF', 'impression ou PDF')}
      {item('svg', false, 'SVG', 'vectoriel')}
      {several && (
        <>
          <p className="org-pop-title">Tous les organigrammes côte à côte</p>
          {item('png', true, 'Image PNG', 'une seule image')}
          {item('pdf', true, 'PDF', 'une seule page')}
          {item('svg', true, 'SVG', 'vectoriel')}
        </>
      )}
    </>
  );
}

function SelectionText({ selection, exact }: { selection: Selection; exact: boolean }) {
  const r = selection.range;
  if (!r) return <>Cette case n’a pas de ligne correspondante dans le code actuel.</>;
  const lines = r.line === r.endLine ? `ligne ${r.line}` : `lignes ${r.line} à ${r.endLine}`;
  return <>Code : {lines}{exact ? '' : ' (position estimée, le code a été modifié)'} — surligné dans le panneau Code. Échap pour effacer.</>;
}

function OriginNote({ notes }: { notes: readonly string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="org-note">
      <Icon name="dot" size={10} />
      <span>Organigramme reconstruit à partir du code C.</span>
      {notes.length > 0 && (
        <>
          <button type="button" className="org-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'Masquer les détails' : `${notes.length} remarque${notes.length > 1 ? 's' : ''}`}
          </button>
          {open && <ul className="org-note-list">{notes.map((n) => <li key={n}>{n}</li>)}</ul>}
        </>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="pcx-empty">
      <strong>Pas encore d’organigramme</strong>
      Écrivez un programme qui compile dans le panneau Code, ou décrivez-le avec l’assistant : l’organigramme se dessine tout seul.
      <div className="org-empty-actions">
        <button type="button" className="org-button" onClick={() => getApp().setAssistantOpen(true)}>
          <Icon name="assistant" size={14} /> Ouvrir l’assistant
        </button>
        <button type="button" className="org-button" onClick={() => getApp().setTemplatePickerOpen(true)}>
          <Icon name="templates" size={14} /> Choisir un modèle de TP
        </button>
      </div>
    </div>
  );
}

