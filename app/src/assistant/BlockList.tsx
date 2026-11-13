// A list of blocks (initialisation, main loop, a branch, a loop body, the interrupt routine): rows with a summary,
// move / duplicate / delete tools, the editor of the selected row, nested lists for « si » and loops, and the
// « Ajouter un bloc » palette.
import { describeCond, type IfStmt, type Issue, type Stmt } from '@pic/program-model';
import { memo, useState, type KeyboardEvent } from 'react';
import { Icon } from '../shell/icons';
import { BlockEditor } from './BlockEditor';
import { blockGroups, blockSummary, blockUnavailable, createBlock, defaultCond, type BlockType } from './blocks';
import { CondBuilder } from './CondBuilder';
import { useAssistant } from './context';
import { IconButton } from './fields';
import {
  addElse, addElseIf, bodyList, branchList, duplicateStmt, idFactory, insertStmt, moveStmt, removeBranch, removeStmt,
  updateBranch, type ListKey,
} from './model';

interface BlockListProps {
  listKey: ListKey;
  stmts: readonly Stmt[];
  inInterrupt: boolean;
  /** Text when the list is empty. */
  empty: string;
  depth?: number;
}

export function BlockList({ listKey, stmts, inInterrupt, empty, depth = 0 }: BlockListProps) {
  const { selectedId } = useAssistant();
  const selectedIndex = stmts.findIndex((s) => s.id === selectedId);
  return (
    <div className="as-list" data-depth={depth}>
      {stmts.length === 0 ? (
        <p className="as-list-empty">{empty}</p>
      ) : (
        <ol className="as-blocks">
          {stmts.map((s, i) => (
            <BlockRow key={s.id} stmt={s} index={i} count={stmts.length} inInterrupt={inInterrupt} depth={depth} />
          ))}
        </ol>
      )}
      <AddBlock listKey={listKey} insertAt={selectedIndex >= 0 ? selectedIndex + 1 : stmts.length} afterSelected={selectedIndex >= 0} inInterrupt={inInterrupt} />
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ row

interface BlockRowProps {
  stmt: Stmt;
  index: number;
  count: number;
  inInterrupt: boolean;
  depth: number;
}

function IssueList({ issues }: { issues: readonly Issue[] | undefined }) {
  if (!issues?.length) return null;
  return (
    <ul className="as-issues">
      {issues.map((i, k) => (
        <li key={`${i.code}${k}`} className={`as-issue is-${i.severity}`}>
          <Icon name={i.severity === 'error' ? 'error' : 'warning'} size={12} />
          <span>{i.message}</span>
        </li>
      ))}
    </ul>
  );
}

const BlockRow = memo(function BlockRow({ stmt, index, count, inInterrupt, depth }: BlockRowProps) {
  const { program, edit, selectedId, select, issuesByStmt } = useAssistant();
  const selected = selectedId === stmt.id;
  const summary = blockSummary(program, stmt);
  const issues = issuesByStmt.get(stmt.id);
  const severity = issues?.some((i) => i.severity === 'error') ? 'error' : issues?.some((i) => i.severity === 'warning') ? 'warning' : null;

  const move = (delta: -1 | 1) => edit((p) => moveStmt(p, stmt.id, delta));
  const remove = () => {
    if (selected) select(null);
    edit((p) => removeStmt(p, stmt.id));
  };
  const duplicate = () => {
    let created: string | null = null;
    edit((p) => {
      const r = duplicateStmt(p, stmt.id);
      created = r.id;
      return r.program;
    });
    if (created) select(created);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && !e.altKey) { e.preventDefault(); remove(); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicate(); }
  };

  return (
    <li className={`as-block tone-${summary.tone}${selected ? ' is-selected' : ''}${severity ? ` has-${severity}` : ''}`} id={`as-stmt-${stmt.id}`}>
      <div className="as-block-head">
        <button
          type="button"
          className="as-block-main"
          aria-expanded={selected}
          onClick={() => select(selected ? null : stmt.id)}
          onKeyDown={onKeyDown}
          title="Cliquer pour modifier · Alt+↑/↓ déplacer · ⌘D dupliquer · Suppr effacer"
        >
          <span className="as-badge">{summary.label}</span>
          <span className="as-block-detail">{summary.detail}</span>
          {severity && <Icon name={severity === 'error' ? 'error' : 'warning'} size={13} className={`as-block-flag is-${severity}`} />}
        </button>
        <span className="as-block-tools">
          <IconButton label="Monter le bloc" title="Monter (Alt+↑)" onClick={() => move(-1)} disabled={index === 0}><Icon name="chevronDown" size={13} className="as-rot180" /></IconButton>
          <IconButton label="Descendre le bloc" title="Descendre (Alt+↓)" onClick={() => move(1)} disabled={index === count - 1}><Icon name="chevronDown" size={13} /></IconButton>
          <IconButton label="Dupliquer le bloc" title="Dupliquer (⌘D)" onClick={duplicate}><DuplicateIcon /></IconButton>
          <IconButton label="Supprimer le bloc" title="Supprimer (Suppr)" onClick={remove} tone="danger"><Icon name="trash" size={13} /></IconButton>
        </span>
      </div>
      <IssueList issues={issues} />
      {selected && <BlockEditor stmt={stmt} inInterrupt={inInterrupt} />}
      {stmt.kind === 'if' && <IfBranches stmt={stmt} inInterrupt={inInterrupt} depth={depth} />}
      {(stmt.kind === 'while' || stmt.kind === 'repeat' || stmt.kind === 'for') && (
        <div className="as-children">
          <BlockList listKey={bodyList(stmt.id)} stmts={stmt.body} inInterrupt={inInterrupt} depth={depth + 1} empty="Bloc vide : ajoutez ce qui se répète." />
        </div>
      )}
    </li>
  );
});

function DuplicateIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" />
    </svg>
  );
}

