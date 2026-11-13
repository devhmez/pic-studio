import { describe, expect, it } from 'vitest';
import type { ComponentInstance } from '../src/api';
import {
  componentAt, distanceToSegment, hitTestActuator, hitTestComponent, hitTestPin, hitTestWire, inverseTransformPoint,
  labelLayout, normalizeRotation, pinTip, pinTips, placeText, pointInsideSegment, pointOnSegment, rotateBy, snap,
  svgTransform, transformPoint, type Rotation,
} from '../src/geometry';
import { SYMBOLS } from '../src/symbols';

const part = (kind: ComponentInstance['kind'], at = { x: 0, y: 0 }, rotation: Rotation = 0, mirror = false, props = {}): ComponentInstance =>
  ({ id: 'X', kind, ref: 'X1', at, rotation, mirror, props });

describe('transforms', () => {
  it('rotates clockwise on screen (Y down), mirrors X first', () => {
    const p = { x: 2, y: 1 };
    const at = { x: 10, y: 20 };
    expect(transformPoint(p, { at, rotation: 0 })).toEqual({ x: 12, y: 21 });
    expect(transformPoint(p, { at, rotation: 90 })).toEqual({ x: 9, y: 22 });
    expect(transformPoint(p, { at, rotation: 180 })).toEqual({ x: 8, y: 19 });
    expect(transformPoint(p, { at, rotation: 270 })).toEqual({ x: 11, y: 18 });
    expect(transformPoint(p, { at, rotation: 0, mirror: true })).toEqual({ x: 8, y: 21 });
    expect(transformPoint(p, { at, rotation: 90, mirror: true })).toEqual({ x: 9, y: 18 });
  });

  it('inverts every placement', () => {
    for (const rotation of [0, 90, 180, 270] as const) {
      for (const mirror of [false, true]) {
        const pl = { at: { x: 3, y: -7 }, rotation, mirror };
        const p = { x: 1.5, y: -2 };
        expect(inverseTransformPoint(transformPoint(p, pl), pl)).toEqual(p);
      }
    }
  });

  it('matches the ISIS pin tips of a vertical resistor (demux R1, rotated)', () => {
    // DSN R1 at (-10,-1) Y-up, angle -90 → ours (-10,1), 90° clockwise; tips (-10,1)/(-10,-4) Y-up.
    const r1 = part('RES', { x: -10, y: 1 }, 90);
    expect(pinTip(r1, '1')).toEqual({ x: -10, y: -1 });
    expect(pinTip(r1, '2')).toEqual({ x: -10, y: 4 });
  });

  it('svgTransform reproduces transformPoint', () => {
    expect(svgTransform({ at: { x: 4, y: 5 }, rotation: 0 })).toBe('translate(4 5)');
    expect(svgTransform({ at: { x: 4, y: 5 }, rotation: 270, mirror: true })).toBe('translate(4 5) rotate(270) scale(-1 1)');
  });

  it('normalizes and steps rotations', () => {
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(-180)).toBe(180);
    expect(rotateBy(270, 90)).toBe(0);
  });
});

describe('grid and segments', () => {
  it('snaps to the 0.1 in grid (or a finer step)', () => {
    expect(snap({ x: 1.4, y: -2.6 })).toEqual({ x: 1, y: -3 });
    expect(snap({ x: 1.3, y: 14.6 }, 0.5)).toEqual({ x: 1.5, y: 14.5 });
  });

  it('tests points against segments', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    expect(pointOnSegment({ x: 4, y: 0 }, a, b)).toBe(true);
    expect(pointOnSegment({ x: 0, y: 0 }, a, b)).toBe(true);
    expect(pointInsideSegment({ x: 0, y: 0 }, a, b)).toBe(false);
    expect(pointOnSegment({ x: 11, y: 0 }, a, b)).toBe(false);
    expect(distanceToSegment({ x: 5, y: 3 }, a, b)).toBe(3);
    expect(distanceToSegment({ x: 13, y: 4 }, a, b)).toBe(5);
  });
});

describe('hit-testing', () => {
  const pic = part('PIC16F84A');
  it('finds pins, bodies, wires and actuators', () => {
    expect(hitTestPin({ x: 15.2, y: 6.1 }, pic)).toBe('RB0/INT');
    expect(hitTestPin({ x: 7, y: 7 }, pic)).toBeUndefined();
    expect(hitTestComponent({ x: 7, y: 7 }, pic)).toBe(true);
    expect(hitTestComponent({ x: 30, y: 7 }, pic)).toBe(false);
    expect(hitTestWire({ x: 5, y: 0.2 }, { id: 'W', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }] })).toBe(0);
    expect(hitTestWire({ x: 10.1, y: 3 }, { id: 'W', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }] })).toBe(1);
    expect(hitTestWire({ x: 5, y: 2 }, { id: 'W', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] })).toBe(-1);
    const ls = part('LOGICSTATE', { x: 20, y: 0 }, 0, true);
    expect(hitTestActuator({ x: 21.3, y: 0 }, ls)?.action).toBe('toggle');
    expect(hitTestActuator({ x: 30, y: 0 }, ls)).toBeUndefined();
    const ldr = part('TORCH_LDR');
    expect(hitTestActuator({ x: -9.6, y: -0.45 }, ldr)?.action).toBe('increment');
    expect(hitTestActuator({ x: -9.6, y: 0.45 }, ldr)?.action).toBe('decrement');
    expect(componentAt({ x: 7, y: 7 }, [pic, ls])?.kind).toBe('PIC16F84A');
  });

  it('lists the visible pin tips only', () => {
    expect(pinTips(pic).map((p) => p.name)).not.toContain('VDD');
    expect(pinTips(pic)).toHaveLength(16);
  });
});

describe('text placement', () => {
  it('keeps text upright and flips its justification when mirrored', () => {
    const t = { at: { x: 1, y: -1 }, anchor: 'start' as const, baseline: 'bottom' as const, size: 1 };
    expect(placeText(t, { at: { x: 0, y: 0 }, rotation: 0, mirror: true })).toEqual({ at: { x: -1, y: -1 }, anchor: 'end', baseline: 'bottom', size: 1 });
    expect(placeText(t, { at: { x: 0, y: 0 }, rotation: 180 })).toEqual({ at: { x: -1, y: 1 }, anchor: 'end', baseline: 'top', size: 1 });
    expect(placeText(t, { at: { x: 0, y: 0 }, rotation: 90 })).toMatchObject({ anchor: 'start', baseline: 'bottom' });
  });

  it('uses the ISIS label offsets for unrotated parts and stacks labels right of rotated vertical parts', () => {
    const u1 = labelLayout(part('PIC16F84A', { x: -13, y: -14 }));
    expect(u1.ref.at).toEqual({ x: -11.08, y: -15.25 });
    expect(u1.value).toMatchObject({ at: { x: -11.08, y: 0.08 }, baseline: 'top' });
    const r = labelLayout(part('RES', { x: 0, y: 0 }, 90));
    expect(r.ref.anchor).toBe('start');
    expect(r.ref.at.x).toBeGreaterThan(0.4);
    expect(r.value.at.y).toBeGreaterThan(r.ref.at.y);
    expect(SYMBOLS.RES.labels.ref.baseline).toBe('bottom');
  });
});
