// Small stroke icons for the debugger controls (16 px, currentColor). Decorative: buttons carry aria-labels.
import type { ReactNode, SVGProps } from 'react';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'>;

function Icon({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
      {children}
    </svg>
  );
}

/** One machine instruction: a short arrow into a single row. */
export function StepInstructionIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 3.5h6.5a3 3 0 0 1 0 6H6" />
      <path d="M8 7.5 6 9.5l2 2" />
      <rect x="2.5" y="12.5" width="11" height="1.5" rx=".5" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** One C line: arrow down over source lines. */
export function StepLineIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 3h7M2.5 6h5" />
      <path d="M12 2.5v8" />
      <path d="m9.5 8.5 2.5 2.5 2.5-2.5" />
      <path d="M2.5 13.5h11" />
    </Icon>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 3v10l8.5-5z" fill="currentColor" />
    </Icon>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 3.5v9M11 3.5v9" strokeWidth="2.2" />
    </Icon>
  );
}

export function MinusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 8h8" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 8h8M8 4v8" />
    </Icon>
  );
}

export function ErrorIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8v3.7M8 11v.2" />
    </Icon>
  );
}

export function WarningIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.2 14.2 13H1.8z" />
      <path d="M8 6.5v3M8 11.2v.2" />
    </Icon>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.3V11M8 5v.2" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m3.5 8.5 3 3 6-7" />
    </Icon>
  );
}

export function InterruptIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 1.8 3.8 9h4l-1 5.2L12.2 7h-4z" />
    </Icon>
  );
}
