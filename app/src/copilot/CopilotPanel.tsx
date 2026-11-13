// « Copilote » drawer: a French chat that builds the whole project (schéma + code C + tests) from a description or
// an énoncé, through the student's own Claude Code (Mac app only). Every answer is compiled and simulated before it
// is shown; nothing changes in the project until « Appliquer au projet ».
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { getHost } from '../host/bridge';
import { Icon } from '../shell/icons';
import { getApp } from '../state/store';
import { ENONCE_MAX_CHARS } from './core/enonceText';
import type { ChatMessage } from './core/messages';
import type { TurnStage } from './core/turn';
import { formatUsage, modelLabel } from './core/usage';
import { ENONCE_ACCEPT } from './enonce';
import { ResultCard, useUndoGuard } from './ResultCard';
import { errorHelp, getCopilot, useCopilot } from './store';
import '../assistant/assistant.css';
import './copilot.css';

const SUGGESTIONS = [
  'Une LED rouge sur RB0 qui clignote toutes les 500 ms.',
  'Le démultiplexeur 1 vers 4 : L0 sur RA0, L1 sur RA1 (LOGICSTATE), LEDs D0 à D3 sur RB0 à RB3.',
  'Un bouton poussoir sur RA0 allume la LED de RB1 tant qu’il est appuyé.',
];

const NUMBER = new Intl.NumberFormat('fr-FR');

/** 'max' → 'Max', 'pro' → 'Pro'. */
const subscriptionName = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function stageText(stage: TurnStage | null): string {
  if (!stage) return '';
  switch (stage.step) {
    case 'reading': return 'Lecture de l’énoncé…';
    case 'thinking': return 'Le copilote réfléchit…';
    case 'verify': return stage.what === 'compile' ? 'Vérification : compilation…' : 'Vérification : simulation des tests…';
    case 'correcting': return `Correction automatique (${stage.attempt}/${stage.max})…`;
  }
}

// ------------------------------------------------------------------------------------------------ panel

