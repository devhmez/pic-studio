import { describe, expect, it } from 'vitest';
import type { ComponentKind } from '../src/api';
import {
  BCD_GLYPHS, COMPONENT_KINDS, ISIS_COLORS, SEGMENTS, SYMBOLS, activeLayers, getSymbol, interactionFor, isisPartName,
  ledFrame, visiblePins,
} from '../src/symbols';

const tips = (kind: ComponentKind, props = {}) =>
  Object.fromEntries(getSymbol(kind, props).pins.map((p) => [p.name, p.tip]));

describe('symbol library', () => {
  it('has a symbol for every ComponentKind, with unique pin names on the half grid', () => {
    const kinds: ComponentKind[] = ['PIC16F84A', 'LED', 'LOGICSTATE', 'BUTTON', 'RES', '7SEG-BCD', '7SEG-CC',
      'TRAFFIC_LIGHTS', 'TORCH_LDR', 'CAP', 'CRYSTAL', 'POWER', 'GROUND'];
    expect([...COMPONENT_KINDS].sort()).toEqual([...kinds].sort());
    for (const kind of kinds) {
      const s = SYMBOLS[kind];
      expect(s.kind).toBe(kind);
      const names = s.pins.map((p) => p.name);
      expect(new Set(names).size).toBe(names.length);
      for (const p of s.pins) {
        expect(Number.isInteger(p.tip.x * 2) && Number.isInteger(p.tip.y * 2)).toBe(true);
      }
      expect(s.bounds.w).toBeGreaterThan(0);
      expect(s.body.length).toBeGreaterThan(0);
    }
  });

  it('PIC16F84A: origin on OSC1, port A top right, a gap, then port B; VDD/VSS hidden', () => {
    const t = tips('PIC16F84A');
    expect(t['OSC1/CLKIN']).toEqual({ x: 0, y: 0 });
    expect(t['OSC2/CLKOUT']).toEqual({ x: 0, y: 1 });
    expect(t.MCLR).toEqual({ x: 0, y: 3 });
    expect(['RA0', 'RA1', 'RA2', 'RA3', 'RA4/T0CKI'].map((n) => t[n])).toEqual([0, 1, 2, 3, 4].map((y) => ({ x: 15, y })));
    expect(['RB0/INT', 'RB1', 'RB2', 'RB3', 'RB4', 'RB5', 'RB6', 'RB7'].map((n) => t[n]))
      .toEqual([6, 7, 8, 9, 10, 11, 12, 13].map((y) => ({ x: 15, y })));
    const pic = SYMBOLS.PIC16F84A;
    expect(pic.pins.filter((p) => p.hidden).map((p) => p.name)).toEqual(['VDD', 'VSS']);
    expect(pic.pins.find((p) => p.name === 'MCLR')?.overbar).toBe(true);
    expect(pic.pins.find((p) => p.name === 'RA2')?.number).toBe(1);
    expect(pic.pins.find((p) => p.name === 'RB0/INT')?.number).toBe(6);
    expect(pic.body[0]).toMatchObject({ type: 'rect', x: 2, y: -1, w: 11, h: 15, fill: ISIS_COLORS.body, stroke: ISIS_COLORS.outline });
    expect(visiblePins({ kind: 'PIC16F84A', props: {} })).toHaveLength(16);
  });

  it('decoded pin geometry of the other ISIS parts (Y down)', () => {
    expect(tips('LED')).toEqual({ A: { x: 0, y: -2 }, K: { x: 0, y: 2 } });
    expect(tips('RES')).toEqual({ 1: { x: -2, y: 0 }, 2: { x: 3, y: 0 } });
    expect(tips('LOGICSTATE')).toEqual({ Q0: { x: 2, y: 0 } });
    expect(tips('7SEG-BCD')).toEqual({ E3: { x: 1, y: 10.5 }, E2: { x: 2.5, y: 10.5 }, E1: { x: 4, y: 10.5 }, E0: { x: 5.5, y: 10.5 } });
    expect(tips('TRAFFIC_LIGHTS')).toEqual({ R: { x: -4, y: -3 }, A: { x: -4, y: 0 }, G: { x: -4, y: 3 } });
    expect(tips('TORCH_LDR')).toEqual({ 1: { x: 2, y: -3 }, 2: { x: 2, y: 3 } });
    expect(tips('POWER')).toEqual({ VDD: { x: 0, y: 1 } });
    expect(tips('GROUND')).toEqual({ GND: { x: 0, y: -1 } });
    expect(Object.keys(tips('7SEG-CC'))).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp', 'K']);
    expect(Object.keys(tips('BUTTON'))).toEqual(['1', '2']);
  });

  it('exports the ISIS colours', () => {
    expect(ISIS_COLORS).toMatchObject({
      background: '#E0E0D0', body: '#C8C8AA', outline: '#800000', wire: '#004000',
      pinHigh: '#FF4040', pinLow: '#4040FF', pinFloating: '#808080',
    });
  });

  it('resolves colour variants and the Proteus part names', () => {
    expect(isisPartName({ kind: 'LED', props: { color: 'BLUE' } })).toBe('LED-BLUE');
    expect(isisPartName({ kind: '7SEG-BCD', props: { color: 'BLUE' } })).toBe('7SEG-BCD-BLUE');
    expect(isisPartName({ kind: '7SEG-BCD', props: {} })).toBe('7SEG-BCD');
    expect(isisPartName({ kind: 'TRAFFIC_LIGHTS', props: {} })).toBe('TRAFFIC LIGHTS');
    expect(getSymbol('LED', { color: 'GREEN' })).not.toBe(getSymbol('LED', { color: 'RED' }));
  });
});

