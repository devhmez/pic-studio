// « Pas à pas »: follows the paused simulation. Explains the C line the PIC is about to execute, the last executed
// instruction (with the values before / after and why each flag has its value), what changed, and keeps the last
// steps.
import { instructionInfo } from '@pic/emulator';
import { useMemo, useState } from 'react';
import { SHORTCUTS, stepInstruction, stepLine } from '../debug/commands';
import { execLineFor } from '../debug/listing';
import { Icon } from '../shell/icons';
import { useApp } from '../state/store';
import { addrH, explainLine, groupThousands, liveEnv, plural, type ChangeItem, type InstructionExplanation, type LineExplanation } from './explain';
import type { LearnContext } from './context';
import { useStepHistory, type StepEntry } from './history';
import { Chevron, LineBadge, TermChips, Warn } from './ui';

function FlagChip({ value }: { value: 0 | 1 }) {
  return <span className={`lp-flag is-${value}`}>{value}</span>;
}

export function InstructionView({ ex, compact = false }: { ex: InstructionExplanation; compact?: boolean }) {
  return (
    <div className="lp-instr">
      <div className="lp-instr-head">
        <span className="lp-instr-asm">{ex.asm}</span>
        <span className="lp-badge">{addrH(ex.addr)}</span>
        <span className="lp-badge">{plural(ex.cycles, 'cycle')}</span>
        {ex.skipped && <span className="lp-badge is-accent">saut</span>}
      </div>
      <div className="lp-instr-summary">{ex.summary}</div>
      {!compact && ex.details.map((d, i) => <p key={i} className="lp-p">{d}</p>)}
      {ex.flags.length > 0 && (
        <ul className="lp-flags">
          {ex.flags.map((f) => (
            <li key={f.flag}><span className="lp-mono">{f.flag === 'TO' || f.flag === 'PD' ? `/${f.flag}` : f.flag}</span> <FlagChip value={f.value} /> {f.why}</li>
          ))}
        </ul>
      )}
      {!compact && <TermChips ids={ex.terms} />}
    </div>
  );
}

export function ChangesView({ items }: { items: readonly ChangeItem[] }) {
  if (!items.length) return <p className="lp-hint">Aucun registre, aucune broche n’a changé.</p>;
  return (
    <ul className="lp-changes">
      {items.map((c, i) => (
        <li key={i}>
          <span className="lp-change-label">{c.label}</span>
          <span className="lp-change-values">{c.from} → <b>{c.to}</b></span>
          <span className="lp-change-why">{c.why}</span>
        </li>
      ))}
    </ul>
  );
}

function EntryBody({ entry }: { entry: StepEntry }) {
  const ex = entry.explanation;
  return (
    <>
      {ex.kind === 'trace' && ex.trace && (
        <>
          <p className="lp-kicker">Instructions exécutées</p>
          {ex.trace.first.map((i, k) => <InstructionView key={`f${k}`} ex={i} compact />)}
          {ex.trace.omitted > 0 && <p className="lp-trace-gap">… {groupThousands(ex.trace.omitted)} instructions de plus (boucles d’attente) …</p>}
          {ex.trace.last.map((i, k) => <InstructionView key={`l${k}`} ex={i} compact />)}
        </>
      )}
      {ex.kind !== 'trace' && ex.instruction && <InstructionView ex={ex.instruction} />}
      {ex.kind === 'avance' && <p className="lp-hint">Plusieurs instructions ont été exécutées ; seules les modifications sont listées.</p>}
      <p className="lp-kicker" style={{ marginTop: 8 }}>Ce qui a changé</p>
      <ChangesView items={ex.changes} />
    </>
  );
}

function LineCard({ title, ex, hint }: { title: string; ex: LineExplanation; hint?: string }) {
  return (
    <div className="lp-card">
      <p className="lp-kicker">{title}{ex.section ? ` — ${ex.section}` : ''}</p>
      <div className="lp-line-code"><span className="lp-ln">{ex.line}</span>{ex.code || ' '}</div>
      {hint && <p className="lp-hint">{hint}</p>}
      {ex.points.map((p, i) => <p key={i} className="lp-p">{p}</p>)}
      {ex.warnings.map((w, i) => <Warn key={i}>{w}</Warn>)}
      <TermChips ids={ex.terms} />
    </div>
  );
}

