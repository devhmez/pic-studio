// Properties of the selected part (double-click or Entrée): reference, value, colour, initial state, PIC clock.
import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  getSymbol, LDR_LEVEL_OHMS, LED_COLOR_NAMES, parseResistance, SEVEN_SEG_COLOR_NAMES, formatValue,
  type ComponentInstance,
} from '@pic/circuit';
import { getApp, useApp } from '../state/store';
import { CLOCK_OPTIONS, formatClock } from '../shell/format';
import { Icon } from '../shell/icons';
import { componentExtent, updateComponent } from './editing';
import { commit, patchEditor, useEditor } from './editorStore';
import { KIND_LABEL } from './parts';
import { deleteSelected, rotateOrMirror } from './commands';
import { toScreen } from './viewport';

const COLOR_LABEL: Readonly<Record<string, string>> = { RED: 'Rouge', GREEN: 'Vert', BLUE: 'Bleu', YELLOW: 'Jaune' };

function change(id: string, fn: (c: ComponentInstance) => ComponentInstance): void {
  commit(updateComponent(getApp().project.schematic, id, fn));
}

/** Text field committed on Entrée or when it loses focus; Échap restores the value. */
function TextField({ label, value, onCommit, validate, disabled, placeholder, hint }: {
  label: string;
  value: string;
  onCommit(v: string): void;
  validate?(v: string): string | null;
  disabled?: boolean;
  placeholder?: string;
  hint?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const error = validate && draft !== value ? validate(draft) : null;
  const done = () => {
    if (draft === value) return;
    if (validate?.(draft)) {
      setDraft(value);
      return;
    }
    onCommit(draft.trim());
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      done();
      e.currentTarget.select();
    } else if (e.key === 'Escape') {
      if (draft !== value) {
        e.stopPropagation();
        setDraft(value);
      }
    }
  };
  return (
    <label className="sch-field">
      <span className="sch-field-label">{label}</span>
      <input
        type="text"
        value={draft}
        disabled={disabled}
        placeholder={placeholder}
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={done}
        onKeyDown={onKeyDown}
      />
      {error ? <span className="sch-field-error">{error}</span> : hint ? <span className="sch-field-hint">{hint}</span> : null}
    </label>
  );
}