export function CopilotPanel() {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    const c = getCopilot();
    c.syncProject();
    void c.refreshStatus();
  }, []);

  const onDragEnter = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    depth.current += 1;
    setDragging(true);
  };
  const onDragLeave = () => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  };
  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    await getCopilot().attachFile(file.name, new Uint8Array(await file.arrayBuffer()));
  };

  return (
    <div
      className="cp-panel as-panel"
      onDragEnter={onDragEnter}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDragLeave={onDragLeave}
      onDrop={(e) => void onDrop(e)}
    >
      <Header />
      <AvailabilityBanner />
      <Messages />
      <UndoBar />
      <EnonceBox />
      <Composer />
      {dragging && (
        <div className="cp-drop" aria-hidden="true">
          <Icon name="export" size={22} />
          <strong>Déposez l’énoncé ici</strong>
          <span>PDF ou Word (.docx) — le texte sera lu, pas les figures.</span>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ header

function Header() {
  const model = useCopilot((s) => s.model);
  const busy = useCopilot((s) => s.busy);
  const hasMessages = useCopilot((s) => s.messages.length > 0);
  const [confirmNew, setConfirmNew] = useState(false);
  return (
    <header className="as-header cp-header">
      <div className="as-header-text">
        <h2 className="as-title"><Icon name="chat" size={15} /> Copilote</h2>
        <p className="as-subtitle">Décrivez votre TP ou joignez l’énoncé : le copilote prépare le schéma, le code C et des tests, vérifiés en simulation.</p>
        <div className="cp-model" role="radiogroup" aria-label="Modèle">
          <div className="as-seg">
            <button type="button" role="radio" aria-checked={model === 'haiku'} disabled={busy} onClick={() => getCopilot().setModel('haiku')} title="Réponses rapides, consomme peu de votre abonnement">
              Rapide <span className="as-seg-hint">(Haiku)</span>
            </button>
            <button type="button" role="radio" aria-checked={model === 'sonnet'} disabled={busy} onClick={() => getCopilot().setModel('sonnet')} title="Plus fiable sur les TP longs, consomme davantage">
              Plus fiable <span className="as-seg-hint">(Sonnet)</span>
            </button>
          </div>
        </div>
      </div>
      <div className="as-header-tools">
        <button
          type="button" className="as-iconbtn" disabled={!hasMessages}
          onClick={() => { if (confirmNew) { getCopilot().newConversation(); setConfirmNew(false); } else setConfirmNew(true); }}
          onBlur={() => setConfirmNew(false)}
          aria-label="Nouvelle conversation" title={confirmNew ? 'Cliquez encore pour effacer la conversation' : 'Nouvelle conversation'}
        >
          <Icon name={confirmNew ? 'trash' : 'fileNew'} size={14} />
        </button>
        <button type="button" className="as-iconbtn" onClick={() => getApp().setCopilotOpen(false)} aria-label="Fermer le copilote" title="Fermer le copilote">
          <Icon name="close" size={14} />
        </button>
      </div>
      {confirmNew && <p className="cp-confirm-new" role="status">Cliquez encore sur <Icon name="trash" size={11} /> pour commencer une nouvelle conversation (le projet n’est pas modifié).</p>}
    </header>
  );
}

// ------------------------------------------------------------------------------------------------ availability

function AvailabilityBanner() {
  const availability = useCopilot((s) => s.availability);
  if (availability.kind === 'ready') return null;
  if (availability.kind === 'checking') {
    return <div className="cp-availability is-checking" role="status"><span className="cp-spinner" /> Recherche de Claude Code sur ce Mac…</div>;
  }
  if (availability.kind === 'browser') {
    return (
      <div className="as-banner cp-banner" role="note">
        <div className="as-banner-text">
          <Icon name="warning" size={15} />
          <div>
            <strong>Le copilote fonctionne dans l’application Mac</strong>
            <p>Ici (dans le navigateur), il ne peut pas utiliser votre Claude Code. Ouvrez PIC Studio depuis le Dock ou le dossier Applications.</p>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="as-banner cp-banner" role="alert">
      <div className="as-banner-text">
        <Icon name="warning" size={15} />
        <div>
          <strong>Le copilote n’est pas disponible</strong>
          <p>{availability.status.error ?? 'Claude Code ne répond pas.'}</p>
        </div>
      </div>
      <div className="as-banner-actions">
        <button type="button" className="as-small-button" onClick={() => void getCopilot().refreshStatus(true)}>Réessayer</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ messages

function Messages() {
  const messages = useCopilot((s) => s.messages);
  const busy = useCopilot((s) => s.busy);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages.length, busy]);
  return (
    <div className="cp-scroll" aria-live="polite">
      {messages.length === 0 && !busy ? <EmptyState /> : (
        <ol className="cp-messages">
          {messages.map((m) => <Message key={m.id} message={m} />)}
        </ol>
      )}
      {busy && <Progress />}
      <div ref={end} />
    </div>
  );
}

function EmptyState() {
  const ready = useCopilot((s) => s.availability.kind === 'ready');
  return (
    <div className="cp-empty">
      <p><strong>Bonjour !</strong> Dites ce que doit faire votre montage (broches, composants, comportement), ou joignez l’énoncé du TP.</p>
      <p className="cp-muted">Le copilote pose des questions si quelque chose n’est pas clair. Il vérifie sa proposition (compilation et simulation) avant de vous la montrer, et rien ne change dans votre projet tant que vous n’avez pas cliqué sur « Appliquer au projet ».</p>
      <div className="cp-suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" className="cp-suggestion" disabled={!ready} onClick={() => getCopilot().setDraft(s)}>{s}</button>
        ))}
      </div>
    </div>
  );
}

function Paragraphs({ text }: { text: string }) {
  return <>{text.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</>;
}

function Message({ message }: { message: ChatMessage }) {
  if (message.role === 'student') {
    return (
      <li className="cp-msg is-student">
        <div className="cp-bubble">
          <Paragraphs text={message.text} />
          {message.attachment && (
            <span className="cp-attachment">
              <Icon name="fileNew" size={12} /> {message.attachment.name} · {NUMBER.format(message.attachment.chars)} caractères{message.attachment.truncated ? ' (coupé)' : ''}
            </span>
          )}
        </div>
      </li>
    );
  }
  const help = message.error ? errorHelp(message.error.kind) : null;
  return (
    <li className="cp-msg is-copilot">
      <div className="cp-author"><Icon name="chat" size={12} /> Copilote</div>
      {message.text && <div className="cp-text"><Paragraphs text={message.text} /></div>}
      {message.questions && message.questions.length > 0 && (
        <ul className="cp-questions">
          {message.questions.map((q, i) => (
            <li key={i}>
              <span>{q}</span>
              <button type="button" className="cp-link" onClick={() => answerQuestion(q)}>Répondre</button>
            </li>
          ))}
        </ul>
      )}
      {message.proposal && <ResultCard message={message} />}
      {message.error && (
        <div className={`cp-error${message.error.kind === 'cancelled' ? ' is-soft' : ''}`} role={message.error.kind === 'cancelled' ? 'status' : 'alert'}>
          <Icon name={message.error.kind === 'cancelled' ? 'stop' : 'warning'} size={13} />
          <div>
            <p>{message.error.message}</p>
            {help && <p className="cp-muted">{help}</p>}
          </div>
        </div>
      )}
      <Footnote message={message} />
    </li>
  );
}

function Footnote({ message }: { message: ChatMessage }) {
  const parts: ReactNode[] = [];
  if (message.corrections) parts.push(`corrigé automatiquement ${message.corrections === 1 ? 'une fois' : `${message.corrections} fois`}`);
  if (message.usage) {
    const label = modelLabel(message.usage.model);
    parts.push(`${label ? `${label} · ` : ''}${formatUsage(message.usage)}`);
  }
  if (parts.length === 0) return null;
  return <div className="cp-footnote">{parts.join(' · ')}</div>;
}

function answerQuestion(q: string): void {
  const c = getCopilot();
  const prefix = c.draft.trim() ? `${c.draft.trim()}\n` : '';
  c.setDraft(`${prefix}${q.replace(/\s*\?$/, '')} : `);
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.cp-input')?.focus());
}

function useElapsed(active: boolean): number {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return Math.floor((now - start) / 1000);
}

function Progress() {
  const stage = useCopilot((s) => s.stage);
  // The request may belong to another project's conversation (opened meanwhile) or to a conversation just cleared.
  const elsewhere = useCopilot((s) => s.requestSession !== null && s.requestSession !== s.conversation.sessionId);
  const seconds = useElapsed(true);
  const text = elsewhere ? 'Le copilote termine la demande envoyée depuis une autre conversation…' : stageText(stage) || 'Annulation…';
  return (
    <div className="cp-progress" role="status">
      <span className="cp-spinner" />
      <span className="cp-progress-text">{text}{seconds >= 5 ? <span className="cp-muted"> {seconds} s</span> : null}</span>
      <button type="button" className="as-small-button" onClick={() => getCopilot().cancel()}>Annuler</button>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ undo

function UndoBar() {
  const guard = useUndoGuard();
  if (!guard.available) return null;
  return (
    <div className="cp-undo" role="status">
      <Icon name="check" size={13} />
      <span>{guard.confirming ? 'Vos modifications faites depuis seront perdues.' : 'Projet mis à jour par le copilote.'}</span>
      <button type="button" className="as-small-button" onClick={guard.onClick} onBlur={guard.reset}>
        <Icon name="undo" size={13} /> {guard.label}
      </button>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ énoncé

function EnonceBox() {
  const enonce = useCopilot((s) => s.enonce);
  const loading = useCopilot((s) => s.enonceLoading);
  const notice = useCopilot((s) => s.notice);
  if (loading) {
    return <div className="cp-enonce is-loading" role="status"><span className="cp-spinner" /> Lecture de l’énoncé « {loading} »…</div>;
  }
  return (
    <>
      {notice && (
        <div className="cp-notice" role="alert">
          <Icon name="warning" size={13} />
          <span>{notice}</span>
          <button type="button" className="as-iconbtn" onClick={() => getCopilot().dismissNotice()} aria-label="Fermer le message"><Icon name="close" size={12} /></button>
        </div>
      )}
      {enonce && (
        <div className="cp-enonce">
          <div className="cp-enonce-head">
            <Icon name="fileNew" size={13} />
            <strong title={enonce.name}>{enonce.name}</strong>
            <span className="cp-muted">{enonce.pages ? `${enonce.pages} page${enonce.pages > 1 ? 's' : ''} · ` : ''}{NUMBER.format(enonce.text.length)} caractères</span>
            <button type="button" className="as-iconbtn" onClick={() => getCopilot().removeEnonce()} aria-label="Retirer l’énoncé" title="Retirer l’énoncé"><Icon name="close" size={12} /></button>
          </div>
          {enonce.truncated && (
            <p className="cp-enonce-warning">
              <Icon name="warning" size={12} /> Texte coupé à {NUMBER.format(ENONCE_MAX_CHARS)} caractères (le document en compte {NUMBER.format(enonce.originalLength)}). Supprimez ci-dessous ce qui ne concerne pas le TP.
            </p>
          )}
          <p className="cp-muted cp-enonce-note">Vérifiez le texte lu (modifiable). Les figures ne sont pas lues : si les broches ou le montage ne sont que sur un dessin, décrivez-les dans votre message.</p>
          <textarea
            className="as-textarea cp-enonce-text" value={enonce.text} rows={6} spellCheck={false}
            onChange={(e) => getCopilot().setEnonceText(e.target.value)} aria-label="Texte de l’énoncé envoyé au copilote"
          />
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------------------------------------ composer

async function pickEnonce(): Promise<void> {
  const host = getHost();
  if (host) {
    const file = await host.platform.openDocument(ENONCE_ACCEPT);
    if (file) await getCopilot().attachFile(file.name, file.bytes);
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = ENONCE_ACCEPT.join(',');
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (file) void file.arrayBuffer().then((b) => getCopilot().attachFile(file.name, new Uint8Array(b)));
  });
  input.addEventListener('cancel', () => input.remove());
  document.body.appendChild(input);
  input.click();
}

function Composer() {
  const draft = useCopilot((s) => s.draft);
  const busy = useCopilot((s) => s.busy);
  const hasEnonce = useCopilot((s) => !!s.enonce);
  const availability = useCopilot((s) => s.availability);
  const ready = availability.kind === 'ready';
  const canSend = ready && !busy && (draft.trim() !== '' || hasEnonce);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) void getCopilot().send();
    }
  };

  return (
    <div className="cp-composer">
      <textarea
        className="as-textarea cp-input" rows={3} value={draft} disabled={!ready && availability.kind !== 'checking'}
        placeholder={hasEnonce ? 'Ajoutez une précision (facultatif), puis Envoyer…' : 'Décrivez votre montage ou posez une question…'}
        onChange={(e) => getCopilot().setDraft(e.target.value)} onKeyDown={onKeyDown} aria-label="Message au copilote"
      />
      <div className="cp-composer-row">
        <button type="button" className="as-small-button" disabled={busy || !ready} onClick={() => void pickEnonce()} title="PDF ou Word (.docx) ; vous pouvez aussi le glisser ici">
          <Icon name="fileNew" size={13} /> Joindre un énoncé
        </button>
        <span className="cp-composer-hint">Entrée pour envoyer · Maj+Entrée : nouvelle ligne</span>
        {busy ? (
          <button type="button" className="as-small-button" onClick={() => getCopilot().cancel()}>Annuler</button>
        ) : (
          <button type="button" className="as-small-button is-primary" disabled={!canSend} onClick={() => void getCopilot().send()}>Envoyer</button>
        )}
      </div>
      {availability.kind === 'ready' && (
        <div className="cp-status-line">
          Claude Code {availability.status.cliVersion ?? ''}{availability.status.subscription ? ` · abonnement ${subscriptionName(availability.status.subscription)}` : ''} · vos demandes utilisent votre abonnement Claude
        </div>
      )}
    </div>
  );
}
