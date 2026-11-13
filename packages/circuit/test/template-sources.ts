// Sources of the templates in /templates. The five TP circuits the prof shipped as .DSN are imported as-is;
// vote and pupitre have no DSN and are drawn here in the same ISIS style (PIC at the origin, inputs on the right).
import type { Schematic } from '../src/api';
import { SchematicBuilder, pinRef } from '../src/builder';
import { importDsn } from '../src/dsn';
import type { SchematicMeta } from '../src/schematic-io';
import { DSN_FILES, readBytes } from './helpers';

export interface TemplateSource {
  file: string;
  meta: SchematicMeta;
  build: () => Schematic;
}

const DSN_DESCRIPTIONS: Record<string, string> = {
  'tp0-exemple1': 'RA0 → LED-BLUE D1 → GND (sans résistance). Horloge 1 MHz.',
  'tp0-exemple2': 'LOGICSTATE (état initial 1) → RB0 ; RA0 → LED-GREEN D1 → GND. Horloge 1 MHz.',
  'tp1-demux': 'RA0 ← LOGICSTATE (L0, 0), RA1 ← LOGICSTATE (L1, 1) ; RB0..RB3 → RES 220 → D1 LED-BLUE, D2 LED-GREEN, '
    + 'D3 LED-RED, D4 LED-YELLOW → GND. Horloge 1 MHz.',
  'tp-status': 'RB0 → X_SUPERIEUR (LED-BLUE), RB1 → EGALITE (LED-GREEN), RB2 → X_INFERIEUR (LED-RED), cathodes → GND. Horloge 1 MHz.',
  'tp-traffic': 'RA0/RA1/RA2 → TRAFFIC LIGHTS rouge/orange/vert ; POWER → TORCH_LDR → RA3 → RES 1k → GND ; '
    + 'RB0..RB3 → 7SEG-BCD-BLUE (E0..E3). Horloge 8 MHz.',
};

/**
 * Pupitre-style push-button input on `row` (the pin's y): RA → BUTTON → POWER, with a 10k pull-down from the
 * node to GROUND drawn above (active high, as VALIDER in the prof's TP2 capture). `c` is the node column.
 */
function buttonInput(b: SchematicBuilder, picPin: string, row: number, c: number, ref: string): void {
  const btn = b.place('BUTTON', { at: { x: c + 3, y: row }, ref });
  b.wire(pinRef('U1', picPin), pinRef(btn.id, '1'));
  const pwr = b.place('POWER', { at: { x: c + 7, y: -11 } });
  b.wire(pinRef(btn.id, '2'), { x: c + 7, y: row }, pinRef(pwr.id, 'VDD'));
  const r = b.place('RES', { at: { x: c, y: row - 4 }, rotation: 270, value: '10k' });
  b.wire(pinRef(r.id, '1'), { x: c, y: row });
  const gnd = b.place('GROUND', { at: { x: c - 3, y: -7 } });
  b.wire(pinRef(r.id, '2'), { x: c, y: -9 }, { x: c - 3, y: -9 }, pinRef(gnd.id, 'GND'));
}

/** Vote (Énoncé_élection.pdf): buttons Vote A RA0, Vote B RA1, Résultat RA3; LED RA2; 7SEG-BCD RB0..RB3; LED-GREEN RB5. */
export function buildVote(): Schematic {
  const b = new SchematicBuilder(1_000_000);
  b.place('PIC16F84A', { at: { x: 0, y: 0 } });
  buttonInput(b, 'RA0', 0, 20, 'VOTE_A');
  buttonInput(b, 'RA1', 1, 33, 'VOTE_B');

  // RA2: confirmation LED drawn horizontally above the pin rows, anode towards the PIC, its own GROUND (Ch2 style).
  const led = b.place('LED', { at: { x: 49, y: -3 }, rotation: 270, ref: 'CONFIRMATION', props: { color: 'YELLOW' } });
  b.wire(pinRef('U1', 'RA2'), { x: 46, y: 2 }, { x: 46, y: -3 }, pinRef(led.id, 'A'));
  const ledGnd = b.place('GROUND', { at: { x: 53, y: -3 }, rotation: 270 });
  b.wire(pinRef(led.id, 'K'), pinRef(ledGnd.id, 'GND'));

  buttonInput(b, 'RA3', 3, 59, 'RESULTAT');

  // 7SEG-BCD above the RB lines, E3 (MSB) on the left, as in the traffic-light circuit.
  const seg = b.place('7SEG-BCD', { at: { x: 70, y: -6 }, props: { color: 'RED' } });
  for (const [i, pin] of (['RB0/INT', 'RB1', 'RB2', 'RB3'] as const).entries()) {
    const tip = b.pin(seg.id, `E${i}`);
    b.wire(pinRef('U1', pin), { x: tip.x, y: b.pin('U1', pin).y }, pinRef(seg.id, `E${i}`));
  }

  // RB5: green "égalité" LED, vertical, anode on top.
  const egal = b.place('LED', { at: { x: 20, y: 15 }, ref: 'EGALITE', props: { color: 'GREEN' } });
  b.wire(pinRef('U1', 'RB5'), { x: 20, y: 11 }, pinRef(egal.id, 'A'));
  const egalGnd = b.place('GROUND', { at: { x: 20, y: 20 } });
  b.wire(pinRef(egal.id, 'K'), pinRef(egalGnd.id, 'GND'));
  return b.build();
}

