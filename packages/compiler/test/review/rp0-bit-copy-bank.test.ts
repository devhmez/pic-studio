import { describe, expect, it } from 'vitest';
import { onEmulator } from '../e2e/support';
import { runFor } from '../support/harness';

// The emitter does automatic RP0 bank selection and tracks the current bank. Copying a run-time bit into STATUS.RP0
// emits `BTFSC tmp,0 / BSF STATUS,RP0 / BTFSS tmp,0 / BCF STATUS,RP0`, after which the emitter believes bank 0 is
// selected (the last instruction it saw was BCF RP0), although RP0 now equals the copied bit. The next bank-0 access
// is emitted without a bank switch, so `PORTB = 0x06;` is executed as `MOVWF 0x86` (TRISB) when RB0 = 1.

describe('suivi de banque après STATUS.RP0 = <bit>', () => {
  it('PORTB = 0x06 écrit bien PORTB (et pas TRISB) quand RB0 = 1', () => {
    const { core } = onEmulator(`void main() {
    TRISB = 0x01;
    STATUS.RP0 = PORTB.F0;
    PORTB = 0x06;
}`);
    core.setInput('RB0', 1);
    runFor(core, 100);
    expect(core.peek(0x86), 'TRISB ne doit pas être modifié').toBe(0x01);
    expect(core.getDrive('RB1')).toBe(1);
    expect(core.getDrive('RB2')).toBe(1);
  });
});
