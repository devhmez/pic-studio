// Virtualized assembly listing: address, opcode, label, instruction and C source, with the PC row highlighted,
// breakpoint toggles in the gutter and the reset / interrupt vectors called out.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { getApp } from '../state/store';
import { hex0x } from './format';
import { SHORTCUTS } from './commands';
import { moveCodeCursor, type ListingRow } from './listing';
import { useVirtualRows } from './virtual';

export const LISTING_ROW_HEIGHT = 22;

export interface ListingViewProps {
  rows: readonly ListingRow[];
  rowByAddr: ReadonlyMap<number, number>;
  /** PC to highlight, or null when stopped. */
  pc: number | null;
  /** C line currently executing (its instructions get a light band). */
  execLine: number | null;
  breakpoints: readonly number[];
  /** Follow the PC (when paused/stepping; not while running at full speed). */
  follow: boolean;
  /** Dim the PC highlight while the simulation runs. */
  running: boolean;
  /** Text of the empty state (default: waiting for a successful build). */
  emptyMessage?: string;
  /** Toggle a breakpoint on an address of these rows (default: the store's toggleBreakpoint). */
  onToggleBreakpoint?: (addr: number) => void;
}

const defaultToggle = (addr: number): void => getApp().toggleBreakpoint(addr);

export const ListingView = memo(function ListingView({
  rows, rowByAddr, pc, execLine, breakpoints, follow, running, emptyMessage, onToggleBreakpoint = defaultToggle,
}: ListingViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { range, onScroll, reveal } = useVirtualRows(scrollRef, rows.length, LISTING_ROW_HEIGHT);
  const bpSet = useMemo(() => new Set(breakpoints), [breakpoints]);
  const pcRow = pc === null ? -1 : rowByAddr.get(pc) ?? -1;
  /** Keyboard cursor (an instruction row), shown while the listing has focus. */
  const [cursor, setCursor] = useState(-1);
  const cursorRow = cursor >= 0 && cursor < rows.length && rows[cursor].kind === 'code' ? cursor : -1;

  useEffect(() => {
    if (follow && pcRow >= 0) reveal(pcRow);
  }, [follow, pcRow, reveal]);

  const moveTo = useCallback((index: number) => {
    if (index < 0) return;
    setCursor(index);
    reveal(index);
  }, [reveal]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 220) / LISTING_ROW_HEIGHT) - 2);
    const from = cursorRow >= 0 ? cursorRow : pcRow;
    let handled = true;
    switch (e.key) {
      case 'ArrowDown': moveTo(moveCodeCursor(rows, from, 1)); break;
      case 'ArrowUp': moveTo(moveCodeCursor(rows, from, -1)); break;
      case 'PageDown': moveTo(moveCodeCursor(rows, from, page)); break;
      case 'PageUp': moveTo(moveCodeCursor(rows, from, -page)); break;
      case 'Home': moveTo(moveCodeCursor(rows, -1, 1)); break;
      case 'End': moveTo(moveCodeCursor(rows, -1, -1)); break;
      case ' ':
      case 'Enter':
      case SHORTCUTS.breakpoint.keys[0]: {
        const target = cursorRow >= 0 ? cursorRow : pcRow;
        const addr = target >= 0 ? rows[target].addr : null;
        if (addr !== null) onToggleBreakpoint(addr);
        else handled = false;
        break;
      }
      default: handled = false;
    }
    if (handled) e.preventDefault();
  };

  if (rows.length === 0) {
    // Keep the scroll container mounted so the virtualizer's observers stay attached.
    return (
      <div className="dbg-listing is-empty" ref={scrollRef}>
        <div className="pcx-empty">
          <strong>Pas encore de listing</strong>
          {emptyMessage ?? 'Le code assembleur apparaît ici dès que le programme C compile sans erreur.'}
        </div>
      </div>
    );
  }

  const visible: ReactNode[] = [];
  for (let i = range.start; i < range.end; i++) {
    const r = rows[i];
    visible.push(
      <ListingRowView
        key={r.key}
        row={r}
        index={i}
        isPc={i === pcRow}
        isCursor={i === cursorRow}
        running={running}
        inExecLine={execLine !== null && r.srcLine === execLine}
        hasBreakpoint={r.addr !== null && bpSet.has(r.addr)}
        onToggle={onToggleBreakpoint}
      />,
    );
  }

  return (
    <div
      className="dbg-listing"
      ref={scrollRef}
      onScroll={onScroll}
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="grid"
      aria-label="Listing assembleur — ↑ ↓ pour parcourir, F9 ou Espace pour un point d'arrêt"
      aria-rowcount={rows.length + 1}
      aria-activedescendant={cursorRow >= 0 ? `dbg-row-${cursorRow}` : undefined}
      title="↑ ↓ pour parcourir les instructions, F9 ou Espace pour poser / retirer un point d'arrêt"
    >
      <div className="dbg-lrow dbg-lhead" role="row" aria-rowindex={1}>
        <span role="columnheader" className="dbg-lgutter"><span className="pcx-visually-hidden">Point d'arrêt</span></span>
        <span role="columnheader" title="Adresse en mémoire programme (hexadécimal)">Adr.</span>
        <span role="columnheader" title="Code machine de l'instruction (14 bits, hexadécimal)">Code</span>
        <span role="columnheader" title="Étiquette (nom de routine ou de saut)">Étiq.</span>
        <span role="columnheader">Instruction</span>
        <span role="columnheader">Source C</span>
      </div>
      <div className="dbg-lbody" role="rowgroup" style={{ height: rows.length * LISTING_ROW_HEIGHT }}>
        {visible}
      </div>
    </div>
  );
});

