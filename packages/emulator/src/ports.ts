// PORTA / PORTB pin model (DS35007, section 4): latches, direction, input levels, RA4 open drain,
// PORTB weak pull-ups and the RB7:RB4 change-detection latch.
import type { Drive, Level, PinName } from './api';

/** Pin index: RA0..RA4 → 0..4, RB0..RB7 → 8..15. */
export const PIN_INDEX: Readonly<Record<PinName, number>> = {
  RA0: 0, RA1: 1, RA2: 2, RA3: 3, RA4: 4,
  RB0: 8, RB1: 9, RB2: 10, RB3: 11, RB4: 12, RB5: 13, RB6: 14, RB7: 15,
};

export const PORTA_MASK = 0x1f;
const RA4 = 0x10;
const RB_CHANGE_PINS = 0xf0;

export class PortState {
  latchA = 0;
  latchB = 0;
  trisA = PORTA_MASK;
  trisB = 0xff;
  /**
   * Level seen by each pin's input buffer, one bit per pin. A floating ('Z') or contended ('X')
   * net keeps the last defined level (default 0), except a floating PORTB input with its weak
   * pull-up enabled, which reads 1.
   */
  levelA = 0;
  levelB = 0;
  /** PORTB pins whose net was last reported as floating; pins never reported count as unconnected. */
  floatB = 0xff;
  /** OPTION_REG.RBPU = 0. */
  pullupsEnabled = false;
  /** PORTB value latched by the last read or write of PORTB (RBIF mismatch reference). */
  rbLatch = 0;

  /** PORTA read: input pins return the pin level, output pins the driven value. */
  readA(): number {
    const out = ~this.trisA & PORTA_MASK;
    let value = (this.levelA & this.trisA) | (this.latchA & out);
    // RA4 is open drain: with its latch at 1 the pin is released and reads the external level.
    if (out & this.latchA & RA4) value = (value & ~RA4) | (this.levelA & RA4);
    return value & PORTA_MASK;
  }

  readB(): number {
    return ((this.levelB & this.trisB) | (this.latchB & ~this.trisB)) & 0xff;
  }

  drive(index: number): Drive {
    if (index < 8) {
      const bit = 1 << index;
      if (this.trisA & bit) return 'Z';
      if (index === 4) return this.latchA & RA4 ? 'Z' : 0;
      return this.latchA & bit ? 1 : 0;
    }
    const bit = 1 << (index - 8);
    if (this.trisB & bit) return 'Z';
    return this.latchB & bit ? 1 : 0;
  }

  hasPullup(index: number): boolean {
    return index >= 8 && this.pullupsEnabled && (this.trisB & (1 << (index - 8))) !== 0;
  }

  /** Record the level of a pin's net. Returns nothing; callers diff levelA/levelB for edges. */
  setLevel(index: number, level: Level): void {
    if (index < 8) {
      const bit = 1 << index;
      if (level === 0) this.levelA &= ~bit;
      else if (level === 1) this.levelA |= bit;
      return;
    }
    const bit = 1 << (index - 8);
    if (level === 'Z') {
      this.floatB |= bit;
      this.applyPullups();
      return;
    }
    this.floatB &= ~bit;
    if (level === 0) this.levelB &= ~bit;
    else if (level === 1) this.levelB |= bit;
  }

  /** Floating PORTB inputs with an enabled weak pull-up read 1. */
  applyPullups(): void {
    if (this.pullupsEnabled) this.levelB |= this.floatB & this.trisB;
  }

  /** RB port-change condition: an RB7:RB4 input differs from the value latched at the last PORTB access. */
  rbMismatch(): boolean {
    return ((this.levelB ^ this.rbLatch) & this.trisB & RB_CHANGE_PINS) !== 0;
  }

  /** Power-on state of the latches and direction registers (pin levels come from the circuit). */
  reset(powerOn: boolean): void {
    if (powerOn) {
      this.latchA = 0;
      this.latchB = 0;
    }
    this.trisA = PORTA_MASK;
    this.trisB = 0xff;
    this.pullupsEnabled = false;
    this.rbLatch = this.readB();
  }
}
