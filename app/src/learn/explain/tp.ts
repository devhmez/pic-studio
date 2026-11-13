// « Ce TP »: what the énoncé asks, the parts and pins, how the program works step by step, and the classic
// mistakes. Course TPs have hand-written content (from research/00_SYNTHESIS.md §2 and the chapter reports); any
// other project gets the parts of this guide that can be derived from its circuit and program model.
import type { Schematic } from '@pic/circuit';
import {
  describeActions, describeCond, describeConfiguration, describeExpr, describeRepeat, describeWait, formatDuration,
  isSimpleStmt, signalById, type Cond, type PinName, type Program, type Stmt,
} from '@pic/program-model';
import { PIN_NUMBER } from '@pic/emulator';
import { describeParts, Topology, partName, partsOnPin, inputSourceOf, type PartRole, type WiringOptions } from './circuit';
import { groupThousands } from './text';

export interface TpTest {
  /** Inputs, e.g. « x = 5, y = 6 » or « L1 = 0, L0 = 1 ». */
  inputs: string;
  expected: string;
}

/** Hand-written content of a course TP. */
export interface TpContent {
  id: string;
  /** Chapter number in this year's course (1–6). */
  chapter: number;
  title: string;
  /** What the énoncé asks, one item per requirement. */
  goal: string[];
  /** What to hand in. */
  deliverables?: string;
  /** Expected behaviour table (truth table, test values). */
  tests?: { caption: string; rows: TpTest[] };
  /** Choices made by the template where the énoncé is ambiguous, and useful remarks. */
  notes?: string[];
  /** Classic mistakes for this TP. */
  mistakes: string[];
}

