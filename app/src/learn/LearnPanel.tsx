// « Comprendre » drawer: offline, deterministic French explanations (no AI) of the current TP, of each simulation
// step, of the course chapters, plus a glossary. Selecting a part on the schematic adds a « Pourquoi ? » card.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { readPref, writePref } from '../debug/useElementWidth';
import { Icon } from '../shell/icons';
import { getApp, useApp } from '../state/store';
import { useLearnContext } from './context';
import { CourseTab } from './CourseTab';
import { GlossaryTab } from './GlossaryTab';
import { installStepRecorder, useStepHistory } from './history';
import { StepTab } from './StepTab';
import { TpTab } from './TpTab';
import { LearnNavContext, type LearnNav, type LearnTab } from './ui';
import { WhyCard } from './WhyCard';
import './learn.css';

// From the first opening on, steps are recorded even while the drawer is closed (history, « Pourquoi ? »).
installStepRecorder();

const TABS: readonly { id: LearnTab; label: string; title: string }[] = [
  { id: 'tp', label: 'Ce TP', title: 'L’énoncé, les composants, les broches et le programme du projet ouvert' },
  { id: 'pas', label: 'Pas à pas', title: 'Explication de chaque pas de la simulation' },
  { id: 'cours', label: 'Cours', title: 'Résumés des chapitres 1 à 6 et révision du DS' },
  { id: 'glossaire', label: 'Glossaire', title: 'Tous les mots du cours, avec leur définition' },
];
const TAB_IDS = TABS.map((t) => t.id);
const TAB_PREF = 'picstudio.learn.tab';

export function LearnPanel() {
  const [tab, setTabState] = useState<LearnTab>(() => readPref(TAB_PREF, TAB_IDS, 'tp'));
  const [term, setTerm] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const ctx = useLearnContext();
  const status = useApp((s) => s.sim.status);
  const hasSteps = useStepHistory((h) => h.entries.length > 0);

  const setTab = useCallback((t: LearnTab) => {
    setTabState(t);
    writePref(TAB_PREF, t);
    scrollRef.current?.scrollTo({ top: 0 });
  }, []);

  const nav = useMemo<LearnNav>(() => ({
    openTerm: (id) => {
      setTerm(id);
      setTabState('glossaire');
      writePref(TAB_PREF, 'glossaire');
    },
    setTab,
  }), [setTab]);

  // Pausing on a step brings the « Pas à pas » explanation forward once per pause.
  const lastStatus = useRef(status);
  useEffect(() => {
    if (lastStatus.current !== 'paused' && status === 'paused' && hasSteps && tab === 'tp') setTab('pas');
    lastStatus.current = status;
  }, [status, hasSteps, tab, setTab]);

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = TAB_IDS.indexOf(tab);
    const next = TAB_IDS[(i + (e.key === 'ArrowRight' ? 1 : TAB_IDS.length - 1)) % TAB_IDS.length];
    setTab(next);
    (e.currentTarget.querySelector(`[data-tab="${next}"]`) as HTMLElement | null)?.focus();
  };

  const clearTerm = useCallback(() => setTerm(null), []);

  return (
    <LearnNavContext.Provider value={nav}>
      <div className="lp-panel">
        <header className="lp-header">
          <div className="lp-header-text">
            <h2 className="lp-title"><Icon name="book" size={15} /> Comprendre</h2>
            <p className="lp-subtitle">Des explications en français pour chaque TP, chaque pas de la simulation et chaque mot du cours.</p>
          </div>
          <button type="button" className="lp-iconbtn" onClick={() => getApp().setLearnOpen(false)} aria-label="Fermer « Comprendre »" title="Fermer">
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="lp-tabs" role="tablist" aria-label="Rubriques" onKeyDown={onTabKey}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              data-tab={t.id}
              id={`lp-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="lp-tabpanel"
              tabIndex={tab === t.id ? 0 : -1}
              className="lp-tab"
              title={t.title}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.id === 'pas' && status === 'paused' && hasSteps && tab !== 'pas' && <span className="lp-tab-dot" aria-label="nouveau pas" />}
            </button>
          ))}
        </div>
        <div className="lp-scroll" ref={scrollRef} role="tabpanel" id="lp-tabpanel" aria-labelledby={`lp-tab-${tab}`}>
          {(tab === 'tp' || tab === 'pas') && <WhyCard ctx={ctx} />}
          {tab === 'tp' && <TpTab ctx={ctx} />}
          {tab === 'pas' && <StepTab ctx={ctx} />}
          {tab === 'cours' && <CourseTab />}
          {tab === 'glossaire' && <GlossaryTab target={term} onTargetShown={clearTerm} />}
        </div>
      </div>
    </LearnNavContext.Provider>
  );
}
