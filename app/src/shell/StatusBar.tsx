// Bottom bar: simulation state, simulated time, cycles, real-time ratio, PC; errors and the clock on the right.
import { memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { appStore, getApp, useApp } from '../state/store';
import type { AppState, SimStatus } from '../state/types';
import { formatAddr, formatClock, formatCount, formatRatio, formatSimTime } from './format';
import { Icon } from './icons';

const STATUS_TEXT: Record<SimStatus, string> = { stopped: 'Arrêté', running: 'En cours', paused: 'Pause' };

const selectLive = (s: AppState) => {
  const snap = s.sim.snapshot;
  const debug = s.sim.debug;
  return {
    time: snap?.time ?? debug?.time ?? 0,
    cycles: snap?.cycles ?? debug?.cycles ?? 0,
    pc: debug?.pc ?? snap?.cpu.pc ?? null,
    ratio: s.sim.realtimeRatio,
    sleeping: snap?.cpu.sleeping ?? false,
    halted: snap?.cpu.halted ?? false,
  };
};

const LiveFigures = memo(function LiveFigures({ status }: { status: SimStatus }) {
  const live = useApp(useShallow(selectLive));
  if (status === 'stopped') return <span className="status-item muted">Appuyez sur ▶ (F5) pour lancer la simulation</span>;
  return (
    <>
      <span className="status-item" title="Temps simulé depuis le démarrage (ou le dernier reset)">
        <span className="status-label">Temps</span> {formatSimTime(live.time)}
      </span>
      <span className="status-item" title="Cycles d’instruction exécutés (1 cycle = 4 périodes d’horloge)">
        <span className="status-label">Cycles</span> {formatCount(live.cycles)}
      </span>
      <span className="status-item" title="Vitesse mesurée par rapport au temps réel">
        {status === 'running' ? formatRatio(live.ratio) : '—'} <span className="status-label">temps réel</span>
      </span>
      {live.pc !== null && (
        <span className="status-item mono" title="Compteur ordinal (adresse de la prochaine instruction)">
          <span className="status-label">PC</span> {formatAddr(live.pc)}
        </span>
      )}
      {live.sleeping && <span className="status-item muted">SLEEP</span>}
    </>
  );
});

const SimError = memo(function SimError() {
  const error = useApp((s) => s.sim.error);
  if (!error) return null;
  return (
    <span className="status-item status-error" role="alert" title={error}>
      <Icon name="warning" size={13} /> {error}
    </span>
  );
});

const StaleHint = memo(function StaleHint({ status }: { status: SimStatus }) {
  const outdated = useApp((s) => appStore.isProgramOutdated(s));
  const failed = useApp((s) => s.compile.result !== null && !s.compile.result.ok && !s.compile.stale);
  if (status === 'stopped' || !outdated) return null;
  if (failed) {
    return (
      <span className="status-item muted" title="Le simulateur garde le programme d’avant la modification ; il faut que le code compile pour faire un pas ou continuer.">
        Code modifié avec des erreurs : corrigez-les pour continuer
      </span>
    );
  }
  return (
    <span className="status-item muted" title="Le simulateur exécute encore le programme d’avant la modification. Au prochain pas ou ▶, PIC Studio propose de charger le nouveau programme ; la simulation repart alors du début.">
      Code modifié : le prochain pas ou ▶ proposera de recharger le programme
    </span>
  );
});

export function StatusBar() {
  const status = useApp((s) => s.sim.status);
  const clockHz = useApp((s) => s.project.clockHz);
  return (
    <footer className="statusbar" aria-label="Barre d’état">
      <span className={`status-pill is-${status}`} aria-live="polite">
        <span className="status-dot" aria-hidden="true" />
        {STATUS_TEXT[status]}
      </span>
      <LiveFigures status={status} />
      <span className="status-spacer" />
      <StaleHint status={status} />
      <SimError />
      <button type="button" className="status-item status-button" onClick={() => getApp().focusPanel('schema')}
        title="Horloge du PIC (modifiable dans la barre d’outils)">
        {formatClock(clockHz)}
      </button>
    </footer>
  );
}
