// Source of the Ch5–Ch6 template schematics without a DSN (tp5-int-rb0, tp6-rbie, ch5-manip-rb0, ch6-exo-rbie), drawn with the
// ISIS conventions of the other templates: PIC at the origin, never rotated, OSC/MCLR unconnected; inputs and outputs
// on the right; LEDs vertical with the anode up and one common GROUND; BUTTON to +5 V with a 10k pull-down (the
// pupitre's VALIDER); LOGICSTATEs facing the PIC, stacked downwards with staircase wiring (no crossings).
import { SchematicBuilder, pinRef, type Schematic, type SchematicMeta } from '@pic/circuit';

/** Push-button on `picPin` (row `row`): RB0 → BUTTON → POWER, 10k pull-down from the node to GROUND drawn above. */
function buttonInput(b: SchematicBuilder, picPin: string, row: number, c: number, ref: string): void {
  const btn = b.place('BUTTON', { at: { x: c + 3, y: row }, ref, id: ref });
  b.wire(pinRef('U1', picPin), pinRef(btn.id, '1'));
  const pwr = b.place('POWER', { at: { x: c + 7, y: row - 6 } });
  b.wire(pinRef(btn.id, '2'), { x: c + 7, y: row }, pinRef(pwr.id, 'VDD'));
  const r = b.place('RES', { at: { x: c, y: row - 4 }, rotation: 270, value: '10k' });
  b.wire(pinRef(r.id, '1'), { x: c, y: row });
  const gnd = b.place('GROUND', { at: { x: c - 3, y: row - 9 } });
  b.wire(pinRef(r.id, '2'), { x: c, y: row - 9 - 2 }, { x: c - 3, y: row - 9 - 2 }, pinRef(gnd.id, 'GND'));
}

/** Ch5: BUTTON + 10k pull-down on RB0/INT; LED-RED on RB1 (toggled by the interrupt), LED-GREEN on RB2 (blinks). */
export function buildIntRb0(): Schematic {
  const b = new SchematicBuilder(1_000_000);
  b.place('PIC16F84A', { at: { x: 0, y: 0 } });

  // RB1 (upper row) goes furthest right so the two LED drops never cross; both stay left of the button stage.
  const leds = [
    { pin: 'RB1', ref: 'D1', color: 'RED', x: 27 },
    { pin: 'RB2', ref: 'D2', color: 'GREEN', x: 19 },
  ];
  for (const l of leds) {
    const led = b.place('LED', { at: { x: l.x, y: 13 }, ref: l.ref, props: { color: l.color } });
    b.wire(pinRef('U1', l.pin), { x: l.x, y: b.pin('U1', l.pin).y }, pinRef(led.id, 'A'));
  }
  b.wire(pinRef('D2', 'K'), { x: 19, y: 17 }, { x: 27, y: 17 }, pinRef('D1', 'K'));
  const gnd = b.place('GROUND', { at: { x: 23, y: 19 } });
  b.wire(pinRef(gnd.id, 'GND'), { x: 23, y: 17 });

  buttonInput(b, 'RB0/INT', 6, 34, 'BOUTON');
  return b.build();
}

/** Ch6: four LOGICSTATEs on RB4..RB7; four LED-RED on RA0..RA3 with one common GROUND. */
export function buildRbie(): Schematic {
  const b = new SchematicBuilder(1_000_000);
  b.place('PIC16F84A', { at: { x: 0, y: 0 } });

  // RA0..RA3: LEDs hanging below their pin rows, RA0 furthest right (staircase).
  const ledX = [63, 54, 45, 36];
  ledX.forEach((x, k) => {
    const led = b.place('LED', { at: { x, y: 8 }, ref: `D${k + 1}`, props: { color: 'RED' } });
    b.wire(pinRef('U1', `RA${k}`), { x, y: b.pin('U1', `RA${k}`).y }, pinRef(led.id, 'A'));
  });
  b.wire(pinRef('D4', 'K'), { x: 36, y: 11 }, { x: 63, y: 11 }, pinRef('D1', 'K'));
  b.wire(pinRef('D3', 'K'), { x: 45, y: 11 });
  b.wire(pinRef('D2', 'K'), { x: 54, y: 11 });
  const gnd = b.place('GROUND', { at: { x: 50, y: 13 } });
  b.wire(pinRef(gnd.id, 'GND'), { x: 50, y: 11 });

  // RB4..RB7: LOGICSTATEs facing the PIC, stacked downwards (RB4 at the top), staircase wiring as in the pupitre.
  for (let k = 0; k < 4; k++) {
    const pin = `RB${4 + k}`;
    const y = 15 + 3 * k;
    const x = 30 - k;
    const ls = b.place('LOGICSTATE', { at: { x: 34, y }, mirror: true, props: { state: 0 } });
    b.wire(pinRef('U1', pin), { x, y: b.pin('U1', pin).y }, { x, y }, pinRef(ls.id, 'Q0'));
  }
  return b.build();
}

/**
 * Course manipulation (chapitre 5, slide « Manipulation Interruption RB0 »): LED-RED on RA1, LED-GREEN on RA2, each
 * drawn horizontally above the pin rows with its own GROUND (vote's confirmation LED); BUTTON + 10k pull-down on
 * RB0/INT, moved right so its resistor stays clear of the RA rows.
 */
