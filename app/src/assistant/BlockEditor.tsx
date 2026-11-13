// The editor opened under a block row: one small form per statement kind, plus the shared « commentaires et
// organigramme » options.
import {
  busById, describeStmt, formatDuration, signalById,
  type DelayStmt, type DisplayStmt, type Expr, type Level, type LValue, type Program, type Signal, type Stmt,
} from '@pic/program-model';
import { useState } from 'react';
import { Icon } from '../shell/icons';
import { exprText } from './blocks';
import { CondBuilder } from './CondBuilder';
import { useAssistant } from './context';
import { Check, ExprField, NumberField, Row, Segmented, Select, TextArea, TextField } from './fields';
import { cleanOptional, outputs, replaceStmt } from './model';

interface Props {
  stmt: Stmt;
  inInterrupt: boolean;
}

const signalOption = (s: Signal) => ({ value: s.id, label: `${s.name} — ${s.label} (${s.pin})` });

const GLYPHS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'b', 'C', 'd', 'E', 'F'];

const DELAY_PRESETS = [100, 250, 500, 1000, 2000, 3000];

export function BlockEditor({ stmt, inInterrupt }: Props) {
  const { program, edit } = useAssistant();
  const update = (patch: Partial<Stmt>) => edit((p) => replaceStmt(p, stmt.id, (s) => cleanOptional({ ...s, ...patch } as Stmt)));

  return (
    <div className="as-editor">
      <KindEditor program={program} stmt={stmt} update={update} inInterrupt={inInterrupt} />
      <OptionsEditor program={program} stmt={stmt} update={update} />
    </div>
  );
}

interface KindProps {
  program: Program;
  stmt: Stmt;
  update(patch: Partial<Stmt>): void;
  inInterrupt: boolean;
}

