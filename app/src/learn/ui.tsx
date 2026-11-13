// Small building blocks shared by the « Comprendre » tabs.
import { createContext, useContext, type ReactNode } from 'react';
import { Icon } from '../shell/icons';
import { glossaryEntry } from './explain';

export type LearnTab = 'tp' | 'pas' | 'cours' | 'glossaire';

export interface LearnNav {
  /** Show a glossary entry (switches to the « Glossaire » tab). */
  openTerm(id: string): void;
  setTab(tab: LearnTab): void;
}

export const LearnNavContext = createContext<LearnNav>({ openTerm: () => {}, setTab: () => {} });

export function useLearnNav(): LearnNav {
  return useContext(LearnNavContext);
}

export function Chevron() {
  return <Icon name="chevronDown" size={12} className="lp-chev" />;
}

/** Collapsible card (native <details>). */
export function Section({ title, count, open, children, icon }: { title: ReactNode; count?: ReactNode; open?: boolean; icon?: ReactNode; children: ReactNode }) {
  return (
    <details className="lp-section" open={open}>
      <summary>
        <Chevron />
        {icon}
        <span>{title}</span>
        {count !== undefined && <span className="lp-count">{count}</span>}
      </summary>
      <div className="lp-section-body">{children}</div>
    </details>
  );
}

export function Warn({ children }: { children: ReactNode }) {
  return (
    <div className="lp-warn" role="note">
      <Icon name="warning" size={13} />
      <span>{children}</span>
    </div>
  );
}

/** « Voir aussi : STATUS · C » chips that open glossary entries. */
export function TermChips({ ids, label = 'Glossaire :' }: { ids: readonly string[]; label?: string }) {
  const nav = useLearnNav();
  const entries = [...new Set(ids)].map((id) => glossaryEntry(id)).filter((e): e is NonNullable<typeof e> => !!e);
  if (!entries.length) return null;
  return (
    <div className="lp-terms">
      <span className="lp-terms-label">{label}</span>
      {entries.map((e) => (
        <button key={e.id} type="button" className="lp-term" onClick={() => nav.openTerm(e.id)} title={e.short}>
          {e.term.replace(/ \(.*\)$/, '')}
        </button>
      ))}
    </div>
  );
}

/** C line reference badge (« ligne 25 »). */
export function LineBadge({ line }: { line: number }) {
  return <span className="lp-badge is-line" title={`Ligne ${line} du code C`}>ligne {line}</span>;
}
