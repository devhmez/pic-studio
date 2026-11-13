// Condition editor: rows « [broche / drapeau / comparaison] … » joined by « et » / « ou ».
import { describeCond, type Cond, type Level, type Program } from '@pic/program-model';
import { condC } from '@pic/style-c';
import { useMemo } from 'react';
import { Icon } from '../shell/icons';
import {
  COMPARE_OPS, condToDraft, draftToCond, flagOptions, levelHint, nextTerm, subjectOf, termForSubject,
  type CondDraft, type CondTerm,
} from './conditions';
import { ExprField, IconButton, Segmented, Select, TextField } from './fields';

interface CondBuilderProps {
  program: Program;
  cond: Cond;
  onChange(cond: Cond): void;
  /** Interrupt flags (INTF, RBIF, T0IF) are offered inside the interrupt routine. */
  inInterrupt?: boolean;
  /** Visible lead-in of the first row: « Si », « Tant que », « Attendre que ». */
  lead: string;
}

function subjectOptions(program: Program, inInterrupt: boolean) {
  const opts: { value: string; label: string; group?: string }[] = [];
  for (const s of program.signals.filter((x) => x.dir === 'in')) opts.push({ value: `pin:${s.id}`, label: `${s.name} (${s.pin})`, group: 'Entrées' });
  for (const s of program.signals.filter((x) => x.dir === 'out')) opts.push({ value: `pin:${s.id}`, label: `${s.name} (${s.pin})`, group: 'Sorties (relire la broche)' });
  for (const f of flagOptions(inInterrupt)) opts.push({ value: `flag:${f.flag}`, label: f.label, group: 'Drapeaux' });
  opts.push({ value: 'compare', label: 'Comparer deux valeurs (x < y…)', group: 'Autres' });
  opts.push({ value: 'raw', label: 'Condition écrite en C', group: 'Autres' });
  return opts;
}

export function CondBuilder({ program, cond, onChange, inInterrupt = false, lead }: CondBuilderProps) {
  const draft = useMemo(() => condToDraft(program, cond), [program, cond]);
  const subjects = useMemo(() => subjectOptions(program, inInterrupt), [program, inInterrupt]);
  const set = (d: CondDraft) => onChange(draftToCond(d));
  const setTerm = (i: number, t: CondTerm) => set({ ...draft, terms: draft.terms.map((x, k) => (k === i ? t : x)) });

  let preview = '';
  let previewC = '';
  try {
    preview = describeCond(program, cond);
    previewC = condC(program, cond);
  } catch {
    // Incomplete condition: no preview.
  }

  return (
    <div className="as-cond">
      {draft.terms.map((t, i) => (
        <div className="as-cond-row" key={i}>
          {i === 0 ? (
            <span className="as-cond-lead">{lead}</span>
          ) : (
            <Select
              className="as-cond-join"
              label="Liaison entre les conditions"
              value={draft.join}
              onChange={(join) => set({ ...draft, join })}
              options={[{ value: 'and', label: 'et' }, { value: 'or', label: 'ou' }]}
            />
          )}
          <Select
            className="as-cond-subject"
            label={`Condition ${i + 1} : ce qui est testé`}
            value={subjectOf(t)}
            onChange={(key) => setTerm(i, termForSubject(program, key, t))}
            options={subjects}
          />
          <TermValue program={program} term={t} onChange={(next) => setTerm(i, next)} index={i} />
          {draft.terms.length > 1 && (
            <IconButton label={`Retirer la condition ${i + 1}`} onClick={() => set({ ...draft, terms: draft.terms.filter((_, k) => k !== i) })}>
              <Icon name="close" size={12} />
            </IconButton>
          )}
        </div>
      ))}
      <div className="as-cond-foot">
        <button type="button" className="as-link" onClick={() => set({ ...draft, terms: [...draft.terms, nextTerm(program, draft) as CondTerm] })}>
          <Icon name="plus" size={12} /> {draft.join === 'or' ? 'ou' : 'et'} une autre condition
        </button>
        {preview && (
          <span className="as-cond-preview" title={`En C : ${previewC}`}>
            Organigramme : <code>{preview}</code>
          </span>
        )}
      </div>
    </div>
  );
}

function TermValue({ program, term, onChange, index }: { program: Program; term: CondTerm; onChange(t: CondTerm): void; index: number }) {
  switch (term.kind) {
    case 'pin': {
      const opt = (v: Level) => {
        const hint = levelHint(program, term.signal, v);
        return { value: v, label: <>= {v}{hint ? <span className="as-seg-hint"> {hint}</span> : null}</>, title: hint ? `== ${v} (${hint})` : `== ${v}` };
      };
      return <Segmented<Level> label={`Condition ${index + 1} : niveau`} value={term.value} onChange={(value) => onChange({ ...term, value })} options={[opt(1), opt(0)]} />;
    }
    case 'flag':
      return (
        <Segmented<Level>
          label={`Condition ${index + 1} : valeur du drapeau`}
          value={term.value}
          onChange={(value) => onChange({ ...term, value })}
          options={[{ value: 1, label: '= 1' }, { value: 0, label: '= 0' }]}
        />
      );
    case 'compare':
      return (
        <span className="as-cond-compare">
          <ExprField program={program} value={term.left} label={`Condition ${index + 1} : valeur de gauche`} onCommit={(left) => onChange({ ...term, left })} className="as-expr-short" />
          <Select
            className="as-cond-op"
            label={`Condition ${index + 1} : comparaison`}
            value={term.op}
            onChange={(op) => onChange({ ...term, op })}
            options={COMPARE_OPS.map((o) => ({ value: o.op, label: o.label }))}
          />
          <ExprField program={program} value={term.right} label={`Condition ${index + 1} : valeur de droite`} onCommit={(right) => onChange({ ...term, right })} className="as-expr-short" />
        </span>
      );
    case 'raw':
      return (
        <TextField
          value={term.text}
          label={`Condition ${index + 1} en C`}
          placeholder="ex. PORTB == 0xCA"
          mono
          className="as-grow"
          validate={(v) => (v.trim() === '' ? 'Condition vide.' : null)}
          onCommit={(text) => onChange({ kind: 'raw', text })}
        />
      );
  }
}
