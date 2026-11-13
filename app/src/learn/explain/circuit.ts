// What each part of the schematic does and why it is wired that way (LED + résistance, LOGICSTATE, bouton +
// pull-down 10 k, afficheur 7 segments BCD, LDR en diviseur, feu tricolore), from the netlist around the PIC16F84A.
import {
  buildNetlist, LDR_LEVEL_OHMS, parseResistance, TTL_THRESHOLDS,
  type ComponentInstance, type Net, type Netlist, type Schematic,
} from '@pic/circuit';
import { gpioOfSchematicPin, type PinName } from '@pic/program-model';
import { pinWithNumber } from './cpu';
import { formatHz, formatOhms, formatSeconds, frenchList, frenchNumber } from './text';

const VDD = 5;
/** Forward voltage of the ISIS LED model (VF 2.2 V). */
const LED_VF = 2.2;

const LED_COLOR_FR: Readonly<Record<string, string>> = { RED: 'rouge', GREEN: 'verte', BLUE: 'bleue', YELLOW: 'jaune' };

export interface Member { componentId: string; pin: string }

/** Connectivity queries over one schematic. */
export class Topology {
  readonly netlist: Netlist;
  readonly byId: Map<string, ComponentInstance>;
  readonly pic: ComponentInstance | undefined;
  private readonly nets: Map<string, Net>;

  constructor(readonly schematic: Schematic, netlist?: Netlist) {
    this.netlist = netlist ?? buildNetlist(schematic);
    this.byId = new Map(schematic.components.map((c) => [c.id, c]));
    this.pic = schematic.components.find((c) => c.kind === 'PIC16F84A');
    this.nets = new Map(this.netlist.nets.map((n) => [n.id, n]));
  }

  netOf(componentId: string, pin: string): Net | undefined {
    const id = this.netlist.pinToNet.get(`${componentId}:${pin}`);
    return id ? this.nets.get(id) : undefined;
  }

  netIdOf(componentId: string, pin: string): string | undefined {
    return this.netlist.pinToNet.get(`${componentId}:${pin}`);
  }

  peers(componentId: string, pin: string): Member[] {
    const net = this.netOf(componentId, pin);
    return net ? net.pins.filter((p) => !(p.componentId === componentId && p.pin === pin)) : [];
  }

  rail(componentId: string, pin: string): 'VDD' | 'GND' | undefined {
    return this.netOf(componentId, pin)?.rail;
  }

  kind(id: string) {
    return this.byId.get(id)?.kind;
  }

  /** The other pin of a two-pin part. */
  otherPin(componentId: string, pin: string): string | undefined {
    const kind = this.kind(componentId);
    if (kind === 'LED') return pin === 'A' ? 'K' : 'A';
    if (kind === 'RES' || kind === 'BUTTON' || kind === 'TORCH_LDR' || kind === 'CAP' || kind === 'CRYSTAL') return pin === '1' ? '2' : '1';
    return undefined;
  }

  /** PIC GPIO on the same net as (componentId, pin). */
  picPinOn(componentId: string, pin: string): PinName | undefined {
    if (!this.pic) return undefined;
    const hit = this.peers(componentId, pin).find((p) => p.componentId === this.pic!.id);
    return hit ? gpioOfSchematicPin(hit.pin) : undefined;
  }

  /** PIC net of a GPIO (the net its schematic pin sits on). */
  picNet(gpio: PinName): Net | undefined {
    if (!this.pic) return undefined;
    const name = gpio === 'RB0' ? 'RB0/INT' : gpio === 'RA4' ? 'RA4/T0CKI' : gpio;
    return this.netOf(this.pic.id, name);
  }

  /** PIC GPIO reached from (componentId, pin) directly or through one series resistor (not a pull-up/down). */
  reachPic(componentId: string, pin: string): { pin: PinName; via?: ComponentInstance } | undefined {
    const direct = this.picPinOn(componentId, pin);
    if (direct) return { pin: direct };
    for (const p of this.peers(componentId, pin)) {
      if (this.kind(p.componentId) !== 'RES') continue;
      const other = this.otherPin(p.componentId, p.pin)!;
      const gpio = this.picPinOn(p.componentId, other);
      if (gpio) return { pin: gpio, via: this.byId.get(p.componentId) };
    }
    return undefined;
  }