export const TP_CONTENT: readonly TpContent[] = [
  {
    id: 'tp0-exemple1', chapter: 1, title: 'TP 0 — Exemple 1 : allumer une LED',
    goal: [
      'Allumer la LED bleue branchée sur RA0 : c’est le tout premier programme.',
      'Deux étapes seulement : configurer RA0 en sortie (TRISA.RA0 = 0), puis y écrire 1 (PORTA.RA0 = 1).',
    ],
    notes: [
      'Le programme n’a pas de boucle while(1) : après avoir allumé la LED, main() se termine. MikroC fait alors tourner le PIC sur place (GOTO $) et la LED reste allumée.',
      'Pas de résistance dans le montage du cours : ISIS l’accepte. Sur une vraie carte, il en faudrait une (220 Ω à 330 Ω).',
    ],
    mistakes: [
      'Oublier TRISA.RA0 = 0 : après un reset toutes les broches sont des entrées (TRISA = 0x1F), la LED ne s’allume pas.',
      'Inverser la règle TRIS : 0 = sortie (Output), 1 = entrée (Input).',
      'Confondre TRIS et PORT : TRIS choisit la direction de la broche, PORT sa valeur.',
    ],
  },
  {
    id: 'tp0-exemple2', chapter: 1, title: 'TP 0 — Exemple 2 : commander une LED par un interrupteur',
    goal: [
      'La LED verte (RA0) recopie l’interrupteur branché sur RB0 : interrupteur à 1 → LED allumée, à 0 → LED éteinte.',
      'RB0 est une entrée (TRISB.RB0 = 1), RA0 une sortie.',
    ],
    tests: { caption: 'Comportement attendu', rows: [{ inputs: 'RB0 = 1', expected: 'LED allumée' }, { inputs: 'RB0 = 0', expected: 'LED éteinte' }] },
    notes: [
      'Le « bouton » de cet exemple est un LOGICSTATE : il reste dans sa position, il n’y a pas de relâchement à attendre.',
      'La boucle while(1) relit RB0 sans arrêt : la LED réagit tout de suite quand on bascule l’interrupteur.',
    ],
    mistakes: [
      'Oublier le else : sans LED = 0, la LED resterait allumée pour toujours après le premier 1.',
      'Mettre RB0 en sortie (TRISB.RB0 = 0) : on ne peut plus lire l’interrupteur.',
      'Écrire if (BOUTON = 1) avec un seul = : c’est une écriture, pas une comparaison. Il faut ==.',
    ],
  },
  {
    id: 'tp1-demux', chapter: 2, title: 'Atelier — Démultiplexeur 1 vers 4',
    goal: [
      'Réaliser un démultiplexeur 1 vers 4 : deux interrupteurs L1 et L0 (LOGICSTATE sur RA1 et RA0) choisissent laquelle des 4 LEDs D0 à D3 (RB0 à RB3) est allumée. Une seule sortie est active à la fois.',
      '1.1 Montage ISIS : deux LOGICSTATE en entrée, 4 LEDs de couleurs différentes en sortie.',
      '1.2 Proposer un organigramme.',
      '1.3 Écrire le programme C avec MikroC PRO for PIC.',
      '1.4 Utiliser obligatoirement des #define pour les entrées et les sorties.',
    ],
    deliverables: 'Organigramme + code, avec les captures MikroC et ISIS.',
    tests: {
      caption: 'Table de vérité (Tableau 1.1 de l’énoncé)',
      rows: [
        { inputs: 'L1 = 0, L0 = 0', expected: 'D0 allumée' },
        { inputs: 'L1 = 0, L0 = 1', expected: 'D1 allumée' },
        { inputs: 'L1 = 1, L0 = 0', expected: 'D2 allumée' },
        { inputs: 'L1 = 1, L0 = 1', expected: 'D3 allumée' },
      ],
    },
    notes: [
      'La figure de l’énoncé n’a pas de résistances ; le fichier ISIS du cours ajoute 220 Ω en série avec chaque LED. Les deux fonctionnent en simulation.',
      'Dans le fichier ISIS du cours, les LEDs s’appellent D1 à D4 alors que le code les appelle D0 à D3 : D1 du schéma = D0 du code.',
    ],
    mistakes: [
      'L’ordre L1 / L0 : L1 est le bit de poids fort. (L1, L0) = (0, 1) allume D1 et (1, 0) allume D2. La correction demux.c du cours inverse D1 et D2 : suivez la table de vérité de l’énoncé.',
      'Oublier d’éteindre les autres LEDs dans chaque branche : chaque branche écrit les 4 sorties (D0=1; D1=0; D2=0; D3=0;).',
      'Écrire des if séparés au lieu de if / else if / else : le dernier « else » s’exécuterait aussi et allumerait D3.',
      'Oublier de mettre RA0 et RA1 en entrée (bits TRISA à 1).',
    ],
  },
  {
    id: 'tp-status', chapter: 3, title: 'TP — Manipulation du registre STATUS',
    goal: [
      'Comparer deux valeurs x et y avec le PIC16F84 grâce au registre STATUS : calculer z = x − y, puis tester les drapeaux Z (zéro) et C (retenue).',
      'x > y → LED SUPÉRIEUR (RB0) ; x = y → LED ÉGAL (RB1) ; x < y → LED INFÉRIEUR (RB2).',
      'Déclarer unsigned char x, y, z ; utiliser des #define (LED_SUP, LED_EGAL, LED_INF) et les macros LED_ON(pin) / LED_OFF(pin).',
    ],
    tests: {
      caption: 'Tests de l’énoncé (diapositive 7)',
      rows: [
        { inputs: 'x = 5, y = 6', expected: 'LED_INF' },
        { inputs: 'x = 6, y = 5', expected: 'LED_SUP' },
        { inputs: 'x = 5, y = 5', expected: 'LED_EGAL' },
        { inputs: 'x = 10, y = 3', expected: 'LED_SUP' },
        { inputs: 'x = 3, y = 10', expected: 'LED_INF' },
      ],
    },
    notes: [
      'Pour essayer un autre test, changez les valeurs de x et y dans l’initialisation, puis relancez la simulation.',
      'Après z = x − y : Z = 1 si x = y ; C = 1 s’il n’y a pas d’emprunt (x ≥ y), C = 0 s’il y a un emprunt (x < y).',
    ],
    mistakes: [
      'Deux if séparés au lieu de « else if » : quand x = y, Z = 1 ET C = 1 (pas d’emprunt), donc deux LEDs s’allument. C’est le bug de la correction status.c. Testez Z d’abord, puis C dans un else if.',
      'Croire que C = 1 veut dire « emprunt » (comme l’écrit le support p. 7). Sur le PIC, après une soustraction, C = 1 veut dire PAS d’emprunt (x ≥ y) et C = 0 veut dire emprunt (x < y).',
      'Tester C avant Z : quand x = y, C vaut aussi 1 et on allumerait SUPÉRIEUR.',
      'Faire un autre calcul entre z = x − y et les tests : les drapeaux seraient remplacés par ceux du nouveau calcul.',
      'Oublier d’éteindre les trois LEDs au début de chaque tour.',
      'STATUS = 0 met Z à 1 (CLRF STATUS). Ce n’est pas gênant ici, car z = x − y recalcule les drapeaux juste avant les tests.',
    ],
  },
  {
    id: 'tp-vote', chapter: 3, title: 'TP — Boîtier électronique de vote (A / B)',
    goal: [
      'Boutons « Vote A » (RA0), « Vote B » (RA1) et « Résultat » (RA3) ; LED de confirmation (RA2) ; afficheur 7 segments BCD sur RB0 à RB3 ; LED verte (RB5) pour l’égalité.',
      'Au démarrage : afficher « F » pendant 0,5 s.',
      'À chaque vote : compter (var1++ ou var2++) puis faire clignoter la LED RA2 (0,5 s allumée / 0,5 s éteinte), pour éviter les doubles appuis.',
      'Appui sur « Résultat » : égalité → « E » et la LED verte RB5 clignote 3 fois ; var1 > var2 → « A » ; var1 < var2 → « b ». Puis un nouveau cycle de vote commence.',
    ],
    deliverables: 'Organigramme + code C, câblage ISIS et test.',
    tests: {
      caption: 'Lettres sur l’afficheur BCD',
      rows: [
        { inputs: 'Démarrage', expected: '« F » (0x0F)' },
        { inputs: 'var1 = var2', expected: '« E » (0x0E) + RB5 clignote 3 fois' },
        { inputs: 'var1 > var2', expected: '« A » (0x0A)' },
        { inputs: 'var1 < var2', expected: '« b » (0x0B)' },
      ],
    },
    notes: [
      'L’énoncé ne dit pas ce qui reste affiché après le résultat : ce modèle garde la dernière lettre et remet les compteurs à zéro.',
      'Le dépouillement utilise la même technique que le TP STATUS : z = var1 − var2, puis Z, puis C.',
    ],
    mistakes: [
      'Ne pas attendre le relâchement du bouton (while (VOTE_A == 1);) : un appui un peu long compterait plusieurs votes.',
      'PORTB = 0x0E pour afficher « E » met aussi RB5 (LED verte) à 0 : allumez RB5 avec son bit après avoir écrit l’afficheur.',
      'Tester C avant Z, ou écrire deux if séparés : même piège que le TP STATUS.',
      'Un afficheur BCD ne peut pas s’éteindre : il montre toujours un chiffre ou une lettre (0x0B s’affiche « b »).',
      'Oublier la résistance de rappel (pull-down 10 kΩ) d’un bouton poussoir : l’entrée serait « en l’air ».',
    ],
  },
  {
    id: 'tp-traffic', chapter: 4, title: 'TP — Feu tricolore',
    goal: [
      'Feu tricolore (TRAFFIC LIGHTS : rouge sur RA0, orange sur RA1, vert sur RA2), capteur de luminosité sur RA3, afficheur 7 segments BCD sur RB0 à RB3.',
      'Mode nuit (capteur = 0) : l’orange clignote toutes les 0,5 s et l’afficheur montre « A ».',
      'Mode jour (capteur = 1) : rouge 10 s avec un décompte de 9 à 0, orange avec un décompte de 2 à 0, vert 10 s avec un décompte de 9 à 0 (un chiffre par seconde).',
      'Les attentes se font avec une fonction delay_ms() (ici Delay_ms de MikroC).',
    ],
    deliverables: 'Organigramme + code complet.',
    notes: [
      'Horloge 8 MHz dans le fichier ISIS du cours : 1 cycle d’instruction = 0,5 µs. Delay_ms est calculé pour cette horloge.',
      'Le capteur n’est lu qu’au début de chaque cycle : le mode nuit attend la fin du cycle de jour en cours.',
      'Orange : 2, 1, 0 pendant 1 s chacun, soit 3 s (l’énoncé dit « 2 secondes »).',
      'R1 vaut 1 kΩ dans le fichier ISIS (l’image de l’énoncé semble indiquer 4 kΩ). Avec 1 kΩ, il faut une lumière forte (niveau 8 ou 9 de la lampe) pour lire 1.',
    ],
    mistakes: [
      'Inverser jour et nuit : la LDR éclairée a une faible résistance, donc une tension haute sur RA3 → 1 = jour.',
      'Envoyer le code des segments au lieu du nombre : avec un 7SEG-BCD on écrit directement le chiffre (AFFICHEUR = 9).',
      'Mettre une variable dans Delay_ms : MikroC exige une constante.',
      'Changer l’horloge sans recompiler : la durée de Delay_ms dépend de la fréquence.',
      'Oublier de mettre RA3 en entrée et RA0 à RA2 en sortie.',
    ],
  },
  {
    id: 'tp-pupitre', chapter: 4, title: 'TP 2 — Pupitre de jeu',
    goal: [
      'QCM de 8 questions Q0 à Q7 : une réponse par LOGICSTATE sur RB0 à RB7. La bonne combinaison est Q7..Q0 = 1100 1010, soit PORTB == 0xCA.',
      'DEMARRER (LOGICSTATE sur RA4) lance la partie ; VALIDER (bouton sur RA0, avec une résistance de 10 kΩ vers la masse) valide les réponses.',
      'Bonnes réponses : LED YES (verte, RA3) pendant 3 s. Mauvaises réponses : LED NO (rouge, RA2) pendant 3 s et un essai de moins. Après 3 échecs : GAME OVER (bleue, RA1) pendant 3 s.',
    ],
    deliverables: 'Montage ISIS, organigramme et programme C.',
    notes: [
      'L’énoncé dit « sous MPLAB » ; ce modèle est écrit en MikroC comme les autres TP.',
      'Pour rejouer : remettre DEMARRER à 0 puis à 1 (un LOGICSTATE reste dans sa position).',
    ],
    mistakes: [
      'Comparer les réponses une par une : REPONSES == 0xCA compare les 8 bits de PORTB d’un coup.',
      'TRISB doit valoir 0xFF (PORTB en entrée) et TRISA 0x11 (RA0 et RA4 en entrée).',
      'Ne pas attendre le relâchement de VALIDER : un appui compterait plusieurs essais.',
      'RA4 est à drain ouvert : pas de LED dessus. Ici elle sert d’entrée (DEMARRER), c’est correct.',
    ],
  },
  {
    id: 'tp4-inte', chapter: 5, title: 'TP4 — Interruption INTE',
    goal: [
      'Le programme principal est un compteur qui affiche 0 à 9 sur l’afficheur 7 segments BCD (RA0 à RA3).',
      'Quand le bouton (RB0/INT) passe à 1, la LED rouge (RB3) clignote 3 fois, puis le système continue son fonctionnement principal.',
      'Écrire le programme sans interruption, puis avec interruption ; commencer par l’organigramme.',
    ],
    deliverables: 'Organigrammes (sans et avec interruption) et programmes C sous MikroC ; simulation sur le montage ISIS TP_inte.DSN.',
    notes: [
      'Montage du prof (TP_inte.DSN) : horloge 8 MHz, rappel de 220 Ω de RB0 vers la masse (l’énoncé dessine 10k), LED sans résistance. Le bouton donne 1 à l’appui : INTEDG = 1.',
      'Le compteur reprend au chiffre où il a été interrompu, et même au milieu de son Delay_ms : c’est la preuve que le programme reprend « à l’endroit exact ».',
      'Version sans interruption : le test if (BOUTON == 1) n’est fait qu’entre deux chiffres ; un appui court pendant Delay_ms(500) est perdu.',
      'Le corrigé du prof (int2A10.c) donne le même comportement ; il écrit portb en minuscules, MikroC l’accepte.',
    ],
    mistakes: [
      'Tester le bouton dans la boucle du main : c’est la version sans interruption.',
      'Oublier INTCON.INTF = 0 à la fin de la routine : la LED clignote sans fin et le compteur reste figé.',
      'Utiliser la même variable i pour le compteur et pour les 3 clignotements : au retour, le compteur serait faux.',
      'Mettre GIE = 1 sans INTE = 1 (ou l’inverse).',
    ],
  },
  {
    id: 'ch5-manip-rb0', chapter: 5, title: 'Manipulation — Interruption RB0 (LEDs RA1 et RA2)',
    goal: [
      'Au repos (RB0 = 0), la LED rouge RA1 est éteinte et la LED verte RA2 clignote, 4 fois par tour de boucle.',
      'Un appui sur le bouton éteint la LED verte et fait clignoter la LED rouge 2 fois, puis on revient à l’état principal.',
    ],
    notes: [
      'Organigramme du cours : main = « Clignoter RA2 » ×4 ; routine = « Éteindre RA2 », « Clignoter RA1 » ×2, « INTF = 0 ».',
      'Éteindre la verte dans la routine : si l’appui arrive pendant qu’elle est allumée, elle resterait allumée pendant tout le traitement.',
    ],
    mistakes: [
      'Oublier d’éteindre la LED verte dans la routine.',
      'Oublier INTF = 0 ou GIE = 1.',
      'Se tromper de front : le montage a une résistance de 10k vers la masse (pull-down), donc INTEDG = 1.',
    ],
  },
  {
    id: 'tp-traffic-int', chapter: 5, title: 'Feu tricolore avec interruption (montage trafficint)',
    goal: [
      'Montage du prof trafficint.DSN : capteur (LOGICSTATE) sur RB0/INT, feux sur RB2 (rouge), RB3 (orange), RB4 (vert), afficheur BCD sur RA0 à RA3.',
      'Énoncé non fourni : le modèle suppose le cycle de jour dans le main (rouge 9 → 0, orange 2 → 0, vert 9 → 0, 1 s par chiffre) et le mode nuit dans l’interruption (orange clignotant, « A ») tant que le capteur est à 0.',
    ],
    notes: [
      'Le capteur passe de 1 à 0 à la tombée de la nuit : front descendant, INTEDG = 0.',
      'Au démarrage, mettre le capteur à 1 (jour) : s’il est déjà à 0, il n’y a pas de front et donc pas d’interruption.',
      'La routine coupe les feux ; le main les réécrit à chaque seconde, sinon ils resteraient éteints jusqu’à la couleur suivante.',
      'Une routine aussi longue (une boucle qui attend le jour) bloque le programme principal : à éviter en vrai, mais c’est le style des exercices.',
    ],
    mistakes: [
      'Mettre INTEDG = 1 : l’interruption partirait au retour du jour, pas à la nuit.',
      'Oublier que le main reprend au milieu de son Delay_ms : la couleur affichée juste après la nuit dépend de ce que la routine a laissé.',
    ],
  },
  {
    id: 'tp5-int-rb0', chapter: 5, title: 'Ch5 — Interruption externe RB0/INT',
    goal: [
      'Chaque front montant sur RB0/INT (bouton) déclenche la fonction interrupt(), qui inverse la LED rouge RB1.',
      'Pendant ce temps, la boucle principale fait clignoter la LED verte RB2 toutes les 500 ms.',
    ],
    notes: [
      'L’interruption est prise même pendant un Delay_ms de la boucle : c’est tout l’intérêt par rapport à un simple test du bouton.',
      'Configuration : OPTION_REG.INTEDG = 1 (front montant), INTCON.INTE = 1 (autoriser RB0/INT), INTCON.GIE = 1 (autoriser les interruptions).',
    ],
    mistakes: [
      'Oublier GIE = 1 : INTE seul ne suffit pas, GIE est l’interrupteur général.',
      'Oublier d’effacer INTF dans interrupt() : dès le RETFIE, l’interruption recommencerait sans fin.',
      'Se tromper de front : INTEDG = 1 → front montant (appui), 0 → front descendant (relâchement).',
      'Mettre un long Delay_ms dans l’interruption : elle doit rester courte.',
      'Laisser RB0 en sortie : RB0/INT doit être une entrée (TRISB.RB0 = 1).',
    ],
  },
  {
    id: 'ch6-exo-rbie', chapter: 6, title: 'Exercice — Compteur 0 à 9 et boutons RB4 à RB7',
    goal: [
      'Le système affiche un compteur de 0 à 9 sur l’afficheur BCD (RA0 à RA3).',
      'Quatre boutons sur RB4, RB5, RB6 et RB7 : quand un bouton est à 1, le nombre désigné par ce bouton s’affiche 500 ms, puis le compteur continue.',
      'Écrire le programme avec l’interruption sur changement du PORTB (RBIE).',
    ],
    notes: [
      'Choix du modèle : le bouton B4 affiche 4, B5 affiche 5, B6 affiche 6, B7 affiche 7. Si l’énoncé numérote les boutons 1 à 4, changer seulement les valeurs.',
      'Le relâchement provoque une deuxième interruption : aucun bouton n’est à 1, la routine ne fait qu’effacer RBIF.',
      'Les tests if (B4 == 1)… lisent PORTB : cela met fin à la condition de changement avant RBIF = 0.',
      'Configuration : TRISB = 0xF0 (ou bit par bit), INTCON.RBIE = 1, INTCON.GIE = 1 (INTCON = 0x88).',
    ],
    mistakes: [
      'Mettre OPTION_REG.INTEDG : il ne sert qu’à RB0/INT.',
      'Effacer RBIF sans lire PORTB.',
      'Afficher sans tester == 1 : au relâchement, la routine afficherait un nombre faux.',
    ],
  },
  {
    id: 'tp6-rbie', chapter: 6, title: 'Ch6 — Interruption sur changement de RB4 à RB7',
    goal: [
      'À chaque changement d’un des 4 interrupteurs RB4 à RB7, la fonction interrupt() recopie leur état sur les LEDs RA0 à RA3.',
      'La boucle principale n’a rien à faire : tout se passe dans l’interruption (RBIE).',
    ],
    notes: [
      'L’état des interrupteurs est aussi recopié une fois au démarrage, avant d’attendre les interruptions.',
    ],
    mistakes: [
      'Effacer RBIF sans avoir lu PORTB : la condition de changement reste vraie et RBIF revient aussitôt. Lisez PORTB d’abord, puis RBIF = 0.',
      'Seules les broches RB4 à RB7 configurées en entrée déclenchent RBIF.',
      'Oublier GIE ou RBIE.',
    ],
  },
];