// ------------------------------------------------------------------------------------------------ if branches

function IfBranches({ stmt, inInterrupt, depth }: { stmt: IfStmt; inInterrupt: boolean; depth: number }) {
  const { program, edit, selectedId, select, issuesByStmt } = useAssistant();
  const branchIssues = (id: string) => issuesByStmt.get(id);
  const addElseIfBranch = () => {
    let id = '';
    edit((p) => {
      const r = addElseIf(p, stmt.id, defaultCond(p));
      id = r.branchId;
      return r.program;
    });
    if (id) select(id);
  };
  return (
    <div className="as-children as-branches">
      {stmt.branches.map((b, i) => {
        const open = selectedId === b.id;
        let condText = '';
        try { condText = describeCond(program, b.cond); } catch { condText = '?'; }
        return (
          <div key={b.id} className={`as-branch${open ? ' is-selected' : ''}`} id={`as-stmt-${b.id}`}>
            <div className="as-branch-head">
              <button type="button" className="as-branch-main" aria-expanded={open} onClick={() => select(open ? null : b.id)} title="Modifier la condition">
                <span className="as-branch-kw">{i === 0 ? 'Si' : 'Sinon si'}</span>
                <code className="as-branch-cond">{condText}</code>
                <Icon name="chevronDown" size={12} className={open ? '' : 'as-rot'} />
              </button>
              {stmt.branches.length > 1 && (
                <IconButton label={`Supprimer la branche « ${i === 0 ? 'Si' : 'Sinon si'} ${condText} »`} onClick={() => { if (open) select(null); edit((p) => removeBranch(p, stmt.id, b.id)); }} tone="danger">
                  <Icon name="close" size={12} />
                </IconButton>
              )}
            </div>
            <IssueList issues={branchIssues(b.id)} />
            {open && (
              <div className="as-editor">
                <CondBuilder program={program} cond={b.cond} onChange={(cond) => edit((p) => updateBranch(p, stmt.id, b.id, { cond }))} lead={i === 0 ? 'Si' : 'Sinon si'} inInterrupt={inInterrupt} />
                <BranchExtras comment={b.comment} note={b.note} onChange={(patch) => edit((p) => updateBranch(p, stmt.id, b.id, patch))} />
              </div>
            )}
            <BlockList listKey={branchList(stmt.id, b.id)} stmts={b.body} inInterrupt={inInterrupt} depth={depth + 1} empty="Rien à faire dans ce cas : ajoutez un bloc." />
          </div>
        );
      })}
      {stmt.otherwise && (
        <div className={`as-branch${selectedId === stmt.otherwise.id ? ' is-selected' : ''}`} id={`as-stmt-${stmt.otherwise.id}`}>
          <div className="as-branch-head">
            <button type="button" className="as-branch-main" aria-expanded={selectedId === stmt.otherwise.id} onClick={() => select(selectedId === stmt.otherwise!.id ? null : stmt.otherwise!.id)} title="Options de la branche « Sinon »">
              <span className="as-branch-kw">Sinon</span>
              <span className="as-muted">dans tous les autres cas</span>
            </button>
            <IconButton label="Supprimer la branche « Sinon »" onClick={() => edit((p) => removeBranch(p, stmt.id, stmt.otherwise!.id))} tone="danger">
              <Icon name="close" size={12} />
            </IconButton>
          </div>
          {selectedId === stmt.otherwise.id && (
            <div className="as-editor">
              <BranchExtras comment={stmt.otherwise.comment} note={stmt.otherwise.note} onChange={(patch) => edit((p) => updateBranch(p, stmt.id, stmt.otherwise!.id, patch))} />
            </div>
          )}
          <BlockList listKey={branchList(stmt.id, stmt.otherwise.id)} stmts={stmt.otherwise.body} inInterrupt={inInterrupt} depth={depth + 1} empty="Rien à faire sinon : ajoutez un bloc ou supprimez cette branche." />
        </div>
      )}
      <div className="as-branch-add">
        <button type="button" className="as-link" onClick={addElseIfBranch}><Icon name="plus" size={12} /> Sinon si…</button>
        {!stmt.otherwise && (
          <button type="button" className="as-link" onClick={() => {
            let id = '';
            edit((p) => { const r = addElse(p, stmt.id); id = r.branchId; return r.program; });
            if (id) select(id);
          }}>
            <Icon name="plus" size={12} /> Sinon
          </button>
        )}
      </div>
    </div>
  );
}

