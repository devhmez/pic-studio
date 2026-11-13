// « Pourquoi ? » card for the part selected on the schematic: why this LED is lit / off, what the display shows,
// what an input reads — traced from the net to the C line that decided it.
import { useMemo, useState } from 'react';
import { execLineFor } from '../debug/listing';
import { Icon } from '../shell/icons';
import { useApp } from '../state/store';
import { explainWhy, liveEnv, staticEnv, type WhyAnswer } from './explain';
import { useStepHistory } from './history';
import type { LearnContext } from './context';
import { LineBadge } from './ui';

export function WhyCard({ ctx }: { ctx: LearnContext }) {
  const selected = useApp((s) => s.ui.selectedComponentId);
  const status = useApp((s) => s.sim.status);
  const debug = useApp((s) => s.sim.debug);
  const visuals = useApp((s) => s.sim.snapshot?.visuals);
  const lastWrites = useStepHistory((h) => h.lastWrites);
  const [hidden, setHidden] = useState<string | null>(null);

  // While running, the answer follows the last debug snapshot (about 10 per second).
  const answer = useMemo<WhyAnswer | null>(() => {
    if (!selected) return null;
    const build = ctx.build;
    const unit = build?.ast ?? null;
    const live = status !== 'stopped' && debug
      ? { cpu: debug, visuals, line: build?.ok ? execLineFor(debug.pc, debug.stack, build.addrToLine) : null }
      : null;
    try {
      return explainWhy({
        schematic: ctx.schematic, netlist: ctx.topo.netlist, componentId: selected, clockHz: ctx.clockHz,
        unit, source: build?.source, symbols: build?.symbols, program: ctx.program,
        live, liveEnv: live ? liveEnv(live.cpu, build?.symbols) : undefined,
        staticEnv: staticEnv(unit, ctx.topo), lastWrites: status === 'paused' ? lastWrites : undefined,
        pinInfo: ctx.pinInfo,
      });
    } catch {
      return null;
    }
  }, [selected, ctx, status, debug, visuals, lastWrites]);

  if (!selected || !answer || hidden === selected) return null;
  const stateClass = answer.state === 'on' ? 'is-on' : answer.state === 'off' ? 'is-off' : '';
  return (
    <section className="lp-card lp-why" aria-label="Pourquoi ?">
      <p className="lp-kicker">Pourquoi ? — {ctx.partName(selected)}</p>
      <h3 className="lp-card-title">
        {answer.state !== 'na' && <span className={`lp-why-state ${stateClass}`} aria-hidden="true" />}
        <span className="lp-grow">{answer.question}</span>
        <button type="button" className="lp-iconbtn" onClick={() => setHidden(selected)} aria-label="Masquer cette explication" title="Masquer">
          <Icon name="close" size={12} />
        </button>
      </h3>
      <p className="lp-why-summary">{answer.summary}</p>
      <ol className="lp-steps">
        {answer.steps.map((s, i) => (
          <li key={i} className={`lp-step${s.tone ? ` is-${s.tone}` : ''}`}>
            <div className="lp-step-title">
              <span>{s.title}</span>
              {s.line !== undefined && <LineBadge line={s.line} />}
            </div>
            <div>{s.text}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}
