// Mémoire programme: a 32 × 32 map of the 1024 program words (0000h reset vector, 0004h interrupt vector,
// routines, free space up to 03FFh), the usage bar and the RAM / stack budget.
import { memo, useMemo } from 'react';
import type { ListingLine } from '@pic/compiler';
import { frenchDecimal, hex, hexH } from './format';
import { INTERRUPT_VECTOR, LAST_ADDRESS, PROGRAM_WORDS, programRegions, RESET_VECTOR, usedWords, type ProgramRegion } from './listing';

const COLS = 32;
const ROWS = PROGRAM_WORDS / COLS;
/** Left margin of the SVG (address labels), in cell units. */
const MARGIN = 4.2;
const GPR_BYTES = 68;

export interface MemoryMapViewProps {
  listing: readonly ListingLine[];
  pc: number | null;
  breakpoints: readonly number[];
  ramBytes: number | null;
  stackDepth: number | undefined;
}

interface Rect { x: number; y: number; w: number; region: ProgramRegion }

/** Split a region into one rectangle per map row it spans. */
function regionRects(r: ProgramRegion): Rect[] {
  const out: Rect[] = [];
  let a = r.from;
  while (a <= r.to) {
    const row = Math.floor(a / COLS);
    const rowEnd = Math.min(r.to, row * COLS + COLS - 1);
    out.push({ x: a % COLS, y: row, w: rowEnd - a + 1, region: r });
    a = rowEnd + 1;
  }
  return out;
}

function rangeText(r: ProgramRegion): string {
  return r.from === r.to ? hexH(r.from) : `${hexH(r.from)}–${hexH(r.to)}`;
}

export const MemoryMapView = memo(function MemoryMapView({ listing, pc, breakpoints, ramBytes, stackDepth }: MemoryMapViewProps) {
  const regions = useMemo(() => programRegions(listing), [listing]);
  const used = useMemo(() => usedWords(listing), [listing]);
  const rects = useMemo(() => regions.filter((r) => r.kind !== 'free').flatMap(regionRects), [regions]);
  const pct = (used / PROGRAM_WORDS) * 100;
  const hasInterrupt = regions.some((r) => r.kind === 'interrupt');

  return (
    <div className="dbg-mem">
      <section className="dbg-card dbg-wide" aria-labelledby="dbg-mem-title">
        <header className="dbg-card-head">
          <h3 id="dbg-mem-title">Mémoire programme</h3>
          <span className="dbg-card-hint pcx-mono">{used} / {PROGRAM_WORDS} mots · {frenchDecimal(pct, 1)} %</span>
        </header>
        <div className="dbg-meter" role="meter" aria-valuemin={0} aria-valuemax={PROGRAM_WORDS} aria-valuenow={used}
          aria-label="Mots de mémoire programme utilisés">
          <span style={{ width: `${Math.min(100, Math.max(used > 0 ? 0.6 : 0, pct))}%` }} />
        </div>

        <svg className="dbg-map" viewBox={`0 0 ${MARGIN + COLS} ${ROWS}`} role="img"
          aria-label={`Carte des ${PROGRAM_WORDS} mots de la mémoire programme : ${used} utilisés`}>
          <rect className="dbg-map-bg" x={MARGIN} y={0} width={COLS} height={ROWS} />
          {Array.from({ length: ROWS / 4 }, (_, k) => (
            <text key={k} className="dbg-map-axis" x={MARGIN - 0.6} y={k * 4 + 0.82} textAnchor="end">{hex(k * 4 * COLS, 3)}</text>
          ))}
          {rects.map((r, i) => (
            <rect key={i} className={`dbg-map-cell is-${r.region.kind}`} x={MARGIN + r.x + 0.06} y={r.y + 0.06} width={r.w - 0.12} height={0.88} rx={0.15}>
              <title>{`${rangeText(r.region)} · ${r.region.name}`}</title>
            </rect>
          ))}
          <rect className="dbg-map-vector" x={MARGIN + (INTERRUPT_VECTOR % COLS)} y={0} width={1} height={1}>
            <title>{`${hexH(INTERRUPT_VECTOR)} · vecteur d'interruption`}</title>
          </rect>
          <rect className="dbg-map-end" x={MARGIN + (LAST_ADDRESS % COLS)} y={ROWS - 1} width={1} height={1}>
            <title>{`${hexH(LAST_ADDRESS)} · fin de la mémoire programme`}</title>
          </rect>
          {breakpoints.map((a) => (
            <circle key={a} className="dbg-map-bp" cx={MARGIN + (a % COLS) + 0.5} cy={Math.floor(a / COLS) + 0.5} r={0.3}>
              <title>{`Point d'arrêt à ${hexH(a)}`}</title>
            </circle>
          ))}
          {pc !== null && (
            <rect className="dbg-map-pc" x={MARGIN + (pc % COLS) - 0.08} y={Math.floor(pc / COLS) - 0.08} width={1.16} height={1.16} rx={0.2}>
              <title>{`PC = ${hexH(pc)}`}</title>
            </rect>
          )}
        </svg>

        <ul className="dbg-legend" aria-label="Contenu de la mémoire programme">
          <li><span className="dbg-swatch is-reset" /> <span className="pcx-mono">{hexH(RESET_VECTOR)}</span> Vecteur de reset — le PIC démarre ici</li>
          <li>
            <span className="dbg-swatch is-vector" /> <span className="pcx-mono">{hexH(INTERRUPT_VECTOR)}</span>
            {hasInterrupt ? " Vecteur d'interruption — début de interrupt()" : " Vecteur d'interruption (inutilisé ici : main() y commence)"}
          </li>
          {regions.filter((r) => r.kind !== 'reset').map((r) => (
            <li key={r.from} className={r.kind === 'free' ? 'is-free' : undefined}>
              <span className={`dbg-swatch is-${r.kind}`} /> <span className="pcx-mono">{rangeText(r)}</span> {r.name}
              <span className="dbg-muted"> · {r.to - r.from + 1} mot{r.to > r.from ? 's' : ''}</span>
            </li>
          ))}
          <li><span className="dbg-swatch is-end" /> <span className="pcx-mono">{hexH(LAST_ADDRESS)}</span> Fin de la mémoire programme (1 K mots)</li>
        </ul>
      </section>

      <section className="dbg-card" aria-labelledby="dbg-budget-title">
        <header className="dbg-card-head"><h3 id="dbg-budget-title">Ressources</h3></header>
        <dl className="dbg-budget">
          <div>
            <dt title="Registres d'usage général 0x0C–0x4F">RAM (GPR)</dt>
            <dd className="pcx-mono">{ramBytes === null ? '—' : `${ramBytes} / ${GPR_BYTES} octets`}</dd>
          </div>
          <div>
            <dt title="Profondeur maximale de la pile matérielle prévue par le compilateur (appels + interruption)">Pile</dt>
            <dd className="pcx-mono">{stackDepth === undefined ? '—' : `${stackDepth} / 8 niveaux`}</dd>
          </div>
          <div>
            <dt title="Instructions de 14 bits">Programme</dt>
            <dd className="pcx-mono">{used} / {PROGRAM_WORDS} mots</dd>
          </div>
        </dl>
      </section>
    </div>
  );
});
