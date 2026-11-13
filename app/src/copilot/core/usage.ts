// Per-request usage line: tokens of every CLI call of the request (the correction turns included) and the API-
// equivalent cost, computed as the difference between consecutive cumulative session totals (the CLI reports
// total_cost_usd for the whole session on resumed calls).
import type { CopilotUsage } from '../../host/bridge';

export interface TurnUsage {
  tokens: number;
  costUsd: number;
  /** Model id the CLI reported (e.g. claude-haiku-4-5-20251001). */
  model?: string;
  durationMs: number;
  /** CLI calls (1 + automatic corrections). */
  calls: number;
}

export const emptyUsage = (): TurnUsage => ({ tokens: 0, costUsd: 0, durationMs: 0, calls: 0 });

/** Tokens processed by one call (input, output and prompt cache). */
export function callTokens(u: CopilotUsage): number {
  const n = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  return n(u.inputTokens) + n(u.outputTokens) + n(u.cacheReadTokens) + n(u.cacheCreationTokens);
}

/**
 * Cost of one call from the session's cumulative total. `baseline` is the total after the previous call of the same
 * session (0 for a new session); a total below it means a new session started.
 */
export function callCost(sessionCostUsd: number, baseline: number): number {
  if (!Number.isFinite(sessionCostUsd) || sessionCostUsd < 0) return 0;
  return sessionCostUsd >= baseline ? sessionCostUsd - baseline : sessionCostUsd;
}

export function addCall(total: TurnUsage, u: CopilotUsage, baseline: number): { total: TurnUsage; baseline: number } {
  const next: TurnUsage = {
    tokens: total.tokens + callTokens(u),
    costUsd: total.costUsd + callCost(u.sessionCostUsd, baseline),
    durationMs: total.durationMs + (Number.isFinite(u.durationMs) ? u.durationMs : 0),
    calls: total.calls + 1,
    ...(u.model ? { model: u.model } : total.model ? { model: total.model } : {}),
  };
  return { total: next, baseline: Number.isFinite(u.sessionCostUsd) ? u.sessionCostUsd : baseline };
}

const TOKENS = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const USD = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** « 12 400 jetons · ≈ 0,02 $ en équivalent API (inclus dans votre abonnement Claude) » */
export function formatUsage(u: TurnUsage): string {
  const tokens = Math.round(u.tokens / 100) * 100;
  const cost = u.costUsd > 0 && u.costUsd < 0.005 ? '< 0,01 $' : `≈ ${USD.format(u.costUsd)} $`;
  return `${TOKENS.format(tokens)} jetons · ${cost} en équivalent API (inclus dans votre abonnement Claude)`;
}

/** « Haiku », « Sonnet » from a model id. */
export function modelLabel(id: string | undefined): string | null {
  if (!id) return null;
  if (/haiku/i.test(id)) return 'Haiku';
  if (/sonnet/i.test(id)) return 'Sonnet';
  if (/opus/i.test(id)) return 'Opus';
  return id;
}
