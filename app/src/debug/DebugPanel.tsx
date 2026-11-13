// "Assembleur / registres" panel: listing (virtualized, PC + breakpoints), register view (W, PC, STATUS chips,
// stack, SFR, variables, EEPROM) and the program-memory map. Tabs when narrow; listing | details split when wide.
import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ListingLine } from '@pic/compiler';
import { remapAddresses } from '../state/builds';
import { appStore, getApp, useApp } from '../state/store';
import type { SimStatus } from '../state/types';
import { handleDebugKey, SHORTCUTS } from './commands';
import { diffSnapshots, EMPTY_BASELINE, NO_CHANGES, nextBaseline } from './diff';
import { hex0x, hexH } from './format';
import { InterruptIcon } from './icons';
import { HeaderActions } from './PanelChrome';
import { buildListingRows, execLineFor, INTERRUPT_VECTOR, rowIndexByAddr } from './listing';
import { ListingView } from './ListingView';
import { selectShownBuild } from './running';
import { MemoryMapView } from './MemoryMapView';
import { RegistersView } from './RegistersView';
import { StepControls } from './StepControls';
import { readPref, useElementWidth, writePref } from './useElementWidth';
import './chrome.css';
import './DebugPanel.css';

type Tab = 'listing' | 'registres' | 'memoire';

const TABS: readonly { id: Tab; label: string; title: string }[] = [
  { id: 'listing', label: 'Listing', title: 'Code assembleur généré, instruction par instruction' },
  { id: 'registres', label: 'Registres', title: 'W, PC, STATUS, pile, registres spéciaux, variables et EEPROM' },
  { id: 'memoire', label: 'Mémoire', title: 'Carte de la mémoire programme (0000h–03FFh)' },
];
const TAB_IDS = TABS.map((t) => t.id);
const TAB_PREF = 'picstudio.debug.tab';
/** From this width the listing stays visible on the left and the tabs switch the right-hand pane. */
const SPLIT_MIN_WIDTH = 860;
/** Below this width the tabs leave the (crowded) panel header for a slim bar at the top of the panel. */
const TABS_IN_HEADER_MIN_WIDTH = 600;
const EMPTY_LISTING: readonly ListingLine[] = [];
const EMPTY_SYMBOLS: readonly never[] = [];