function Segmented<T extends string | number>({ label, value, options, onChange, disabled }: {
  label: string;
  value: T;
  options: readonly { value: T; label: ReactNode; title?: string }[];
  onChange(v: T): void;
  disabled?: boolean;
}) {
  return (
    <div className="sch-field">
      <span className="sch-field-label">{label}</span>
      <div className="sch-segmented" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            className={o.value === value ? 'is-on' : ''}
            disabled={disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function KindFields({ c, disabled }: { c: ComponentInstance; disabled: boolean }) {
  const clockHz = useApp((s) => s.project.clockHz);
  const config = useApp((s) => s.project.config);
  switch (c.kind) {
    case 'LED':
      return (
        <Segmented
          label="Couleur"
          value={String(c.props.color ?? 'RED')}
          disabled={disabled}
          options={LED_COLOR_NAMES.map((col) => ({ value: col, label: <span className={`sch-swatch led-${col.toLowerCase()}`} />, title: COLOR_LABEL[col] }))}
          onChange={(color) => change(c.id, (x) => ({
            ...x,
            props: { ...x.props, color },
            value: !x.value || /^LED-/.test(x.value) ? `LED-${color}` : x.value,
          }))}
        />
      );
    case '7SEG-BCD':
    case '7SEG-CC':
      return (
        <Segmented
          label="Couleur"
          value={String(c.props.color ?? 'RED')}
          disabled={disabled}
          options={SEVEN_SEG_COLOR_NAMES.map((col) => ({ value: col, label: <span className={`sch-swatch seg-${col.toLowerCase()}`} />, title: COLOR_LABEL[col] }))}
          onChange={(color) => change(c.id, (x) => ({ ...x, props: { ...x.props, color } }))}
        />
      );
    case 'LOGICSTATE':
      return (
        <Segmented
          label="État au démarrage"
          value={Number(c.props.state) === 1 ? 1 : 0}
          disabled={disabled}
          options={[{ value: 0, label: '0', title: 'Niveau bas' }, { value: 1, label: '1', title: 'Niveau haut' }]}
          onChange={(state) => change(c.id, (x) => ({ ...x, props: { ...x.props, state } }))}
        />
      );
    case 'RES':
      return (
        <TextField
          label="Valeur (Ω)"
          value={c.value ?? ''}
          disabled={disabled}
          placeholder="220, 1k, 10k, 4k7…"
          validate={(v) => (parseResistance(v) === null ? 'Valeur invalide : par exemple 220, 1k, 10k ou 4k7.' : null)}
          onCommit={(value) => change(c.id, (x) => ({ ...x, value }))}
        />
      );
    case 'CAP':
      return <TextField label="Valeur" value={c.value ?? ''} disabled={disabled} placeholder="22pF" onCommit={(value) => change(c.id, (x) => ({ ...x, value }))} />;
    case 'CRYSTAL':
      return (
        <TextField
          label="Fréquence"
          value={String(c.props.freq ?? '')}
          disabled={disabled}
          hint="Décoratif : la vitesse vient de l’horloge du PIC."
          onCommit={(freq) => change(c.id, (x) => ({ ...x, props: { ...x.props, freq } }))}
        />
      );
    case 'TORCH_LDR': {
      const level = Math.max(0, Math.min(LDR_LEVEL_OHMS.length - 1, Number(c.props.level ?? 0)));
      return (
        <label className="sch-field">
          <span className="sch-field-label">Lumière au démarrage : {level}/{LDR_LEVEL_OHMS.length - 1} (LDR ≈ {formatValue(LDR_LEVEL_OHMS[level])}Ω)</span>
          <input
            type="range"
            min={0}
            max={LDR_LEVEL_OHMS.length - 1}
            value={level}
            disabled={disabled}
            onChange={(e) => change(c.id, (x) => ({ ...x, props: { ...x.props, level: Number(e.target.value) } }))}
          />
        </label>
      );
    }
    case 'PIC16F84A': {
      const options = CLOCK_OPTIONS.includes(clockHz) ? CLOCK_OPTIONS : [...CLOCK_OPTIONS, clockHz].sort((a, b) => a - b);
      return (
        <>
          <label className="sch-field">
            <span className="sch-field-label">Horloge (CLOCK)</span>
            <select value={String(clockHz)} disabled={disabled} onChange={(e) => getApp().setClock(Number(e.target.value))}>
              {options.map((hz) => <option key={hz} value={String(hz)}>{formatClock(hz)}</option>)}
            </select>
            <span className="sch-field-hint">Le code (Delay_ms) et la simulation utilisent la même horloge.</span>
          </label>
          <div className="sch-field">
            <span className="sch-field-label">Mot de configuration</span>
            <span className="sch-field-static">0x{config.toString(16).toUpperCase().padStart(4, '0')} (chien de garde désactivé)</span>
          </div>
        </>
      );
    }
    default:
      return null;
  }
}

export const PropertiesPopover = memo(function PropertiesPopover() {
  const id = useEditor((s) => s.popoverFor);
  const view = useEditor((s) => s.view);
  const size = useEditor((s) => s.size);
  const component = useApp((s) => (id ? s.project.schematic.components.find((c) => c.id === id) ?? null : null));
  const locked = useApp((s) => s.sim.status === 'running');
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(240);

  useLayoutEffect(() => {
    if (ref.current) setHeight(ref.current.offsetHeight);
  });

  useEffect(() => {
    if (id) ref.current?.querySelector<HTMLElement>('input, select, button')?.focus({ preventScroll: true });
  }, [id]);

  if (!component) return null;
  const symbol = getSymbol(component.kind, component.props);
  const ext = componentExtent(component);
  const anchor = toScreen(view, { x: ext.x + ext.w, y: ext.y });
  const width = 260;
  let left = anchor.x + 12;
  if (left + width > size.w - 8) left = Math.max(8, toScreen(view, { x: ext.x, y: 0 }).x - width - 12);
  const top = Math.max(8, Math.min(anchor.y, size.h - height - 8));
  const close = () => patchEditor({ popoverFor: null });

  return (
    <div
      ref={ref}
      className="sch-overlay-ui sch-popover"
      style={{ left, top, width }}
      role="dialog"
      aria-label={`Propriétés de ${component.ref || KIND_LABEL[component.kind]}`}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
          (document.querySelector('.sch-canvas-wrap') as HTMLElement | null)?.focus();
        }
      }}
    >
      <header className="sch-popover-header">
        <div>
          <div className="sch-popover-title">{KIND_LABEL[component.kind]}</div>
          <div className="sch-popover-sub">{symbol.isisName}</div>
        </div>
        <button type="button" className="icon-button" onClick={close} aria-label="Fermer les propriétés (Échap)">
          <Icon name="close" size={13} />
        </button>
      </header>
      {locked && <p className="sch-popover-note"><Icon name="lock" size={12} /> Mettez la simulation en pause pour modifier.</p>}
      <TextField
        label="Référence"
        value={component.ref}
        disabled={locked}
        placeholder={symbol.refPrefix ? `${symbol.refPrefix}1` : 'aucune'}
        hint={component.kind === 'LOGICSTATE' || component.kind === 'BUTTON' ? 'Par exemple VALIDER, DEMARRER…' : undefined}
        onCommit={(ref) => change(component.id, (x) => ({ ...x, ref }))}
      />
      <KindFields c={component} disabled={locked} />
      <footer className="sch-popover-actions">
        <button type="button" className="tool-button ghost" disabled={locked} onClick={() => rotateOrMirror('rotate')} title="Pivoter de 90° (R)">
          <Icon name="rotate" size={14} /> Pivoter
        </button>
        <button type="button" className="tool-button ghost" disabled={locked} onClick={() => rotateOrMirror('mirror')} title="Miroir horizontal (M)">
          <Icon name="mirror" size={14} /> Miroir
        </button>
        <button type="button" className="tool-button ghost danger" disabled={locked} onClick={deleteSelected} title="Supprimer (⌫)">
          <Icon name="trash" size={14} /> Supprimer
        </button>
      </footer>
    </div>
  );
});