/** Pupitre de jeu (TP2 capture): VALIDER RA0, LEDs RA1-RA3, DEMARRER RA4, answers Q0..Q7 on RB0..RB7. */
export function buildPupitre(): Schematic {
  const b = new SchematicBuilder(1_000_000);
  b.place('PIC16F84A', { at: { x: 0, y: 0 } });
  buttonInput(b, 'RA0', 0, 20, 'VALIDER');

  // RA4: DEMARRER LOGICSTATE, output to the left.
  const start = b.place('LOGICSTATE', { at: { x: 42, y: 7 }, mirror: true, ref: 'DEMARRER', props: { state: 0 } });
  b.wire(pinRef('U1', 'RA4/T0CKI'), { x: 38, y: 4 }, { x: 38, y: 7 }, pinRef(start.id, 'Q0'));

  // RB0..RB7: eight answer LOGICSTATEs stacked downwards (RB0 at the top), staircase wiring without crossings.
  for (let k = 0; k < 8; k++) {
    const pin = k === 0 ? 'RB0/INT' : `RB${k}`;
    const y = 15 + 3 * k;
    const x = 30 - k;
    const ls = b.place('LOGICSTATE', { at: { x: 34, y }, mirror: true, props: { state: 0 } });
    b.wire(pinRef('U1', pin), { x, y: 6 + k }, { x, y }, pinRef(ls.id, 'Q0'));
  }

  // LEDs hanging from RA3 (YES), RA2 (NO), RA1 (GAME OVER); common cathode bus to one GROUND.
  const leds = [
    { pin: 'RA3', ref: 'D3', color: 'GREEN', x: 48 },
    { pin: 'RA2', ref: 'D2', color: 'RED', x: 57 },
    { pin: 'RA1', ref: 'D4', color: 'BLUE', x: 66 },
  ];
  for (const l of leds) {
    const led = b.place('LED', { at: { x: l.x, y: 7 }, ref: l.ref, props: { color: l.color } });
    b.wire(pinRef('U1', l.pin), { x: l.x, y: b.pin('U1', l.pin).y }, pinRef(led.id, 'A'));
  }
  b.wire(pinRef('D3', 'K'), { x: 48, y: 11 }, { x: 66, y: 11 }, pinRef('D4', 'K'));
  b.wire(pinRef('D2', 'K'), { x: 57, y: 11 });
  const gnd = b.place('GROUND', { at: { x: 57, y: 13 } });
  b.wire(pinRef(gnd.id, 'GND'), { x: 57, y: 11 });
  return b.build();
}

export const TEMPLATE_SOURCES: TemplateSource[] = [
  ...DSN_FILES.map(({ file, template, name }): TemplateSource => ({
    file: template,
    meta: { name, source: `cours/${file}`, description: DSN_DESCRIPTIONS[template] },
    build: () => importDsn(readBytes(`cours/${file}`)),
  })),
  {
    file: 'tp-vote',
    meta: {
      name: 'TP — Boîtier électronique de vote (A / B)',
      source: 'Énoncé_élection.pdf (pas de schéma fourni : montage reconstitué)',
      description: 'Boutons « Vote A » RA0, « Vote B » RA1, « Résultat » RA3 (BUTTON vers +5 V, rappel 10k vers la masse) ; '
        + 'LED de confirmation RA2 ; 7SEG-BCD sur RB0..RB3 ; LED verte RB5. Horloge 1 MHz.',
    },
    build: buildVote,
  },
  {
    file: 'tp-pupitre',
    meta: {
      name: 'TP2 — Pupitre de jeu',
      source: 'TP -pupitre Séance3.docx (capture ISIS redessinée)',
      description: 'VALIDER : BUTTON vers +5 V avec R1 10k vers la masse sur RA0 ; D4 LED-BLUE « GAME OVER » RA1, '
        + 'D2 LED-RED « NO » RA2, D3 LED-GREEN « YES » RA3 ; LOGICSTATE DEMARRER sur RA4 ; 8 LOGICSTATE (Q0..Q7) sur RB0..RB7.',
    },
    build: buildPupitre,
  },
  // Chapitre 5 (interruption RB0/INT): the prof's own ISIS files, imported as-is.
  {
    file: 'tp4-inte',
    meta: {
      name: 'TP4 — Interruption INTE',
      source: 'cours/TP_inte.DSN',
      description: 'BUTTON entre RB0/INT et +5 V, R1 220 de RB0 vers la masse (rappel) ; D1 LED-RED sur RB3 → GND ; '
        + '7SEG-BCD sur RA0..RA3 (E0..E3). Horloge 8 MHz.',
    },
    build: () => importDsn(readBytes('cours/TP_inte.DSN')),
  },
  {
    file: 'tp-traffic-int',
    meta: {
      name: 'Feu tricolore avec interruption',
      source: 'cours/trafficint.DSN',
      description: 'LOGICSTATE (capteur jour/nuit) sur RB0/INT ; TRAFFIC LIGHTS rouge RB2, orange RB3, vert RB4 ; '
        + '7SEG-BCD-BLUE sur RA0..RA3 (E0..E3). Horloge 8 MHz.',
    },
    build: () => importDsn(readBytes('cours/trafficint.DSN')),
  },
];
