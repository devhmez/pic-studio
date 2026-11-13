// Draggable divider between two panels (pointer drag, arrow keys, double-click to reset).
import { useCallback, useRef, type KeyboardEvent, type PointerEvent } from 'react';

export interface SplitterProps {
  orientation: 'vertical' | 'horizontal';
  /** Current fraction (0..1) of the first pane. */
  value: number;
  onChange(value: number): void;
  onReset(): void;
  label: string;
}

/** `vertical` splits left|right (drag along X); `horizontal` splits top/bottom (drag along Y). */
export function Splitter({ orientation, value, onChange, onReset, label }: SplitterProps) {
  const ref = useRef<HTMLDivElement>(null);

  const fractionAt = useCallback((e: PointerEvent<HTMLDivElement>): number | null => {
    const container = ref.current?.parentElement;
    if (!container) return null;
    const r = container.getBoundingClientRect();
    return orientation === 'vertical' ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
  }, [orientation]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add(orientation === 'vertical' ? 'is-resizing-x' : 'is-resizing-y');
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const f = fractionAt(e);
    if (f !== null) onChange(f);
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.classList.remove('is-resizing-x', 'is-resizing-y');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const back = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    const fwd = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    if (e.key === back) onChange(value - step);
    else if (e.key === fwd) onChange(value + step);
    else if (e.key === 'Home' || e.key === 'Enter') onReset();
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={ref}
      className={`splitter splitter-${orientation}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={15}
      aria-valuemax={85}
      aria-valuenow={Math.round(value * 100)}
      title={`${label} — glisser pour redimensionner, double-clic pour rétablir`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
