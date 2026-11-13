// Header actions for the Code and Assembleur panels: rendered into the shell's panel header (PanelHeaderActions
// portal) when the panel sits inside the shell, or into a standalone header bar otherwise (tests, other hosts).
import type { ReactNode } from 'react';
import { PanelHeaderActions, usePanelId } from '../shell/Panel';

export interface HeaderActionsProps {
  /** Title of the standalone header (the shell shows its own title). */
  title: string;
  children: ReactNode;
}

export function HeaderActions({ title, children }: HeaderActionsProps) {
  const inShell = usePanelId() !== null;
  if (inShell) return <PanelHeaderActions>{children}</PanelHeaderActions>;
  return (
    <div className="pcx-header">
      <span className="pcx-title">{title}</span>
      <span className="pcx-spacer" />
      {children}
    </div>
  );
}
