// Shared state of the assistant drawer's editors.
import { createContext, useContext } from 'react';
import type { Issue, Program } from '@pic/program-model';
import type { Usage } from './model';

export interface AssistantContextValue {
  program: Program;
  /** Apply an edit to the latest stored program (never to a stale render copy). */
  edit(fn: (p: Program) => Program): void;
  issuesByStmt: ReadonlyMap<string, Issue[]>;
  issuesBySignal: ReadonlyMap<string, Issue[]>;
  usage: Usage;
  /** Statement or branch whose editor is open. */
  selectedId: string | null;
  select(id: string | null): void;
}

export const AssistantContext = createContext<AssistantContextValue | null>(null);

export function useAssistant(): AssistantContextValue {
  const v = useContext(AssistantContext);
  if (!v) throw new Error('AssistantContext manquant');
  return v;
}