export function buildManipRb0(): Schematic {
  const b = new SchematicBuilder(1_000_000);
  b.place('PIC16F84A', { at: { x: 0, y: 0 } });
  const leds = [
    { pin: 'RA1', ref: 'D1', color: 'RED', x: 18 },
    { pin: 'RA2', ref: 'D2', color: 'GREEN', x: 30 },
  ];
  for (const l of leds) {
    const led = b.place('LED', { at: { x: l.x + 3, y: -3 }, rotation: 270, ref: l.ref, props: { color: l.color } });
    b.wire(pinRef('U1', l.pin), { x: l.x, y: b.pin('U1', l.pin).y }, { x: l.x, y: -3 }, pinRef(led.id, 'A'));
    const gnd = b.place('GROUND', { at: { x: l.x + 7, y: -3 }, rotation: 270 });
    b.wire(pinRef(led.id, 'K'), pinRef(gnd.id, 'GND'));
  }
  buttonInput(b, 'RB0/INT', 6, 44, 'BOUTON');
  return b.build();
}

/**
 * Course exercise (chapitre 6, « Exercice d'application »): 7SEG-BCD on RA0..RA3 drawn above the pin rows (vote's
 * display); four BUTTONs B4..B7 on RB4..RB7, staircase wiring downwards, each to the +5 V rail on the right with
 * its own 10k pull-down to GROUND hanging below the node.
 */
export function buildRbieCompteur(): Schematic {
  const b = new SchematicBuilder(1_000_000);
  b.place('PIC16F84A', { at: { x: 0, y: 0 } });

  const seg = b.place('7SEG-BCD', { at: { x: 22, y: -12 }, props: { color: 'RED' } });
  for (const k of [0, 1, 2, 3]) {
    const tip = b.pin(seg.id, `E${k}`);
    b.wire(pinRef('U1', `RA${k}`), { x: tip.x, y: b.pin('U1', `RA${k}`).y }, pinRef(seg.id, `E${k}`));
  }

  const railX = 48;
  const rows = [0, 1, 2, 3].map((k) => 17 + 10 * k);
  for (let k = 0; k < 4; k++) {
    const pin = `RB${4 + k}`;
    const y = rows[k];
    const turn = 30 - k;
    const node = { x: 36, y };
    const btn = b.place('BUTTON', { at: { x: 42, y }, ref: `B${4 + k}`, id: `B${4 + k}` });
    b.wire(pinRef('U1', pin), { x: turn, y: b.pin('U1', pin).y }, { x: turn, y }, pinRef(btn.id, '1'));
    b.wire(pinRef(btn.id, '2'), { x: railX, y });
    const r = b.place('RES', { at: { x: node.x, y: y + 3 }, rotation: 90, value: '10k' });
    const [top, bottom] = ['1', '2'].map((n) => ({ n, p: b.pin(r.id, n) })).sort((a, c) => a.p.y - c.p.y);
    b.wire(pinRef(r.id, top.n), node);
    const gnd = b.place('GROUND', { at: { x: node.x, y: bottom.p.y + 2 } });
    b.wire(pinRef(r.id, bottom.n), pinRef(gnd.id, 'GND'));
  }
  // +5 V rail joining the four buttons, POWER on top.
  const pwr = b.place('POWER', { at: { x: railX, y: rows[0] - 3 } });
  b.wire(pinRef(pwr.id, 'VDD'), { x: railX, y: rows[3] });
  return b.build();
}

export interface SchematicTemplate {
  id: string;
  meta: SchematicMeta;
  build: () => Schematic;
}

export const NEW_SCHEMATICS: readonly SchematicTemplate[] = [
  {
    id: 'tp5-int-rb0',
    meta: {
      name: 'TP5 — Interruption externe RB0/INT',
      source: 'Chapitre 5 (montage reconstitué dans le style des TP)',
      description: 'BOUTON vers +5 V avec rappel 10k vers la masse sur RB0/INT ; D1 LED-RED sur RB1 (interruption), '
        + 'D2 LED-GREEN sur RB2 (clignotement) ; cathodes → GND. Horloge 1 MHz.',
    },
    build: buildIntRb0,
  },
  {
    id: 'tp6-rbie',
    meta: {
      name: 'TP6 — Interruption sur changement du PORTB',
      source: 'Chapitre 6 (montage reconstitué dans le style des TP)',
      description: '4 LOGICSTATE sur RB4 à RB7 ; D1 à D4 LED-RED sur RA0 à RA3, cathodes → GND. Horloge 1 MHz.',
    },
    build: buildRbie,
  },
  {
    id: 'ch5-manip-rb0',
    meta: {
      name: 'Manipulation — Interruption RB0',
      source: 'INTERRUPTIONS_e2026.pptx, diapo « Manipulation » (montage redessiné)',
      description: 'D1 LED-RED sur RA1, D2 LED-GREEN sur RA2, cathodes → GND ; BOUTON vers +5 V avec rappel 10k vers la masse '
        + 'sur RB0/INT. Horloge 1 MHz.',
    },
    build: buildManipRb0,
  },
  {
    id: 'ch6-exo-rbie',
    meta: {
      name: 'Exercice — Compteur et boutons RB4 à RB7',
      source: 'INTERRUPTIONS_e2026.pptx, diapo « Exercice d’application » (montage redessiné)',
      description: '7SEG-BCD sur RA0..RA3 ; boutons B4 à B7 sur RB4..RB7, chacun vers +5 V avec un rappel 10k vers la masse. '
        + 'Horloge 1 MHz.',
    },
    build: buildRbieCompteur,
  },
];
