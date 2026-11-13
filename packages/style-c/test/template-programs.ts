// Source of templates/<id>.program.json: the corrected logic of every TP, written with the program-model blocks.
// Regenerate the template files with:  UPDATE_TEMPLATES=1 npx vitest run packages/style-c/test/templates.test.ts
import { blocks as b, defaultStyle, ensureIds, type Bus, type CodeStyle, type Program, type Signal, type Stmt } from '@pic/program-model';

type SignalSpec = Omit<Signal, 'id'> & { id?: string };

const sig = (s: SignalSpec): Signal => ({ id: s.id ?? s.name.toLowerCase(), ...s });

function program(p: Omit<Program, 'version' | 'style' | 'buses' | 'constants' | 'variables' | 'functions'> & {
  style?: Partial<CodeStyle>;
  buses?: Bus[];
  constants?: Program['constants'];
  variables?: Program['variables'];
  functions?: Program['functions'];
}): Program {
  const { style, ...rest } = p;
  return ensureIds({
    version: 1,
    buses: [],
    constants: [],
    variables: [],
    functions: [],
    ...rest,
    style: { ...defaultStyle(), ...style },
  });
}

const uchar = (...names: string[]): Program['variables'] => names.map((name) => ({ name, type: 'unsigned char' }));

// ---------------------------------------------------------------------------------------------------------------
// TP0 (Ch1)

export function tp0Exemple1(): Program {
  return program({
    title: 'TP0 — Exemple 1 : allumer une LED (RA0)',
    description: 'La LED bleue branchée sur RA0 s’allume au démarrage ; le programme se termine ensuite.',
    clockHz: 1_000_000,
    style: { macros: false },
    signals: [sig({ name: 'LED', pin: 'RA0', dir: 'out', label: 'Led bleue', activeLevel: 1, device: 'led', componentId: 'D1' })],
    init: [b.on('led', { comment: 'Allumer la LED' })],
    loop: null,
  });
}

export function tp0Exemple2(): Program {
  return program({
    title: 'TP0 — Exemple 2 : commander une LED par un bouton',
    description: 'La LED verte (RA0) recopie l’état de l’interrupteur LOGICSTATE branché sur RB0.',
    clockHz: 1_000_000,
    // Her EXEMPLE2 writes the whole register (`TRISA = 0;`): TRISA = 0x00, PORTA en sortie.
    style: { macros: false, tris: { A: 'port', B: 'auto' } },
    signals: [
      sig({ name: 'BOUTON', pin: 'RB0', dir: 'in', label: 'Interrupteur', activeLevel: 1, device: 'logicstate', componentId: 'LS1' }),
      sig({ name: 'LED', pin: 'RA0', dir: 'out', label: 'Led verte', activeLevel: 1, device: 'led', componentId: 'D1' }),
    ],
    init: [b.off('led')],
    loop: [
      b.when(b.pin('bouton', 1), [b.on('led')], [b.off('led')], { lead: 'La LED suit le bouton' }),
    ],
  });
}

// ---------------------------------------------------------------------------------------------------------------
// TP1 « Démultiplexeur 1 vers 4 » (Ch2): Tableau 1.1 of the énoncé (D1 for L1 L0 = 01, D2 for 10).

export function tp1Demux(): Program {
  const leds = [0, 1, 2, 3].map((k) => sig({
    name: `D${k}`, pin: `RB${k}` as Signal['pin'], dir: 'out', label: `Led D${k}`, activeLevel: 1, device: 'led',
    // The prof's DSN numbers the LEDs D1..D4 (D1 on RB0).
    componentId: `D${k + 1}`,
  }));
  const only = (k: number) => [0, 1, 2, 3].map((j) => b.set(`d${j}`, j === k ? 1 : 0));
  return program({
    title: 'Atelier — Démultiplexeur 1 vers 4',
    description: 'Deux interrupteurs L1 L0 (RA1, RA0) choisissent laquelle des quatre LEDs D0 à D3 (RB0 à RB3) est allumée, selon la table de vérité de l’énoncé.',
    clockHz: 1_000_000,
    style: { macros: false, compactAssign: true, echoRegister: true },
    signals: [
      sig({ name: 'L0', pin: 'RA0', dir: 'in', label: 'Interrupteur L0', activeLevel: 1, device: 'logicstate', componentId: 'LS1' }),
      sig({ name: 'L1', pin: 'RA1', dir: 'in', label: 'Interrupteur L1', activeLevel: 1, device: 'logicstate', componentId: 'LS2' }),
      ...leds,
    ],
    init: [0, 1, 2, 3].map((k) => b.off(`d${k}`)),
    loop: [
      b.ifChain([
        b.branch(b.and(b.pin('l1', 0), b.pin('l0', 0)), only(0)),
        b.branch(b.and(b.pin('l1', 0), b.pin('l0', 1)), only(1)),
        b.branch(b.and(b.pin('l1', 1), b.pin('l0', 0)), only(2)),
      ], b.otherwise(only(3)), { lead: 'Décodage de L1 L0' }),
    ],
  });
}