function BranchExtras({ comment, note, onChange }: { comment?: string; note?: string; onChange(patch: { comment?: string; note?: string }): void }) {
  return (
    <div className="as-branch-extras">
      <label className="as-mini">
        <span>Note de la case (organigramme)</span>
        <input className="as-input" defaultValue={note ?? ''} placeholder="ex. x= y" aria-label="Note affichée en tête de la case de cette branche (// …)"
          onBlur={(e) => { const v = e.target.value.trim(); if (v !== (note ?? '')) onChange({ note: v || undefined }); }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
      </label>
      <label className="as-mini">
        <span>Commentaire dans le code</span>
        <input className="as-input" defaultValue={comment ?? ''} placeholder="ex. Test du bit Zero, x = y" aria-label="Commentaire de la ligne if dans le code"
          onBlur={(e) => { const v = e.target.value.trim(); if (v !== (comment ?? '')) onChange({ comment: v || undefined }); }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
      </label>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ add palette

function AddBlock({ listKey, insertAt, afterSelected, inInterrupt }: { listKey: ListKey; insertAt: number; afterSelected: boolean; inInterrupt: boolean }) {
  const { program, edit, select } = useAssistant();
  const [open, setOpen] = useState(false);
  const groups = blockGroups(inInterrupt);
  const add = (type: BlockType) => {
    let created = '';
    edit((p) => {
      const r = createBlock(p, type, idFactory(p));
      created = r.stmt.id;
      return insertStmt(r.program, listKey, insertAt, r.stmt);
    });
    setOpen(false);
    if (created) select(created);
  };
  if (!open) {
    return (
      <button type="button" className="as-add" onClick={() => setOpen(true)} aria-expanded={false} title={afterSelected ? 'Ajouter un bloc après le bloc sélectionné' : 'Ajouter un bloc à la fin'}>
        <Icon name="plus" size={13} /> Ajouter un bloc{afterSelected ? ' ici' : ''}
      </button>
    );
  }
  return (
    <div
      className="as-palette"
      role="dialog"
      aria-label="Choisir un bloc"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}
    >
      <div className="as-palette-head">
        <span>Ajouter un bloc{afterSelected ? ' après la sélection' : ''}</span>
        <IconButton label="Fermer la liste des blocs" onClick={() => setOpen(false)}><Icon name="close" size={12} /></IconButton>
      </div>
      {groups.map((g, gi) => (
        <div key={g.title} className="as-palette-group">
          <p className="as-palette-title">{g.title}</p>
          <div className="as-palette-items">
            {g.items.map((it, k) => {
              const why = blockUnavailable(program, it.type);
              return (
                <button
                  key={it.type}
                  type="button"
                  className={`as-palette-item tone-${it.tone}`}
                  onClick={() => add(it.type)}
                  disabled={!!why}
                  title={why ?? it.hint}
                  autoFocus={gi === 0 && k === 0}
                >
                  <span className="as-palette-label">{it.label}</span>
                  <span className="as-palette-hint">{why ?? it.hint}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
