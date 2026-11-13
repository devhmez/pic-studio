// The card under a copilot answer that proposes changes: what it will change (parts, pins, code, tests ✓/✗,
// remaining problems) and « Appliquer au projet » / « Ignorer » / « Annuler l'application ».
import { useMemo, useState } from 'react';
import { Icon } from '../shell/icons';
import { useApp } from '../state/store';
import type { ChatMessage, ProposalPayload, ProposalSummary } from './core/messages';
import { projectFingerprint } from './core/turn';
import { getCopilot, useCopilot } from './store';

/**
 * « Annuler l'application » with a guard: when the project changed since the copilot's proposal was applied, the
 * first click only warns (« Vos modifications faites depuis seront perdues ») and a second click undoes. Shared by
 * the bar above the composer and the button on the result card.
 */
export function useUndoGuard(): { available: boolean; confirming: boolean; label: string; onClick(): void; reset(): void } {
  const undo = useCopilot((s) => s.undo);
  // The project object only changes on edits (not on simulation updates): fingerprint it once per change.
  const project = useApp((s) => s.project);
  const changed = useMemo(() => (undo ? projectFingerprint(project) !== undo.fingerprint : false), [project, undo]);
  const [confirming, setConfirming] = useState(false);
  return {
    available: !!undo,
    confirming,
    label: confirming ? 'Revenir quand même' : 'Annuler l’application',
    onClick() {
      if (changed && !confirming) { setConfirming(true); return; }
      setConfirming(false);
      getCopilot().undoApply();
    },
    reset() { setConfirming(false); },
  };
}