// ---------------------------------------------------------------------------------------------------------------
// TP « Manipulation du status » (Ch3): her slide-6 organigramme, with else if (status.c lights two LEDs when x = y).

export function tpStatus(): Program {
  const ledsOff = () => [b.off('led_sup'), b.off('led_egal'), b.off('led_inf')];
  return program({
    title: 'TP — Manipulation du registre STATUS',
    description: 'Compare x et y avec z = x - y et les drapeaux Z (égalité) et C (pas d’emprunt) du registre STATUS : une seule des trois LEDs s’allume.',
    clockHz: 1_000_000,
    style: { bitNotation: 'index', sections: 'status', tris: { A: 'auto', B: 'port' }, oneLineBranches: true, packLines: true },
    signals: [
      sig({ name: 'LED_SUP', pin: 'RB0', dir: 'out', label: 'Led supérieur', activeLevel: 1, device: 'led', componentId: 'X_SUPERIEUR' }),
      sig({ name: 'LED_EGAL', pin: 'RB1', dir: 'out', label: 'Led égalité', activeLevel: 1, device: 'led', componentId: 'EGALITE' }),
      sig({ name: 'LED_INF', pin: 'RB2', dir: 'out', label: 'Led inférieur', activeLevel: 1, device: 'led', componentId: 'X_INFERIEUR' }),
    ],
    variables: uchar('x', 'y', 'z'),
    // status.c: `STATUS=0;` closes the initialisation (CLRF STATUS leaves Z = 1, research 00 §3.7 #5).
    init: [b.assign(b.v('x'), 5), b.assign(b.v('y'), 6), ...ledsOff(), b.assign(b.reg('STATUS'), 0)],
    loop: [
      ...ledsOff(),
      b.assign(b.v('z'), b.sub(b.v('x'), b.v('y')), { comment: 'Soustraction' }),
      b.ifChain([
        b.branch(b.flag('Z', 1), [b.on('led_egal')], { comment: 'Test du bit Zero, x = y', note: 'x= y' }),
        b.branch(b.flag('C', 1), [b.on('led_sup')], { comment: 'Test du Carry, x > y', note: 'x> y' }),
      ], b.otherwise([b.on('led_inf')], { comment: 'x < y', note: 'x<y' })),
    ],
  });
}

// ---------------------------------------------------------------------------------------------------------------
// TP « Boîtier électronique de vote » (Ch3)

