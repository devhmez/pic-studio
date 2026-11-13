import { describe, expect, it } from 'vitest';
import { ChunkSizer, Pacer, RatioMeter, Throttle, lineStops } from './pacing';

describe('Pacer', () => {
  it('owes wall time × speed since the start', () => {
    const p = new Pacer();
    p.start(1000, 0, 1);
    expect(p.owed(1050, 0)).toBeCloseTo(0.05);
    expect(p.owed(1050, 0.03)).toBeCloseTo(0.02);
    p.start(0, 2, 0.25);
    expect(p.peek(200, 2)).toBeCloseTo(0.05);
  });

  it('never owes negative time when the simulation is ahead', () => {
    const p = new Pacer();
    p.start(0, 0, 1);
    expect(p.owed(10, 0.5)).toBe(0);
  });

  it('caps the backlog instead of spiralling when the simulator cannot keep up', () => {
    const p = new Pacer(0.1);
    p.start(0, 0, 10);
    // 5 s of wall time at ×10 would be 50 s owed: capped at 0.1 s wall × 10.
    expect(p.owed(5000, 0)).toBeCloseTo(1);
    // The anchor slid: after running that second, the next 10 ms owe only 0.1 s more.
    expect(p.owed(5010, 1)).toBeCloseTo(0.1);
  });

  it('changes speed without a jump', () => {
    const p = new Pacer();
    p.start(0, 0, 1);
    p.setSpeed(100, 0.1, 0.1);
    expect(p.owed(100, 0.1)).toBe(0);
    expect(p.peek(1100, 0.1)).toBeCloseTo(0.1);
  });

  it('owes everything at maximum speed', () => {
    const p = new Pacer();
    p.start(0, 0, Number.POSITIVE_INFINITY);
    expect(p.owed(1, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('RatioMeter', () => {
  it('measures simulated / wall time over its window', () => {
    const m = new RatioMeter(1000, 50);
    m.sample(0, 0);
    expect(m.sample(100, 0.1)).toBeCloseTo(1);
    expect(m.sample(200, 0.15)).toBeCloseTo(0.75);
  });

  it('keeps the previous ratio while the span is too short and restarts after a reset', () => {
    const m = new RatioMeter(1000, 50);
    m.sample(0, 0);
    expect(m.sample(100, 0.2)).toBeCloseTo(2);
    expect(m.sample(110, 0)).toBeCloseTo(2); // reset: new window, too short yet
    expect(m.sample(210, 0.1)).toBeCloseTo(1);
  });

  it('forgets samples older than the window', () => {
    const m = new RatioMeter(500, 50);
    m.sample(0, 0);
    m.sample(100, 1); // ×10 burst
    for (let t = 200; t <= 1200; t += 100) m.sample(t, 1 + (t - 100) / 1000);
    expect(m.sample(1300, 2.2)).toBeCloseTo(1, 1);
  });
});

describe('ChunkSizer', () => {
  it('converges to about 2 ms of wall time per call and respects its bounds', () => {
    const c = new ChunkSizer(2, 1e-5, 0.02, 1e-3);
    for (let i = 0; i < 20; i++) c.record(c.current, c.current * 1000); // 1 s simulated per wall second
    expect(c.current).toBeCloseTo(0.002, 4);
    for (let i = 0; i < 40; i++) c.record(c.current, 0.001); // extremely fast
    expect(c.current).toBe(0.02);
    expect(c.next(0.005)).toBe(0.005);
  });
});

describe('Throttle', () => {
  it('fires at most once per interval', () => {
    const t = new Throttle(100);
    expect(t.due(0)).toBe(true);
    t.mark(0);
    expect(t.due(50)).toBe(false);
    expect(t.due(100)).toBe(true);
  });
});

describe('lineStops', () => {
  const map: [number, number][] = [[0x05, 10], [0x06, 10], [0x07, 11], [0x08, 12], [0x09, 10]];

  it('stops on every address of another line', () => {
    expect(lineStops(map, 0x06)).toEqual({ line: 10, stops: [0x07, 0x08] });
  });

  it('stops on the first C line from unmapped startup code', () => {
    expect(lineStops(map, 0x00)).toEqual({ line: undefined, stops: [0x05, 0x06, 0x07, 0x08, 0x09] });
  });
});
