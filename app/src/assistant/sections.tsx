// Sections of the assistant drawer: Broches, Variables, Interruptions, Style du code, and the collapsible frame.
import {
  deriveSignals, interruptRoutine, PORT_WIDTH, ALL_PINS,
  type Bus, type CodeStyle, type InterruptConfig, type Level, type PinName, type Prescaler, type Program, type Signal,
  type SignalDevice, type TrisMode, type VarType,
} from '@pic/program-model';
import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from '../shell/icons';
import { notify } from '../shell/toast';
import { getApp } from '../state/store';
import { BlockList } from './BlockList';
import { useAssistant } from './context';
import { parseNumberLiteral } from './expr';
import { Check, IconButton, Segmented, Select, TextField } from './fields';
import {
  addBus, addConstant, addSignal, addVariable, busPinsText, fnList, isInterruptEnabled, removeBus, removeConstant,
  removeFunction, removeSignal, removeVariable, setInterruptConfig, syncSummary, syncWithSchematic, takenPins, updateBus,
  updateConstant, updateSignal, updateVariable,
} from './model';

const C_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const nameError = (v: string): string | null => (C_NAME.test(v) ? null : 'Lettres, chiffres et _ seulement, sans accent ni espace.');

// ------------------------------------------------------------------------------------------------ frame

const SECTION_PREF = 'pic-studio.assistant.sections.v1';

/** Open state the student chose for a section, if any. */
function storedOpen(id: string): boolean | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(SECTION_PREF);
    const v = raw ? (JSON.parse(raw) as Record<string, boolean>)[id] : undefined;
    return typeof v === 'boolean' ? v : undefined;
  } catch {
    return undefined;
  }
}

function writeOpen(id: string, open: boolean): void {
  try {
    const raw = globalThis.localStorage?.getItem(SECTION_PREF);
    const all = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    all[id] = open;
    globalThis.localStorage?.setItem(SECTION_PREF, JSON.stringify(all));
  } catch {
    // Not remembered: fine.
  }
}

interface SectionProps {
  id: string;
  title: string;
  count?: string;
  defaultOpen?: boolean;
  actions?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}

