// The assistant drawer: describe the circuit's pins and the program's behaviour with blocks; every change rewrites
// the C in the prof's style and the organigramme (both come from the same Program model). When the student edits
// the code by hand the assistant pauses until the model is rebuilt from the code or the code regenerated.
import { buildNetlist } from '@pic/circuit';
import { deriveSignals, fromAstDetailed, validate, type Issue, type Program } from '@pic/program-model';
import { generate } from '@pic/style-c';
import { useCallback, useMemo, useState, type KeyboardEvent } from 'react';
import { Icon } from '../shell/icons';
import { notify } from '../shell/toast';
import { getApp, MINIMAL_SOURCE, useApp } from '../state/store';
import { BlockList } from './BlockList';
import { commitProgram, redo, resetProgram, undo, useHistory } from './commit';
import { AssistantContext, type AssistantContextValue } from './context';
import { Check } from './fields';
import {
  asProgram, computeUsage, finalizeProgram, INIT_LIST, LOOP_LIST, programFromSchematic, setLoopEnabled,
} from './model';
import { InterruptsSection, PinsSection, Section, StyleSection, VariablesSection } from './sections';
import './assistant.css';

const normalizeEol = (s: string) => s.replace(/\r\n?/g, '\n').trimEnd();

/** The code would change if `program` replaced the current source. */
function rewritesCode(program: Program): boolean {
  try {
    return normalizeEol(generate(program)) !== normalizeEol(getApp().project.source);
  } catch {
    return true;
  }
}

/** Program rebuilt from the C code (compiles first when needed). */
function programFromCode(): { program: Program; notes: string[]; withErrors: boolean } | { error: string } {
  const app = getApp();
  const result = app.compile.stale || !app.compile.result ? app.build() : app.compile.result;
  if (!result.ast) return { error: 'Le code ne peut pas être lu : corrigez d’abord les erreurs de syntaxe dans le panneau Code.' };
  const { program, notes } = fromAstDetailed(result.ast, result.source, { title: app.project.name, clockHz: app.project.clockHz });
  return { program: finalizeProgram(program, app.project.clockHz), notes, withErrors: !result.ok };
}

// ------------------------------------------------------------------------------------------------ panel