export function StepTab({ ctx }: { ctx: LearnContext }) {
  const status = useApp((s) => s.sim.status);
  const debug = useApp((s) => s.sim.debug);
  const entries = useStepHistory((h) => h.entries);
  const [open, setOpen] = useState<number | null>(null);
  const build = ctx.build;

  const current = useMemo(() => {
    if (status !== 'paused' || !debug || !build?.ok || !build.ast) return null;
    const line = execLineFor(debug.pc, debug.stack, build.addrToLine);
    if (line === null) return null;
    const explanation = explainLine({
      unit: build.ast, source: build.source, line, clockHz: ctx.clockHz, symbols: build.symbols, program: ctx.program,
      env: liveEnv(debug, build.symbols), envKind: 'live', pinInfo: ctx.pinInfo,
    });
    const asm = build.listing.filter((l) => l.addr !== undefined && l.srcLine === line);
    return { line, explanation, asm };
  }, [status, debug, build, ctx]);

  const latest = entries[0];
  const older = entries.slice(1);

  return (
    <div>
      <div className="lp-controls">
        <button type="button" className="lp-button is-primary" onClick={stepLine} title={`Exécuter la ligne C suivante (${SHORTCUTS.stepLine.label})`}>
          <Icon name="stepLine" size={13} /> Ligne suivante <kbd>{SHORTCUTS.stepLine.label}</kbd>
        </button>
        <button type="button" className="lp-button" onClick={stepInstruction} title={`Exécuter une seule instruction assembleur (${SHORTCUTS.stepInstruction.label})`}>
          <Icon name="stepInstr" size={13} /> Instruction <kbd>{SHORTCUTS.stepInstruction.label}</kbd>
        </button>
        <span className="lp-status">
          {status === 'stopped' ? 'Simulation arrêtée' : status === 'running' ? 'Simulation en cours…' : debug ? `En pause · ${groupThousands(debug.cycles)} cycles` : 'En pause'}
        </span>
      </div>

      {status === 'stopped' && (
        <div className="lp-empty">
          <strong>Avancez pas à pas</strong>
          « Ligne suivante » exécute une ligne de C, « Instruction » une seule instruction assembleur. Après chaque pas, cet onglet explique la ligne, l’instruction, les drapeaux de STATUS et tout ce qui a changé.
        </div>
      )}
      {status === 'running' && (
        <p className="lp-tip"><strong>La simulation tourne.</strong> Mettez-la en pause ({SHORTCUTS.pause.label}) ou avancez pas à pas pour lire les explications.</p>
      )}
      {status === 'paused' && !build?.ok && <Warn>Le programme ne compile pas : les explications reviendront quand le code sera corrigé.</Warn>}

      {current && (
        <LineCard title="Prochaine ligne" ex={current.explanation} hint="Le PIC va exécuter cette ligne au prochain pas." />
      )}
      {current && current.asm.length > 0 && debug && (
        <div className="lp-card">
          <p className="lp-kicker">Instructions de la ligne {current.line}</p>
          <ul className="lp-asm">
            {current.asm.map((l) => {
              const m = l.text.trim().split(/\s+/)[0];
              const desc = instructionInfo(m)?.description;
              return (
                <li key={l.addr} className={l.addr === debug.pc ? 'is-pc' : undefined}>
                  <span className="lp-asm-addr">{addrH(l.addr!)}</span>
                  <span className="lp-asm-text">{l.text}{desc && <span className="lp-asm-desc"> — {desc}</span>}</span>
                </li>
              );
            })}
          </ul>
          <p className="lp-hint" style={{ marginTop: 6, marginBottom: 0 }}>En couleur : l’instruction pointée par le PC (la prochaine à exécuter).</p>
        </div>
      )}

      {latest && status !== 'stopped' && (
        <div className="lp-card">
          <p className="lp-kicker">Dernier pas</p>
          <h3 className="lp-card-title">
            <span className="lp-grow">{latest.explanation.summary}</span>
            {latest.explanation.line !== null && <LineBadge line={latest.explanation.line} />}
          </h3>
          <EntryBody entry={latest} />
        </div>
      )}

      {older.length > 0 && status !== 'stopped' && (
        <div className="lp-card">
          <p className="lp-kicker">Pas précédents</p>
          <ul className="lp-history">
            {older.map((e) => (
              <li key={e.id}>
                <button type="button" className="lp-history-item" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>
                  <Chevron />
                  <span className="lp-history-text">{e.explanation.summary}</span>
                  {e.explanation.line !== null && <LineBadge line={e.explanation.line} />}
                </button>
                {open === e.id && <div className="lp-history-body"><EntryBody entry={e} /></div>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
