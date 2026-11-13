// The four panels, in ⌘1–⌘4 order.
import type { PanelId } from '../state/types';

export interface PanelInfo {
  id: PanelId;
  title: string;
  /** ⌘ + digit. */
  shortcut: number;
}

/** Panels in ⌘1–⌘4 order. */
export const PANELS: readonly PanelInfo[] = [
  { id: 'schema', title: 'Schéma', shortcut: 1 },
  { id: 'code', title: 'Code C', shortcut: 2 },
  { id: 'asm', title: 'Assembleur / registres', shortcut: 3 },
  { id: 'organigramme', title: 'Organigramme', shortcut: 4 },
];