export function AssistantPanel() {
  const raw = useApp((s) => s.project.program);
  const origin = useApp((s) => s.project.sourceOrigin);
  const program = useMemo(() => asProgram(raw), [raw]);
  /** Another project (template, file, new) starts with fresh editor state (open blocks, selection). */
  const projectKey = useApp((s) => `${s.project.templateId ?? ''}|${s.fileName ?? ''}|${s.project.name}`);
  const { canUndo, canRedo } = useHistory();
  const [notes, setNotes] = useState<string[]>([]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    }
  };

  return (
    <div className="as-panel" onKeyDown={onKeyDown}>
      <header className="as-header">
        <div className="as-header-text">
          <h2 className="as-title"><Icon name="assistant" size={15} /> Assistant</h2>
          <p className="as-subtitle">Décrivez les broches et le comportement : le code C et l’organigramme suivent.</p>
        </div>
        <div className="as-header-tools">
          <button type="button" className="as-iconbtn" onClick={undo} disabled={!canUndo || origin === 'manual'} aria-label="Annuler la dernière modification" title="Annuler (⌘Z)">
            <Icon name="undo" size={14} />
          </button>
          <button type="button" className="as-iconbtn" onClick={redo} disabled={!canRedo || origin === 'manual'} aria-label="Rétablir" title="Rétablir (⇧⌘Z)">
            <Icon name="redo" size={14} />
          </button>
          <button type="button" className="as-iconbtn" onClick={() => getApp().setAssistantOpen(false)} aria-label="Fermer l’assistant" title="Fermer l’assistant">
            <Icon name="close" size={14} />
          </button>
        </div>
      </header>
      <div className="as-scroll">
        {program ? (
          <>
            {origin === 'manual' && <ManualBanner program={program} onNotes={setNotes} />}
            {notes.length > 0 && <ImportNotes notes={notes} onClose={() => setNotes([])} />}
            <Editor key={projectKey} program={program} locked={origin === 'manual'} />
          </>
        ) : (
          <EmptyState onNotes={setNotes} />
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ editor

function Editor({ program, locked }: { program: Program; locked: boolean }) {
  const schematic = useApp((s) => s.project.schematic);
  const clockHz = useApp((s) => s.project.clockHz);
  const netlist = useMemo(() => buildNetlist(schematic), [schematic]);
  const issues = useMemo(() => {
    try {
      // The project clock is the reference (the toolbar may have changed it since the last edit).
      return validate(program.clockHz === clockHz ? program : { ...program, clockHz }, schematic, { netlist });
    } catch {
      return [];
    }
  }, [program, schematic, netlist, clockHz]);
  const usage = useMemo(() => computeUsage(program), [program]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const edit = useCallback((fn: (p: Program) => Program) => {
    const current = asProgram(getApp().project.program);
    if (!current) return;
    const next = fn(current);
    if (next !== current) commitProgram(next);
  }, []);

  const ctx = useMemo<AssistantContextValue>(() => {
    const byStmt = new Map<string, Issue[]>();
    const bySignal = new Map<string, Issue[]>();
    for (const i of issues) {
      if (i.stmtId) byStmt.set(i.stmtId, [...(byStmt.get(i.stmtId) ?? []), i]);
      else if (i.signalId) bySignal.set(i.signalId, [...(bySignal.get(i.signalId) ?? []), i]);
    }
    return { program, edit, issuesByStmt: byStmt, issuesBySignal: bySignal, usage, selectedId, select: setSelectedId };
  }, [program, edit, issues, usage, selectedId]);

  return (
    <AssistantContext.Provider value={ctx}>
      <IssuesSummary issues={issues} onSelect={setSelectedId} locked={locked} />
      <div className={`as-sections${locked ? ' is-locked' : ''}`} inert={locked} aria-disabled={locked || undefined}>
        <PinsSection />
        <VariablesSection />
        <Section id="init" title="Initialisation" count={blocksCount(program.init.length)} hint="Exécutée une seule fois au démarrage, avant la boucle principale (ex. éteindre toutes les LEDs).">
          <BlockList listKey={INIT_LIST} stmts={program.init} inInterrupt={false} empty="Rien au démarrage." />
        </Section>
        <MainLoopSection program={program} />
        <InterruptsSection />
        <StyleSection />
      </div>
    </AssistantContext.Provider>
  );
}

const blocksCount = (n: number) => `${n} bloc${n > 1 ? 's' : ''}`;

function MainLoopSection({ program }: { program: Program }) {
  const loop = program.loop;
  const [confirmOff, setConfirmOff] = useState(false);
  const setEnabled = (on: boolean) => {
    if (!on && (loop?.length ?? 0) > 0 && !confirmOff) {
      setConfirmOff(true);
      return;
    }
    setConfirmOff(false);
    const current = asProgram(getApp().project.program);
    if (current) commitProgram(setLoopEnabled(current, on));
  };
  return (
    <Section
      id="loop"
      title="Boucle principale"
      count={loop ? blocksCount(loop.length) : 'aucune'}
      hint={loop ? 'Répétée sans fin : while(1) { … } — c’est la « Boucle infinie » de l’organigramme.' : 'Sans boucle, le programme s’exécute une fois puis s’arrête (comme EXEMPLE1).'}
    >
      <Check checked={!!loop} onChange={setEnabled} hint="while(1)">Le programme tourne en boucle</Check>
      {confirmOff && (
        <div className="as-confirm" role="alert">
          <span>Les {loop?.length} blocs de la boucle iront à la fin de l’initialisation.</span>
          <button type="button" className="as-small-button" onClick={() => setConfirmOff(false)}>Annuler</button>
          <button type="button" className="as-small-button is-primary" onClick={() => setEnabled(false)}>Retirer la boucle</button>
        </div>
      )}
      {loop && <BlockList listKey={LOOP_LIST} stmts={loop} inInterrupt={false} empty="La boucle est vide : ajoutez ce que le PIC doit faire en permanence." />}
    </Section>
  );
}

// ------------------------------------------------------------------------------------------------ issues

function IssuesSummary({ issues, onSelect, locked }: { issues: readonly Issue[]; onSelect(id: string | null): void; locked: boolean }) {
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  const global = issues.filter((i) => !i.stmtId && !i.signalId && i.severity !== 'info');
  const located = issues.filter((i) => i.stmtId || i.signalId);
  if (issues.length === 0) {
    return (
      <div className="as-status is-ok" role="status">
        <Icon name="check" size={13} /> {locked ? 'Aucun problème dans le modèle.' : 'Aucun problème : le code généré est à jour.'}
      </div>
    );
  }
  const jump = () => {
    const first = located.find((i) => i.severity === 'error') ?? located[0];
    if (!first) return;
    if (first.stmtId) onSelect(first.stmtId);
    const el = document.getElementById(first.stmtId ? `as-stmt-${first.stmtId}` : `as-sig-${first.signalId}`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  const parts = [errors ? `${errors} erreur${errors > 1 ? 's' : ''}` : '', warnings ? `${warnings} avertissement${warnings > 1 ? 's' : ''}` : ''].filter(Boolean);
  return (
    <div className={`as-status ${errors ? 'is-error' : 'is-warning'}`} role="status">
      <div className="as-status-line">
        <Icon name={errors ? 'error' : 'warning'} size={13} />
        <span>{parts.join(', ') || 'Remarques'}{errors ? ' : le code ne compilera pas tant qu’elles restent.' : '.'}</span>
        {located.length > 0 && <button type="button" className="as-link" onClick={jump}>Voir</button>}
      </div>
      {global.length > 0 && (
        <ul className="as-issues">
          {global.map((i, k) => (
            <li key={`${i.code}${k}`} className={`as-issue is-${i.severity}`}><Icon name={i.severity === 'error' ? 'error' : 'warning'} size={12} /><span>{i.message}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ manual code

type Pending = { kind: 'regenerate' } | { kind: 'rebuild'; program: Program; notes: string[]; withErrors: boolean };

function ManualBanner({ program, onNotes }: { program: Program; onNotes(notes: string[]): void }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const rebuild = () => {
    const r = programFromCode();
    if ('error' in r) {
      notify(r.error, 'error');
      return;
    }
    if (rewritesCode(r.program) || r.withErrors) {
      setPending({ kind: 'rebuild', ...r });
      return;
    }
    if (resetProgram(r.program)) {
      onNotes(r.notes);
      notify('Modèle reconstruit depuis le code : l’assistant reprend la main.', 'success');
    }
  };

  const confirm = () => {
    if (!pending) return;
    if (pending.kind === 'regenerate') {
      if (resetProgram(program)) notify('Code régénéré depuis le modèle de l’assistant.', 'success');
    } else if (resetProgram(pending.program)) {
      onNotes(pending.notes);
      notify('Modèle reconstruit depuis le code : l’assistant reprend la main.', 'success');
    }
    setPending(null);
  };

  return (
    <div className="as-banner" role="region" aria-label="Code modifié à la main">
      <div className="as-banner-text">
        <Icon name="warning" size={15} />
        <div>
          <strong>Le code a été modifié à la main</strong>
          <p>L’assistant est en pause pour ne pas écraser vos modifications. Choisissez ce qui fait foi :</p>
        </div>
      </div>
      {!pending && (
        <div className="as-banner-actions">
          <button type="button" className="as-small-button is-primary" onClick={rebuild} title="Relire le code C et en faire des blocs (vos modifications sont gardées)">
            Reconstruire le modèle depuis le code
          </button>
          <button type="button" className="as-small-button" onClick={() => setPending({ kind: 'regenerate' })} title="Réécrire le code à partir des blocs (vos modifications du code sont perdues)">
            Régénérer le code depuis le modèle
          </button>
        </div>
      )}
      {pending && (
        <div className="as-confirm" role="alert">
          <span>
            {pending.kind === 'regenerate'
              ? 'Vos modifications du code seront perdues : il sera réécrit à partir des blocs de l’assistant.'
              : `Le code sera réécrit dans le style du cours (mêmes instructions, mise en forme du cours).${pending.withErrors ? ' Il contient des erreurs : les parties illisibles seront gardées telles quelles.' : ''}`}
          </span>
          <span className="as-confirm-actions">
            <button type="button" className="as-small-button" onClick={() => setPending(null)}>Annuler</button>
            <button type="button" className="as-small-button is-danger" onClick={confirm} autoFocus>
              {pending.kind === 'regenerate' ? 'Régénérer le code' : 'Reconstruire'}
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

function ImportNotes({ notes, onClose }: { notes: string[]; onClose(): void }) {
  return (
    <div className="as-notes" role="status">
      <div className="as-notes-head">
        <span>Repris du code tel quel :</span>
        <button type="button" className="as-iconbtn" onClick={onClose} aria-label="Fermer les remarques"><Icon name="close" size={12} /></button>
      </div>
      <ul>{notes.map((n) => <li key={n}>{n}</li>)}</ul>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ no program yet

function EmptyState({ onNotes }: { onNotes(notes: string[]): void }) {
  const hasCode = useApp((s) => normalizeEol(s.project.source) !== normalizeEol(MINIMAL_SOURCE));
  const canRead = useApp((s) => !!s.compile.result?.ast);
  const [pending, setPending] = useState<{ program: Program; notes: string[]; label: string } | null>(null);

  const start = (program: Program, notes: string[], label: string) => {
    if (hasCode && rewritesCode(program)) {
      setPending({ program, notes, label });
      return;
    }
    if (resetProgram(program)) {
      onNotes(notes);
      notify(label, 'success');
    }
  };

  const fromSchematic = () => {
    const { project } = getApp();
    const io = deriveSignals(project.schematic);
    const program = finalizeProgram(programFromSchematic(io, project.name, project.clockHz), project.clockHz);
    const n = io.signals.length + io.buses.length;
    start(program, [], n ? `Programme créé : ${n} broche${n > 1 ? 's' : ''} reprise${n > 1 ? 's' : ''} du schéma.` : 'Programme créé. Le schéma n’a encore rien de branché sur le PIC.');
  };

  const fromCode = () => {
    const r = programFromCode();
    if ('error' in r) {
      notify(r.error, 'error');
      return;
    }
    start(r.program, r.notes, 'Modèle construit depuis le code.');
  };

  return (
    <div className="as-empty">
      <h3>Aucun programme décrit pour ce projet</h3>
      <p>L’assistant écrit le code C dans le style du cours et dessine l’organigramme à partir de blocs simples : allumer, attendre, si… sinon…</p>
      <div className="as-empty-choices">
        <button type="button" className="as-choice" onClick={fromSchematic}>
          <span className="as-choice-title">Partir du schéma</span>
          <span className="as-choice-text">Les LEDs, interrupteurs, boutons et afficheurs câblés au PIC deviennent les broches du programme.</span>
        </button>
        <button type="button" className="as-choice" onClick={fromCode} disabled={!canRead} title={canRead ? undefined : 'Le code actuel ne peut pas être lu (erreurs de syntaxe)'}>
          <span className="as-choice-title">Partir du code actuel</span>
          <span className="as-choice-text">Le code C est relu et transformé en blocs que vous pouvez modifier.</span>
        </button>
      </div>
      {pending && (
        <div className="as-confirm" role="alert">
          <span>Le code actuel sera remplacé par le code écrit par l’assistant.</span>
          <span className="as-confirm-actions">
            <button type="button" className="as-small-button" onClick={() => setPending(null)}>Annuler</button>
            <button
              type="button"
              className="as-small-button is-danger"
              autoFocus
              onClick={() => {
                const p = pending;
                setPending(null);
                if (resetProgram(p.program)) {
                  onNotes(p.notes);
                  notify(p.label, 'success');
                }
              }}
            >
              Remplacer le code
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
