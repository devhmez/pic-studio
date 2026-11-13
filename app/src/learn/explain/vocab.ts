// French meaning of the PIC16F84A control bits, shared by the C-line and change explanations.

/** What writing `value` into a named bit does. */
export function bitWriteMeaning(reg: string, name: string, value: 0 | 1): string | null {
  const key = `${reg}.${name}`;
  const t = BIT_WRITES[key];
  return t ? t[value ? 1 : 0] : null;
}

/** [meaning of 0, meaning of 1]. */
const BIT_WRITES: Readonly<Record<string, readonly [string, string]>> = {
  'STATUS.C': ['efface la retenue C', 'force la retenue C à 1'],
  'STATUS.DC': ['efface la retenue décimale DC', 'force DC à 1'],
  'STATUS.Z': ['efface le bit Z', 'force le bit Z à 1'],
  'STATUS.RP0': ['sélectionne la banque 0 (PORTA, PORTB…)', 'sélectionne la banque 1 (TRISA, TRISB, OPTION_REG)'],
  'INTCON.GIE': ['interdit toutes les interruptions (interrupteur général GIE)', 'autorise les interruptions (interrupteur général GIE) : sans GIE = 1, aucune interruption n’est prise'],
  'INTCON.EEIE': ['interdit l’interruption de fin d’écriture EEPROM', 'autorise l’interruption de fin d’écriture EEPROM'],
  'INTCON.T0IE': ['interdit l’interruption de débordement de TMR0', 'autorise l’interruption de débordement de TMR0 (T0IF)'],
  'INTCON.INTE': ['interdit l’interruption externe RB0/INT', 'autorise l’interruption externe sur la broche RB0/INT (INTF)'],
  'INTCON.RBIE': ['interdit l’interruption sur changement de RB4 à RB7', 'autorise l’interruption sur changement d’état de RB4 à RB7 (RBIF)'],
  'INTCON.T0IF': ['efface le drapeau de débordement de TMR0 : sinon l’interruption recommencerait aussitôt', 'force le drapeau T0IF'],
  'INTCON.INTF': ['efface le drapeau INTF : sinon, dès le RETFIE, l’interruption recommencerait', 'force le drapeau INTF'],
  'INTCON.RBIF': ['efface le drapeau RBIF (après avoir lu PORTB, sinon il revient tout de suite)', 'force le drapeau RBIF'],
  'OPTION_REG.RBPU': ['active les résistances de pull-up internes de PORTB (bit actif à 0)', 'désactive les résistances de pull-up internes de PORTB'],
  'OPTION_REG.INTEDG': ['RB0/INT déclenche l’interruption sur un front descendant (1 → 0)', 'RB0/INT déclenche l’interruption sur un front montant (0 → 1)'],
  'OPTION_REG.T0CS': ['TMR0 compte les cycles d’instruction (mode temporisateur)', 'TMR0 compte les fronts reçus sur RA4/T0CKI (mode compteur)'],
  'OPTION_REG.T0SE': ['en mode compteur, TMR0 avance sur les fronts montants de RA4', 'en mode compteur, TMR0 avance sur les fronts descendants de RA4'],
  'OPTION_REG.PSA': ['le prédiviseur est affecté à TMR0', 'le prédiviseur est affecté au chien de garde (TMR0 compte sans division)'],
  'OPTION_REG.PS0': ['bit 0 du rapport du prédiviseur (PS2:PS0)', 'bit 0 du rapport du prédiviseur (PS2:PS0)'],
  'OPTION_REG.PS1': ['bit 1 du rapport du prédiviseur (PS2:PS0)', 'bit 1 du rapport du prédiviseur (PS2:PS0)'],
  'OPTION_REG.PS2': ['bit 2 du rapport du prédiviseur (PS2:PS0)', 'bit 2 du rapport du prédiviseur (PS2:PS0)'],
};

/** Meaning of a flag value in a test: « Z = 1 : le dernier résultat est nul ». */
export function flagTestMeaning(name: string, value: 0 | 1): string | null {
  switch (name) {
    case 'Z': return value ? 'le dernier résultat est nul' : 'le dernier résultat n’est pas nul';
    case 'C': return value
      ? 'retenue : après une soustraction, il n’y a pas eu d’emprunt (a ≥ b) ; après une addition, le résultat a dépassé 255'
      : 'pas de retenue : après une soustraction, il y a eu un emprunt (a < b)';
    case 'DC': return value ? 'retenue entre les quartets (bit 3 → bit 4)' : 'pas de retenue entre les quartets';
    case 'INTF': return value ? 'un front est arrivé sur RB0/INT' : 'pas de front sur RB0/INT';
    case 'RBIF': return value ? 'une entrée RB4 à RB7 a changé' : 'pas de changement sur RB4–RB7';
    case 'T0IF': return value ? 'TMR0 a débordé (255 → 0)' : 'TMR0 n’a pas débordé';
    default: return null;
  }
}

/** Prescaler ratio of OPTION_REG (PS2:PS0, PSA). */
export function prescalerText(option: number): string {
  const ps = option & 7;
  if (option & 0x08) return `prédiviseur au chien de garde, 1:${1 << ps}`;
  return `prédiviseur à TMR0, 1:${2 << ps}`;
}