export function tpVote(): Program {
  const blink = (led: string) => [b.on(led), b.delay(500), b.off(led), b.delay(500)];
  return program({
    title: 'TP — Boîtier électronique de vote (A / B)',
    description: 'Compte les votes A (RA0) et B (RA1) avec un clignotement de confirmation (RA2) ; « Résultat » (RA3) affiche A, B ou E (égalité, LED verte RB5) sur l’afficheur 7 segments BCD.',
    clockHz: 1_000_000,
    style: { packLines: true },
    signals: [
      sig({ name: 'VOTE_A', pin: 'RA0', dir: 'in', label: 'Bouton Vote A', activeLevel: 1, device: 'button', componentId: 'VOTE_A' }),
      sig({ name: 'VOTE_B', pin: 'RA1', dir: 'in', label: 'Bouton Vote B', activeLevel: 1, device: 'button', componentId: 'VOTE_B' }),
      sig({ name: 'RESULTAT', pin: 'RA3', dir: 'in', label: 'Bouton Résultat', activeLevel: 1, device: 'button', componentId: 'RESULTAT' }),
      sig({ name: 'LED_VOTE', pin: 'RA2', dir: 'out', label: 'Led de confirmation', activeLevel: 1, device: 'led', componentId: 'CONFIRMATION' }),
      sig({ name: 'LED_EGAL', pin: 'RB5', dir: 'out', label: 'Led verte', activeLevel: 1, device: 'led', componentId: 'EGALITE' }),
    ],
    buses: [{ id: 'afficheur', name: 'AFFICHEUR', port: 'B', lsb: 0, width: 4, dir: 'out', label: 'Afficheur 7 segments BCD', device: 'bcd', componentId: 'SEG1' }],
    variables: uchar('var1', 'var2', 'z', 'i'),
    init: [
      b.assign(b.v('var1'), 0),
      b.assign(b.v('var2'), 0),
      b.off('led_vote'),
      b.off('led_egal'),
      b.display('afficheur', 0x0f, { comment: "Afficher la lettre 'F'" }),
      b.delay(500),
    ],
    loop: [
      b.when(b.pin('vote_a', 1), [
        b.incr('var1', { lead: 'Vote A : compter, puis faire clignoter la LED de confirmation' }),
        ...blink('led_vote'),
        b.waitFor(b.pin('vote_a', 0), { comment: 'Attente du relâchement du bouton' }),
      ]),
      b.when(b.pin('vote_b', 1), [
        b.incr('var2', { lead: 'Vote B : compter, puis faire clignoter la LED de confirmation' }),
        ...blink('led_vote'),
        b.waitFor(b.pin('vote_b', 0), { comment: 'Attente du relâchement du bouton' }),
      ]),
      b.when(b.pin('resultat', 1), [
        b.assign(b.v('z'), b.sub(b.v('var1'), b.v('var2')), { lead: 'Dépouillement', comment: 'Soustraction' }),
        b.ifChain([
          b.branch(b.flag('Z', 1), [
            b.display('afficheur', 0x0e, { comment: "Afficher la lettre 'E'" }),
            b.repeat(3, 'i', blink('led_egal')),
          ], { comment: 'Test du bit Zero, var1 = var2', note: 'var1= var2' }),
          b.branch(b.flag('C', 1), [
            b.display('afficheur', 0x0a, { comment: "Afficher la lettre 'A'" }),
            b.delay(500),
          ], { comment: 'Test du Carry, var1 > var2', note: 'var1> var2' }),
        ], b.otherwise([
          b.display('afficheur', 0x0b, { comment: "Afficher la lettre 'B'" }),
          b.delay(500),
        ], { comment: 'var1 < var2', note: 'var1<var2' })),
        b.assign(b.v('var1'), 0),
        b.assign(b.v('var2'), 0, { comment: 'Nouveau cycle de vote' }),
        b.waitFor(b.pin('resultat', 0), { comment: 'Attente du relâchement du bouton' }),
      ]),
    ],
  });
}

// ---------------------------------------------------------------------------------------------------------------
// TP « Feu tricolore » (Ch4), 8 MHz

