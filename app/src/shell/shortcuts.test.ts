import { describe, expect, it } from 'vitest';
import { panelDigit } from './shortcuts';

describe('⌘1–⌘4 panel shortcuts', () => {
  it('reads the physical key, so a French AZERTY keyboard works without Shift', () => {
    // AZERTY: the unshifted digit row types & é " '.
    expect(panelDigit({ code: 'Digit1', key: '&' })).toBe(1);
    expect(panelDigit({ code: 'Digit2', key: 'é' })).toBe(2);
    expect(panelDigit({ code: 'Digit3', key: '"' })).toBe(3);
    expect(panelDigit({ code: 'Digit4', key: '\'' })).toBe(4);
    expect(panelDigit({ code: 'Numpad2', key: '2' })).toBe(2);
    expect(panelDigit({ code: 'Digit5', key: '(' })).toBeNull();
    expect(panelDigit({ code: 'KeyB', key: 'b' })).toBeNull();
    // Synthetic events without a code.
    expect(panelDigit({ code: '', key: '3' })).toBe(3);
  });
});