function KindEditor({ program, stmt, update, inInterrupt }: KindProps) {
  const outs = outputs(program);
  switch (stmt.kind) {
    case 'set': {
      const sig = signalById(program, stmt.signal);
      const active = sig?.activeLevel ?? 1;
      const ledLike = sig?.device === 'led' || sig?.device === 'lamp';
      return (
        <>
          <Row label="Sortie">
            <Select label="Sortie à commander" value={stmt.signal} onChange={(signal) => update({ signal })} options={outs.map(signalOption)} />
          </Row>
          <Row label="Action" hint={sig ? `En C : ${sig.name} = ${stmt.value}` : undefined}>
            <Segmented<Level>
              label="Allumer ou éteindre"
              value={stmt.value}
              onChange={(value) => update({ value })}
              options={ledLike || !sig
                ? [{ value: active, label: 'Allumer' }, { value: (1 - active) as Level, label: 'Éteindre' }]
                : [{ value: 1, label: 'Mettre à 1' }, { value: 0, label: 'Mettre à 0' }]}
            />
          </Row>
        </>
      );
    }
    case 'toggle':
      return (
        <Row label="Sortie" hint="En C : SORTIE = !SORTIE;">
          <Select label="Sortie à inverser" value={stmt.signal} onChange={(signal) => update({ signal })} options={outs.map(signalOption)} />
        </Row>
      );
    case 'setAll': {
      const chosen = new Set(stmt.signals);
      const allHigh = stmt.signals.every((id) => (signalById(program, id)?.activeLevel ?? 1) === 1);
      return (
        <>
          <Row label="Action">
            <Segmented<Level>
              label="Niveau écrit"
              value={stmt.value}
              onChange={(value) => update({ value })}
              options={allHigh ? [{ value: 1, label: 'Allumer (1)' }, { value: 0, label: 'Éteindre (0)' }] : [{ value: 1, label: 'Mettre à 1' }, { value: 0, label: 'Mettre à 0' }]}
            />
          </Row>
          <div className="as-checklist" role="group" aria-label="Sorties concernées">
            {outs.map((s) => (
              <Check
                key={s.id}
                checked={chosen.has(s.id)}
                onChange={(on) => update({ signals: outs.filter((x) => (x.id === s.id ? on : chosen.has(x.id))).map((x) => x.id) })}
              >
                <span className="as-mono">{s.name}</span> <span className="as-muted">{s.label} ({s.pin})</span>
              </Check>
            ))}
          </div>
        </>
      );
    }
    case 'display':
      return <DisplayEditor program={program} stmt={stmt} update={update} />;
    case 'delay':
      return <DelayEditor stmt={stmt} update={update} />;
    case 'waitFor':
      return (
        <>
          <CondBuilder program={program} cond={stmt.cond} onChange={(cond) => update({ cond })} lead="Attendre que" inInterrupt={inInterrupt} />
          <p className="as-hint">Le programme reste bloqué ici tant que la condition est fausse (en C : <code>while (…);</code>).</p>
        </>
      );
    case 'if':
      return <p className="as-hint">Modifiez chaque condition en cliquant sur « Si » / « Sinon si » ci-dessous ; ajoutez des branches avec les boutons en bas du bloc.</p>;
    case 'while':
      return <CondBuilder program={program} cond={stmt.cond} onChange={(cond) => update({ cond })} lead="Tant que" inInterrupt={inInterrupt} />;
    case 'repeat':
      return (
        <>
          <Row label="Nombre de fois">
            <NumberField value={stmt.times} min={1} max={255} label="Nombre de répétitions" onCommit={(times) => update({ times })} suffix="fois" />
          </Row>
          <Row label="Compteur" hint={`En C : for (${stmt.counter} = 0; ${stmt.counter} < ${stmt.times}; ${stmt.counter}++)`}>
            <Select
              label="Variable compteur"
              value={stmt.counter}
              onChange={(counter) => update({ counter })}
              options={program.variables.map((v) => ({ value: v.name, label: v.name }))}
            />
          </Row>
        </>
      );
    case 'for':
      return (
        <p className="as-hint">
          Boucle <code>for</code> importée du code : <code>{exprText(program, stmt.init.target)} = {exprText(program, stmt.init.value)}</code>. Pour la modifier,
          remplacez-la par « Répéter N fois » ou « Tant que ».
        </p>
      );
    case 'assign':
      return <AssignEditor program={program} target={stmt.target} value={stmt.value} update={update} />;
    case 'incr':
    case 'decr':
      return (
        <Row label="Variable" hint={`En C : ${stmt.variable}${stmt.kind === 'incr' ? '++' : '--'};`}>
          <Select
            label="Variable"
            value={stmt.variable}
            onChange={(variable) => update({ variable })}
            options={program.variables.map((v) => ({ value: v.name, label: v.name }))}
          />
        </Row>
      );
    case 'clearFlag':
      return (
        <Row label="Drapeau" hint={`En C : INTCON.${stmt.flag} = 0;`}>
          <Select
            label="Drapeau à effacer"
            value={stmt.flag}
            onChange={(flag) => update({ flag })}
            options={[
              { value: 'INTF', label: 'INTF — RB0/INT' },
              { value: 'RBIF', label: 'RBIF — changement RB4 à RB7' },
              { value: 'T0IF', label: 'T0IF — TMR0' },
            ]}
          />
        </Row>
      );
    case 'call':
      return (
        <Row label="Sous-programme">
          <Select
            label="Sous-programme appelé"
            value={stmt.name}
            onChange={(name) => update({ name })}
            options={program.functions.filter((f) => f.kind === 'function').map((f) => ({ value: f.name, label: `${f.name}()` }))}
          />
        </Row>
      );
    case 'comment':
      return (
        <Row label="Texte">
          <TextField value={stmt.text} label="Texte du commentaire" className="as-grow" onCommit={(text) => update({ text })} />
        </Row>
      );
    case 'raw':
      return (
        <>
          <TextArea value={stmt.code} label="Code C libre" mono rows={4} placeholder={'ex.\nPORTB = 0x00;'} autoFocus={stmt.code === ''} onCommit={(code) => update({ code })} />
          <p className="as-hint">Écrit tel quel dans le programme. Utile pour ce que les blocs ne savent pas faire.</p>
        </>
      );
  }
}

