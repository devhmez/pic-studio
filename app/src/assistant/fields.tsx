// Small form controls of the assistant drawer. Text fields keep a local draft and commit on blur / Enter
// (Escape restores), so the code is regenerated once per change rather than once per keystroke.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Expr, Program } from '@pic/program-model';
import { exprText } from './blocks';
import { expressionNames, parseExpr } from './expr';

interface TextFieldProps {
  value: string;
  onCommit(value: string): void;
  label: string;
  placeholder?: string;
  mono?: boolean;
  className?: string;
  /** Returns a French error to show (the value is not committed), or null. */
  validate?: (value: string) => string | null;
  /** Transform before committing (trim by default). */
  normalize?: (value: string) => string;
  list?: string;
  title?: string;
  disabled?: boolean;
}

export function TextField({ value, onCommit, label, placeholder, mono, className = '', validate, normalize = (v) => v.trim(), list, title, disabled }: TextFieldProps) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);

  const commit = () => {
    editing.current = false;
    const next = normalize(draft);
    const problem = validate?.(next) ?? null;
    setError(problem);
    if (problem) return;
    if (next !== value) onCommit(next);
    else setDraft(value);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      editing.current = false;
      setDraft(value);
      setError(null);
      const input = e.currentTarget;
      requestAnimationFrame(() => input.blur());
    }
  };
  return (
    <span className={`as-field ${className}`}>
      <input
        className={`as-input${mono ? ' is-mono' : ''}${error ? ' is-invalid' : ''}`}
        value={draft}
        onChange={(e) => { editing.current = true; setDraft(e.target.value); if (error) setError(null); }}
        onBlur={commit}
        onKeyDown={onKeyDown}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        list={list}
        title={error ?? title ?? label}
        disabled={disabled}
      />
      {error && <span className="as-field-error" role="alert">{error}</span>}
    </span>
  );
}

interface NumberFieldProps {
  value: number;
  onCommit(value: number): void;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  className?: string;
}

export function NumberField({ value, onCommit, label, min, max, step = 1, suffix, className = '' }: NumberFieldProps) {
  return (
    <span className={`as-number ${className}`}>
      <TextField
        value={String(value)}
        label={label}
        mono
        className="as-number-input"
        validate={(v) => {
          const n = Number(v.replace(',', '.'));
          if (!Number.isFinite(n) || v === '') return 'Nombre attendu.';
          if (step === 1 && !Number.isInteger(n)) return 'Nombre entier attendu.';
          if (min !== undefined && n < min) return `Minimum ${min}.`;
          if (max !== undefined && n > max) return `Maximum ${max}.`;
          return null;
        }}
        onCommit={(v) => onCommit(Number(v.replace(',', '.')))}
      />
      {suffix && <span className="as-suffix">{suffix}</span>}
    </span>
  );
}

interface ExprFieldProps {
  program: Program;
  value: Expr;
  onCommit(value: Expr): void;
  label: string;
  placeholder?: string;
  className?: string;
}

/** A C expression typed as text (« var1 - var2 », « 0x0A »), resolved against the program's names. */
export function ExprField({ program, value, onCommit, label, placeholder, className }: ExprFieldProps) {
  const listId = useId();
  const names = expressionNames(program);
  return (
    <>
      <TextField
        value={exprText(program, value)}
        label={label}
        placeholder={placeholder ?? 'ex. x - y, 0x0A'}
        mono
        className={className}
        list={listId}
        validate={(v) => {
          const r = parseExpr(v, program);
          return r.ok ? null : r.error;
        }}
        onCommit={(v) => {
          const r = parseExpr(v, program);
          if (r.ok) onCommit(r.expr);
        }}
        title={`${label} — variables, constantes, broches (#define), nombres 10 / 0x0A / 0b0101, opérateurs + - * / & | ^ << >>`}
      />
      <datalist id={listId}>{names.map((n) => <option key={n} value={n} />)}</datalist>
    </>
  );
}

interface SelectProps<T extends string> {
  value: T;
  onChange(value: T): void;
  label: string;
  options: readonly { value: T; label: string; disabled?: boolean; group?: string }[];
  className?: string;
  title?: string;
  disabled?: boolean;
}

export function Select<T extends string>({ value, onChange, label, options, className = '', title, disabled }: SelectProps<T>) {
  const groups: { name: string | undefined; items: typeof options[number][] }[] = [];
  for (const o of options) {
    const last = groups[groups.length - 1];
    if (last && last.name === o.group) last.items.push(o);
    else groups.push({ name: o.group, items: [o] });
  }
  const known = options.some((o) => o.value === value);
  const render = (o: typeof options[number]) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>;
  return (
    <select
      className={`as-select ${className}`}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
    >
      {!known && <option value={value}>{value ? `« ${value} » (introuvable)` : '— choisir —'}</option>}
      {groups.map((g, i) => (g.name ? <optgroup key={`${g.name}${i}`} label={g.name}>{g.items.map(render)}</optgroup> : g.items.map(render)))}
    </select>
  );
}

interface SegmentedProps<T extends string | number> {
  value: T;
  onChange(value: T): void;
  label: string;
  options: readonly { value: T; label: ReactNode; title?: string }[];
  className?: string;
}

export function Segmented<T extends string | number>({ value, onChange, label, options, className = '' }: SegmentedProps<T>) {
  return (
    <span className={`as-seg ${className}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          onClick={() => { if (o.value !== value) onChange(o.value); }}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

interface CheckProps {
  checked: boolean;
  onChange(checked: boolean): void;
  children: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}

export function Check({ checked, onChange, children, hint, disabled }: CheckProps) {
  return (
    <label className={`as-check${disabled ? ' is-disabled' : ''}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <span className="as-check-text">
        <span>{children}</span>
        {hint && <span className="as-hint">{hint}</span>}
      </span>
    </label>
  );
}

interface TextAreaProps {
  value: string;
  onCommit(value: string): void;
  label: string;
  placeholder?: string;
  mono?: boolean;
  rows?: number;
  autoFocus?: boolean;
}

/** Multi-line text (code C libre, texte de l'organigramme): commits on blur or ⌘↩. */
export function TextArea({ value, onCommit, label, placeholder, mono, rows = 3, autoFocus }: TextAreaProps) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  const commit = () => {
    editing.current = false;
    if (draft !== value) onCommit(draft);
  };
  return (
    <textarea
      className={`as-textarea${mono ? ' is-mono' : ''}`}
      value={draft}
      rows={rows}
      onChange={(e) => { editing.current = true; setDraft(e.target.value); }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.currentTarget.blur(); }
        else if (e.key === 'Escape') { e.stopPropagation(); editing.current = false; setDraft(value); }
      }}
      aria-label={label}
      title={`${label} (⌘↩ pour valider)`}
      placeholder={placeholder}
      spellCheck={false}
      autoFocus={autoFocus}
    />
  );
}

/** Label + control on one line inside an editor. */
export function Row({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="as-row">
      <span className="as-row-label">{label}</span>
      <span className="as-row-control">{children}</span>
      {hint && <span className="as-hint as-row-hint">{hint}</span>}
    </div>
  );
}

interface IconButtonProps {
  label: string;
  title?: string;
  onClick(): void;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
  tone?: 'danger';
}

export function IconButton({ label, title, onClick, disabled, children, className = '', tone }: IconButtonProps) {
  return (
    <button
      type="button"
      className={`as-iconbtn${tone === 'danger' ? ' is-danger' : ''} ${className}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title ?? label}
    >
      {children}
    </button>
  );
}