export function tpContent(id: string | undefined | null): TpContent | undefined {
  return id ? TP_CONTENT.find((t) => t.id === id) : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Pins table

export interface PinRow {
  pin: PinName;
  /** DIP-18 pin number. */
  number: number;
  dir: 'entrée' | 'sortie' | '—';
  /** Name in the code (#define), when known. */
  name: string;
  /** Role in words (« Led égalité », « Afficheur, bit E0 »). */
  role: string;
  /** Part of the schematic on that pin. */
  part: string;
}

const PIN_ORDER: readonly PinName[] = ['RA0', 'RA1', 'RA2', 'RA3', 'RA4', 'RB0', 'RB1', 'RB2', 'RB3', 'RB4', 'RB5', 'RB6', 'RB7'];

/** One row per pin used by the program or wired on the schematic. */
export function pinTable(program: Program | null, schematic: Schematic | null): PinRow[] {
  const topo = schematic ? new Topology(schematic) : null;
  const rows: PinRow[] = [];
  for (const pin of PIN_ORDER) {
    const sig = program?.signals.find((s) => s.pin === pin);
    const bus = program?.buses.find((b) => b.port === pin[1] && Number(pin[2]) >= b.lsb && Number(pin[2]) < b.lsb + b.width);
    const parts = topo ? partsOnPin(topo, pin) : [];
    const source = topo ? inputSourceOf(topo, pin) : undefined;
    const partText = parts.length ? parts.map(partName).join(', ') : source ? source.replace(/^(l’|le |la )/, '') : '';
    if (!sig && !bus && !partText) continue;
    let dir: PinRow['dir'] = '—';
    let name = '';
    let role = '';
    if (sig) {
      dir = sig.dir === 'in' ? 'entrée' : 'sortie';
      name = sig.useDefine === false ? '' : sig.name;
      role = sig.label;
    } else if (bus) {
      dir = bus.dir === 'in' ? 'entrée' : 'sortie';
      name = bus.name;
      const k = Number(pin[2]) - bus.lsb;
      role = bus.device === 'bcd' ? `Afficheur BCD, entrée E${k}` : `${bus.label}, bit ${k}`;
    } else if (parts.some((p) => p.kind === 'LED' || p.kind === 'TRAFFIC_LIGHTS' || p.kind === '7SEG-BCD')) {
      dir = 'sortie';
    } else if (source) {
      dir = 'entrée';
    }
    rows.push({ pin, number: PIN_NUMBER[pin], dir, name, role, part: partText });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------
// Program walkthrough

export interface WalkItem {
  text: string;
  children?: WalkItem[];
}

export interface WalkSection {
  title: string;
  /** One-line purpose of the section. */
  intro: string;
  items: WalkItem[];
}

const FLAG_WORDS: Readonly<Record<string, [string, string]>> = {
  Z: ['Z = 0 (le résultat n’est pas nul)', 'Z = 1 (le résultat est nul)'],
  C: ['C = 0 (emprunt : le premier nombre est plus petit)', 'C = 1 (pas d’emprunt : le premier nombre est plus grand ou égal)'],
  DC: ['DC = 0', 'DC = 1'],
  INTF: ['INTF = 0', 'INTF = 1 (front sur RB0/INT)'],
  RBIF: ['RBIF = 0', 'RBIF = 1 (changement sur RB4–RB7)'],
  T0IF: ['T0IF = 0', 'T0IF = 1 (débordement de TMR0)'],
};

/** A condition of the program model in words: « L1 = 0 et L0 = 1 », « Z = 1 (le résultat est nul) ». */
export function condWords(program: Program, c: Cond): string {
  switch (c.kind) {
    case 'pin': {
      const s = signalById(program, c.signal);
      if (!s) return describeCond(program, c);
      const name = s.useDefine === false ? s.pin : s.name;
      const active = c.value === s.activeLevel;
      const meaning = s.device === 'button' ? (active ? ' (bouton appuyé)' : ' (bouton relâché)')
        : s.device === 'sensor' ? (active ? ' (lumière)' : ' (obscurité)') : '';
      return `${name} = ${c.value}${meaning}`;
    }
    case 'flag': return FLAG_WORDS[c.flag]?.[c.value] ?? describeCond(program, c);
    case 'compare': return `${describeExpr(program, c.left)} ${c.op} ${describeExpr(program, c.right)}`;
    case 'and': return c.items.map((x) => condWords(program, x)).join(' et ');
    case 'or': return c.items.map((x) => condWords(program, x)).join(' ou ');
    case 'not': return `non (${condWords(program, c.cond)})`;
    case 'raw': return c.text;
  }
}

function walk(program: Program, stmts: readonly Stmt[]): WalkItem[] {
  const out: WalkItem[] = [];
  let run: Stmt[] = [];
  const flush = () => {
    if (!run.length) return;
    for (const l of describeActions(program, run)) out.push({ text: l.text });
    run = [];
  };
  for (const s of stmts) {
    if (s.kind === 'comment') continue;
    if (isSimpleStmt(s)) { run.push(s); continue; }
    flush();
    switch (s.kind) {
      case 'if': {
        s.branches.forEach((b, i) => {
          out.push({ text: `${i === 0 ? 'Si' : 'Sinon, si'} ${condWords(program, b.cond)} :`, children: walk(program, b.body) });
        });
        if (s.otherwise) out.push({ text: 'Sinon :', children: walk(program, s.otherwise.body) });
        break;
      }
      case 'while':
        out.push({ text: `Tant que ${condWords(program, s.cond)} :`, children: walk(program, s.body) });
        break;
      case 'waitFor': {
        const d = describeWait(program, s);
        out.push({ text: `Attendre que ${condWords(program, s.cond)} (diamant « ${d.text} »).` });
        break;
      }
      case 'repeat': {
        const r = describeRepeat(program, s);
        out.push(r.summary.startsWith('Répéter') ? { text: `${r.summary} :`, children: walk(program, s.body) } : { text: r.summary });
        break;
      }
      case 'for':
        out.push({ text: `Boucle : ${describeActions(program, [s.init]).map((l) => l.text).join(', ')}, tant que ${condWords(program, s.cond)} :`, children: walk(program, s.body) });
        break;
      default:
        break;
    }
  }
  flush();
  return out;
}

/** The program in the organigramme's order: CONFIGURATION, INITIALISATION, boucle infinie, interruptions. */
export function programWalkthrough(program: Program): WalkSection[] {
  const sections: WalkSection[] = [];
  sections.push({
    title: 'CONFIGURATION',
    intro: 'Exécutée une seule fois : on dit au PIC quelles broches sont des entrées et des sorties (registres TRIS) et on déclare les variables.',
    items: describeConfiguration(program).map((l) => ({ text: l.text })),
  });
  sections.push({
    title: 'INITIALISATION',
    intro: 'Exécutée une seule fois : on donne leur valeur de départ aux sorties et aux variables.',
    items: program.init.length ? walk(program, program.init) : [{ text: 'Rien de particulier au démarrage.' }],
  });
  if (program.loop) {
    sections.push({
      title: 'Boucle infinie — while(1)',
      intro: 'Répétée sans fin, des milliers de fois par seconde (sauf pendant les attentes Delay_ms).',
      items: program.loop.length ? walk(program, program.loop) : [{ text: 'La boucle est vide : le PIC attend les interruptions.' }],
    });
  } else {
    sections.push({ title: 'Fin', intro: 'Pas de boucle : après l’initialisation, main() se termine et le PIC tourne sur place (GOTO $).', items: [] });
  }
  for (const f of program.functions) {
    sections.push({
      title: f.kind === 'interrupt' ? 'Programme d’interruption — interrupt()' : `Sous-programme ${f.name}()`,
      intro: f.kind === 'interrupt'
        ? 'Exécuté automatiquement quand une interruption autorisée arrive : le PIC suspend la boucle, saute à 0004h, puis revient où il en était (RETFIE).'
        : 'Exécuté à chaque appel (CALL), puis retour (RETURN).',
      items: walk(program, f.body),
    });
  }
  return sections;
}

/** Delays of a program, for the timing note (« 0,5 s = 125 000 cycles à 1 MHz »). */
export function delaySummary(program: Program): string | null {
  const delays = new Set<number>();
  const rec = (list: readonly Stmt[]) => {
    for (const s of list) {
      if (s.kind === 'delay' && (s.unit ?? 'ms') === 'ms') delays.add(s.ms);
      if (s.kind === 'if') { s.branches.forEach((b) => rec(b.body)); if (s.otherwise) rec(s.otherwise.body); }
      if (s.kind === 'while' || s.kind === 'repeat' || s.kind === 'for') rec(s.body);
    }
  };
  rec(program.init);
  rec(program.loop ?? []);
  program.functions.forEach((f) => rec(f.body));
  if (!delays.size) return null;
  const cyc = (ms: number) => Math.round((ms / 1000) * (program.clockHz / 4));
  return [...delays].sort((a, b) => a - b).map((ms) => `${formatDuration(ms)} ≈ ${groupThousands(cyc(ms))} cycles`).join(' ; ');
}

/** Part cards for the « Ce TP » tab. */
export function partRoles(schematic: Schematic, clockHz: number, opts: WiringOptions = {}): PartRole[] {
  return describeParts(new Topology(schematic), clockHz, opts);
}
