// Fixed-row-height virtualization helpers (pure) and the hook that wires them to a scroll container.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface VisibleRange {
  /** First rendered row (inclusive). */
  start: number;
  /** Last rendered row (exclusive). */
  end: number;
}

/** Rows to render for a scroll position, with `overscan` extra rows above and below. */
export function visibleRange(scrollTop: number, viewport: number, rowHeight: number, count: number, overscan = 6): VisibleRange {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visible = Math.ceil(Math.max(0, viewport) / rowHeight) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visible + overscan);
  return { start, end: Math.max(start, end) };
}

/**
 * scrollTop that brings row `index` into view (centred), or null when it is already comfortably visible
 * (at least `margin` rows from either edge).
 */
export function scrollTargetFor(index: number, rowHeight: number, scrollTop: number, viewport: number, margin = 2): number | null {
  if (index < 0 || viewport <= 0) return null;
  const top = index * rowHeight;
  const bottom = top + rowHeight;
  const m = Math.min(margin * rowHeight, Math.max(0, (viewport - rowHeight) / 2));
  if (top >= scrollTop + m && bottom <= scrollTop + viewport - m) return null;
  return Math.max(0, Math.round(top - (viewport - rowHeight) / 2));
}

export interface VirtualRows {
  range: VisibleRange;
  onScroll: () => void;
  /** Scroll so that `index` is visible (no-op if it already is). */
  reveal: (index: number) => void;
}

/** Virtualize `count` rows of `rowHeight` px inside the scroll container `ref`. */
export function useVirtualRows(ref: RefObject<HTMLElement | null>, count: number, rowHeight: number): VirtualRows {
  const [metrics, setMetrics] = useState({ scrollTop: 0, viewport: 600 });
  const frame = useRef(0);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setMetrics((m) => (m.scrollTop === el.scrollTop && m.viewport === el.clientHeight ? m : { scrollTop: el.scrollTop, viewport: el.clientHeight }));
  }, [ref]);

  const onScroll = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(measure);
  }, [measure]);

  useLayoutEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, measure]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const reveal = useCallback((index: number) => {
    const el = ref.current;
    if (!el) return;
    const target = scrollTargetFor(index, rowHeight, el.scrollTop, el.clientHeight);
    if (target !== null) {
      el.scrollTop = target;
      measure();
    }
  }, [ref, rowHeight, measure]);

  return { range: visibleRange(metrics.scrollTop, metrics.viewport, rowHeight, count), onScroll, reveal };
}