interface RowProps {
  row: ListingRow;
  index: number;
  isPc: boolean;
  isCursor: boolean;
  running: boolean;
  inExecLine: boolean;
  hasBreakpoint: boolean;
  onToggle(addr: number): void;
}

const ListingRowView = memo(function ListingRowView({ row, index, isPc, isCursor, running, inExecLine, hasBreakpoint, onToggle }: RowProps) {
  const style = { transform: `translateY(${index * LISTING_ROW_HEIGHT}px)` };
  if (row.kind === 'section' || row.kind === 'gap') {
    return (
      <div className={`dbg-lrow dbg-lnote is-${row.kind}`} style={style} role="row" aria-rowindex={index + 2}>
        <span role="gridcell" className="dbg-lnote-text">{row.note}</span>
      </div>
    );
  }
  if (row.kind === 'label') {
    return (
      <div className="dbg-lrow is-label-only" style={style} role="row" aria-rowindex={index + 2}>
        <span role="gridcell" className="dbg-lgutter" />
        <span role="gridcell" />
        <span role="gridcell" />
        <span role="gridcell" className="dbg-llabel">{row.label}:</span>
        <span role="gridcell" />
        <span role="gridcell" />
      </div>
    );
  }
  const addr = row.addr!;
  const cls = ['dbg-lrow', 'is-code'];
  if (isPc) cls.push(running ? 'is-pc-running' : 'is-pc');
  if (inExecLine && !isPc && !running) cls.push('is-exec-line');
  if (hasBreakpoint) cls.push('has-bp');
  if (isCursor) cls.push('is-cursor');
  return (
    <div id={`dbg-row-${index}`} className={cls.join(' ')} style={style} role="row" aria-rowindex={index + 2}
      aria-current={isPc ? 'step' : undefined} aria-selected={isCursor}>
      <span role="gridcell" className="dbg-lgutter">
        <button
          type="button"
          tabIndex={-1}
          className="dbg-bp"
          aria-pressed={hasBreakpoint}
          aria-label={`${hasBreakpoint ? 'Retirer' : 'Ajouter'} un point d'arrêt à ${hex0x(addr, 3)}`}
          title={hasBreakpoint ? 'Retirer le point d’arrêt' : 'Ajouter un point d’arrêt sur cette instruction'}
          onClick={() => onToggle(addr)}
        >
          {isPc ? <span className="dbg-pc-arrow" aria-hidden="true">▶</span> : null}
        </button>
      </span>
      <span role="gridcell" className="dbg-laddr">{row.addrText}</span>
      <span role="gridcell" className="dbg-lop">{row.opcodeText}</span>
      <span role="gridcell" className="dbg-llabel" title={row.label ?? undefined}>{row.label ? `${row.label}:` : ''}</span>
      <span role="gridcell" className="dbg-lins">
        <span className="dbg-mn">{row.mnemonic}</span>
        {row.operands ? <span className="dbg-ops"> {row.operands}</span> : null}
      </span>
      <span role="gridcell" className="dbg-lsrc" title={row.comment ? `Ligne ${row.srcLine} : ${row.comment}` : undefined}>
        {row.comment ? (
          <>
            <span className="dbg-lline">{row.srcLine}</span>
            {row.comment}
          </>
        ) : null}
      </span>
    </div>
  );
});