describe('7-segment glyphs', () => {
  const lit = (v: number) => SEGMENTS.filter((_, i) => (BCD_GLYPHS[v] >> i) & 1).join(' ');
  it('decodes 0-9 A b C d E F like the ISIS 7SEG-BCD frames', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(lit)).toEqual([
      'a b c d e f', 'b c', 'a b d e g', 'a b c d g', 'b c f g', 'a c d f g', 'a c d e f g', 'a b c', 'a b c d e f g', 'a b c d f g',
    ]);
    expect([10, 11, 12, 13, 14, 15].map(lit)).toEqual([
      'a b c e f g', 'c d e f g', 'a d e f', 'b c d e g', 'a d e f g', 'a e f g',
    ]);
  });
});

describe('state layers', () => {
  it('maps simulation visuals to existing layers', () => {
    const cases = [
      [{ kind: 'LED', props: { color: 'RED' } }, { kind: 'LED', brightness: 1, lit: true }, ['lit', 'emission']],
      [{ kind: 'LED', props: {} }, { kind: 'LED', brightness: 0, lit: false }, []],
      [{ kind: 'LOGICSTATE', props: {} }, { kind: 'LOGICSTATE', state: 1 }, ['state-1']],
      [{ kind: 'BUTTON', props: {} }, { kind: 'BUTTON', pressed: true }, ['pressed']],
      [{ kind: 'TORCH_LDR', props: {} }, { kind: 'TORCH_LDR', level: 9 }, ['beam-9', 'torch-9']],
      [{ kind: 'TRAFFIC_LIGHTS', props: {} }, { kind: 'TRAFFIC_LIGHTS', red: true, amber: false, green: true }, ['red-on', 'green-on']],
      [{ kind: '7SEG-BCD', props: {} }, { kind: '7SEG-BCD', value: 0x0a }, ['seg-a', 'seg-b', 'seg-c', 'seg-e', 'seg-f', 'seg-g']],
      [{ kind: '7SEG-BCD', props: {} }, { kind: '7SEG-BCD', value: null }, []],
      [{ kind: '7SEG-CC', props: {} }, { kind: '7SEG-CC', segments: 0x86 }, ['seg-b', 'seg-c', 'seg-dp']],
    ] as const;
    for (const [component, visual, expected] of cases) {
      const layers = activeLayers(component, visual);
      expect(layers.map((l) => l.name)).toEqual(expected);
      const symbol = getSymbol(component.kind, component.props);
      for (const l of layers) expect(symbol.layers[l.name]).toBeDefined();
    }
    expect(activeLayers({ kind: 'LED', props: {} }, { kind: 'LED', brightness: 0.5, lit: true })[0].opacity).toBeCloseTo(4 / 7);
    expect(activeLayers({ kind: 'LOGICSTATE', props: { state: 1 } })).toEqual([{ name: 'state-1', opacity: 1 }]);
  });

  it('quantizes LED brightness to the 8 ISIS frames', () => {
    expect([0, 0.07, 0.5, 1].map(ledFrame)).toEqual([0, 0, 4, 7]);
  });

  it('turns actuator clicks into interactions', () => {
    expect(interactionFor('toggle')).toEqual({ type: 'toggle' });
    expect(interactionFor('press')).toEqual({ type: 'press' });
    expect(interactionFor('increment', { kind: 'TORCH_LDR', level: 3 })).toEqual({ type: 'setLevel', level: 4 });
    expect(interactionFor('decrement', { kind: 'TORCH_LDR', level: 0 })).toEqual({ type: 'setLevel', level: 0 });
    expect(interactionFor('increment', { kind: 'TORCH_LDR', level: 9 })).toEqual({ type: 'setLevel', level: 9 });
  });
});