export function DebugPanel() {
  const result = useApp((s) => s.compile.result);
  const stale = useApp((s) => s.compile.stale);
  const status = useApp((s) => s.sim.status);
  const debug = useApp((s) => s.sim.debug);
  const breakpoints = useApp((s) => s.sim.breakpoints);
  const clockHz = useApp((s) => s.project.clockHz);

  const rootRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(rootRef);
  const split = width >= SPLIT_MIN_WIDTH;

  const [tab, setTabState] = useState<Tab>(() => readPref(TAB_PREF, TAB_IDS, 'listing'));
  const setTab = useCallback((t: Tab) => {
    setTabState(t);
    writePref(TAB_PREF, t);
  }, []);
  const tabs = split ? TABS.filter((t) => t.id !== 'listing') : TABS;
  /** Tab shown: in split mode the listing is always visible, so 'listing' falls back to the registers. */
  const activeTab: Tab = split && tab === 'listing' ? 'registres' : tab;

  // While the simulation holds a program, the listing, the symbols and the PC are those of the program being
  // executed, even after the code was edited (the new build only runs after a reload).
  const shown = useApp(selectShownBuild);
  const showingOld = shown !== result && shown !== null;

  // Breakpoints are numbered like the last good build; translate them when another program is shown.
  const bpBuild = useMemo(() => appStore.breakpointBuild(), [result]); // changes only with compile.result
  const shownBreakpoints = useMemo(
    () => (showingOld && shown && bpBuild && shown !== bpBuild ? remapAddresses(breakpoints, bpBuild, shown) : breakpoints),
    [showingOld, shown, bpBuild, breakpoints],
  );
  const onToggleBreakpoint = useCallback((addr: number) => {
    const app = getApp();
    const target = appStore.breakpointBuild();
    const from = selectShownBuild(app);
    if (!from || !target || from === target) {
      app.toggleBreakpoint(addr);
      return;
    }
    // Toggle the matching instruction of the current build (if that statement still exists).
    const [mapped] = remapAddresses([addr], from, target);
    if (mapped !== undefined) app.toggleBreakpoint(mapped);
  }, []);

  // Listing rows are rebuilt only when a new compile result arrives.
  const listing = shown?.listing ?? EMPTY_LISTING;
  const rows = useMemo(() => buildListingRows(listing), [listing]);
  const rowByAddr = useMemo(() => rowIndexByAddr(rows), [rows]);

  // Live core state: nothing while stopped (the listing is shown statically).
  const live = status === 'stopped' ? null : debug;
  const [baseline, setBaseline] = useState(EMPTY_BASELINE);
  const nextBase = nextBaseline(baseline, debug, status);
  if (nextBase !== baseline) setBaseline(nextBase); // "previous render" pattern: derived during render, StrictMode-safe
  const diff = useMemo(
    () => (status === 'paused' && baseline.cur === debug ? diffSnapshots(baseline.base, baseline.cur) : NO_CHANGES),
    [status, baseline, debug],
  );

  const pc = live ? live.pc : null;
  const execLine = live && shown ? execLineFor(live.pc, live.stack, shown.addrToLine) : null;

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => { handleDebugKey(e); }, []);

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const ids = tabs.map((t) => t.id);
    const i = Math.max(0, ids.indexOf(activeTab));
    const next = ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
    setTab(next);
    (e.currentTarget.querySelector(`[data-tab='${next}']`) as HTMLButtonElement | null)?.focus();
    e.preventDefault();
  };

  const emptyListing = result && !result.ok && !stale
    ? 'Le programme contient des erreurs : corrigez-les dans l’éditeur C pour voir l’assembleur.'
    : undefined;

  const listingView = (
    <ListingView
      rows={rows}
      rowByAddr={rowByAddr}
      pc={pc}
      execLine={execLine}
      breakpoints={shownBreakpoints}
      onToggleBreakpoint={onToggleBreakpoint}
      follow={status === 'paused'}
      running={status === 'running'}
      emptyMessage={emptyListing}
    />
  );

  const detailsView = activeTab === 'memoire' ? (
    <MemoryMapView
      listing={listing}
      pc={pc}
      breakpoints={shownBreakpoints}
      ramBytes={shown?.ok ? shown.usage.ram : null}
      stackDepth={shown?.stackDepth}
    />
  ) : live ? (
    <RegistersView
      debug={live}
      diff={diff}
      symbols={shown?.symbols ?? EMPTY_SYMBOLS}
      addrToLine={shown?.addrToLine ?? null}
      clockHz={clockHz}
      stackDepth={shown?.stackDepth}
    />
  ) : (
    <div className="pcx-empty">
      <strong>Simulation arrêtée</strong>
      Faites un pas (<kbd className="pcx-kbd">{SHORTCUTS.stepInstruction.label}</kbd> instruction,{' '}
      <kbd className="pcx-kbd">{SHORTCUTS.stepLine.label}</kbd> ligne C) ou lancez la simulation pour voir W, STATUS,
      la pile, les registres et la RAM évoluer.
    </div>
  );

  const tabBar = (
    <div className="pcx-seg" role="tablist" aria-label="Vue du panneau Assembleur" onKeyDown={onTabKey}>
      {tabs.map((t) => {
        const selected = activeTab === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            data-tab={t.id}
            id={`dbg-tab-${t.id}`}
            aria-selected={selected}
            aria-controls="dbg-tabpanel"
            tabIndex={selected ? 0 : -1}
            title={t.title}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
  const tabsInHeader = width === 0 || width >= TABS_IN_HEADER_MIN_WIDTH;

  return (
    <div ref={rootRef} className="pcx-panel dbg-panel" onKeyDown={onKeyDown}>
      <HeaderActions title="Assembleur / registres">
        {tabsInHeader && tabBar}
        {tabsInHeader && <span className="pcx-spacer" />}
        {width >= 720 && <SimStateChip status={status} pc={pc} />}
        <StepControls labels={width >= 900} />
      </HeaderActions>

      {!tabsInHeader && <div className="dbg-subbar">{tabBar}</div>}

      {live?.interruptEntry && (
        <div className="dbg-banner" role="status">
          <InterruptIcon />
          <strong>Entrée en interruption → {hexH(INTERRUPT_VECTOR)}</strong>
          <span>
            GIE passe à 0
            {live.stack.length > 0 ? `, l\u2019adresse de retour ${hex0x(live.stack[live.stack.length - 1], 4)} est empilée` : ''}
            {' '}; RETFIE reviendra au programme principal.
          </span>
        </div>
      )}

      {showingOld && (
        <div className="dbg-note" role="status">
          {result && !result.ok
            ? 'Le code modifié contient des erreurs : affichage du programme en cours d’exécution (dernière compilation réussie).'
            : 'Code modifié : affichage du programme en cours d’exécution. Au prochain pas ou ▶, vous pourrez charger le nouveau programme (la simulation repartira du début).'}
        </div>
      )}

      <div className={`dbg-body${split ? ' is-split' : ''}`}>
        {split ? (
          <>
            <div className="dbg-pane dbg-pane-listing">{listingView}</div>
            <div className="dbg-pane dbg-pane-details" id="dbg-tabpanel" role="tabpanel" aria-labelledby={`dbg-tab-${activeTab}`}>
              {detailsView}
            </div>
          </>
        ) : (
          <div className="dbg-pane" id="dbg-tabpanel" role="tabpanel" aria-labelledby={`dbg-tab-${activeTab}`}>
            {activeTab === 'listing' ? listingView : detailsView}
          </div>
        )}
      </div>
    </div>
  );
}

function SimStateChip({ status, pc }: { status: SimStatus; pc: number | null }) {
  if (status === 'stopped') return <span className="pcx-chip dbg-state" title="La simulation est arrêtée">Arrêté</span>;
  if (status === 'running') return <span className="pcx-chip is-accent dbg-state" title="La simulation tourne"><span className="dbg-dot" />En cours</span>;
  return (
    <span className="pcx-chip is-warning dbg-state" title="Simulation en pause : faites un pas ou continuez">
      En pause{pc !== null ? <span className="pcx-mono"> · {hexH(pc)}</span> : null}
    </span>
  );
}
