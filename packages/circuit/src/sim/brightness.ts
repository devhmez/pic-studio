// LED brightness shown by the UI (ISIS draws 8 frames, see ledFrame()).
//  - Steady LED, or at most one on/off change within the last window (single-stepping, a slow blink): the current
//    state. A freshly switched-on LED shows lit once it has been on for TLITMIN; switching off shows at once.
//  - LED toggling faster than the window (PWM, multiplexing, an off/on loop): the lit fraction of the last full
//    window, i.e. the duty cycle.

/** Averaging window: 20 ms, i.e. one 50 Hz display refresh. */
export const BRIGHTNESS_WINDOW_S = 0.02;

/** TLITMIN "Minimum on time to light" of the LED-RED/GREEN/BLUE/YELLOW library parts: 0.1 ms (research 05 §4.1). */
export const LED_MIN_ON_TIME_S = 1e-4;

/** Relative tolerance on accumulated float times. */
const EPS = 1e-9;

export class DutyCycle {
  // Fixed-window average.
  private onTime = 0;
  private total = 0;
  private published: number | null = null;
  // State during the latest advance() (null: no time accounted yet), how long it has lasted, and the run before it.
  private state: boolean | null = null;
  private run = 0;
  private previousRun = Infinity;

  constructor(
    private readonly window: number = BRIGHTNESS_WINDOW_S,
    private readonly minOnTime: number = LED_MIN_ON_TIME_S,
  ) {}

  /** Account `dt` seconds spent in the `lit` state. */
  advance(dt: number, lit: boolean): void {
    if (!(dt > 0)) return;
    if (lit !== this.state) {
      this.previousRun = this.state === null ? Infinity : this.run;
      this.state = lit;
      this.run = 0;
    }
    this.run += dt;
    this.accumulate(dt, lit);
  }

  /** Brightness 0..1 to draw now, `currentlyLit` being the electrical state (possibly changed since advance()). */
  value(currentlyLit: boolean): number {
    if (this.state === null) return currentlyLit ? 1 : 0; // no simulated time yet: the electrical state
    // A change that no advance() has accounted yet starts a run of length 0.
    const changed = currentlyLit !== this.state;
    const run = changed ? 0 : this.run;
    const previousRun = changed ? this.run : this.previousRun;
    if (run + previousRun >= this.window * (1 - EPS)) {
      return currentlyLit && run >= this.minOnTime * (1 - EPS) ? 1 : 0;
    }
    if (this.published !== null) return this.published;
    return this.total > 0 ? this.onTime / this.total : currentlyLit ? 1 : 0;
  }

  reset(): void {
    this.onTime = 0;
    this.total = 0;
    this.published = null;
    this.state = null;
    this.run = 0;
    this.previousRun = Infinity;
  }

  private accumulate(dt: number, lit: boolean): void {
    let remaining = dt;
    const first = Math.min(this.window - this.total, remaining);
    this.add(first, lit);
    remaining -= first;
    if (remaining <= 0) return;
    // Whole windows in a constant state, then the partial tail.
    const whole = Math.floor(remaining / this.window);
    if (whole > 0) this.published = lit ? 1 : 0;
    this.add(remaining - whole * this.window, lit);
  }

  private add(dt: number, lit: boolean): void {
    if (dt <= 0) return;
    this.total += dt;
    if (lit) this.onTime += dt;
    if (this.total >= this.window * (1 - EPS)) {
      this.published = this.onTime / this.total;
      this.onTime = 0;
      this.total = 0;
    }
  }
}