function DisplayEditor({ program, stmt, update }: { program: Program; stmt: DisplayStmt; update(p: Partial<Stmt>): void }) {
  const bus = busById(program, stmt.bus);
  const buses = program.buses.filter((b) => b.dir === 'out');
  const isNum = stmt.value.kind === 'num';
  const [mode, setMode] = useState<'glyph' | 'expr'>(isNum ? 'glyph' : 'expr');
  const max = bus ? (1 << bus.width) - 1 : 15;
  const bcd = bus?.device === 'bcd';
  return (
    <>
      {buses.length > 1 && (
        <Row label="Afficheur">
          <Select label="Afficheur" value={stmt.bus} onChange={(b) => update({ bus: b })} options={buses.map((b) => ({ value: b.id, label: `${b.name} — ${b.label}` }))} />
        </Row>
      )}
      <Row label="Valeur">
        <Segmented<'glyph' | 'expr'>
          label="Type de valeur"
          value={mode}
          onChange={setMode}
          options={[{ value: 'glyph', label: bcd ? 'Chiffre ou lettre' : 'Nombre' }, { value: 'expr', label: 'Variable / calcul' }]}
        />
      </Row>
      {mode === 'glyph' && bcd && (
        <div className="as-glyphs" role="radiogroup" aria-label="Chiffre ou lettre à afficher">
          {GLYPHS.map((g, v) => (
            <button
              key={g}
              type="button"
              role="radio"
              aria-checked={isNum && stmt.value.kind === 'num' && stmt.value.value === v}
              className="as-glyph"
              onClick={() => update({ value: { kind: 'num', value: v, radix: 16 } })}
              title={`${v < 10 ? 'Chiffre' : 'Lettre'} ${g} — ${bus?.name ?? 'AFFICHEUR'} = 0x${v.toString(16).toUpperCase().padStart(2, '0')}`}
            >
              {g}
            </button>
          ))}
        </div>
      )}
      {mode === 'glyph' && !bcd && (
        <Row label="Nombre">
          <NumberField value={stmt.value.kind === 'num' ? stmt.value.value : 0} min={0} max={max} label="Valeur écrite" onCommit={(v) => update({ value: { kind: 'num', value: v, radix: 16 } })} />
        </Row>
      )}
      {mode === 'expr' && (
        <Row label="Expression" hint="Par exemple une variable de décompte : compte">
          <ExprField program={program} value={stmt.value} label="Valeur à afficher" onCommit={(value) => update({ value })} className="as-grow" />
        </Row>
      )}
    </>
  );
}