  /** Rail reached from (componentId, pin) directly or through one resistor. */
  reachRail(componentId: string, pin: string): { rail: 'VDD' | 'GND'; via?: ComponentInstance } | undefined {
    const direct = this.rail(componentId, pin);
    if (direct) return { rail: direct };
    for (const p of this.peers(componentId, pin)) {
      if (this.kind(p.componentId) !== 'RES') continue;
      const rail = this.rail(p.componentId, this.otherPin(p.componentId, p.pin)!);
      if (rail) return { rail, via: this.byId.get(p.componentId) };
    }
    return undefined;
  }

  /** Resistors on a net going to a rail (pull-up / pull-down). */
  railResistors(componentId: string, pin: string): { res: ComponentInstance; rail: 'VDD' | 'GND' }[] {
    const out: { res: ComponentInstance; rail: 'VDD' | 'GND' }[] = [];
    for (const p of this.peers(componentId, pin)) {
      if (this.kind(p.componentId) !== 'RES') continue;
      const rail = this.rail(p.componentId, this.otherPin(p.componentId, p.pin)!);
      if (rail) out.push({ res: this.byId.get(p.componentId)!, rail });
    }
    return out;
  }
}

export function ohmsOf(c: ComponentInstance): number {
  return parseResistance(c.value ?? (c.props.value as string | number | undefined)) ?? 10_000;
}

/** A component reference chosen by the student (EGALITE, VALIDER), not an automatic one (D1, R2). */
export function isCustomRef(ref: string | undefined): boolean {
  const r = ref?.trim();
  return !!r && !/^(D|R|U|LS|BTN|SEG|TL|LDR|C|X|PWR|GND)\d+$/i.test(r);
}

/** Name of a part for sentences: « LED rouge X_INFERIEUR », « interrupteur LOGICSTATE », « R1 (220 Ω) ». */
export function partName(c: ComponentInstance): string {
  const ref = c.ref?.trim();
  switch (c.kind) {
    case 'LED': {
      const color = LED_COLOR_FR[String(c.props.color ?? '').toUpperCase()];
      return `LED${color ? ` ${color}` : ''}${ref ? ` ${ref}` : ''}`;
    }
    case 'LOGICSTATE': return `interrupteur LOGICSTATE${ref ? ` ${ref}` : ''}`;
    case 'BUTTON': return `bouton${ref ? ` ${ref}` : ''}`;
    case 'RES': return `${ref || 'résistance'} (${formatOhms(ohmsOf(c))})`;
    case '7SEG-BCD': return `afficheur 7 segments BCD${ref ? ` ${ref}` : ''}`;
    case '7SEG-CC': return `afficheur 7 segments${ref ? ` ${ref}` : ''}`;
    case 'TRAFFIC_LIGHTS': return `feu tricolore${ref ? ` ${ref}` : ''}`;
    case 'TORCH_LDR': return `photorésistance${ref ? ` ${ref}` : ''} (LDR)`;
    case 'PIC16F84A': return `PIC16F84A${ref ? ` ${ref}` : ''}`;
    case 'POWER': return 'alimentation +5 V';
    case 'GROUND': return 'masse';
    case 'CAP': return `condensateur${ref ? ` ${ref}` : ''}`;
    case 'CRYSTAL': return `quartz${ref ? ` ${ref}` : ''}`;
  }
}