const STYLE_TEXT = {
  prof: 'réécrit dans le style du professeur',
  copilote: 'tel qu’écrit par le copilote',
  actuel: 'code actuel conservé',
} as const;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n > 1 ? many : one}`;
}

/** « RA0, RA1, RB0–RB3 » */
export function pinRanges(pins: readonly string[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < pins.length) {
    const port = pins[i].slice(0, 2);
    let j = i;
    while (j + 1 < pins.length && pins[j + 1].slice(0, 2) === port && Number(pins[j + 1].slice(2)) === Number(pins[j].slice(2)) + 1) j++;
    out.push(j - i >= 2 ? `${pins[i]}–${pins[j]}` : pins.slice(i, j + 1).join(', '));
    i = j + 1;
  }
  return out.join(', ');
}

function Verdict({ summary, status }: { summary: ProposalSummary; status: string }) {
  if (status === 'applied') return <span className="cp-chip is-applied"><Icon name="check" size={12} /> Appliquée</span>;
  if (status === 'ignored') return <span className="cp-chip is-muted">Ignorée</span>;
  if (status === 'undone') return <span className="cp-chip is-muted">Application annulée</span>;
  const failed = summary.tests.filter((t) => !t.passed).length;
  const problems = summary.issues.length + failed;
  // Nothing simulated: say so instead of a green « Vérifiée » (the drawer promises tests run in simulation).
  if (problems === 0 && summary.tests.length === 0) return <span className="cp-chip is-muted">Non testée en simulation</span>;
  if (problems === 0) return <span className="cp-chip is-ok"><Icon name="check" size={12} /> Vérifiée</span>;
  return <span className="cp-chip is-warning"><Icon name="warning" size={12} /> {plural(problems, 'point à revoir', 'points à revoir')}</span>;
}

/** What « Appliquer au projet » will replace. */
export function replaceHint(circuit: boolean, code: boolean, changedSince: boolean): string {
  if (circuit && code) return changedSince ? 'Remplace le schéma et le code actuels, y compris vos changements faits depuis la demande (annulable).' : 'Remplace le schéma et le code actuels (annulable).';
  if (circuit) return changedSince ? 'Remplace seulement le schéma ; votre code actuel est gardé tel quel (annulable).' : 'Remplace seulement le schéma ; le code est gardé (annulable).';
  return changedSince ? 'Remplace seulement le code ; votre schéma actuel est gardé tel quel (annulable).' : 'Remplace seulement le code ; le schéma est gardé (annulable).';
}

function appliedText(payload: ProposalPayload | undefined): string {
  const circuit = payload?.circuit !== false; const code = payload?.code !== false;
  if (circuit && code) return 'Le schéma et le code ont été remplacés.';
  return circuit ? 'Le schéma a été remplacé.' : 'Le code a été remplacé.';
}

export function ResultCard({ message }: { message: ChatMessage }) {
  const proposal = message.proposal!;
  const { summary, status, payload } = proposal;
  const undoId = useCopilot((s) => s.undo?.messageId ?? null);
  const busy = useCopilot((s) => s.busy);
  const guard = useUndoGuard();
  const pendingPayload = status === 'pending' ? payload : undefined;
  // The project changed since the request was sent: only the proposed half is replaced, say which one is kept.
  const project = useApp((s) => s.project);
  const changedSince = useMemo(() => (pendingPayload?.base ? projectFingerprint(project) !== pendingPayload.base : false), [project, pendingPayload]);
  const [showParts, setShowParts] = useState(false);
  const passed = summary.tests.filter((t) => t.passed).length;
  const pending = status === 'pending' && !!payload;
  const shownParts = showParts ? summary.parts : summary.parts.slice(0, 4);

  return (
    <section className={`cp-card is-${status}`} aria-label="Proposition du copilote">
      <header className="cp-card-head">
        <strong>Proposition</strong>
        <Verdict summary={summary} status={status} />
      </header>

      <dl className="cp-card-rows">
        {summary.circuitChanged && (
          <div className="cp-card-row">
            <dt>Schéma</dt>
            <dd>
              {plural(summary.parts.length, 'composant', 'composants')} en plus du PIC
              {summary.pins.length > 0 && <> · broches {pinRanges(summary.pins)}</>} · {String(summary.clockMhz).replace('.', ',')} MHz
              {summary.parts.length > 0 && (
                <ul className="cp-parts">
                  {shownParts.map((p) => <li key={p}>{p}</li>)}
                  {summary.parts.length > 4 && (
                    <li>
                      <button type="button" className="cp-link" onClick={() => setShowParts(!showParts)}>
                        {showParts ? 'Réduire' : `+ ${summary.parts.length - 4} autres`}
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </dd>
          </div>
        )}
        <div className="cp-card-row">
          <dt>Code</dt>
          <dd>
            {summary.codeChanged
              ? <>{plural(summary.codeLines, 'ligne', 'lignes')}, {STYLE_TEXT[summary.style]}{summary.changedLines > 0 && summary.changedLines < summary.codeLines ? <> ({plural(summary.changedLines, 'ligne modifiée', 'lignes modifiées')})</> : null}</>
              : 'inchangé'}
          </dd>
        </div>
        <div className="cp-card-row">
          <dt>Tests</dt>
          <dd>
            {summary.tests.length === 0 ? <span className="cp-muted">aucun test</span> : (
              <>
                <span className={passed === summary.tests.length ? 'cp-ok' : 'cp-ko'}>
                  {passed}/{summary.tests.length} réussi{passed > 1 ? 's' : ''} en simulation
                </span>
                <ul className="cp-tests">
                  {summary.tests.map((t, i) => (
                    <li key={i} className={t.passed ? 'is-pass' : 'is-fail'}>
                      <Icon name={t.passed ? 'check' : 'error'} size={12} />
                      <span>
                        {t.description}
                        {!t.passed && t.details.length > 0 && <span className="cp-test-detail">{t.details.join(' ; ')}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </dd>
        </div>
      </dl>

      {summary.issues.length > 0 && (
        <div className="cp-issues" role="note">
          <div className="cp-issues-title"><Icon name="warning" size={13} /> Encore à corriger</div>
          <ul>{summary.issues.map((i, k) => <li key={k}>{i}</li>)}</ul>
          {pending && <p className="cp-muted">Vous pouvez appliquer quand même et corriger dans le schéma ou le code, ou demander au copilote de corriger.</p>}
        </div>
      )}
      {summary.warnings.length > 0 && (
        <details className="cp-details">
          <summary>{plural(summary.warnings.length, 'remarque', 'remarques')}</summary>
          <ul>{summary.warnings.map((w, k) => <li key={k}>{w}</li>)}</ul>
        </details>
      )}
      {payload && (
        <details className="cp-details">
          <summary>Voir le code proposé</summary>
          <pre className="cp-code">{payload.source}</pre>
        </details>
      )}

      {pending && (
        <div className="cp-card-actions">
          <button type="button" className="as-small-button is-primary" disabled={busy} onClick={() => getCopilot().apply(message.id)}>
            <Icon name="check" size={13} /> Appliquer au projet
          </button>
          <button type="button" className="as-small-button" onClick={() => getCopilot().ignore(message.id)}>Ignorer</button>
          <span className="cp-muted cp-card-hint">{replaceHint(payload!.circuit !== false, payload!.code !== false, changedSince)}</span>
        </div>
      )}
      {status === 'applied' && undoId === message.id && guard.available && (
        <div className="cp-card-actions">
          <span className="cp-muted">{guard.confirming ? 'Vos modifications faites depuis seront perdues.' : appliedText(payload)}</span>
          <button type="button" className="as-small-button" onClick={guard.onClick} onBlur={guard.reset}>
            <Icon name="undo" size={13} /> {guard.label}
          </button>
        </div>
      )}
      {status === 'pending' && !payload && <p className="cp-muted">Proposition expirée : redemandez-la au copilote.</p>}
    </section>
  );
}
