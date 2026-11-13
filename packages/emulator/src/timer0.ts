// Timer0 and the 8-bit prescaler it shares with the watchdog (DS35007, section 5).
import { OPTION_PSA, OPTION_PS_MASK, OPTION_T0CS } from './sfr';

/**
 * DS35007 §5.1: after a write to TMR0 "the increment is inhibited for the following two
 * instruction cycles". The write lands in Q4 of the write cycle and overrides that cycle's own
 * increment, so the write cycle and the two following ones produce no count: the three
 * instructions after `MOVWF TMR0` read the written value, the fourth reads value + 1 (mid-range
 * reference manual DS33023, "TMR0 timing: internal clock/no prescale": "reads NT0" three times).
 * With the prescaler assigned to Timer0 it is cleared by the write and also waits out the window,
 * which amounts to the 2-cycle synchronizer delay on the prescaler output.
 */
export const TMR0_WRITE_INHIBIT = 2;
/** Cycles without increment, counted from the write cycle itself. */
const INHIBITED_CYCLES = TMR0_WRITE_INHIBIT + 1;

export class Timer0 {
  /** TMR0 register. */
  value = 0;
  /**
   * Prescaler counter. Assigned to TMR0 when OPTION_REG.PSA = 0 (rate 1:2..1:256),
   * to the watchdog when PSA = 1 (rate 1:1..1:128).
   */
  prescaler = 0;
  /** Remaining instruction cycles (write cycle included) during which increments are discarded. */
  inhibit = 0;

  reset(): void {
    this.prescaler = 0;
    this.inhibit = 0;
  }

  /** Program write to TMR0: clears the prescaler when it is assigned to Timer0. */
  write(value: number, option: number): void {
    this.value = value & 0xff;
    if ((option & OPTION_PSA) === 0) this.prescaler = 0;
    this.inhibit = INHIBITED_CYCLES;
  }

  /** Advance by `cycles` instruction cycles. Returns true if TMR0 overflowed (FFh → 00h). */
  tick(cycles: number, option: number): boolean {
    if (option & OPTION_T0CS) {
      // Counter mode: only the write-inhibit window elapses; increments come from T0CKI edges.
      this.inhibit = this.inhibit > cycles ? this.inhibit - cycles : 0;
      return false;
    }
    let overflow = false;
    for (let n = cycles; n > 0; n--) {
      if (this.inhibit > 0) {
        this.inhibit--;
        continue;
      }
      if (this.increment(option)) overflow = true;
    }
    return overflow;
  }

  /** One active edge on RA4/T0CKI in counter mode. Returns true on overflow. */
  externalEdge(option: number): boolean {
    if (this.inhibit > 0) return false;
    return this.increment(option);
  }

  /**
   * One watchdog time-out pulse through the prescaler (PSA = 1).
   * Returns true when the prescaler output fires, i.e. the WDT really times out.
   */
  watchdogPulse(option: number): boolean {
    if ((option & OPTION_PSA) === 0) return true;
    this.prescaler = (this.prescaler + 1) & 0xff;
    return (this.prescaler & ((1 << (option & OPTION_PS_MASK)) - 1)) === 0;
  }

  /** One clock into Timer0, through the prescaler when it is assigned to Timer0. */
  private increment(option: number): boolean {
    if ((option & OPTION_PSA) === 0) {
      this.prescaler = (this.prescaler + 1) & 0xff;
      if ((this.prescaler & ((2 << (option & OPTION_PS_MASK)) - 1)) !== 0) return false;
    }
    this.value = (this.value + 1) & 0xff;
    return this.value === 0;
  }
}