export function tpTraffic(): Program {
  const lamps = (r: 0 | 1, o: 0 | 1, v: 0 | 1, lead: string) => [
    b.set('rouge', r, { lead }), b.set('orange', o), b.set('vert', v),
  ];
  const countdown = (from: number) => b.repeat(from + 1, 'compte', [
    b.display('afficheur', b.sub(b.num(from), b.v('compte'))),
    b.delay(1000),
  ]);
  return program({
    title: 'TP — Feu tricolore',
    description: 'Le capteur de luminosité (RA3) choisit le mode : nuit, orange clignotant et « A » affiché ; jour, cycle rouge, orange, vert avec un décompte chaque seconde sur l’afficheur. Choix à connaître : l’orange affiche 2, 1, 0 pendant 1 s chacun, soit 3 s (l’énoncé dit « 2 secondes ») ; le capteur n’est lu qu’au début de chaque cycle, donc le mode nuit attend la fin du cycle de jour en cours.',
    clockHz: 8_000_000,
    signals: [
      sig({ name: 'CAPTEUR', pin: 'RA3', dir: 'in', label: 'Capteur de luminosité', activeLevel: 1, device: 'sensor', componentId: 'LDR1' }),
      sig({ name: 'ROUGE', pin: 'RA0', dir: 'out', label: 'Feu rouge', activeLevel: 1, device: 'lamp', componentId: 'TL1' }),
      sig({ name: 'ORANGE', pin: 'RA1', dir: 'out', label: 'Feu orange', activeLevel: 1, device: 'lamp', componentId: 'TL1' }),
      sig({ name: 'VERT', pin: 'RA2', dir: 'out', label: 'Feu vert', activeLevel: 1, device: 'lamp', componentId: 'TL1' }),
    ],
    buses: [{ id: 'afficheur', name: 'AFFICHEUR', port: 'B', lsb: 0, width: 4, dir: 'out', label: 'Afficheur 7 segments BCD', device: 'bcd', componentId: 'SEG1' }],
    variables: uchar('compte'),
    init: [b.off('rouge'), b.off('orange'), b.off('vert'), b.display('afficheur', 0x00)],
    loop: [
      b.ifChain([
        b.branch(b.pin('capteur', 0), [
          b.off('rouge', { lead: 'Mode nuit : orange clignotant, afficheur "A"' }),
          b.off('vert'),
          b.display('afficheur', 0x0a, { comment: "Afficher la lettre 'A'" }),
          b.on('orange'),
          b.delay(500),
          b.off('orange'),
          b.delay(500),
        ], { note: 'Mode nuit' }),
      ], b.otherwise([
        ...lamps(1, 0, 0, 'Mode jour : rouge 10 s, décompte de 9 à 0'),
        countdown(9),
        ...lamps(0, 1, 0, 'Orange : décompte de 2 à 0 (3 valeurs, 1 s chacune : 3 s ; l\'énoncé dit 2 s)'),
        countdown(2),
        ...lamps(0, 0, 1, 'Vert : 10 s, décompte de 9 à 0'),
        countdown(9),
      ], { note: 'Mode jour' }), { lead: 'Lecture du capteur de luminosité (une fois par cycle : le mode nuit attend la fin du cycle de jour)' }),
    ],
  });
}

// ---------------------------------------------------------------------------------------------------------------
// TP2 « Pupitre de jeu » (Ch4 this year)

