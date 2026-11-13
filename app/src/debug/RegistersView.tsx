// Registres: W, PC, cycles/time, STATUS bit chips, the 8-level stack, SFRs, C variables and the data EEPROM.
import { memo, useMemo } from 'react';
import type { SymbolInfo } from '@pic/compiler';
import type { DebugSnapshot } from '../state/types';
import type { SnapshotDiff } from './diff';
import { binGrouped, formatClock, formatCycleTime, formatTime, groupThousands, hex, hex0x } from './format';
import { selectedBank, sfrRows, stackSlots, statusChips, variableRows, type BitCell } from './registers';

export interface RegistersViewProps {
  debug: DebugSnapshot;
  diff: SnapshotDiff;
  symbols: readonly SymbolInfo[];
  addrToLine: ReadonlyMap<number, number> | null;
  clockHz: number;
  /** Worst-case stack depth computed by the compiler, if known. */
  stackDepth: number | undefined;
}

export const RegistersView = memo(function RegistersView({ debug, diff, symbols, addrToLine, clockHz, stackDepth }: RegistersViewProps) {
  const pcLine = addrToLine?.get(debug.pc) ?? null;
  return (
    <div className="dbg-regs">
      <section className="dbg-card dbg-core" aria-label="Cœur du processeur">
        <Stat
          label="W"
          title="W : registre de travail (accumulateur). Toutes les opérations passent par lui."
          value={hex0x(debug.w)}
          sub={`${debug.w} · ${binGrouped(debug.w)}`}
          changed={diff.w}
        />
        <Stat
          label="PC"
          title="PC : compteur ordinal (13 bits) — adresse de la prochaine instruction à exécuter."
          value={hex0x(debug.pc & 0x1fff, 4)}
          sub={pcLine !== null ? `ligne C ${pcLine}` : 'hors ligne C'}
          changed={diff.pc}
        />
        <Stat
          label="Cycles"
          title={`Cycles machine depuis le reset. Un cycle = 4 périodes d'horloge = ${formatCycleTime(clockHz)} à ${formatClock(clockHz)}.`}
          value={groupThousands(debug.cycles)}
          sub={`1 cycle = ${formatCycleTime(clockHz)}`}
        />
        <Stat
          label="Temps simulé"
          title="Temps écoulé dans le circuit simulé depuis le reset."
          value={formatTime(debug.time)}
          sub={`horloge ${formatClock(clockHz)}`}
        />
        {(debug.halted || debug.sleeping) && (
          <p className="dbg-core-note" role="status">
            {debug.halted
              ? 'Programme terminé : main() est sorti, le PIC boucle sur « GOTO $ ».'
              : 'En sommeil (SLEEP) : le PIC attend un réveil (interruption, WDT ou reset).'}
          </p>
        )}
      </section>

      <StatusCard status={debug.status} changedMask={diff.statusMask} />
      <StackCard stack={debug.stack} changed={diff.stack} addrToLine={addrToLine} stackDepth={stackDepth} />
      <SfrCard file={debug.file} changed={diff.file} />
      <VariablesCard symbols={symbols} file={debug.file} changed={diff.file} />
      <EepromCard eeprom={debug.eeprom} changed={diff.eeprom} />
    </div>
  );
});

function Stat({ label, title, value, sub, changed = false }: { label: string; title: string; value: string; sub: string; changed?: boolean }) {
  return (
    <div className={`dbg-stat${changed ? ' is-changed' : ''}`} title={title}>
      <span className="dbg-stat-label">{label}</span>
      <span className="dbg-stat-value pcx-mono">{value}</span>
      <span className="dbg-stat-sub pcx-mono">{sub}</span>
    </div>
  );
}

const StatusCard = memo(function StatusCard({ status, changedMask }: { status: number; changedMask: number }) {
  const chips = useMemo(() => statusChips(status, changedMask), [status, changedMask]);
  return (
    <section className="dbg-card" aria-labelledby="dbg-status-title">
      <header className="dbg-card-head">
        <h3 id="dbg-status-title">STATUS</h3>
        <span className="pcx-mono dbg-card-value" title={`STATUS = ${hex0x(status)} = ${binGrouped(status)}`}>{hex0x(status)}</span>
        <span className="dbg-card-hint">banque {selectedBank(status)}</span>
      </header>
      <div className="dbg-chips" role="list">
        {chips.map((c) => (
          <span
            key={c.bit}
            role="listitem"
            className={`dbg-chip${c.value ? ' is-on' : ''}${c.changed ? ' is-changed' : ''}`}
            title={`${c.help}\n\nValeur actuelle : ${c.value}${c.changed ? ' (vient de changer)' : ''}`}
            aria-label={`${c.label} = ${c.value}${c.changed ? ', modifié' : ''}`}
          >
            <span className="dbg-chip-name">{c.label}</span>
            <span className="dbg-chip-val pcx-mono">{c.value}</span>
          </span>
        ))}
      </div>
    </section>
  );
});

