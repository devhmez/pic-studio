// « Cours »: chapter summaries (Ch1–Ch6) and the « Révision DS » page, with links to open the matching TP.
import { useState } from 'react';
import { notify } from '../shell/toast';
import { appStore, getApp, useApp } from '../state/store';
import { CHAPTERS, DS_QUESTIONS, ORGANIGRAMME_RULES, type Chapter, type CourseSection } from './explain';
import { Chevron, TermChips } from './ui';

function OpenTemplate({ id }: { id: string }) {
  const t = appStore.templates.find((x) => x.id === id);
  const current = useApp((s) => s.project.templateId === id);
  const [confirm, setConfirm] = useState(false);
  if (!t) return null;
  const open = () => {
    getApp().loadTemplate(id).catch((e: unknown) => notify(e instanceof Error ? e.message : String(e), 'error'));
    setConfirm(false);
  };
  return (
    <div>
      <div className="lp-row">
        <button
          type="button"
          className="lp-button"
          disabled={current}
          onClick={() => (getApp().dirty ? setConfirm(true) : open())}
          title={current ? 'Ce TP est déjà ouvert' : `Ouvrir le circuit, le code et l’organigramme de « ${t.title} »`}
        >
          {current ? 'Ouvert' : 'Ouvrir le TP'}
        </button>
        <span className="lp-muted" style={{ fontSize: 'var(--fs-xs)' }}>{t.title}</span>
      </div>
      {confirm && (
        <div className="lp-confirm" role="alertdialog" aria-label="Remplacer le projet">
          <span>Le projet actuel a des modifications non enregistrées : elles seront remplacées.</span>
          <button type="button" className="lp-button" onClick={() => setConfirm(false)}>Annuler</button>
          <button type="button" className="lp-button is-primary" onClick={open}>Ouvrir quand même</button>
        </div>
      )}
    </div>
  );
}

function SectionView({ s }: { s: CourseSection }) {
  return (
    <div>
      <p className="lp-sub">{s.title}</p>
      {s.paragraphs?.map((p, i) => <p key={i} className="lp-p">{p}</p>)}
      {s.bullets && <ul className="lp-list">{s.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>}
      {s.table && (
        <div className="lp-table-wrap">
          <table className="lp-table">
            <thead><tr>{s.table.head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{s.table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
      {s.code && <code className="lp-code">{s.code}</code>}
    </div>
  );
}

const CHAPTER_TERMS: Readonly<Record<string, readonly string[]>> = {
  ch1: ['harvard', 'risc', 'instructions', 'porta', 'portb'],
  ch2: ['trisa', 'trisb', 'banque', 'define', 'macro', 'gpr'],
  ch3: ['status', 'carry', 'zero', '7seg-bcd', '7seg', 'cycle'],
  ch4: ['w', 'pc', 'pile', 'vecteur', 'flash', 'opcode'],
  ch5: ['interruption', 'gie', 'inte', 'intf', 'intedg', 'front'],
  ch6: ['rbie', 'rbif', 'tmr0', 'prediviseur', 't0if'],
};

function ChapterView({ c, open }: { c: Chapter; open: boolean }) {
  return (
    <details className="lp-section" open={open}>
      <summary>
        <Chevron />
        <span className="lp-chapter-num">{c.number}</span>
        <span className="lp-chapter-head">
          <span>{c.title}</span>
          <span className="lp-chapter-summary">{c.summary}</span>
        </span>
      </summary>
      <div className="lp-section-body">
        {c.status && <p className="lp-tip">{c.status}</p>}
        {c.sections.map((s) => <SectionView key={s.title} s={s} />)}
        <div className="lp-keypoints">
          <p className="lp-kicker">À retenir</p>
          <ul className="lp-list">{c.keyPoints.map((k, i) => <li key={i}>{k}</li>)}</ul>
        </div>
        {c.templates.length > 0 && (
          <>
            <p className="lp-sub">Les TP de ce chapitre</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {c.templates.map((id) => <OpenTemplate key={id} id={id} />)}
            </div>
          </>
        )}
        <TermChips ids={CHAPTER_TERMS[c.id] ?? []} label="Glossaire :" />
      </div>
    </details>
  );
}

export function CourseTab() {
  const templateId = useApp((s) => s.project.templateId);
  const currentChapter = CHAPTERS.find((c) => templateId && c.templates.includes(templateId))?.id;
  return (
    <div>
      <p className="lp-hint">Le cours résumé chapitre par chapitre, avec les corrections des erreurs des supports. Cliquez sur un chapitre pour l’ouvrir.</p>
      {CHAPTERS.map((c) => <ChapterView key={c.id} c={c} open={c.id === currentChapter} />)}

      <details className="lp-section">
        <summary>
          <Chevron />
          <span className="lp-chapter-num">DS</span>
          <span className="lp-chapter-head">
            <span>Révision DS</span>
            <span className="lp-chapter-summary">{DS_QUESTIONS.length} questions typiques du DS (QCM et problème) avec des réponses courtes, et les règles de l’organigramme.</span>
          </span>
        </summary>
        <div className="lp-section-body">
          <p className="lp-sub">Les règles de l’organigramme</p>
          <ul className="lp-list">{ORGANIGRAMME_RULES.map((r, i) => <li key={i}>{r}</li>)}</ul>
          <p className="lp-sub">Questions de révision</p>
          <p className="lp-hint">Essayez de répondre avant d’ouvrir la réponse.</p>
          {DS_QUESTIONS.map((q, i) => (
            <details key={i} className="lp-qa">
              <summary><Chevron /><span><span className="lp-badge">{q.topic}</span> {q.question}</span></summary>
              <div className="lp-qa-answer">{q.answer}</div>
            </details>
          ))}
        </div>
      </details>
    </div>
  );
}
