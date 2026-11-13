// Debugger step controls: pas instruction / pas ligne / continuer (pause while running). Reusable in any header.
import { memo } from 'react';
import { useApp } from '../state/store';
import { continueOrPause, SHORTCUTS, stepInstruction, stepLine } from './commands';
import { PauseIcon, PlayIcon, StepInstructionIcon, StepLineIcon } from './icons';

export interface StepControlsProps {
  /** Show text labels next to the icons (wide headers). */
  labels?: boolean;
}

export const StepControls = memo(function StepControls({ labels = false }: StepControlsProps) {
  const status = useApp((s) => s.sim.status);
  // Stepping is impossible only when the last build failed and no rebuild is pending.
  const blocked = useApp((s) => !!s.compile.result && !s.compile.result.ok && !s.compile.stale);
  const running = status === 'running';
  const why = blocked ? ' — corrigez d’abord les erreurs de compilation' : '';

  return (
    <div className="pcx-group" role="group" aria-label="Contrôles du débogueur">
      <button
        type="button"
        className="pcx-iconbtn"
        onClick={stepInstruction}
        disabled={blocked || running}
        aria-label="Pas à pas : une instruction"
        title={`Pas instruction (${SHORTCUTS.stepInstruction.label}) : exécute une seule instruction assembleur${why}`}
      >
        <StepInstructionIcon />
        {labels && <span>Instruction</span>}
      </button>
      <button
        type="button"
        className="pcx-iconbtn"
        onClick={stepLine}
        disabled={blocked || running}
        aria-label="Pas à pas : une ligne C"
        title={`Pas ligne (${SHORTCUTS.stepLine.label}) : exécute jusqu’à la ligne C suivante${why}`}
      >
        <StepLineIcon />
        {labels && <span>Ligne</span>}
      </button>
      <button
        type="button"
        className="pcx-iconbtn is-primary"
        onClick={continueOrPause}
        disabled={blocked && !running}
        aria-label={running ? 'Pause' : 'Continuer'}
        title={running
          ? `Pause (${SHORTCUTS.pause.label})`
          : `Continuer (${SHORTCUTS.run.label}) : lance la simulation jusqu’au prochain point d’arrêt${why}`}
      >
        {running ? <PauseIcon /> : <PlayIcon />}
        {labels && <span>{running ? 'Pause' : 'Continuer'}</span>}
      </button>
    </div>
  );
});