const StackCard = memo(function StackCard({ stack, changed, addrToLine, stackDepth }: {
  stack: readonly number[];
  changed: boolean;
  addrToLine: ReadonlyMap<number, number> | null;
  stackDepth: number | undefined;
}) {
  const slots = useMemo(() => stackSlots(stack), [stack]);
  return (
    <section className={`dbg-card${changed ? ' is-changed' : ''}`} aria-labelledby="dbg-stack-title">
      <header className="dbg-card-head">
        <h3 id="dbg-stack-title" title="Pile matérielle à 8 niveaux : CALL et les interruptions y empilent l'adresse de retour, RETURN/RETFIE la dépilent.">Pile</h3>
        <span className="dbg-card-hint">{stack.length} / 8 niveaux{stackDepth !== undefined ? ` · max. prévu ${stackDepth}` : ''}</span>
      </header>
      <ol className="dbg-stack" aria-label="Niveaux de la pile, du sommet vers le bas">
        {slots.map((s) => {
          const line = s.addr !== null ? addrToLine?.get((s.addr - 1) & 0x1fff) : undefined;
          return (
            <li key={s.level} className={`dbg-stack-slot${s.addr === null ? ' is-empty' : ''}${s.isTop ? ' is-top' : ''}`}
              title={s.addr === null ? `Niveau ${s.level} : vide` : `Niveau ${s.level} : retour à ${hex0x(s.addr, 4)}${line !== undefined ? ` (appel ligne C ${line})` : ''}`}>
              <span className="dbg-stack-level">{s.level}</span>
              <span className="pcx-mono">{s.addr === null ? '—' : hex0x(s.addr, 4)}</span>
              {s.isTop && <span className="dbg-stack-top">sommet</span>}
            </li>
          );
        })}
      </ol>
    </section>
  );
});

function Bits({ cells }: { cells: readonly BitCell[] }) {
  return (
    <span className="dbg-bits pcx-mono">
      {cells.map((b) => (
        <span key={b.bit} className={`dbg-bit${b.implemented ? '' : ' is-unimpl'}${b.value ? ' is-one' : ''}`} title={b.title}>
          {b.implemented ? b.value : '-'}
        </span>
      ))}
    </span>
  );
}

const SfrCard = memo(function SfrCard({ file, changed }: { file: readonly number[]; changed: ReadonlySet<number> }) {
  const rows = useMemo(() => sfrRows(file, changed), [file, changed]);
  return (
    <section className="dbg-card dbg-wide" aria-labelledby="dbg-sfr-title">
      <header className="dbg-card-head">
        <h3 id="dbg-sfr-title">Registres spéciaux (SFR)</h3>
        <span className="dbg-card-hint">survolez un bit pour son nom</span>
      </header>
      <table className="dbg-table">
        <thead>
          <tr><th scope="col">Nom</th><th scope="col">Adr.</th><th scope="col">Hex</th><th scope="col">Binaire <span className="dbg-bitnums">7 … 0</span></th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className={r.changed ? 'is-changed' : undefined}>
              <th scope="row" title={r.description}>{r.name}</th>
              <td className="pcx-mono dbg-muted">{r.addrText}</td>
              <td className="pcx-mono">{r.hexText}</td>
              <td><Bits cells={r.bits} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
});

const VariablesCard = memo(function VariablesCard({ symbols, file, changed }: {
  symbols: readonly SymbolInfo[];
  file: readonly number[];
  changed: ReadonlySet<number>;
}) {
  const rows = useMemo(() => variableRows(symbols, file, changed), [symbols, file, changed]);
  return (
    <section className="dbg-card dbg-wide" aria-labelledby="dbg-vars-title">
      <header className="dbg-card-head">
        <h3 id="dbg-vars-title" title="Variables du programme C placées en RAM (registres d'usage général, GPR 0x0C–0x4F).">Variables (RAM)</h3>
        <span className="dbg-card-hint">{rows.length === 0 ? 'aucune' : `${rows.length}`}</span>
      </header>
      {rows.length === 0 ? (
        <p className="dbg-card-empty">Ce programme ne déclare aucune variable en RAM.</p>
      ) : (
        <table className="dbg-table">
          <thead>
            <tr><th scope="col">Nom</th><th scope="col">Adr.</th><th scope="col">Hex</th><th scope="col">Déc.</th><th scope="col">Binaire</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={r.changed ? 'is-changed' : undefined}>
                <th scope="row" title={`${r.type}${r.scope === 'global' ? ' — globale' : ` — locale à ${r.scope}()`}`}>
                  {r.name}
                  {r.scope !== 'global' && <span className="dbg-scope">{r.scope}</span>}
                </th>
                <td className="pcx-mono dbg-muted">{r.addrText}</td>
                <td className="pcx-mono">{r.hexText}</td>
                <td className="pcx-mono">{r.decText}</td>
                <td className="pcx-mono dbg-muted">{r.binText}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
});

const EEPROM_COLS = 8;

const EepromCard = memo(function EepromCard({ eeprom, changed }: { eeprom: readonly number[]; changed: ReadonlySet<number> }) {
  const rows = useMemo(() => {
    const out: number[][] = [];
    for (let i = 0; i < 64; i += EEPROM_COLS) out.push(Array.from({ length: EEPROM_COLS }, (_, k) => i + k));
    return out;
  }, []);
  return (
    <section className="dbg-card dbg-wide" aria-labelledby="dbg-ee-title">
      <header className="dbg-card-head">
        <h3 id="dbg-ee-title" title="EEPROM de données : 64 octets conservés hors tension (EEPROM_Read / EEPROM_Write). 0xFF = case effacée.">EEPROM (64 octets)</h3>
        <span className="dbg-card-hint">0xFF = vide</span>
      </header>
      <table className="dbg-table dbg-ee">
        <thead>
          <tr>
            <th scope="col"><span className="pcx-visually-hidden">Adresse</span></th>
            {Array.from({ length: EEPROM_COLS }, (_, k) => <th key={k} scope="col" className="pcx-mono">+{k}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row[0]}>
              <th scope="row" className="pcx-mono dbg-muted">{hex(row[0], 2)}</th>
              {row.map((i) => {
                const v = eeprom[i] ?? 0xff;
                const cls = `pcx-mono${v === 0xff ? ' dbg-muted' : ''}${changed.has(i) ? ' is-changed' : ''}`;
                return <td key={i} className={cls} title={`EEPROM ${hex0x(i)} = ${hex0x(v)} (${v})`}>{hex(v, 2)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
});

