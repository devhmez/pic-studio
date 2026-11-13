/// <reference types="node" />
// deriveSignals: suggested I/O from the circuits of the templates.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SchematicBuilder, parseSchematicJson, pinRef, type Schematic } from '@pic/circuit';
import { deriveSignals, toIdentifier } from '../src';

const schematic = (id: string): Schematic =>
  parseSchematicJson(readFileSync(new URL(`../../../templates/${id}.schematic.json`, import.meta.url), 'utf8'));

const brief = (id: string) => {
  const { signals, buses } = deriveSignals(schematic(id));
  return {
    signals: signals.map((s) => `${s.pin} ${s.dir} ${s.name} « ${s.label} » ${s.device} actif=${s.activeLevel} (${s.componentId})`),
    buses: buses.map((b) => `${b.name} PORT${b.port} bits ${b.lsb}+${b.width} ${b.dir} ${b.device} (${b.componentId})`),
  };
};

describe('deriveSignals on the TP circuits', () => {
  it('EXEMPLE2: LOGICSTATE → input, LED-GREEN → output « Led verte »', () => {
    expect(brief('tp0-exemple2').signals).toEqual([
      'RA0 out LED_VERTE « Led verte » led actif=1 (D1)',
      'RB0 in INTER_RB0 « Interrupteur RB0 » logicstate actif=1 (LS1)',
    ]);
  });

  it('demux DSN: LEDs through their 220 Ω series resistors, colours numbered', () => {
    expect(brief('tp1-demux').signals).toEqual([
      'RA0 in INTER_RA0 « Interrupteur RA0 » logicstate actif=1 (LS1)',
      'RA1 in INTER_RA1 « Interrupteur RA1 » logicstate actif=1 (LS2)',
      'RB0 out LED_BLEUE « Led bleue » led actif=1 (D1)',
      'RB1 out LED_VERTE « Led verte » led actif=1 (D2)',
      'RB2 out LED_ROUGE « Led rouge » led actif=1 (D3)',
      'RB3 out LED_JAUNE « Led jaune » led actif=1 (D4)',
    ]);
  });

  it('status: the custom references become the names', () => {
    expect(brief('tp-status').signals).toEqual([
      'RB0 out X_SUPERIEUR « Led x superieur » led actif=1 (X_SUPERIEUR)',
      'RB1 out EGALITE « Led egalite » led actif=1 (EGALITE)',
      'RB2 out X_INFERIEUR « Led x inferieur » led actif=1 (X_INFERIEUR)',
    ]);
  });

  it('vote: buttons with pull-downs (active high), the 7SEG-BCD bus on RB0..RB3', () => {
    expect(brief('tp-vote')).toEqual({
      signals: [
        'RA0 in VOTE_A « Bouton vote a » button actif=1 (VOTE_A)',
        'RA1 in VOTE_B « Bouton vote b » button actif=1 (VOTE_B)',
        'RA2 out CONFIRMATION « Led confirmation » led actif=1 (CONFIRMATION)',
        'RA3 in RESULTAT « Bouton resultat » button actif=1 (RESULTAT)',
        'RB5 out EGALITE « Led egalite » led actif=1 (EGALITE)',
      ],
      buses: ['AFFICHEUR PORTB bits 0+4 out bcd (SEG1)'],
    });
  });

  it('traffic: lamps ROUGE / ORANGE / VERT, the LDR divider as CAPTEUR (light = 1)', () => {
    expect(brief('tp-traffic')).toEqual({
      signals: [
        'RA0 out ROUGE « Feu rouge » lamp actif=1 (TL1)',
        'RA1 out ORANGE « Feu orange » lamp actif=1 (TL1)',
        'RA2 out VERT « Feu vert » lamp actif=1 (TL1)',
        'RA3 in CAPTEUR « Capteur de luminosité » sensor actif=1 (LDR1)',
      ],
      buses: ['AFFICHEUR PORTB bits 0+4 out bcd (SEG1)'],
    });
  });

  it('pupitre: VALIDER, DEMARRER, three LEDs and eight answer switches', () => {
    const { signals } = brief('tp-pupitre');
    expect(signals.slice(0, 5)).toEqual([
      'RA0 in VALIDER « Bouton valider » button actif=1 (VALIDER)',
      'RA1 out LED_BLEUE « Led bleue » led actif=1 (D4)',
      'RA2 out LED_ROUGE « Led rouge » led actif=1 (D2)',
      'RA3 out LED_VERTE « Led verte » led actif=1 (D3)',
      'RA4 in DEMARRER « Interrupteur demarrer » logicstate actif=1 (DEMARRER)',
    ]);
    expect(signals.slice(5)).toHaveLength(8);
    expect(signals[12]).toBe('RB7 in INTER_RB7 « Interrupteur RB7 » logicstate actif=1 (LS8)');
  });

  it('interrupt templates', () => {
    expect(brief('tp5-int-rb0').signals).toEqual([
      'RB0 in BOUTON « Bouton bouton » button actif=1 (BOUTON)',
      'RB1 out LED_ROUGE « Led rouge » led actif=1 (D1)',
      'RB2 out LED_VERTE « Led verte » led actif=1 (D2)',
    ]);
    expect(brief('tp6-rbie').signals.map((s) => s.split(' ').slice(0, 3).join(' '))).toEqual([
      'RA0 out LED_ROUGE', 'RA1 out LED_ROUGE_2', 'RA2 out LED_ROUGE_3', 'RA3 out LED_ROUGE_4',
      'RB4 in INTER_RB4', 'RB5 in INTER_RB5', 'RB6 in INTER_RB6', 'RB7 in INTER_RB7',
    ]);
  });
});

