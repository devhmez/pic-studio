// Stroke icons (24-unit grid, currentColor) shared by the shell and the schematic editor.
import type { ReactElement, SVGProps } from 'react';

const PATHS = {
  play: <path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" />,
  pause: <><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />,
  stepLine: <><path d="M4 10a8 8 0 0 1 14-3" /><path d="M18 3v4h-4" /><circle cx="12" cy="17" r="2.2" fill="currentColor" stroke="none" /><path d="M4 21h16" /></>,
  stepInstr: <><path d="M12 3v11" /><path d="M8 10l4 4 4-4" /><path d="M5 19h14" /><path d="M5 22h9" /></>,
  reset: <><path d="M4 12a8 8 0 1 0 2.5-5.8" /><path d="M4 4v5h5" /></>,
  templates: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>,
  assistant: <><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" /><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" /></>,
  chat: <><path d="M4 5.5h16v10H9l-4 3.5v-3.5H4z" /><path d="M8 9.5h8M8 12.5h5" /></>,
  book: <><path d="M4 5c2.5-1 5.5-1 8 .8C14.5 4 17.5 4 20 5v13c-2.5-1-5.5-1-8 .8-2.5-1.8-5.5-1.8-8-.8z" /><path d="M12 5.8v13" /></>,
  export: <><path d="M12 15V3" /><path d="M7.5 7.5L12 3l4.5 4.5" /><path d="M5 12v7.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V12" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></>,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  system: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  maximize: <><path d="M14 4h6v6" /><path d="M10 20H4v-6" /><path d="M20 4l-6.5 6.5" /><path d="M4 20l6.5-6.5" /></>,
  minimize: <><path d="M4 14h6v6" /><path d="M20 10h-6V4" /><path d="M14 10l6.5-6.5" /><path d="M10 14l-6.5 6.5" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  error: <><circle cx="12" cy="12" r="8.5" /><path d="M9 9l6 6M15 9l-6 6" /></>,
  warning: <><path d="M12 4L2.8 19.5h18.4z" /><path d="M12 10v4.5" /><circle cx="12" cy="17" r=".6" fill="currentColor" /></>,
  dot: <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  select: <path d="M5 3.5l13 7-5.5 1.5 3.5 6.5-2.5 1.3-3.5-6.5L6 17z" />,
  wire: <><circle cx="5" cy="19" r="2" /><circle cx="19" cy="5" r="2" /><path d="M7 19h5V5h5" /></>,
  rotate: <><path d="M20 12a8 8 0 1 1-2.5-5.8" /><path d="M20 4v5h-5" /></>,
  mirror: <><path d="M12 3v18" strokeDasharray="2 2" /><path d="M9 7L4 17h5z" /><path d="M15 7l5 10h-5z" /></>,
  trash: <><path d="M4 7h16" /><path d="M9 7V4.5h6V7" /><path d="M6.5 7l1 13h9l1-13" /></>,
  undo: <><path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>,
  redo: <><path d="M15 14l5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></>,
  fit: <><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /><rect x="8.5" y="8.5" width="7" height="7" rx="1" /></>,
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  lock: <><rect x="5" y="11" width="14" height="9.5" rx="2" /><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3" /></>,
  fileNew: <><path d="M6.5 3.5h7l4.5 4.5v12a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-16a.5.5 0 0 1 .5-.5z" /><path d="M13.5 3.5V8H18" /><path d="M12 11.5v6M9 14.5h6" /></>,
  folder: <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.5l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z" />,
  save: <><path d="M5 4h11l3.5 3.5V19a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" /><path d="M8 4v5h7V4" /><path d="M8 20v-6h8v6" /></>,
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof PATHS;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 16, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
