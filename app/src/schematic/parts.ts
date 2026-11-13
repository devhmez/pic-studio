// Component palette: the parts of the course (ISIS names kept as search keywords).
import type { ComponentKind } from '@pic/circuit';
import type { PartSpec } from './editing';

export interface PaletteItem {
  key: string;
  /** French label shown in the palette. */
  label: string;
  /** Proteus library name, shown small under the label. */
  isis: string;
  spec: PartSpec;
  /** Extra words matched by the search box. */
  keywords: string;
  group: 'Microcontrôleur' | 'Sorties' | 'Entrées' | 'Passifs' | 'Alimentation';
}

const led = (color: 'RED' | 'GREEN' | 'BLUE' | 'YELLOW', label: string): PaletteItem => ({
  key: `LED-${color}`,
  label,
  isis: `LED-${color}`,
  spec: { kind: 'LED', props: { color }, value: `LED-${color}` },
  keywords: 'led diode del lumière sortie',
  group: 'Sorties',
});

export const PALETTE: readonly PaletteItem[] = [
  { key: 'PIC16F84A', label: 'PIC16F84A', isis: 'PIC16F84A', spec: { kind: 'PIC16F84A' }, keywords: 'microcontrôleur pic mcu', group: 'Microcontrôleur' },
  led('RED', 'LED rouge'),
  led('GREEN', 'LED verte'),
  led('BLUE', 'LED bleue'),
  led('YELLOW', 'LED jaune'),
  { key: '7SEG-BCD', label: 'Afficheur 7 segments BCD', isis: '7SEG-BCD', spec: { kind: '7SEG-BCD', props: { color: 'RED' } }, keywords: 'afficheur seg bcd chiffre décodeur', group: 'Sorties' },
  { key: '7SEG-CC', label: 'Afficheur 7 segments (cathode commune)', isis: '7SEG-COM-CATHODE', spec: { kind: '7SEG-CC', props: { color: 'RED' } }, keywords: 'afficheur seg cathode direct a b c d e f g', group: 'Sorties' },
  { key: 'TRAFFIC', label: 'Feux tricolores', isis: 'TRAFFIC LIGHTS', spec: { kind: 'TRAFFIC_LIGHTS' }, keywords: 'feu rouge orange vert traffic lights carrefour', group: 'Sorties' },
  { key: 'LOGICSTATE', label: 'Interrupteur logique', isis: 'LOGICSTATE', spec: { kind: 'LOGICSTATE' }, keywords: 'logicstate état logique bouton interrupteur entrée 0 1', group: 'Entrées' },
  { key: 'BUTTON', label: 'Bouton poussoir', isis: 'BUTTON', spec: { kind: 'BUTTON' }, keywords: 'bouton poussoir button touche entrée', group: 'Entrées' },
  { key: 'TORCH_LDR', label: 'Lampe + photorésistance', isis: 'TORCH_LDR', spec: { kind: 'TORCH_LDR' }, keywords: 'ldr capteur lumière torche photorésistance jour nuit', group: 'Entrées' },
  { key: 'RES', label: 'Résistance', isis: 'RES', spec: { kind: 'RES' }, keywords: 'résistance res ohm 220 10k', group: 'Passifs' },
  { key: 'CAP', label: 'Condensateur', isis: 'CAP', spec: { kind: 'CAP' }, keywords: 'condensateur capacité cap 22pf', group: 'Passifs' },
  { key: 'CRYSTAL', label: 'Quartz', isis: 'CRYSTAL', spec: { kind: 'CRYSTAL' }, keywords: 'quartz crystal oscillateur horloge', group: 'Passifs' },
  { key: 'POWER', label: 'Alimentation +5 V', isis: 'POWER', spec: { kind: 'POWER' }, keywords: 'alimentation vdd vcc +5v power', group: 'Alimentation' },
  { key: 'GROUND', label: 'Masse', isis: 'GROUND', spec: { kind: 'GROUND' }, keywords: 'masse gnd ground 0v terre', group: 'Alimentation' },
];

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Items matching every word of the query (accents and case ignored). */
export function searchPalette(query: string): PaletteItem[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...PALETTE];
  return PALETTE.filter((item) => {
    const hay = fold(`${item.label} ${item.isis} ${item.keywords}`);
    return words.every((w) => hay.includes(w));
  });
}

/** French name of a kind, for tooltips and the properties popover. */
export const KIND_LABEL: Readonly<Record<ComponentKind, string>> = {
  PIC16F84A: 'Microcontrôleur PIC16F84A',
  LED: 'LED',
  LOGICSTATE: 'Interrupteur logique (LOGICSTATE)',
  BUTTON: 'Bouton poussoir',
  RES: 'Résistance',
  '7SEG-BCD': 'Afficheur 7 segments BCD',
  '7SEG-CC': 'Afficheur 7 segments (cathode commune)',
  TRAFFIC_LIGHTS: 'Feux tricolores',
  TORCH_LDR: 'Lampe + photorésistance (LDR)',
  CAP: 'Condensateur',
  CRYSTAL: 'Quartz',
  POWER: 'Alimentation +5 V',
  GROUND: 'Masse',
};