export function Section({ id, title, count, defaultOpen = true, actions, hint, children }: SectionProps) {
  const [open, setOpen] = useState(() => storedOpen(id) ?? defaultOpen);
  // A section that becomes relevant (interrupts enabled by a template) opens, unless the student closed it.
  useEffect(() => {
    if (defaultOpen && storedOpen(id) === undefined) setOpen(true);
  }, [defaultOpen, id]);
  const toggle = () => {
    writeOpen(id, !open);
    setOpen(!open);
  };
  return (
    <section className={`as-section${open ? ' is-open' : ''}`} aria-labelledby={`as-sec-${id}`}>
      <header className="as-section-head">
        <button type="button" className="as-section-toggle" id={`as-sec-${id}`} aria-expanded={open} onClick={toggle}>
          <Icon name="chevronDown" size={13} className={open ? '' : 'as-rot'} />
          <span className="as-section-title">{title}</span>
          {count && <span className="as-count">{count}</span>}
        </button>
        {open && actions && <span className="as-section-actions">{actions}</span>}
      </header>
      {open && (
        <div className="as-section-body">
          {hint && <p className="as-hint as-section-hint">{hint}</p>}
          {children}
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ Broches

const DEVICE_OPTIONS: Readonly<Record<'in' | 'out', { value: SignalDevice; label: string }[]>> = {
  out: [
    { value: 'led', label: 'LED' },
    { value: 'lamp', label: 'Feu (TRAFFIC LIGHTS)' },
    { value: 'output', label: 'Autre sortie' },
  ],
  in: [
    { value: 'logicstate', label: 'Interrupteur (LOGICSTATE)' },
    { value: 'button', label: 'Bouton poussoir' },
    { value: 'sensor', label: 'Capteur (LDR)' },
    { value: 'input', label: 'Autre entrée' },
  ],
};

function pinOptions(program: Program, own: PinName) {
  const taken = takenPins(program);
  return ALL_PINS.map((p) => ({ value: p, label: taken.has(p) && p !== own ? `${p} (occupée)` : p, group: p.startsWith('RA') ? 'PORTA' : 'PORTB' }));
}

function SignalRow({ s }: { s: Signal }) {
  const { program, edit, usage, issuesBySignal } = useAssistant();
  const used = usage.signals.get(s.id) ?? 0;
  const issues = issuesBySignal.get(s.id);
  const device = s.device ?? (s.dir === 'out' ? 'output' : 'input');
  const set = (patch: Partial<Signal>) => edit((p) => updateSignal(p, s.id, patch));
  /** What the active level means for this device: « Allumée à 1 », « Appuyé = 0 ». */
  const levelLabel = (v: Level) => {
    switch (device) {
      case 'led': return `Allumée à ${v}`;
      case 'lamp': return `Allumé à ${v}`;
      case 'button': return `Appuyé = ${v}`;
      case 'sensor': return `Lumière = ${v}`;
      default: return `Actif à ${v}`;
    }
  };
  return (
    <li className="as-signal" id={`as-sig-${s.id}`}>
      <div className="as-signal-line">
        <Select<PinName> className="as-pin" label={`Broche de ${s.name}`} value={s.pin} onChange={(pin) => set({ pin })} options={pinOptions(program, s.pin)} />
        <TextField className="as-signal-name" value={s.name} label={`Nom (#define) de la broche ${s.pin}`} mono validate={nameError} onCommit={(name) => set({ name })} />
        <Segmented<'in' | 'out'>
          className="as-dir"
          label={`Direction de ${s.name}`}
          value={s.dir}
          onChange={(dir) => set({ dir })}
          options={[{ value: 'in', label: 'Entrée', title: 'TRIS = 1' }, { value: 'out', label: 'Sortie', title: 'TRIS = 0' }]}
        />
        <IconButton
          label={`Supprimer ${s.name}`}
          title={used ? `Utilisée par ${used} bloc${used > 1 ? 's' : ''} : retirez-les d’abord` : `Supprimer ${s.name}`}
          onClick={() => edit((p) => removeSignal(p, s.id))}
          disabled={used > 0}
          tone="danger"
        >
          <Icon name="trash" size={13} />
        </IconButton>
      </div>
      <div className="as-signal-line is-second">
        <TextField className="as-grow" value={s.label} label={`Libellé en français de ${s.name} (organigramme)`} placeholder="ex. Led égalité" onCommit={(label) => set({ label: label || s.name })} />
        <Select<SignalDevice> className="as-device" label={`Type de ${s.name}`} value={device} onChange={(d) => set({ device: d })} options={DEVICE_OPTIONS[s.dir]} />
        <Select<'0' | '1'>
          className="as-level"
          label={`Niveau actif de ${s.name}`}
          title="Niveau qui veut dire « allumé » ou « appuyé »"
          value={String(s.activeLevel) as '0' | '1'}
          onChange={(v) => set({ activeLevel: Number(v) as Level })}
          options={[{ value: '1', label: levelLabel(1) }, { value: '0', label: levelLabel(0) }]}
        />
      </div>
      {issues?.length ? (
        <ul className="as-issues">
          {issues.map((i, k) => (
            <li key={`${i.code}${k}`} className={`as-issue is-${i.severity}`}><Icon name={i.severity === 'error' ? 'error' : 'warning'} size={12} /><span>{i.message}</span></li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function BusRow({ b }: { b: Bus }) {
  const { edit, usage } = useAssistant();
  const used = usage.buses.get(b.id) ?? 0;
  const set = (patch: Partial<Bus>) => edit((p) => updateBus(p, b.id, patch));
  const width = PORT_WIDTH[b.port];
  const starts: { value: string; label: string }[] = [];
  for (const port of ['A', 'B'] as const) {
    for (let lsb = 0; lsb + b.width <= PORT_WIDTH[port]; lsb++) starts.push({ value: `${port}${lsb}`, label: busPinsText({ port, lsb, width: b.width }) });
  }
  return (
    <li className="as-signal">
      <div className="as-signal-line">
        <Select
          className="as-bus-pins"
          label={`Broches de ${b.name}`}
          value={`${b.port}${b.lsb}`}
          onChange={(v) => set({ port: v[0] as 'A' | 'B', lsb: Number(v.slice(1)) })}
          options={starts}
        />
        <TextField className="as-signal-name" value={b.name} label={`Nom (#define) de l'afficheur`} mono validate={nameError} onCommit={(name) => set({ name })} />
        <Select<string>
          className="as-level"
          label={`Nombre de bits de ${b.name}`}
          value={String(b.width)}
          onChange={(v) => {
            const w = Number(v);
            set({ width: w, lsb: Math.min(b.lsb, width - w) });
          }}
          options={Array.from({ length: width }, (_, i) => i + 1).map((w) => ({ value: String(w), label: `${w} bit${w > 1 ? 's' : ''}` }))}
        />
        <IconButton label={`Supprimer ${b.name}`} title={used ? `Utilisé par ${used} bloc${used > 1 ? 's' : ''}` : `Supprimer ${b.name}`} onClick={() => edit((p) => removeBus(p, b.id))} disabled={used > 0} tone="danger">
          <Icon name="trash" size={13} />
        </IconButton>
      </div>
      <div className="as-signal-line is-second">
        <TextField className="as-grow" value={b.label} label={`Libellé de ${b.name}`} onCommit={(label) => set({ label: label || b.name })} />
        <Select<'bcd' | 'generic'>
          className="as-device"
          label={`Type de ${b.name}`}
          value={b.device ?? 'generic'}
          onChange={(device) => set({ device })}
          options={[{ value: 'bcd', label: 'Afficheur 7SEG-BCD' }, { value: 'generic', label: 'Groupe de sorties' }]}
        />
      </div>
    </li>
  );
}

export function PinsSection() {
  const { program, edit } = useAssistant();
  const sync = () => {
    const schematic = getApp().project.schematic;
    let summary = '';
    edit((p) => {
      const r = syncWithSchematic(p, deriveSignals(schematic));
      summary = syncSummary(r.report);
      return r.program;
    });
    notify(summary, 'success');
  };
  const count = program.signals.length + program.buses.length;
  return (
    <Section
      id="pins"
      title="Broches"
      count={String(count)}
      hint="Chaque broche utilisée reçoit un nom (#define) et un libellé en français pour l’organigramme."
      actions={(
        <button type="button" className="as-small-button" onClick={sync} title="Reprendre les entrées et sorties câblées dans le schéma (les noms choisis sont gardés)">
          <SyncIcon /> Synchroniser avec le schéma
        </button>
      )}
    >
      {count === 0 && <p className="as-list-empty">Aucune broche. Câblez le schéma puis « Synchroniser avec le schéma », ou ajoutez-les ici.</p>}
      <ul className="as-signals">
        {program.signals.map((s) => <SignalRow key={s.id} s={s} />)}
        {program.buses.map((b) => <BusRow key={b.id} b={b} />)}
      </ul>
      <div className="as-add-row">
        <button type="button" className="as-add" onClick={() => edit((p) => addSignal(p, 'out').program)}><Icon name="plus" size={13} /> Sortie</button>
        <button type="button" className="as-add" onClick={() => edit((p) => addSignal(p, 'in').program)}><Icon name="plus" size={13} /> Entrée</button>
        <button type="button" className="as-add" onClick={() => edit((p) => addBus(p).program)}><Icon name="plus" size={13} /> Afficheur</button>
      </div>
    </Section>
  );
}

function SyncIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M20 11a8 8 0 0 0-14.5-4.5L4 8" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 14.5 4.5L20 16" />
      <path d="M20 20v-4h-4" />
    </svg>
  );
}

// ------------------------------------------------------------------------------------------------ Variables

const VAR_TYPES: readonly VarType[] = ['unsigned char', 'signed char', 'char', 'unsigned int', 'int'];

export function VariablesSection() {
  const { program, edit, usage } = useAssistant();
  const count = program.variables.length + program.constants.length;
  return (
    <Section id="vars" title="Variables et constantes" count={String(count)} hint="unsigned char : un octet de 0 à 255, comme dans les TP.">
      {program.variables.length === 0 && program.constants.length === 0 && <p className="as-list-empty">Aucune variable.</p>}
      <ul className="as-vars">
        {program.variables.map((v) => {
          const used = usage.names.get(v.name.toLowerCase()) ?? 0;
          return (
            <li key={v.name} className="as-var">
              <Select<VarType> className="as-var-type" label={`Type de ${v.name}`} value={v.type} onChange={(type) => edit((p) => updateVariable(p, v.name, { type }))} options={VAR_TYPES.map((t) => ({ value: t, label: t }))} />
              <TextField className="as-grow" value={v.name} label={`Nom de la variable ${v.name}`} mono validate={nameError} onCommit={(name) => edit((p) => updateVariable(p, v.name, { name }))} />
              <span className="as-used" title="Blocs qui l’utilisent">{used ? `${used} bloc${used > 1 ? 's' : ''}` : 'inutilisée'}</span>
              <IconButton label={`Supprimer ${v.name}`} title={used ? 'Utilisée : retirez d’abord les blocs qui s’en servent' : `Supprimer ${v.name}`} disabled={used > 0} onClick={() => edit((p) => removeVariable(p, v.name))} tone="danger">
                <Icon name="trash" size={13} />
              </IconButton>
            </li>
          );
        })}
        {program.constants.map((c) => {
          const used = usage.names.get(c.name.toLowerCase()) ?? 0;
          const text = c.radix === 16 ? `0x${c.value.toString(16).toUpperCase().padStart(2, '0')}` : c.radix === 2 ? `0b${c.value.toString(2).padStart(8, '0')}` : String(c.value);
          return (
            <li key={c.name} className="as-var">
              <span className="as-var-type as-const-tag" title="Constante : #define NOM valeur">#define</span>
              <TextField className="as-grow" value={c.name} label={`Nom de la constante ${c.name}`} mono validate={nameError} onCommit={(name) => edit((p) => updateConstant(p, c.name, { name }))} />
              <TextField
                className="as-const-value"
                value={text}
                label={`Valeur de ${c.name}`}
                mono
                validate={(v) => (parseNumberLiteral(v) ? null : 'Nombre : 10, 0x0A ou 0b0101.')}
                onCommit={(v) => {
                  const n = parseNumberLiteral(v);
                  if (n) edit((p) => updateConstant(p, c.name, { value: n.value, radix: n.radix }));
                }}
              />
              <IconButton label={`Supprimer ${c.name}`} disabled={used > 0} title={used ? 'Utilisée par des blocs' : `Supprimer ${c.name}`} onClick={() => edit((p) => removeConstant(p, c.name))} tone="danger">
                <Icon name="trash" size={13} />
              </IconButton>
            </li>
          );
        })}
      </ul>
      <div className="as-add-row">
        <button type="button" className="as-add" onClick={() => edit((p) => addVariable(p).program)}><Icon name="plus" size={13} /> Variable</button>
        <button type="button" className="as-add" onClick={() => edit((p) => addConstant(p).program)}><Icon name="plus" size={13} /> Constante</button>
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------------------------------------ Interruptions

const PRESCALERS: readonly Prescaler[] = [1, 2, 4, 8, 16, 32, 64, 128, 256];

export function InterruptsSection() {
  const { program, edit } = useAssistant();
  const cfg = program.interrupts;
  const isr = interruptRoutine(program);
  const enabled = isInterruptEnabled(cfg);
  const apply = (next: Partial<InterruptConfig>) => {
    const merged: InterruptConfig = { gie: cfg?.gie ?? true, ...cfg, ...next };
    for (const k of ['int', 'rbChange', 'tmr0'] as const) if (merged[k] === undefined || merged[k] === false) delete merged[k];
    edit((p) => setInterruptConfig(p, isInterruptEnabled(merged) ? merged : undefined));
  };
  return (
    <Section
      id="interrupts"
      title="Interruptions"
      count={enabled ? 'activées' : undefined}
      defaultOpen={enabled}
      hint="Chapitres 5 et 6 : le PIC quitte la boucle principale pour exécuter void interrupt(), puis y revient."
    >
      <div className="as-checks">
        <Check checked={!!cfg?.int} onChange={(on) => apply({ int: on ? { edge: cfg?.int?.edge ?? 'rising' } : undefined })} hint="INTCON.INTE — RB0 doit être une entrée">
          Interruption externe sur RB0/INT
        </Check>
        {cfg?.int && (
          <div className="as-check-sub">
            <Segmented<'rising' | 'falling'>
              label="Front de RB0/INT"
              value={cfg.int.edge}
              onChange={(edge) => apply({ int: { edge } })}
              options={[{ value: 'rising', label: 'Front montant', title: 'OPTION_REG.INTEDG = 1' }, { value: 'falling', label: 'Front descendant', title: 'OPTION_REG.INTEDG = 0' }]}
            />
          </div>
        )}
        <Check checked={!!cfg?.rbChange} onChange={(on) => apply({ rbChange: on || undefined })} hint="INTCON.RBIE — un changement sur RB4 à RB7">
          Changement d’état sur RB4 à RB7
        </Check>
        <Check checked={!!cfg?.tmr0} onChange={(on) => apply({ tmr0: on ? { prescaler: cfg?.tmr0?.prescaler ?? 256 } : undefined })} hint="INTCON.T0IE — débordement du timer 0">
          Débordement du TMR0
        </Check>
        {cfg?.tmr0 && (
          <div className="as-check-sub">
            <Select<string>
              label="Prédiviseur du TMR0"
              value={String(cfg.tmr0.prescaler)}
              onChange={(v) => apply({ tmr0: { prescaler: Number(v) as Prescaler } })}
              options={PRESCALERS.map((ps) => ({ value: String(ps), label: ps === 1 ? 'Sans prédiviseur' : `Prédiviseur 1:${ps}` }))}
            />
          </div>
        )}
        <Check checked={cfg?.gie ?? false} disabled={!enabled} onChange={(gie) => apply({ gie })} hint="INTCON.GIE — sans lui, aucune interruption ne se produit">
          Autorisation générale (GIE)
        </Check>
      </div>
      {isr && (
        <div className="as-isr">
          <div className="as-isr-head">
            <span className="as-isr-title">Programme d’interruption <code>void interrupt()</code></span>
            <IconButton label="Supprimer le programme d’interruption" onClick={() => edit((p) => removeFunction(p, isr.id))} tone="danger">
              <Icon name="trash" size={13} />
            </IconButton>
          </div>
          <BlockList listKey={fnList(isr.id)} stmts={isr.body} inInterrupt empty="Ajoutez ce que fait l’interruption, sans oublier d’effacer son drapeau." />
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------------------------------------ Style du code

const TRIS_OPTIONS: readonly { value: TrisMode; label: string }[] = [
  { value: 'auto', label: 'Automatique' },
  { value: 'bits', label: 'Bit par bit (TRISA.RA0 = 1;)' },
  { value: 'port', label: 'Registre entier (TRISB = 0x00;)' },
];

export function StyleSection() {
  const { program, edit } = useAssistant();
  const st = program.style;
  const set = (patch: Partial<CodeStyle>) => edit((p) => ({ ...p, style: { ...p.style, ...patch } }));
  return (
    <Section id="style" title="Style du code" defaultOpen={false} hint="Chaque option reprend une habitude du cours (demux.c ou status.c).">
      <div className="as-style">
        <div className="as-style-row">
          <span className="as-row-label">Bits des ports</span>
          <Segmented<'pin' | 'index'>
            label="Écriture des bits"
            value={st.bitNotation}
            onChange={(bitNotation) => set({ bitNotation })}
            options={[{ value: 'pin', label: 'PORTA.RA0', title: 'Comme demux.c' }, { value: 'index', label: 'PORTA.F0', title: 'Comme status.c' }]}
          />
        </div>
        <div className="as-style-row">
          <span className="as-row-label">Titres de sections</span>
          <Segmented<'demux' | 'status'>
            label="Commentaires de sections"
            value={st.sections}
            onChange={(sections) => set({ sections })}
            options={[
              { value: 'demux', label: 'demux.c', title: '// Configuration des entrées … // Boucle principale' },
              { value: 'status', label: 'status.c', title: '// Configuration  i/o … // Traitement' },
            ]}
          />
        </div>
        <div className="as-style-row">
          <span className="as-row-label">TRISA</span>
          <Select<TrisMode> label="Configuration de TRISA" value={st.tris.A} onChange={(A) => set({ tris: { ...st.tris, A } })} options={TRIS_OPTIONS} />
        </div>
        <div className="as-style-row">
          <span className="as-row-label">TRISB</span>
          <Select<TrisMode> label="Configuration de TRISB" value={st.tris.B} onChange={(B) => set({ tris: { ...st.tris, B } })} options={TRIS_OPTIONS} />
        </div>
        <Check checked={st.macros} onChange={(macros) => set({ macros })} hint="#define LED_ON(pin)  (pin = 1), comme status.c">Macros LED_ON / LED_OFF</Check>
        <Check checked={st.compactAssign} onChange={(compactAssign) => set({ compactAssign })} hint="D0=1; au lieu de D0 = 1;">Écriture compacte</Check>
        <Check checked={st.echoRegister} onChange={(echoRegister) => set({ echoRegister })} hint="D0=0; //PORTB.RB0=0; comme demux.c">Rappeler le registre en commentaire</Check>
        <Check checked={st.oneLineBranches} onChange={(oneLineBranches) => set({ oneLineBranches })} hint="if (STATUS.F2 == 1) { LED_ON(LED_EGAL); }">« Si » courts sur une ligne</Check>
        <Check checked={st.packLines} onChange={(packLines) => set({ packLines })} hint="x = 6; y = 6; et LED_OFF(…); LED_OFF(…); sur une ligne, comme status.c">Regrouper les instructions semblables</Check>
      </div>
    </Section>
  );
}