/** Short title for a part card: « LED X_INFERIEUR », « LOGICSTATE sur RA0 ». */
export function partTitle(c: ComponentInstance, topo?: Topology): string {
  const ref = c.ref?.trim();
  if (c.kind === 'LOGICSTATE' && !ref && topo) {
    const pin = topo.picPinOn(c.id, 'Q0');
    return pin ? `LOGICSTATE sur ${pin}` : 'LOGICSTATE';
  }
  if (c.kind === '7SEG-BCD' && !ref) return 'Afficheur 7 segments BCD';
  if (c.kind === 'TRAFFIC_LIGHTS' && !ref) return 'Feu tricolore';
  const name = partName(c);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// ---------------------------------------------------------------------------------------------------------------
// LEDs

export interface LedWiring {
  /** PIC pin that drives the LED. */
  pin?: PinName;
  /** Pin level that lights the LED (1: anode on the pin, cathode to ground). */
  activeLevel?: 0 | 1;
  /** Series resistor, when there is one. */
  series?: ComponentInstance;
  /** Approximate LED current when lit (A). */
  current?: number;
  /** Why the LED cannot light, in French. */
  problem?: string;
}

export function ledWiring(topo: Topology, id: string): LedWiring {
  const anodePic = topo.reachPic(id, 'A');
  const cathodePic = topo.reachPic(id, 'K');
  const anodeRail = topo.reachRail(id, 'A');
  const cathodeRail = topo.reachRail(id, 'K');
  const currentThrough = (series?: ComponentInstance) => (series ? (VDD - LED_VF) / ohmsOf(series) : undefined);
  if (anodePic && cathodeRail?.rail === 'GND') {
    const series = anodePic.via ?? cathodeRail.via;
    const w: LedWiring = { pin: anodePic.pin, activeLevel: 1, series, current: currentThrough(series) };
    if (anodePic.pin === 'RA4') w.problem = 'RA4 est à drain ouvert : il peut tirer la broche à 0 mais jamais fournir 5 V. Une LED reliée de RA4 vers la masse ne peut pas s’allumer (il faudrait la brancher entre +5 V et RA4).';
    return w;
  }
  if (cathodePic && anodeRail?.rail === 'VDD') {
    const series = cathodePic.via ?? anodeRail.via;
    return { pin: cathodePic.pin, activeLevel: 0, series, current: currentThrough(series) };
  }
  if (anodePic && !cathodeRail) return { pin: anodePic.pin, activeLevel: 1, problem: 'la cathode (K) n’est reliée ni à la masse ni au PIC : aucun courant ne peut traverser la LED.' };
  if (!anodePic && !cathodePic) return { problem: 'la LED n’est reliée à aucune broche du PIC.' };
  return { pin: anodePic?.pin ?? cathodePic?.pin, problem: 'le câblage de cette LED ne permet pas au PIC de la commander (vérifiez l’anode et la cathode).' };
}

// ---------------------------------------------------------------------------------------------------------------
// Inputs

export interface InputWiring {
  pin?: PinName;
  kind: 'logicstate' | 'button' | 'ldr';
  /** Level read when the button is pressed / with light. */
  activeLevel?: 0 | 1;
  pull?: { res: ComponentInstance; rail: 'VDD' | 'GND' };
  problem?: string;
}

/** What the program does that changes how the circuit behaves. */
export interface WiringOptions {
  /**
   * PORTB's weak pull-ups are on: the program clears OPTION_REG.RBPU (bit 7). They are OFF after reset
   * (OPTION_REG = 0xFF), so a button to the ground on RB0–RB7 needs either this or a resistor to +5 V.
   */
  rbPullups?: boolean;
}

export function buttonWiring(topo: Topology, id: string, opts: WiringOptions = {}): InputWiring {
  for (const side of ['1', '2']) {
    const pin = topo.picPinOn(id, side);
    if (!pin) continue;
    const other = side === '1' ? '2' : '1';
    const otherRail = topo.rail(id, other);
    const pulls = topo.railResistors(id, side);
    const pull = pulls[0];
    if (otherRail === 'VDD') {
      return { pin, kind: 'button', activeLevel: 1, pull, problem: pull?.rail === 'GND' ? undefined : 'pas de résistance de rappel vers la masse (pull-down) : bouton relâché, l’entrée est « en l’air » (flottante).' };
    }
    if (otherRail === 'GND') {
      const internal = pin.startsWith('RB') && !pull && opts.rbPullups === true;
      if (pull?.rail === 'VDD' || internal) return { pin, kind: 'button', activeLevel: 0, pull };
      return {
        pin, kind: 'button', activeLevel: 0, pull,
        problem: pin.startsWith('RB')
          ? `pas de résistance de rappel vers +5 V (pull-up), et les pull-up internes de PORTB sont coupées au démarrage (bit /RBPU de OPTION_REG à 1) : bouton relâché, l’entrée est « en l’air » (flottante). Ajoutez une résistance de 10 kΩ entre ${pin} et +5 V, ou activez les pull-up internes avec « OPTION_REG.RBPU = 0; » dans la configuration.`
          : 'pas de résistance de rappel vers +5 V (pull-up) : bouton relâché, l’entrée est « en l’air » (flottante).',
      };
    }
    return { pin, kind: 'button', problem: 'l’autre patte du bouton n’est reliée ni au +5 V ni à la masse.' };
  }
  return { kind: 'button', problem: 'le bouton n’est relié à aucune broche du PIC.' };
}

/** Voltage of the LDR divider (POWER → LDR → node → R → GND) for each torch level, and what the PIC reads. */
export function ldrLevels(fixedOhms: number, ldrOnTop: boolean): { level: number; ohms: number; volts: number; reads: '0' | '1' | 'garde' }[] {
  return LDR_LEVEL_OHMS.map((ohms, level) => {
    const volts = ldrOnTop ? (VDD * fixedOhms) / (ohms + fixedOhms) : (VDD * ohms) / (ohms + fixedOhms);
    const reads = volts <= TTL_THRESHOLDS.vil ? '0' : volts >= TTL_THRESHOLDS.vih ? '1' : 'garde';
    return { level, ohms, volts, reads };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Part descriptions (« Ce TP »)

export interface PartRole {
  id: string;
  kind: ComponentInstance['kind'];
  title: string;
  /** What it does and why it is wired that way, one paragraph per entry. */
  text: string[];
  /** PIC pins it uses. */
  pins: PinName[];
  warnings: string[];
}

function ledRole(topo: Topology, c: ComponentInstance): PartRole {
  const w = ledWiring(topo, c.id);
  const text: string[] = [];
  const warnings: string[] = [];
  if (w.pin && w.activeLevel === 1) {
    text.push(`Son anode (+) est reliée à ${pinWithNumber(w.pin)}${w.series ? ` à travers ${partName(w.series)}` : ''}, sa cathode (−) à la masse. Quand le programme met ${w.pin} à 1 (5 V), le courant traverse la LED : elle s’allume. À 0, elle s’éteint.`);
    text.push(`${w.pin} doit donc être une sortie : bit ${w.pin.slice(2)} de TRIS${w.pin[1]} à 0.`);
  } else if (w.pin && w.activeLevel === 0) {
    text.push(`Son anode est reliée au +5 V et sa cathode à ${pinWithNumber(w.pin)}${w.series ? ` à travers ${partName(w.series)}` : ''} : elle s’allume quand le programme met ${w.pin} à 0 (logique inversée).`);
  }
  if (w.series && w.current !== undefined) {
    text.push(`La résistance limite le courant à environ (5 − 2,2) / ${frenchNumber(ohmsOf(w.series), 0)} ≈ ${frenchNumber(w.current * 1000, 1)} mA.`);
  } else if (w.pin && !w.problem) {
    text.push('Pas de résistance : ISIS l’accepte (comme dans les montages du cours), mais sur une vraie carte il en faudrait une (220 Ω à 330 Ω) pour limiter le courant.');
  }
  if (w.problem) warnings.push(w.problem.charAt(0).toUpperCase() + w.problem.slice(1));
  return { id: c.id, kind: c.kind, title: partTitle(c, topo), text, pins: w.pin ? [w.pin] : [], warnings };
}

function logicstateRole(topo: Topology, c: ComponentInstance): PartRole {
  const pin = topo.picPinOn(c.id, 'Q0');
  const state = Number(c.props.state ?? 0) ? 1 : 0;
  const text = [
    'Source logique « à verrou » : un clic la fait passer de 0 (bleu) à 1 (rouge) et elle reste dans cette position. Dans les TP, elle remplace un interrupteur.',
  ];
  if (pin) {
    // In MikroC RA0 alone is the bit number (0), not the pin: the read goes through PORTA / PORTB (or a #define).
    text.push(`Elle impose ${pin} = ${state} en ce moment. ${pin} doit être une entrée : bit ${pin.slice(2)} de TRIS${pin[1]} à 1. Le programme la lit à travers le port, avec un test comme « if (PORT${pin[1]}.${pin} == 1) », ou avec un nom donné par #define (« #define INTER PORT${pin[1]}.${pin} » puis « if (INTER == 1) »). ${pin} tout seul n’est que le numéro du bit (${pin.slice(2)}) : il ne lit pas la broche.`);
  }
  return { id: c.id, kind: c.kind, title: partTitle(c, topo), text, pins: pin ? [pin] : [], warnings: pin ? [] : ['Elle n’est reliée à aucune broche du PIC.'] };
}

function buttonRole(topo: Topology, c: ComponentInstance, opts: WiringOptions): PartRole {
  const w = buttonWiring(topo, c.id, opts);
  const text: string[] = ['Bouton poussoir : il ne conduit que pendant l’appui, puis revient tout seul.'];
  if (w.pin && w.activeLevel === 1) {
    text.push(`Une patte va au +5 V, l’autre à ${pinWithNumber(w.pin)}.${w.pull ? ` ${partName(w.pull.res)} relie ${w.pin} à la masse : c’est une résistance de rappel (pull-down).` : ''}`);
    if (w.pull) text.push(`Relâché : la résistance tire ${w.pin} à 0. Appuyé : ${w.pin} est relié au +5 V et vaut 1. Sans cette résistance, l’entrée serait « en l’air » (flottante) et pourrait lire n’importe quoi.`);
  } else if (w.pin && w.activeLevel === 0) {
    if (w.pull?.rail === 'VDD' || !w.problem) {
      text.push(`Une patte va à la masse, l’autre à ${pinWithNumber(w.pin)}. ${w.pull ? `${partName(w.pull.res)} tire ${w.pin} vers +5 V (pull-up)` : 'Les pull-up internes de PORTB, activées par le programme (OPTION_REG.RBPU = 0), tiennent l’entrée à 1'} : relâché ${w.pin} = 1, appuyé ${w.pin} = 0 (logique inversée).`);
    } else {
      text.push(`Une patte va à la masse, l’autre à ${pinWithNumber(w.pin)} : appuyé, ${w.pin} = 0. Relâché, rien ne tire ${w.pin} vers +5 V (voir l’avertissement).`);
    }
  }
  // Wait while the button is still at its « pressed » level (1 with a pull-down, 0 with a pull-up).
  if (w.pin) text.push(`Comme l’appui dure longtemps pour le PIC (des milliers de cycles), le programme doit attendre le relâchement (« while (BOUTON == ${w.activeLevel ?? 1}); ») pour ne compter qu’un appui.`);
  return { id: c.id, kind: c.kind, title: partTitle(c, topo), text, pins: w.pin ? [w.pin] : [], warnings: w.problem ? [w.problem.charAt(0).toUpperCase() + w.problem.slice(1)] : [] };
}

function bcdRole(topo: Topology, c: ComponentInstance): PartRole {
  const pins = (['E3', 'E2', 'E1', 'E0'] as const).map((e) => ({ e, pin: topo.picPinOn(c.id, e) }));
  const wired = pins.filter((p) => p.pin);
  const text = [
    'Afficheur 7 segments avec décodeur BCD intégré : il reçoit un nombre sur 4 bits (E3 à gauche = poids fort, E0 à droite = poids faible) et allume lui-même les bons segments. 0 à 9 donnent les chiffres, 10 à 15 les lettres A, b, C, d, E, F.',
  ];
  if (wired.length) text.push(`Câblage : ${wired.map((p) => `${p.e} ← ${p.pin}`).join(', ')}.`);
  const lsb = pins[3].pin;
  if (lsb === 'RB0' && pins[0].pin === 'RB3') {
    text.push('Avec E0..E3 sur RB0..RB3, écrire PORTB = 0x0A affiche « A ». Attention : écrire tout PORTB change aussi RB4 à RB7.');
  }
  const warnings = wired.length === 4 ? [] : ['Toutes les entrées E0..E3 ne sont pas reliées au PIC : les bits non reliés restent indéfinis.'];
  return { id: c.id, kind: c.kind, title: partTitle(c, topo), text, pins: wired.map((p) => p.pin!), warnings };
}

function trafficRole(topo: Topology, c: ComponentInstance): PartRole {
  const lamps = ([['R', 'rouge'], ['A', 'orange'], ['G', 'vert']] as const).map(([p, fr]) => ({ fr, pin: topo.picPinOn(c.id, p) }));
  const wired = lamps.filter((l) => l.pin);
  const text = [
    'Feu tricolore : trois lampes qui s’allument quand leur entrée est à 1 (comme trois LEDs).',
  ];
  if (wired.length) text.push(`Câblage : ${wired.map((l) => `feu ${l.fr} ← ${l.pin}`).join(', ')}. Ces broches sont des sorties.`);
  return { id: c.id, kind: c.kind, title: partTitle(c, topo), text, pins: wired.map((l) => l.pin!), warnings: wired.length === 3 ? [] : ['Une lampe n’est pas reliée au PIC.'] };
}

function ldrRole(topo: Topology, c: ComponentInstance): PartRole {
  let node: string | undefined;
  let pin: PinName | undefined;
  for (const side of ['1', '2']) {
    const p = topo.picPinOn(c.id, side);
    if (p) { pin = p; node = side; }
  }
  const text = ['Photorésistance (LDR) : sa résistance baisse quand la lumière augmente (1 MΩ dans le noir, 500 Ω en pleine lumière).'];
  const warnings: string[] = [];
  if (pin && node) {
    const other = node === '1' ? '2' : '1';
    const ldrOnTop = topo.rail(c.id, other) === 'VDD';
    const fixed = topo.railResistors(c.id, node).find((r) => r.rail === (ldrOnTop ? 'GND' : 'VDD'));
    if (fixed) {
      const r = ohmsOf(fixed.res);
      text.push(`Montage en pont diviseur : ${ldrOnTop ? `+5 V → LDR → ${pin} → ${partName(fixed.res)} → masse` : `+5 V → ${partName(fixed.res)} → ${pin} → LDR → masse`}. La tension sur ${pin} vaut ${ldrOnTop ? `5 × R / (R_LDR + R)` : '5 × R_LDR / (R_LDR + R)'}.`);
      const levels = ldrLevels(r, ldrOnTop);
      const ones = levels.filter((l) => l.reads === '1').map((l) => l.level);
      const zeros = levels.filter((l) => l.reads === '0').map((l) => l.level);
      text.push(`Le PIC lit 1 au-dessus de 2 V et 0 au-dessous de 0,8 V ; entre les deux il garde l’état précédent. Ici : niveaux de lumière ${frenchList(ones.map(String))} → 1 ; ${frenchList(zeros.map(String))} → 0.`);
      const level = Math.max(0, Math.min(9, Math.round(Number(c.props.level ?? 0))));
      const now = levels[level];
      text.push(`Niveau actuel ${level} : R_LDR = ${formatOhms(now.ohms)}, V(${pin}) ≈ ${frenchNumber(now.volts, 2)} V → ${now.reads === 'garde' ? 'zone indécise (état précédent conservé)' : `lu ${now.reads}`}.`);
    } else {
      warnings.push(`Il manque la résistance fixe du pont diviseur entre ${pin} et ${ldrOnTop ? 'la masse' : 'le +5 V'}.`);
    }
  } else {
    warnings.push('La LDR n’est reliée à aucune broche du PIC.');
  }
  return { id: c.id, kind: c.kind, title: partTitle(c, topo), text, pins: pin ? [pin] : [], warnings };
}

function picRole(topo: Topology, c: ComponentInstance, clockHz: number): PartRole {
  const text = [`Le microcontrôleur. Horloge ${formatHz(clockHz)} (propriété CLOCK) : 1 cycle d’instruction = 4 périodes d’horloge = ${formatSeconds(4 / clockHz)}.`];
  // Which of the clock / reset pins are really wired (the Ch1 crystal block, MCLR to +5 V).
  const wired = (pin: string) => topo.peers(c.id, pin).some((p) => p.componentId !== c.id) || !!topo.rail(c.id, pin);
  const crystal = ['OSC1/CLKIN', 'OSC2/CLKOUT'].some((p) => topo.peers(c.id, p).some((m) => topo.kind(m.componentId) === 'CRYSTAL'));
  const free = [['OSC1/CLKIN', 'OSC1'], ['OSC2/CLKOUT', 'OSC2'], ['MCLR', 'MCLR']].filter(([p]) => !wired(p)).map(([, n]) => n);
  if (crystal) text.push('Le quartz et ses deux condensateurs (22 pF vers la masse) sur OSC1 / OSC2 forment l’oscillateur d’une vraie carte. Dans la simulation, c’est la propriété CLOCK du PIC qui fixe la vitesse.');
  if (wired('MCLR')) text.push(topo.rail(c.id, 'MCLR') === 'VDD' ? 'MCLR est relié au +5 V : le PIC n’est pas maintenu en reset (MCLR est actif à 0).' : 'MCLR (reset, actif à 0) est câblé : le PIC redémarre quand cette broche passe à 0.');
  if (free.length === 3) text.push('OSC1, OSC2 et MCLR ne sont pas câblés : dans ISIS la simulation n’en a pas besoin (VDD et VSS sont reliés automatiquement). Sur une vraie carte il faudrait le quartz, ses condensateurs et le reset.');
  else if (free.length) text.push(`${frenchList(free)} ${free.length > 1 ? 'ne sont pas câblées' : 'n’est pas câblée'} : la simulation n’en a pas besoin (VDD et VSS sont reliés automatiquement).`);
  return { id: c.id, kind: c.kind, title: partTitle(c), text, pins: [], warnings: [] };
}

function resistorRole(topo: Topology, c: ComponentInstance): PartRole | null {
  const near = (pin: string) => topo.peers(c.id, pin).map((p) => topo.kind(p.componentId));
  const sides = [near('1'), near('2')];
  // Series resistor of a LED, pull resistor of a button, divider resistor of an LDR: described with that part.
  if (sides.some((s) => s.includes('LED') || s.includes('BUTTON') || s.includes('TORCH_LDR'))) return null;
  const pin = topo.picPinOn(c.id, '1') ?? topo.picPinOn(c.id, '2');
  const text = [`Résistance de ${formatOhms(ohmsOf(c))}.`];
  if (pin) {
    const rail = topo.rail(c.id, '1') ?? topo.rail(c.id, '2');
    if (rail) text.push(`Elle relie ${pin} ${rail === 'GND' ? 'à la masse (pull-down) : sans autre signal, l’entrée lit 0' : 'au +5 V (pull-up) : sans autre signal, l’entrée lit 1'}.`);
  }
  return { id: c.id, kind: c.kind, title: partTitle(c, topo), text, pins: pin ? [pin] : [], warnings: [] };
}

/** One card per meaningful part (terminals and resistors described with their LED / button / LDR are skipped). */
export function describeParts(topo: Topology, clockHz: number, opts: WiringOptions = {}): PartRole[] {
  const out: PartRole[] = [];
  for (const c of topo.schematic.components) {
    switch (c.kind) {
      case 'PIC16F84A': out.push(picRole(topo, c, clockHz)); break;
      case 'LED': out.push(ledRole(topo, c)); break;
      case 'LOGICSTATE': out.push(logicstateRole(topo, c)); break;
      case 'BUTTON': out.push(buttonRole(topo, c, opts)); break;
      case '7SEG-BCD': out.push(bcdRole(topo, c)); break;
      case 'TRAFFIC_LIGHTS': out.push(trafficRole(topo, c)); break;
      case 'TORCH_LDR': out.push(ldrRole(topo, c)); break;
      case 'RES': { const r = resistorRole(topo, c); if (r) out.push(r); break; }
      case '7SEG-CC':
        out.push({ id: c.id, kind: c.kind, title: partTitle(c, topo), text: ['Afficheur 7 segments sans décodeur : chaque segment a..g a sa propre entrée, active à 1 (cathode commune). Le programme doit envoyer le code de chaque segment (ex. « H » = 0x76 avec a sur RB0 … g sur RB6).'], pins: [], warnings: [] });
        break;
      case 'CRYSTAL': case 'CAP':
        out.push({ id: c.id, kind: c.kind, title: partTitle(c, topo), text: ['Élément du circuit d’horloge d’une vraie carte. Dans la simulation, c’est la propriété CLOCK du PIC qui fixe la vitesse.'], pins: [], warnings: [] });
        break;
      default: break;
    }
  }
  return out;
}

/** What drives an input pin from outside, for the change list (« l’interrupteur LOGICSTATE sur RA0 »). */
export function inputSourceOf(topo: Topology, pin: PinName): string | undefined {
  const net = topo.picNet(pin);
  if (!net) return undefined;
  for (const m of net.pins) {
    const c = topo.byId.get(m.componentId);
    if (!c || c.id === topo.pic?.id) continue;
    if (c.kind === 'LOGICSTATE') return `l’${partName(c)}`;
    if (c.kind === 'BUTTON') return `le ${partName(c)}`;
    if (c.kind === 'TORCH_LDR') return `la lumière sur la ${partName(c)}`;
    if (c.kind === 'RES') {
      const other = topo.otherPin(c.id, m.pin)!;
      // A pull resistor's far side is a rail: everything on GND / VDD is not wired to this pin.
      if (topo.rail(c.id, other)) continue;
      const far = topo.peers(c.id, other).map((p) => topo.byId.get(p.componentId)).find((x) => x && (x.kind === 'BUTTON' || x.kind === 'TORCH_LDR'));
      if (far) return far.kind === 'BUTTON' ? `le ${partName(far)}` : `la lumière sur la ${partName(far)}`;
    }
  }
  return undefined;
}

/** Parts driven by an output pin (« LED rouge X_INFERIEUR »), for the change list and the instruction details. */
export function partsOnPin(topo: Topology, pin: PinName): ComponentInstance[] {
  const net = topo.picNet(pin);
  if (!net) return [];
  const out: ComponentInstance[] = [];
  for (const m of net.pins) {
    const c = topo.byId.get(m.componentId);
    if (!c || c.id === topo.pic?.id) continue;
    if (c.kind === 'RES') {
      const other = topo.otherPin(c.id, m.pin)!;
      // Only a series resistor leads to the part it feeds; a pull-up / pull-down ends on a rail, whose net holds
      // every LED cathode, every button... none of them wired to this pin.
      if (topo.rail(c.id, other)) continue;
      for (const p of topo.peers(c.id, other)) {
        const far = topo.byId.get(p.componentId);
        if (far && far.kind !== 'RES' && far.kind !== 'GROUND' && far.kind !== 'POWER' && far.id !== topo.pic?.id) out.push(far);
      }
    } else if (c.kind !== 'GROUND' && c.kind !== 'POWER') {
      out.push(c);
    }
  }
  return [...new Set(out)];
}
