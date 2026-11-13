import { describe, expect, it } from 'vitest';
import { scrollTargetFor, visibleRange } from './virtual';

describe('visibleRange', () => {
  it('renders the visible rows plus overscan, clamped to the list', () => {
    expect(visibleRange(0, 220, 22, 1000, 5)).toEqual({ start: 0, end: 16 });
    expect(visibleRange(2200, 220, 22, 1000, 5)).toEqual({ start: 95, end: 116 });
    expect(visibleRange(21_900, 220, 22, 1000, 5)).toEqual({ start: 990, end: 1000 });
  });
  it('handles empty lists and odd inputs', () => {
    expect(visibleRange(0, 220, 22, 0)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(-50, 220, 22, 10, 0)).toEqual({ start: 0, end: 10 });
    expect(visibleRange(0, 0, 22, 10, 0)).toEqual({ start: 0, end: 1 });
  });
});

describe('scrollTargetFor', () => {
  it('leaves a comfortably visible row alone', () => {
    expect(scrollTargetFor(5, 22, 0, 440)).toBeNull();
  });
  it('centres a row that is off-screen or too close to an edge', () => {
    expect(scrollTargetFor(100, 22, 0, 440)).toBe(100 * 22 - (440 - 22) / 2);
    expect(scrollTargetFor(0, 22, 500, 440)).toBe(0);
    expect(scrollTargetFor(19, 22, 0, 440)).not.toBeNull(); // last visible row: within the 2-row margin
  });
  it('ignores invalid rows', () => {
    expect(scrollTargetFor(-1, 22, 0, 440)).toBeNull();
  });
});
