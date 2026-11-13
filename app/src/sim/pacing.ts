// Real-time pacing of the simulation worker, kept free of timers and globals so it can be unit-tested.
//
// The worker loop runs "ticks": each tick asks the Pacer how much simulated time is owed (wall time elapsed since
// the run started × speed), runs it in chunks sized by the ChunkSizer (about 2 ms of wall time each, so a pause or a
// LOGICSTATE click is never stuck behind a long call), stops after SLICE_BUDGET_MS of wall time, then yields.

/** Wall time spent simulating per tick before yielding to messages (the spec allows at most 20 ms). */
export const SLICE_BUDGET_MS = 12;
/** Visual snapshots while running: ~30 per second. */
export const SNAPSHOT_INTERVAL_MS = 1000 / 30;
/** Register snapshots while running: ~10 per second. */
export const DEBUG_INTERVAL_MS = 100;
/** Sleep between ticks when the simulation is ahead of real time. */
export const IDLE_TICK_MS = 4;
/** Backlog (in wall seconds) the pacer accepts before it drops time instead of trying to catch up. */
export const MAX_LAG_WALL_S = 0.1;
/** Wall-time cap of a "pas (ligne)" that never reaches another line (waiting on an input). */
export const STEP_LINE_BUDGET_MS = 250;

/** Maps wall time to the simulated time the run should have reached. */
export class Pacer {
  private anchorWallMs = 0;
  private anchorSim = 0;
  private speedValue = 1;

  constructor(private readonly maxLagWallS = MAX_LAG_WALL_S) {}

  get speed(): number {
    return this.speedValue;
  }

  /** (Re)start pacing from `simTime` at wall time `nowMs`. */
  start(nowMs: number, simTime: number, speed: number = this.speedValue): void {
    this.anchorWallMs = nowMs;
    this.anchorSim = simTime;
    this.speedValue = speed;
  }

  /** Change the speed without a jump: the new rate applies from now on. */
  setSpeed(nowMs: number, simTime: number, speed: number): void {
    this.start(nowMs, simTime, speed);
  }

  /** Simulated seconds the run is behind at `nowMs` (Infinity at maximum speed). Never negative. */
  peek(nowMs: number, simTime: number): number {
    if (!Number.isFinite(this.speedValue)) return Number.POSITIVE_INFINITY;
    const target = this.anchorSim + ((nowMs - this.anchorWallMs) / 1000) * this.speedValue;
    return Math.max(0, target - simTime);
  }

  /**
   * Simulated seconds to run now. When the simulator cannot keep up, the backlog is capped at
   * `maxLagWallS × speed` (the anchor slides forward) so it never spirals; the measured ratio then drops below 1.
   */
  owed(nowMs: number, simTime: number): number {
    const owed = this.peek(nowMs, simTime);
    if (!Number.isFinite(owed)) return owed;
    const cap = this.maxLagWallS * this.speedValue;
    if (owed > cap) {
      this.anchorWallMs = nowMs;
      this.anchorSim = simTime + cap;
      return cap;
    }
    return owed;
  }
}

/** Measured simulated-time / wall-time ratio over a sliding window. */
export class RatioMeter {
  private points: [number, number][] = [];
  private last = 0;

  constructor(private readonly windowMs = 1000, private readonly minSpanMs = 80) {}

  reset(): void {
    this.points = [];
    this.last = 0;
  }

  /** Record (wall ms, simulated s) and return the ratio over the window (the previous value while it is too short). */
  sample(nowMs: number, simTime: number): number {
    const tail = this.points[this.points.length - 1];
    if (tail && (simTime < tail[1] || nowMs < tail[0])) this.points = []; // reset of the core / clock jump
    this.points.push([nowMs, simTime]);
    while (this.points.length > 2 && nowMs - this.points[1][0] >= this.windowMs) this.points.shift();
    const [w0, s0] = this.points[0];
    const span = nowMs - w0;
    if (span >= this.minSpanMs) this.last = (simTime - s0) / (span / 1000);
    return this.last;
  }
}

/** Chooses runFor() lengths so that one call takes about `targetMs` of wall time. */
export class ChunkSizer {
  private value: number;

  constructor(
    private readonly targetMs = 2,
    private readonly minS = 1e-5,
    private readonly maxS = 0.02,
    initialS = 1e-3,
  ) {
    this.value = initialS;
  }

  get current(): number {
    return this.value;
  }

  /** Length of the next call, never more than what is owed. */
  next(owedS: number): number {
    return Math.min(owedS, this.value);
  }

  /** Learn from a call that simulated `simS` seconds in `wallMs` milliseconds. */
  record(simS: number, wallMs: number): void {
    if (!(simS > 0)) return;
    const rate = simS / Math.max(wallMs, 0.02); // simulated seconds per wall ms
    const ideal = rate * this.targetMs;
    this.value = Math.min(this.maxS, Math.max(this.minS, 0.5 * this.value + 0.5 * ideal));
  }
}

/** Fires at most once per `intervalMs`. */
export class Throttle {
  private lastMs = Number.NEGATIVE_INFINITY;

  constructor(private readonly intervalMs: number) {}

  due(nowMs: number): boolean {
    return nowMs - this.lastMs >= this.intervalMs;
  }

  mark(nowMs: number): void {
    this.lastMs = nowMs;
  }

  reset(): void {
    this.lastMs = Number.NEGATIVE_INFINITY;
  }
}

/**
 * Where "pas (ligne)" stops: every program address whose C line is known and differs from the line at `pc`.
 * When `pc` maps to no line (startup code), every mapped address is a stop, so the step lands on the first C line.
 */
export function lineStops(addrToLine: readonly (readonly [number, number])[], pc: number): { line: number | undefined; stops: number[] } {
  let line: number | undefined;
  for (const [addr, l] of addrToLine) {
    if (addr === pc) {
      line = l;
      break;
    }
  }
  const stops: number[] = [];
  for (const [addr, l] of addrToLine) if (l !== line) stops.push(addr);
  return { line, stops };
}
