import { describe, expect, it } from 'vitest';
import type { Schematic } from '@pic/circuit';
import { hitActuator, hitComponent, hitPin, hitWire } from './hit';
import { clampZoom, fitRect, gridStep, MAX_ZOOM, MIN_ZOOM, toScreen, toWorld, visibleWorld, zoomAt } from './viewport';

describe('viewport', () => {
  it('maps screen and world both ways', () => {
    const v = { x: 100, y: 50, k: 10 };
    expect(toWorld(v, 150, 70)).toEqual({ x: 5, y: 2 });
    expect(toScreen(v, { x: 5, y: 2 })).toEqual({ x: 150, y: 70 });
  });

  it('zooms around the cursor and clamps', () => {
    const v = { x: 0, y: 0, k: 10 };
    const z = zoomAt(v, 200, 100, 2);
    expect(z.k).toBe(20);
    expect(toWorld(z, 200, 100)).toEqual(toWorld(v, 200, 100));
    expect(clampZoom(1000)).toBe(MAX_ZOOM);
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
  });

  it('fits a rectangle in the middle of the canvas', () => {
    const v = fitRect({ x: 0, y: 0, w: 40, h: 20 }, 464, 264, 32);
    expect(v.k).toBe(10);
    expect(toScreen(v, { x: 20, y: 10 })).toEqual({ x: 232, y: 132 });
    expect(visibleWorld(v, 464, 264).w).toBeCloseTo(46.4);
  });

  it('thins the grid dots out when zoomed out', () => {
    expect(gridStep(10)).toBe(1);
    expect(gridStep(3)).toBe(5);
    expect(gridStep(2)).toBe(10);
  });
});

describe('hit testing', () => {
  const s: Schematic = {
    clockHz: 1e6,
    components: [
      { id: 'U1', kind: 'PIC16F84A', ref: 'U1', at: { x: 0, y: 0 }, rotation: 0, props: {} },
      { id: 'LS1', kind: 'LOGICSTATE', ref: '', at: { x: 30, y: 0 }, rotation: 0, props: { state: 0 } },
    ],
    wires: [{ id: 'W1', points: [{ x: 15, y: 0 }, { x: 25, y: 0 }] }],
  };

  it('finds pins with their direction', () => {
    expect(hitPin(s, { x: 15.2, y: 0.1 }, 0.5)).toMatchObject({ componentId: 'U1', pin: 'RA0', at: { x: 15, y: 0 }, dir: 'h' });
    expect(hitPin(s, { x: 20, y: 5 }, 0.5)).toBeNull();
  });

  it('finds the LOGICSTATE click target, parts and wires', () => {
    expect(hitActuator(s, { x: 28.8, y: 0.2 })?.component.id).toBe('LS1');
    expect(hitComponent(s, { x: 7, y: 7 })?.id).toBe('U1');
    expect(hitWire(s, { x: 20.4, y: 0.1 }, 0.3)).toEqual({ id: 'W1', at: { x: 20, y: 0 } });
  });
});