function DelayEditor({ stmt, update }: { stmt: DelayStmt; update(p: Partial<Stmt>): void }) {
  const unit = stmt.unit ?? 'ms';
  return (
    <>
      <Row label="Durée" hint={`= ${formatDuration(stmt.ms, unit)} · en C : Delay_${unit}(${stmt.ms});`}>
        <NumberField value={stmt.ms} min={1} max={unit === 'ms' ? 65535 : 65535} label="Durée de la temporisation" onCommit={(ms) => update({ ms })} />
        <Select
          label="Unité"
          value={unit}
          onChange={(u) => update({ unit: u === 'ms' ? undefined : u })}
          options={[{ value: 'ms', label: 'ms' }, { value: 'us', label: 'µs' }]}
        />
      </Row>
      {unit === 'ms' && (
        <div className="as-chips" role="group" aria-label="Durées courantes">
          {DELAY_PRESETS.map((ms) => (
            <button key={ms} type="button" className={`as-chip${ms === stmt.ms ? ' is-on' : ''}`} onClick={() => update({ ms })}>
              {formatDuration(ms)}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

type TargetKey = string;

function targetKey(t: LValue): TargetKey {
  switch (t.kind) {
    case 'var': return `var:${t.name}`;
    case 'signal': return `signal:${t.id}`;
    case 'bus': return `bus:${t.id}`;
    case 'reg': return `reg:${t.name}${t.bit ? `.${t.bit}` : ''}`;
  }
}

function targetFrom(key: TargetKey): LValue {
  const [kind, rest] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if (kind === 'var') return { kind: 'var', name: rest };
  if (kind === 'signal') return { kind: 'signal', id: rest };
  if (kind === 'bus') return { kind: 'bus', id: rest };
  const [name, bit] = rest.split('.');
  return bit ? { kind: 'reg', name, bit } : { kind: 'reg', name };
}

const REGISTER_TARGETS = ['PORTA', 'PORTB', 'TMR0', 'INTCON', 'OPTION_REG'];

function AssignEditor({ program, target, value, update }: { program: Program; target: LValue; value: Expr; update(p: Partial<Stmt>): void }) {
  const options = [
    ...program.variables.map((v) => ({ value: `var:${v.name}`, label: v.name, group: 'Variables' })),
    ...outputs(program).map((s) => ({ value: `signal:${s.id}`, label: `${s.name} (${s.pin})`, group: 'Sorties' })),
    ...program.buses.filter((b) => b.dir === 'out').map((b) => ({ value: `bus:${b.id}`, label: b.name, group: 'Afficheurs / bus' })),
    ...REGISTER_TARGETS.map((r) => ({ value: `reg:${r}`, label: r, group: 'Registres' })),
  ];
  return (
    <>
      <Row label="Ranger dans">
        <Select label="Destination de l'affectation" value={targetKey(target)} onChange={(k) => update({ target: targetFrom(k) })} options={options} />
      </Row>
      <Row label="La valeur" hint="Nombres 10, 0x0A, 0b0101 ; opérations + - * / & | ^ << >>">
        <ExprField program={program} value={value} label="Valeur affectée" onCommit={(v) => update({ value: v })} className="as-grow" />
      </Row>
    </>
  );
}

function OptionsEditor({ program, stmt, update }: { program: Program; stmt: Stmt; update(patch: Partial<Stmt>): void }) {
  const [open, setOpen] = useState(!!(stmt.comment || stmt.lead || stmt.text));
  let prose = '';
  try {
    prose = describeStmt(program, { ...stmt, text: undefined } as Stmt).map((l) => l.text).join('\n');
  } catch {
    prose = '';
  }
  const simple = stmt.kind !== 'if' && stmt.kind !== 'while' && stmt.kind !== 'repeat' && stmt.kind !== 'for';
  return (
    <div className="as-options">
      <button type="button" className="as-link as-options-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="chevronDown" size={12} className={open ? '' : 'as-rot'} /> Commentaires et texte de l’organigramme
      </button>
      {open && (
        <div className="as-options-body">
          <Row label="Commentaire en fin de ligne">
            <TextField value={stmt.comment ?? ''} label="Commentaire en fin de ligne (// …)" placeholder="ex. Soustraction" className="as-grow" onCommit={(comment) => update({ comment })} />
          </Row>
          <Row label="Commentaire au-dessus">
            <TextField value={stmt.lead ?? ''} label="Commentaire au-dessus du bloc" placeholder="ex. Dépouillement" className="as-grow" onCommit={(lead) => update({ lead })} />
          </Row>
          {simple && (
            <div className="as-row as-row-block">
              <span className="as-row-label">Texte dans l’organigramme</span>
              <TextArea value={stmt.text ?? ''} label="Texte de la case dans l'organigramme" placeholder={prose || 'Texte de la case'} rows={2} onCommit={(text) => update({ text: text.trim() === '' ? undefined : text })} />
              <span className="as-hint">Laissez vide pour le texte automatique{prose ? ` (« ${prose.replace(/\n/g, ' / ')} »)` : ''}.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