export function tpPupitre(): Program {
  const lit3s = (led: string) => [b.on(led), b.delay(3000), b.off(led)];
  const withLead = (stmts: Stmt[], lead: string): Stmt[] => stmts.map((s, k) => (k === 0 ? { ...s, lead } : s));
  return program({
    title: 'TP2 — Pupitre de jeu',
    description: 'QCM de 8 questions sur RB0 à RB7 : après DEMARRER (RA4), VALIDER (RA0) compare les réponses à 0xCA ; YES ou NO pendant 3 s, GAME OVER après trois essais faux. Pour rejouer, remettre DEMARRER à 0 puis à 1 : l’interrupteur reste à 1 tant qu’on ne le baisse pas.',
    clockHz: 1_000_000,
    signals: [
      sig({ name: 'VALIDER', pin: 'RA0', dir: 'in', label: 'Bouton Valider', activeLevel: 1, device: 'button', componentId: 'VALIDER' }),
      sig({ name: 'DEMARRER', pin: 'RA4', dir: 'in', label: 'Interrupteur Démarrer', activeLevel: 1, device: 'logicstate', componentId: 'DEMARRER' }),
      sig({ name: 'LED_GAME_OVER', pin: 'RA1', dir: 'out', label: 'Led GAME OVER', activeLevel: 1, device: 'led', componentId: 'D4', comment: 'LED bleue' }),
      sig({ name: 'LED_NO', pin: 'RA2', dir: 'out', label: 'Led NO', activeLevel: 1, device: 'led', componentId: 'D2', comment: 'LED rouge' }),
      sig({ name: 'LED_YES', pin: 'RA3', dir: 'out', label: 'Led YES', activeLevel: 1, device: 'led', componentId: 'D3', comment: 'LED verte' }),
    ],
    buses: [{ id: 'reponses', name: 'REPONSES', port: 'B', lsb: 0, width: 8, dir: 'in', label: 'Réponses Q0 à Q7', device: 'generic', comment: 'Q0..Q7 sur RB0..RB7' }],
    constants: [{ name: 'REPONSE_CORRECTE', value: 0xca, radix: 16, comment: 'Réponses attendues : Q7..Q0 = 1 1 0 0 1 0 1 0' }],
    variables: uchar('essais', 'reussi'),
    init: [b.off('led_game_over'), b.off('led_no'), b.off('led_yes')],
    loop: [
      b.waitFor(b.pin('demarrer', 1), { comment: 'Attente du démarrage' }),
      b.assign(b.v('essais'), 3),
      b.assign(b.v('reussi'), 0),
      b.whileLoop(b.and(b.cmp(b.v('essais'), '>', b.num(0)), b.cmp(b.v('reussi'), '==', b.num(0))), [
        b.waitFor(b.pin('valider', 1), { comment: 'Attente de la validation' }),
        b.ifChain([
          b.branch(b.cmp(b.bus('reponses'), '==', b.v('REPONSE_CORRECTE')), [
            ...withLead(lit3s('led_yes'), 'Toutes les réponses sont correctes'),
            b.assign(b.v('reussi'), 1),
          ], { note: 'Réponses correctes' }),
        ], b.otherwise([
          ...withLead(lit3s('led_no'), 'Erreur : un essai de moins'),
          b.decr('essais'),
        ], { note: 'Réponses fausses' })),
        b.waitFor(b.pin('valider', 0), { comment: 'Attente du relâchement du bouton' }),
      ], { lead: 'Trois essais au maximum' }),
      b.when(b.cmp(b.v('reussi'), '==', b.num(0)), lit3s('led_game_over'), undefined, { lead: 'Trois essais infructueux : GAME OVER' }),
      // DEMARRER is a LOGICSTATE: it stays at 1. Without this wait a new game would start at once (research C1.11).
      b.waitFor(b.pin('demarrer', 0), { comment: 'Attente de la remise à 0 de DEMARRER' }),
    ],
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Ch5: TP4 « Interruption INTE » (Énoncé_tp4.pdf, her circuit TP_inte.DSN and her correction int2A10.c)

export function tp4Inte(): Program {
  return program({
    title: 'TP4 — Interruption INTE',
    description: 'Le compteur affiche 0 à 9 sur l’afficheur 7 segments BCD (RA0 à RA3), un chiffre toutes les 500 ms. Chaque appui sur le bouton (RB0/INT, front montant) déclenche l’interruption : la LED rouge (RB3) clignote 3 fois, puis le compteur reprend exactement où il s’était arrêté.',
    clockHz: 8_000_000,
    signals: [
      sig({ name: 'BOUTON', pin: 'RB0', dir: 'in', label: 'Bouton', activeLevel: 1, device: 'button', componentId: 'BTN1' }),
      sig({ name: 'LED', pin: 'RB3', dir: 'out', label: 'Led rouge', activeLevel: 1, device: 'led', componentId: 'D1' }),
    ],
    buses: [{ id: 'afficheur', name: 'AFFICHEUR', port: 'A', lsb: 0, width: 4, dir: 'out', label: 'Afficheur 7 segments BCD', device: 'bcd', componentId: 'SEG1' }],
    variables: uchar('j', 'i'), // j (routine) is global: written first in the C
    interrupts: { int: { edge: 'rising' }, gie: true },
    functions: [
      b.interrupt([
        b.when(b.flag('INTF', 1), [
          b.repeat(3, 'j', [b.on('led'), b.delay(500), b.off('led'), b.delay(500)], { lead: 'La LED rouge clignote 3 fois' }),
          b.clearFlag('INTF', { comment: 'Remettre le drapeau à zéro' }),
        ], undefined, { comment: 'Interruption RB0/INT : appui sur le bouton' }),
      ], "Programme d'interruption : appelé à chaque appui sur le bouton (front montant sur RB0/INT)"),
    ],
    init: [b.off('led'), b.display('afficheur', 0)],
    loop: [
      b.repeat(10, 'i', [b.display('afficheur', b.v('i')), b.delay(500)], { lead: 'Compteur de 0 à 9 : le programme principal ne lit jamais le bouton' }),
    ],
  });
}

// Ch5: manipulation of the course (INTERRUPTIONS_e2026.pptx, slides 28–29)

export function ch5ManipRb0(): Program {
  return program({
    title: 'Manipulation — Interruption RB0 (LEDs RA1 et RA2)',
    description: 'Au repos, la LED rouge (RA1) est éteinte et la LED verte (RA2) clignote, 4 fois par tour de boucle. Un appui sur le bouton (RB0/INT, front montant) éteint la verte et fait clignoter la rouge 2 fois, puis le programme revient au fonctionnement principal.',
    clockHz: 1_000_000,
    signals: [
      sig({ name: 'BOUTON', pin: 'RB0', dir: 'in', label: 'Bouton', activeLevel: 1, device: 'button', componentId: 'BOUTON' }),
      sig({ id: 'led_rouge', name: 'LED_ROUGE', pin: 'RA1', dir: 'out', label: 'Led rouge', activeLevel: 1, device: 'led', componentId: 'D1' }),
      sig({ id: 'led_verte', name: 'LED_VERTE', pin: 'RA2', dir: 'out', label: 'Led verte', activeLevel: 1, device: 'led', componentId: 'D2' }),
    ],
    variables: uchar('j', 'i'), // j (routine) is global: written first in the C
    interrupts: { int: { edge: 'rising' }, gie: true },
    functions: [
      b.interrupt([
        b.when(b.flag('INTF', 1), [
          b.off('led_verte', { lead: 'Éteindre la LED verte pendant le traitement' }),
          b.repeat(2, 'j', [b.on('led_rouge'), b.delay(500), b.off('led_rouge'), b.delay(500)], { lead: 'La LED rouge clignote 2 fois' }),
          b.clearFlag('INTF', { comment: 'Effacer le drapeau INTF' }),
        ], undefined, { comment: 'Interruption RB0/INT' }),
      ], "Programme d'interruption : appelé à chaque appui sur le bouton (front montant sur RB0/INT)"),
    ],
    init: [b.off('led_rouge'), b.off('led_verte')],
    loop: [
      b.repeat(4, 'i', [b.on('led_verte'), b.delay(500), b.off('led_verte'), b.delay(500)], { lead: 'La LED verte clignote 4 fois' }),
    ],
  });
}

// Ch5: traffic light with an interrupt, on the prof's trafficint.DSN (no énoncé supplied: behaviour reconstructed)

export function tpTrafficInt(): Program {
  const lights = (r: 0 | 1, o: 0 | 1, v: 0 | 1): Stmt[] => [b.set('rouge', r), b.set('orange', o), b.set('vert', v)];
  // The lamps are written again every second: after the night mode (which switches them off), the day cycle
  // shows the right colour again within one second instead of staying dark until the next phase.
  const phase = (r: 0 | 1, o: 0 | 1, v: 0 | 1, from: number, lead: string) => b.repeat(from + 1, 'compte', [
    ...lights(r, o, v),
    b.display('afficheur', b.sub(b.num(from), b.v('compte'))),
    b.delay(1000),
  ], { lead });
  return program({
    title: 'Feu tricolore avec interruption (montage trafficint)',
    description: 'Montage du prof trafficint.DSN (énoncé non fourni : comportement reconstitué). Le programme principal fait le cycle de jour : rouge 9 à 0, orange 2 à 0, vert 9 à 0, une seconde par chiffre. Quand le capteur (LOGICSTATE sur RB0/INT) passe de 1 à 0 (front descendant), l’interruption fait le mode nuit : orange clignotant et « A » affiché tant que le capteur reste à 0, puis le cycle reprend où il s’était arrêté (les feux sont réécrits chaque seconde). Au démarrage, mettre le capteur à 1 (jour).',
    clockHz: 8_000_000,
    signals: [
      sig({ name: 'CAPTEUR', pin: 'RB0', dir: 'in', label: 'Capteur de luminosité', activeLevel: 1, device: 'logicstate', componentId: 'LS1' }),
      sig({ name: 'ROUGE', pin: 'RB2', dir: 'out', label: 'Feu rouge', activeLevel: 1, device: 'lamp', componentId: 'TL1' }),
      sig({ name: 'ORANGE', pin: 'RB3', dir: 'out', label: 'Feu orange', activeLevel: 1, device: 'lamp', componentId: 'TL1' }),
      sig({ name: 'VERT', pin: 'RB4', dir: 'out', label: 'Feu vert', activeLevel: 1, device: 'lamp', componentId: 'TL1' }),
    ],
    buses: [{ id: 'afficheur', name: 'AFFICHEUR', port: 'A', lsb: 0, width: 4, dir: 'out', label: 'Afficheur 7 segments BCD', device: 'bcd', componentId: 'SEG1' }],
    variables: uchar('compte'),
    interrupts: { int: { edge: 'falling' }, gie: true },
    functions: [
      b.interrupt([
        b.when(b.flag('INTF', 1), [
          b.whileLoop(b.pin('capteur', 0), [
            ...lights(0, 0, 0),
            b.display('afficheur', 0x0a, { comment: "Afficher la lettre 'A'" }),
            b.on('orange'), b.delay(500), b.off('orange'), b.delay(500),
          ], { lead: 'Mode nuit : orange clignotant et "A" tant que le capteur est à 0' }),
          b.clearFlag('INTF', { comment: 'Effacer le drapeau INTF' }),
        ], undefined, { comment: 'Interruption RB0/INT : le capteur passe à 0 (nuit)' }),
      ], "Programme d'interruption : appelé quand le capteur passe de 1 à 0 (front descendant sur RB0/INT)"),
    ],
    init: [...lights(0, 0, 0), b.display('afficheur', 0)],
    loop: [
      phase(1, 0, 0, 9, 'Rouge : décompte de 9 à 0 (feux réécrits chaque seconde, utile au retour du mode nuit)'),
      phase(0, 1, 0, 2, 'Orange : décompte de 2 à 0'),
      phase(0, 0, 1, 9, 'Vert : décompte de 9 à 0'),
    ],
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Ch5: interruption externe RB0/INT

export function tp5IntRb0(): Program {
  return program({
    title: 'Ch5 — Interruption externe RB0/INT',
    description: 'Chaque appui sur le bouton (RB0/INT, front montant) déclenche l’interruption qui inverse la LED rouge (RB1) ; pendant ce temps, la boucle principale fait clignoter la LED verte (RB2) toutes les 500 ms.',
    clockHz: 1_000_000,
    signals: [
      sig({ name: 'BOUTON', pin: 'RB0', dir: 'in', label: 'Bouton', activeLevel: 1, device: 'button', componentId: 'BOUTON' }),
      sig({ name: 'LED_INT', pin: 'RB1', dir: 'out', label: 'Led rouge', activeLevel: 1, device: 'led', componentId: 'D1' }),
      sig({ name: 'LED_CLI', pin: 'RB2', dir: 'out', label: 'Led verte', activeLevel: 1, device: 'led', componentId: 'D2' }),
    ],
    interrupts: { int: { edge: 'rising' }, gie: true },
    functions: [
      b.interrupt([
        b.when(b.flag('INTF', 1), [
          b.toggle('led_int', { comment: 'Inverser la LED' }),
          b.clearFlag('INTF', { comment: 'Effacer le drapeau INTF' }),
        ], undefined, { comment: 'Interruption RB0/INT' }),
      ], "Programme d'interruption : appelé à chaque front montant sur RB0/INT"),
    ],
    init: [b.off('led_int'), b.off('led_cli')],
    loop: [b.on('led_cli'), b.delay(500), b.off('led_cli'), b.delay(500)],
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Ch6: interruption sur changement d'état de RB4..RB7

export function tp6Rbie(): Program {
  const copy = (lead: string) => [0, 1, 2, 3].map((k) => b.assign(b.sig(`led${k}`), b.sig(`inter${k + 4}`), k === 0 ? { lead } : {}));
  const inputs = [4, 5, 6, 7].map((k) => sig({
    name: `INTER${k}`, pin: `RB${k}` as Signal['pin'], dir: 'in', label: `Interrupteur RB${k}`, activeLevel: 1, device: 'logicstate', componentId: `LS${k - 3}`,
  }));
  const leds = [0, 1, 2, 3].map((k) => sig({
    name: `LED${k}`, pin: `RA${k}` as Signal['pin'], dir: 'out', label: `Led RA${k}`, activeLevel: 1, device: 'led', componentId: `D${k + 1}`,
  }));
  return program({
    title: 'Ch6 — Interruption sur changement de RB4 à RB7',
    description: 'Au démarrage puis à chaque changement d’un des interrupteurs RB4 à RB7, leur état est recopié sur les LEDs RA0 à RA3 (l’interruption RBIE s’en charge après le démarrage) ; la boucle principale n’a rien à faire.',
    clockHz: 1_000_000,
    // The LEDs are only ever copied from the switches: no LED_ON / LED_OFF (empty macro section, as in demux.c).
    style: { macros: false },
    signals: [...inputs, ...leds],
    interrupts: { rbChange: true, gie: true },
    functions: [
      b.interrupt([
        b.when(b.flag('RBIF', 1), [
          ...copy('Recopier RB4..RB7 sur RA0..RA3 : la lecture de PORTB met fin à la condition de changement'),
          b.clearFlag('RBIF', { comment: 'RBIF peut alors être effacé' }),
        ], undefined, { comment: "Changement d'état sur RB4 à RB7" }),
      ], "Programme d'interruption : appelé à chaque changement de RB4 à RB7"),
    ],
    // The LEDs show the switches from power-up, not only after the first change.
    init: copy('Afficher l\'état des interrupteurs dès le démarrage'),
    loop: [b.comment("Rien à faire : l'interruption met les LEDs à jour", { text: 'Attente des interruptions' })],
  });
}

// Ch6: exercice d'application of the course (INTERRUPTIONS_e2026.pptx, slide 36)

export function ch6ExoRbie(): Program {
  const buttons = [4, 5, 6, 7].map((k) => sig({
    name: `B${k}`, pin: `RB${k}` as Signal['pin'], dir: 'in', label: `Bouton B${k}`, activeLevel: 1, device: 'button', componentId: `B${k}`,
  }));
  return program({
    title: 'Exercice — Compteur 0 à 9 et boutons RB4 à RB7',
    description: 'Le compteur affiche 0 à 9 (RA0 à RA3), un chiffre toutes les 500 ms. Un appui sur un des boutons B4 à B7 (RB4 à RB7) déclenche l’interruption RBIE : le numéro du bouton (4 à 7) s’affiche pendant 500 ms, puis le compteur reprend. Le relâchement du bouton provoque une deuxième interruption qui ne fait rien (aucun bouton à 1).',
    clockHz: 1_000_000,
    style: { macros: false },
    signals: buttons,
    buses: [{ id: 'afficheur', name: 'AFFICHEUR', port: 'A', lsb: 0, width: 4, dir: 'out', label: 'Afficheur 7 segments BCD', device: 'bcd', componentId: 'SEG1' }],
    variables: uchar('i'),
    interrupts: { rbChange: true, gie: true },
    functions: [
      b.interrupt([
        b.when(b.flag('RBIF', 1), [
          b.ifChain([4, 5, 6, 7].map((k) => b.branch(b.pin(`b${k}`, 1), [b.display('afficheur', b.num(k)), b.delay(500)])), null,
            { lead: 'Lire les boutons : la lecture de PORTB met fin à la condition de changement' }),
          b.clearFlag('RBIF', { comment: 'RBIF peut alors être effacé' }),
        ], undefined, { comment: "Changement d'état sur RB4 à RB7" }),
      ], "Programme d'interruption : appelé à chaque changement d'état de RB4 à RB7 (appui ET relâchement)"),
    ],
    init: [b.display('afficheur', 0)],
    loop: [
      b.repeat(10, 'i', [b.display('afficheur', b.v('i')), b.delay(500)], { lead: 'Compteur de 0 à 9' }),
    ],
  });
}

export interface TemplateSpec {
  id: string;
  chapter: number;
  build: () => Program;
}

export const TEMPLATE_PROGRAMS: readonly TemplateSpec[] = [
  { id: 'tp0-exemple1', chapter: 1, build: tp0Exemple1 },
  { id: 'tp0-exemple2', chapter: 1, build: tp0Exemple2 },
  { id: 'tp1-demux', chapter: 2, build: tp1Demux },
  { id: 'tp-status', chapter: 3, build: tpStatus },
  { id: 'tp-vote', chapter: 3, build: tpVote },
  { id: 'tp-traffic', chapter: 4, build: tpTraffic },
  { id: 'tp-pupitre', chapter: 4, build: tpPupitre },
  { id: 'tp4-inte', chapter: 5, build: tp4Inte },
  { id: 'ch5-manip-rb0', chapter: 5, build: ch5ManipRb0 },
  { id: 'tp-traffic-int', chapter: 5, build: tpTrafficInt },
  { id: 'tp5-int-rb0', chapter: 5, build: tp5IntRb0 },
  { id: 'ch6-exo-rbie', chapter: 6, build: ch6ExoRbie },
  { id: 'tp6-rbie', chapter: 6, build: tp6Rbie },
];
