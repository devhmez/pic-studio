// « Glossaire »: searchable definitions (accents and case ignored). Opened on an entry from the term chips.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../shell/icons';
import { glossaryEntry, searchGlossary } from './explain';
import { Chevron, useLearnNav } from './ui';

export function GlossaryTab({ target, onTargetShown }: { target: string | null; onTargetShown(): void }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(target);
  const nav = useLearnNav();
  const results = useMemo(() => searchGlossary(query), [query]);
  const targetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!target) return;
    setQuery('');
    setOpen(target);
    // Wait for the list to render with the entry open, then bring it into view.
    const id = requestAnimationFrame(() => {
      targetRef.current?.scrollIntoView({ block: 'center' });
      onTargetShown();
    });
    return () => cancelAnimationFrame(id);
  }, [target, onTargetShown]);

  return (
    <div>
      <div className="lp-search">
        <div className="lp-search-box">
          <Icon name="search" size={13} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Chercher : TRIS, carry, rebond, pull-up…"
            aria-label="Chercher dans le glossaire"
          />
        </div>
      </div>
      {results.length === 0 && <p className="lp-empty">Aucun mot ne correspond à « {query} ».</p>}
      {results.map((g) => {
        const isOpen = open === g.id;
        return (
          <div key={g.id} className={`lp-entry${target === g.id ? ' is-target' : ''}`} ref={g.id === open ? targetRef : undefined}>
            <button type="button" className="lp-entry-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : g.id)}>
              <Chevron />
              <span className="lp-entry-main">
                <span className="lp-entry-term">{g.term}</span> <span className="lp-badge">{g.category}</span>
                <div className="lp-entry-short">{g.short}</div>
              </span>
            </button>
            {isOpen && (g.body?.length || g.see?.length) ? (
              <div className="lp-entry-body">
                {g.body?.map((b, i) => <p key={i} className="lp-p">{b}</p>)}
                {g.see && g.see.length > 0 && (
                  <div className="lp-terms">
                    <span className="lp-terms-label">Voir aussi :</span>
                    {g.see.map((id) => {
                      const s = glossaryEntry(id);
                      return s ? <button key={id} type="button" className="lp-term" onClick={() => nav.openTerm(id)}>{s.term.replace(/ \(.*\)$/, '')}</button> : null;
                    })}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
