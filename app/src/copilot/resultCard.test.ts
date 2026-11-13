// The result card renders (server-side, no DOM library needed): « Non testée en simulation » instead of a green
// « Vérifiée » for untested code, the half that « Appliquer » replaces, and the guarded « Annuler l'application ».
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { blankProject } from '../state/store';
import type { ChatMessage, ProposalSummary } from './core/messages';
import { ResultCard } from './ResultCard';

const summary = (over: Partial<ProposalSummary> = {}): ProposalSummary => ({
  parts: ['D1 · LED rouge'], pins: ['RB0'], clockMhz: 1, circuitChanged: true, codeChanged: true, codeLines: 12, changedLines: 12,
  style: 'prof', tests: [], issues: [], warnings: [], ...over,
});

function message(s: ProposalSummary, payloadOver: Record<string, unknown> = {}): ChatMessage {
  const p = blankProject();
  return {
    id: 'm1', role: 'copilot', text: 'Voici', at: 0,
    proposal: { summary: s, status: 'pending', payload: { schematic: p.schematic, source: p.source, program: null, clockHz: p.clockHz, fingerprint: 'x', latest: true, ...payloadOver } },
  };
}

const render = (m: ChatMessage) => renderToStaticMarkup(createElement(ResultCard, { message: m }));

describe('ResultCard', () => {
  it('untested code is « Non testée en simulation », not « Vérifiée »', () => {
    const html = render(message(summary()));
    expect(html).toContain('Non testée en simulation');
    expect(html).not.toContain('Vérifiée');
  });

  it('tested code that passes is « Vérifiée »', () => {
    const html = render(message(summary({ tests: [{ description: 'LED', passed: true, details: [] }] })));
    expect(html).toContain('Vérifiée');
  });

  it('a circuit-only proposal says the code is kept', () => {
    const html = render(message(summary({ codeChanged: false }), { code: false }));
    expect(html).toContain('Remplace seulement le schéma');
  });
});