describe('deriveSignals: active levels from the wiring', () => {
  it('button with a pull-up to +5 V and the button to GND → active low; LED cathode on the pin → active low', () => {
    const b = new SchematicBuilder();
    b.place('PIC16F84A', { at: { x: 0, y: 0 } });
    const btn = b.place('BUTTON', { at: { x: 23, y: 0 } });
    b.wire(pinRef('U1', 'RA0'), pinRef(btn.id, '1'));
    const gnd = b.place('GROUND', { at: { x: 27, y: 2 } });
    b.wire(pinRef(btn.id, '2'), { x: 27, y: 0 }, pinRef(gnd.id, 'GND'));
    const r = b.place('RES', { at: { x: 20, y: -4 }, rotation: 270 });
    b.wire(pinRef(r.id, '1'), { x: 20, y: 0 });
    const pwr = b.place('POWER', { at: { x: 20, y: -11 } });
    b.wire(pinRef(r.id, '2'), pinRef(pwr.id, 'VDD'));
    // RB0 → LED cathode, anode to +5 V.
    const led = b.place('LED', { at: { x: 30, y: 10 }, rotation: 180 });
    b.wire(pinRef('U1', 'RB0/INT'), { x: 30, y: 6 }, pinRef(led.id, 'K'));
    const pwr2 = b.place('POWER', { at: { x: 30, y: 15 } });
    b.wire(pinRef(led.id, 'A'), pinRef(pwr2.id, 'VDD'));
    const { signals } = deriveSignals(b.build());
    expect(signals.map((s) => [s.pin, s.dir, s.activeLevel, s.device])).toEqual([
      ['RA0', 'in', 0, 'button'],
      ['RB0', 'out', 0, 'led'],
    ]);
  });

  it('no PIC, nothing connected → nothing suggested', () => {
    expect(deriveSignals({ clockHz: 1e6, components: [], wires: [] })).toEqual({ signals: [], buses: [] });
    const b = new SchematicBuilder();
    b.place('PIC16F84A', { at: { x: 0, y: 0 } });
    expect(deriveSignals(b.build())).toEqual({ signals: [], buses: [] });
  });

  it('identifiers from French text', () => {
    expect(toIdentifier('Led égalité')).toBe('LED_EGALITE');
    expect(toIdentifier('7 segments')).toBe('_7_SEGMENTS');
    expect(toIdentifier('***')).toBe('SIGNAL');
  });
});
