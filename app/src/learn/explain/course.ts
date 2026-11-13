// « Cours »: short chapter summaries of the ESPRIT PIC16F84A course (2025/26), written for a student who finds the
// course hard. Facts come from research/00_SYNTHESIS.md and the chapter reports (01–04), corrected where the slides
// are wrong (C = 1 means NO borrow after a subtraction, 'A' = 0x77 on a direct 7-segment display…). Chapters 5–6
// follow the prof's interrupts chapter (cours/INTERRUPTIONS_e2026.pptx) and TP4, checked against the datasheet.

export interface CourseTable {
  head: readonly string[];
  rows: readonly (readonly string[])[];
}

export interface CourseSection {
  title: string;
  paragraphs?: readonly string[];
  bullets?: readonly string[];
  table?: CourseTable;
  /** Code or assembly sample, shown in monospace. */
  code?: string;
}

export interface Chapter {
  id: string;
  /** '1'…'6', or 'DS' for the revision page. */
  number: string;
  title: string;
  /** One-sentence summary shown on the chapter card. */
  summary: string;
  /** Status note (« Pas encore vu en cours… »). */
  status?: string;
  sections: readonly CourseSection[];
  /** « À retenir ». */
  keyPoints: readonly string[];
  /** Template ids to open from this chapter. */
  templates: readonly string[];
}

export const CHAPTERS: readonly Chapter[] = [
  {
    id: 'ch1', number: '1', title: 'Introduction au PIC16F84A',
    summary: 'Ce qu’est un microcontrôleur, le nom « PIC 16F84-20 », l’architecture Harvard, le jeu de 35 instructions et le brochage.',
    sections: [
      {
        title: 'Système embarqué et microcontrôleur',
        paragraphs: [
          'Un système embarqué perçoit son environnement avec des capteurs, décide avec une unité de traitement, et agit avec des actionneurs (machine à laver, ABS, airbag…).',
          'Le microcontrôleur est cette unité de traitement : sur une seule puce, il réunit un processeur, de la mémoire et des ports d’entrées/sorties. Un microprocesseur (PC) n’a que le processeur : mémoire et périphériques sont à côté.',
        ],
      },
      {
        title: 'Le nom PIC 16F84-20',
        bullets: [
          'PIC : microcontrôleur de Microchip (Programmable Interface Controller).',
          '16 : famille Mid-Range, instructions codées sur 14 bits (Base-Line : 12 bits, High-End : 16 bits).',
          'F : mémoire de programme Flash (reprogrammable).',
          '84 : le type. -20 : quartz de 20 MHz au maximum.',
          'Le PIC est un composant statique : on peut ralentir l’horloge jusqu’à l’arrêt sans perdre de données.',
        ],
      },
      {
        title: 'Architecture Harvard et RISC',
        paragraphs: [
          'Harvard : la mémoire de programme et la mémoire de données sont séparées, avec chacune son bus. Le PIC peut lire l’instruction suivante pendant qu’il travaille sur les données, et les instructions (14 bits) n’ont pas la même taille que les données (8 bits).',
          'Von Neumann (le PC) : programme et données partagent la même mémoire et le même bus.',
          'RISC : jeu d’instructions réduit. Le PIC16F84A n’a que 35 instructions, presque toutes en 1 cycle.',
        ],
      },
      {
        title: 'Brochage (boîtier DIP 18 broches)',
        table: {
          head: ['Broches', 'Rôle'],
          rows: [
            ['17, 18, 1, 2, 3', 'PORT A : RA0, RA1, RA2, RA3, RA4/T0CKI'],
            ['6 à 13', 'PORT B : RB0/INT, RB1 … RB7'],
            ['4', 'MCLR : reset (remise à zéro sans couper l’alimentation)'],
            ['16, 15', 'OSC1, OSC2 : circuit d’horloge (quartz)'],
            ['5 / 14', 'VSS = 0 V / VDD = 5 V (alimentation)'],
          ],
        },
      },
      {
        title: 'TP 0 : premiers programmes',
        paragraphs: [
          'Exemple 1 : TRISA.RA0 = 0 (RA0 en sortie) puis PORTA.RA0 = 1 : la LED s’allume.',
          'Exemple 2 : la LED recopie un interrupteur LOGICSTATE dans une boucle while(1).',
        ],
        code: 'void main() {\n    TRISA.RA0 = 0;   // RA0 en sortie\n    PORTA.RA0 = 1;   // allumer la LED\n}',
      },
    ],
    keyPoints: [
      'PIC16F84A = Mid-Range, Flash, instructions de 14 bits, 35 instructions, architecture Harvard.',
      'PORT A = 5 broches (RA0–RA4), PORT B = 8 broches (RB0–RB7).',
      'Pour allumer une LED : configurer la broche en sortie (TRIS), puis écrire 1 (PORT).',
    ],
    templates: ['tp0-exemple1', 'tp0-exemple2'],
  },
  {
    id: 'ch2', number: '2', title: 'Entrées / sorties et mémoire de données',
    summary: 'Les registres TRIS et PORT, la RAM en deux banques, l’organigramme général, #define et les macros. TP : démultiplexeur.',
    sections: [
      {
        title: 'Configurer les broches : TRISA et TRISB',
        paragraphs: [
          'Chaque broche a un bit dans TRISA (RA0–RA4) ou TRISB (RB0–RB7). Règle du cours : bit à 1 = entrée (Input), bit à 0 = sortie (Output). Moyen mnémotechnique : 1 ressemble à I (Input), 0 à O (Output).',
          'Après un reset, toutes les broches sont des entrées (TRISA = 0x1F, TRISB = 0xFF).',
        ],
        code: 'TRISA.RA0 = 1;   // RA0 : entrée\nTRISB = 0x00;    // tout le PORTB en sortie',
      },
      {
        title: 'Lire et écrire : PORTA et PORTB',
        bullets: [
          'Broche en entrée : on la lit à travers PORTx, avec == (« PORTA.RA0 == 1 », ou « L0 == 1 » après #define L0 PORTA.RA0).',
          'Broche en sortie : on l’écrit à travers PORTx, avec = (« PORTA.RA3 = 1 » allume ce qui est branché).',
          'Attention : RA0 tout seul n’est que le numéro du bit (0), pas la broche. Il faut toujours passer par PORTA / PORTB (ou par un #define).',
          'Notations acceptées par MikroC : PORTB.RB0, PORTB.F0, PORTB.B0, ou tout le port : PORTB = 0x76.',
        ],
      },
      {
        title: 'La mémoire de données',
        bullets: [
          'EEPROM : 64 octets, non volatile (garde les données sans alimentation), plus lente.',
          'RAM : 68 octets de variables (registres GPR, à partir de 0x0C) + les registres spéciaux (SFR : STATUS, PORTA, TRISA…). Volatile.',
          'La RAM est découpée en 2 banques de 128 octets. Le bit RP0 de STATUS choisit la banque : RP0 = 0 → banque 0 (PORTA, PORTB), RP0 = 1 → banque 1 (TRISA, TRISB, OPTION_REG). Le compilateur change de banque tout seul.',
          'absolute fixe l’adresse d’une variable : unsigned char temperature absolute 0x0C;',
        ],
      },
      {
        title: '#define et macros',
        paragraphs: [
          '#define donne un nom à une broche ou à une constante : le compilateur remplace le nom par son texte avant de compiler. Le PIC n’exécute rien pour un #define.',
          'Une macro avec paramètre recopie un petit morceau de code : #define LED_ON(pin) (pin = 1) transforme LED_ON(LED_EGAL) en (PORTB.F1 = 1).',
        ],
        code: '#define L0 PORTA.RA0\n#define D0 PORTB.RB0\n#define LED_ON(pin)  (pin = 1)',
      },
      {
        title: 'Organigramme général du programme',
        paragraphs: [
          'Début → CONFIGURATION (directions des broches, variables) → INITIALISATION (valeurs de départ) → Traitement dans une boucle infinie → Fin. Le code suit le même ordre : configuration, initialisation, while(1).',
        ],
      },
    ],
    keyPoints: [
      'TRIS : 1 = entrée, 0 = sortie. PORT : lire une entrée, écrire une sortie.',
      'TRISA/TRISB sont en banque 1, PORTA/PORTB en banque 0 (bit RP0 de STATUS).',
      'Les variables sont en RAM à partir de 0x0C ; l’EEPROM (64 octets) garde ses données sans courant.',
    ],
    templates: ['tp1-demux'],
  },
  {
    id: 'ch3', number: '3', title: 'Le registre STATUS et les afficheurs',
    summary: 'Les drapeaux C, DC, Z, la comparaison de deux nombres avec z = x − y, les afficheurs 7 segments et BCD. TP : STATUS et vote.',
    sections: [
      {
        title: 'Le registre STATUS (adresses 03h et 83h)',
        table: {
          head: ['Bit', 'Nom', 'Rôle'],
          rows: [
            ['7', 'IRP', 'Inutilisé sur le PIC16F84A : à laisser à 0'],
            ['6', 'RP1', 'Inutilisé sur le PIC16F84A : à laisser à 0'],
            ['5', 'RP0', 'Choix de la banque : 0 = banque 0, 1 = banque 1'],
            ['4', '/TO', 'Passe à 0 si le chien de garde (WDT) déborde. Lecture seule'],
            ['3', '/PD', 'Passe à 0 après l’instruction SLEEP. Lecture seule'],
            ['2', 'Z', 'Zéro : 1 si le résultat de la dernière opération est nul'],
            ['1', 'DC', 'Retenue entre les quartets (bit 3 → bit 4), pour le BCD'],
            ['0', 'C', 'Retenue (addition) / PAS d’emprunt (soustraction)'],
          ],
        },
        paragraphs: ['STATUS existe dans les deux banques : on peut toujours le lire, quelle que soit la banque choisie.'],
      },
      {
        title: 'Addition : C et Z',
        bullets: [
          '200 + 100 = 300 ne tient pas sur 8 bits (max 255) : le PIC garde 300 − 256 = 44 et met C = 1. Z = 0, DC = 0. STATUS = 0x19 (25), comme dans la fenêtre MPLAB du cours.',
          '250 + 6 = 256 → résultat 0 : C = 1, Z = 1, DC = 1 (0xA + 0x6 dépasse 15). STATUS = 0x1F (31).',
        ],
      },
      {
        title: 'Soustraction : attention au bit C',
        paragraphs: [
          'Après une soustraction (SUBWF, SUBLW), C = 1 veut dire qu’il n’y a PAS eu d’emprunt : le premier nombre est plus grand ou égal. C = 0 veut dire qu’il y a eu un emprunt : le premier nombre est plus petit. Le support (p. 7) dit l’inverse : c’est une erreur, le TP STATUS lui-même utilise le vrai comportement.',
          'Exemple : 5 − 6 = −1 → sur 8 bits 255 (0xFF), C = 0 (emprunt), Z = 0. 6 − 5 = 1 → C = 1, Z = 0. 5 − 5 = 0 → C = 1, Z = 1.',
        ],
      },
      {
        title: 'Comparer x et y (TP STATUS)',
        code: 'z = x - y;                             // Soustraction\nif (STATUS.F2 == 1) { LED_ON(LED_EGAL); }     // Z = 1 : x = y\nelse if (STATUS.F0 == 1) { LED_ON(LED_SUP); } // C = 1 : x > y\nelse { LED_ON(LED_INF); }                     // x < y',
        paragraphs: ['L’ordre compte : Z d’abord, puis C dans un else if. Quand x = y, Z et C valent 1 tous les deux : avec deux if séparés, deux LEDs s’allument.'],
      },
      {
        title: 'Afficheur 7 segments (sans décodeur)',
        paragraphs: [
          'Sept LEDs a à g, une par broche : a sur RB0 … g sur RB6, active à 1. Pour « H » : g f e d c b a = 1 1 1 0 1 1 0, soit PORTB = 0x76. « E » = 0x79, « 0 » = 0x3F (le cours écrit 0xBF : RB7 n’est pas branché, ça ne change rien).',
          'Attention : dans la table du cours, la ligne « A » vaut 0x37, il manque le segment g ; la bonne valeur est 0x77.',
        ],
      },
      {
        title: 'Afficheur 7 segments BCD',
        paragraphs: [
          'Il contient un décodeur : on lui envoie juste le nombre sur 4 bits E3 E2 E1 E0 (E3 à gauche = poids fort). Il affiche 0 à 9, puis A, b, C, d, E, F pour 10 à 15.',
          'Avec E0..E3 sur RB0..RB3 : PORTB = 0x0A affiche « A ». Écrire tout PORTB change aussi RB4 à RB7.',
        ],
      },
      {
        title: 'Cycles d’instruction',
        paragraphs: [
          '1 cycle d’instruction = 4 périodes d’horloge. À 4 MHz : 1 µs ; à 1 MHz (fichiers ISIS du cours) : 4 µs ; à 8 MHz : 0,5 µs.',
          'Presque toutes les instructions durent 1 cycle ; les sauts (GOTO, CALL, RETURN, RETFIE, RETLW) et un saut conditionnel réalisé (BTFSC, BTFSS, DECFSZ, INCFSZ) durent 2 cycles.',
        ],
      },
    ],
    keyPoints: [
      'Z = 1 : résultat nul. Après z = x − y : Z = 1 ⇔ x = y.',
      'Après une soustraction, C = 1 ⇔ pas d’emprunt ⇔ x ≥ y. C = 0 ⇔ x < y.',
      'Tester Z puis C avec else if. Un 7SEG-BCD affiche directement la valeur de 4 bits.',
    ],
    templates: ['tp-status', 'tp-vote'],
  },
  {
    id: 'ch4', number: '4', title: 'Mémoire de programme, PC et pile',
    summary: 'L’UAL et W, la mémoire Flash de 1K × 14 bits, les vecteurs 0000h / 0004h, le compteur ordinal, la pile à 8 niveaux, le format des instructions.',
    sections: [
      {
        title: 'UAL et registre W',
        paragraphs: [
          'Le cœur du PIC est une UAL 8 bits (unité arithmétique et logique) avec un seul accumulateur, W (Working register). Les calculs entre deux valeurs passent par W (ADDWF, SUBWF, ANDWF…) ; certaines instructions travaillent directement sur un registre (BSF, BCF, INCF, CLRF).',
          'Les instructions de calcul mettent à jour certains bits de STATUS : ADDWF et SUBWF changent C, DC et Z ; INCF, DECF, ANDWF, IORWF, MOVF, CLRF… ne changent que Z. MOVWF, MOVLW, BCF, BSF, SWAPF, GOTO, CALL ne changent aucun drapeau : c’est pour cela que « z = x − y; » garde les drapeaux de la soustraction pour le test qui suit.',
        ],
      },
      {
        title: 'La mémoire de programme (Flash)',
        bullets: [
          '1K mots = 1024 instructions de 14 bits, adresses 0000h à 03FFh. Reprogrammable (environ 1000 fois).',
          '0000h : vecteur de reset (le programme démarre là). 0004h : vecteur d’interruption, unique.',
          'Bus d’adresse d’instruction : 13 bits (8K adressables, seul 1K existe) ; bus d’instruction : 14 bits.',
        ],
      },
      {
        title: 'Compteur ordinal (PC) et pile',
        bullets: [
          'Le PC (13 bits) contient toujours l’adresse de la PROCHAINE instruction à exécuter.',
          'La pile a 8 niveaux de 13 bits, hors de la RAM. CALL range l’adresse de retour dans la pile ; RETURN, RETLW et RETFIE la reprennent. Une interruption empile aussi le PC.',
          'Au 9e appel imbriqué, la première adresse de retour est écrasée : le programme se perd.',
        ],
      },
      {
        title: 'Registre d’instruction et décodeur',
        paragraphs: [
          'L’instruction lue en Flash (adresse donnée par le PC) est copiée dans le registre d’instruction (14 bits) : c’est la phase d’extraction. Le décodeur l’analyse (opération, opérandes, destination) et commande l’exécution.',
        ],
      },
      {
        title: 'Format des instructions (14 bits)',
        table: {
          head: ['Type', 'Format', 'Exemple'],
          rows: [
            ['Orientée octet', 'opcode (6) | d (1) | f (7)', 'ADDWF f, d — d = 0 : résultat dans W, d = 1 : dans f'],
            ['Orientée bit', 'opcode (4) | b (3) | f (7)', 'BSF PORTB, 1'],
            ['Littéral', 'opcode (6) | k (8)', 'MOVLW 0x8C'],
            ['CALL / GOTO', 'opcode (3) | k (11)', 'GOTO 0x01F'],
          ],
        },
        code: '// En C :\nREGISTRE = 0x8C;\n; En assembleur :\nMOVLW 0x8C        ; W ← 0x8C\nMOVWF REGISTRE    ; REGISTRE ← W',
      },
    ],
    keyPoints: [
      'W est le seul accumulateur ; l’UAL met à jour STATUS.',
      'Flash 1K × 14 bits ; reset en 0000h, interruption en 0004h.',
      'PC 13 bits = adresse de la prochaine instruction ; pile de 8 niveaux pour CALL / RETURN.',
    ],
    templates: ['tp-traffic', 'tp-pupitre'],
  },
  {
    id: 'ch5', number: '5', title: 'Interruption externe RB0/INT',
    summary: 'Interrompre le programme principal sur un front de RB0 : les 4 sources, INTCON (GIE, INTE, INTF), OPTION_REG.INTEDG, le saut en 0004h et l’organigramme à deux colonnes.',
    status: 'Vu en cours (Chapitre « Les interruptions externes », INTERRUPTIONS_e2026.pptx, TP4 INTE).',
    sections: [
      {
        title: 'Définition (à savoir réciter)',
        paragraphs: [
          'Une interruption est un signal généré par un événement interne ou externe, qui provoque la suspension temporaire du programme en cours d’exécution au profit d’un programme plus important ou urgent. Une fois l’interruption traitée, le programme interrompu reprend son exécution à l’endroit exact où il avait été arrêté.',
          'Jusqu’ici, les fonctions étaient appelées par le programme. La routine d’interruption est appelée par un événement, à n’importe quel endroit du programme principal. L’exécution d’une instruction n’est jamais interrompue : le PIC la termine d’abord.',
          'Sans interruption, il faudrait tester le bouton dans la boucle (scrutation) : un appui court pendant un Delay_ms serait perdu. Exemples du cours : capteurs de fumée, de gaz, de flamme.',
        ],
      },
      {
        title: 'Les 4 sources du PIC16F84A',
        table: {
          head: ['Source', 'Type', 'Événement', 'Bits'],
          rows: [
            ['RB0/INT', 'Externe', 'Changement d’état de RB0 (en entrée), sur le front choisi', 'INTE, INTF, INTEDG'],
            ['PORTB', 'Externe', 'Changement de niveau d’une des broches RB4 à RB7 en entrée', 'RBIE, RBIF'],
            ['TMR0', 'Interne', 'Débordement du timer : 0xFF → 0x00', 'T0IE, T0IF'],
            ['EEPROM', 'Interne', 'Fin d’écriture dans l’EEPROM', 'EEIE, EEIF (dans EECON1)'],
          ],
        },
        bullets: [
          'Deux conditions pour qu’une interruption parte : l’événement est une des sources, ET l’utilisateur l’a autorisée (son bit Enable et GIE).',
          'Le drapeau (Flag) passe à 1 à chaque événement, même si l’Enable vaut 0 : c’est l’Enable qui décide du saut.',
        ],
      },
      {
        title: 'Les bits à régler',
        table: {
          head: ['Bit', 'Registre', 'Rôle'],
          rows: [
            ['GIE', 'INTCON.7', 'Interrupteur général : 1 = interruptions autorisées'],
            ['INTE', 'INTCON.4', 'Autorise l’interruption RB0/INT'],
            ['INTF', 'INTCON.1', 'Drapeau : passe à 1 quand le front arrive. À effacer dans la routine'],
            ['INTEDG', 'OPTION_REG.6', '1 = front montant (0 → 1), 0 = front descendant (1 → 0)'],
          ],
        },
        paragraphs: [
          'INTCON, du bit 7 au bit 0 : GIE, EEIE, T0IE, INTE, RBIE, T0IF, INTF, RBIF (« GE · TIR · TIR » : GIE, puis les Enables E-T-I-R, puis les Flags T-I-R). RB0 seule : INTCON = 0x90.',
        ],
      },
      {
        title: 'Front et résistance de rappel',
        bullets: [
          'Une entrée ne doit jamais flotter : une résistance de rappel fixe son niveau au repos.',
          'Pull-down (résistance vers la masse, bouton vers +5 V) : repos = 0, appui = 1, l’appui fait un front montant → INTEDG = 1. C’est le montage des TP.',
          'Pull-up (résistance vers +5 V, bouton vers la masse) : repos = 1, appui = 0 → INTEDG = 0 pour réagir à l’appui.',
        ],
      },
      {
        title: 'Ce qui se passe',
        bullets: [
          'L’événement met le drapeau à 1. Si l’interruption est autorisée, le PIC finit l’instruction en cours, sauvegarde le PC dans la pile, le remplace par 0004h et met GIE à 0 (pas d’autre interruption pendant la routine).',
          'Seul le PC est sauvegardé automatiquement par le matériel (en MikroC, le compilateur sauvegarde aussi W et STATUS dans void interrupt()).',
          'La routine teste le drapeau, fait son travail et remet le drapeau à 0 à la main ; sinon l’interruption se relance dès la sortie.',
          'À la fin (RETFIE), GIE repasse à 1 et le PC est restauré depuis la pile : le programme reprend où il s’était arrêté.',
        ],
        code: 'void interrupt() {\n    if (INTCON.INTF == 1) {\n        // traitement urgent (ex. : LED qui clignote 3 fois)\n        INTCON.INTF = 0;      // remettre le drapeau à zéro\n    }\n}\n// dans main(), configuration :\nTRISB.RB0 = 1;           // RB0 en entrée\nINTCON.GIE = 1;          // autoriser les interruptions\nINTCON.INTE = 1;         // autoriser RB0/INT\nOPTION_REG.INTEDG = 1;   // front montant',
      },
      {
        title: 'L’organigramme avec interruption',
        bullets: [
          'Deux organigrammes côte à côte : le programme principal (Début, CONFIGURATION avec GIE = 1, INTE = 1, INTEDG = 1, INITIALISATION, boucle infinie) et la ROUTINE D’INTERRUPTION (Début, traitement, INTF = 0, Fin).',
          'Ils sont reliés par le drapeau (« INTF = 1 », « Changement d’état de RB0 »), jamais par un appel dans la boucle.',
          'Le programme principal ne contient aucun test du bouton : c’est ce qui le distingue de la version sans interruption.',
        ],
      },
    ],
    keyPoints: [
      'Il faut GIE = 1 ET INTE = 1 ; le drapeau INTF doit être effacé dans la routine.',
      'Entrée en interruption : PC empilé, GIE ← 0, PC ← 0004h. Sortie : RETFIE (GIE ← 1, PC dépilé).',
      'Pull-down → INTEDG = 1 (appui = front montant) ; pull-up → INTEDG = 0.',
      '4 sources : RB0/INT et RB4–RB7 (externes), TMR0 et EEPROM (internes).',
    ],
    templates: ['tp4-inte', 'ch5-manip-rb0', 'tp-traffic-int', 'tp5-int-rb0'],
  },
  {
    id: 'ch6', number: '6', title: 'Interruption sur changement du PORTB (RB4–RB7)',
    summary: 'L’interruption sur changement d’état de RB4 à RB7 : RBIE, RBIF, lire PORTB pour savoir quel bouton a bougé. TMR0 viendra avec le projet.',
    status: 'Vu en cours (fin du chapitre « Les interruptions externes », exercice d’application). TMR0 : séances projet 9–10.',
    sections: [
      {
        title: 'Changement d’état sur RB4 à RB7',
        bullets: [
          'RBIE (INTCON.3) autorise l’interruption ; RBIF (INTCON.0) passe à 1 quand au moins une des broches RB4 à RB7 configurées en entrée change de niveau. Seules les broches en entrée comptent.',
          'Configuration : INTCON.GIE = 1 et INTCON.RBIE = 1, soit INTCON = 0x88 ; TRISB = 0xF0 pour RB4–RB7 en entrée.',
          'Il n’y a pas de choix de front : l’interruption part à l’appui ET au relâchement (INTEDG ne concerne que RB0).',
          'Un seul drapeau pour 4 broches : dans la routine, lire PORTB.RB4 … PORTB.RB7 pour savoir quel bouton a bougé.',
          'Lire PORTB d’abord (cela met fin à la condition de changement), puis effacer RBIF par logiciel. Sinon RBIF revient aussitôt.',
        ],
        code: 'void interrupt() {\n    if (INTCON.RBIF == 1) {\n        if (PORTB.RB4 == 1) { PORTA = 4; Delay_ms(500); }\n        else if (PORTB.RB5 == 1) { PORTA = 5; Delay_ms(500); }\n        // … RB6, RB7\n        INTCON.RBIF = 0;   // après la lecture de PORTB\n    }\n}',
      },
      {
        title: 'Pour plus tard : le timer TMR0',
        paragraphs: [
          'TMR0 est cité dans les 4 sources ; il est étudié avec le projet (séances 9 et 10). C’est un compteur 8 bits qui déborde de 255 à 0 et met T0IF à 1 ; T0IE autorise l’interruption ; le prédiviseur (PSA = 0, PS2:PS0) ralentit le comptage de 1:2 à 1:256.',
          'À 1 MHz, un cycle dure 4 µs. Avec un prédiviseur de 1:256, TMR0 avance toutes les 256 × 4 µs = 1,024 ms et déborde après 256 pas, soit environ 262 ms.',
        ],
      },
    ],
    keyPoints: [
      'RBIE + GIE (INTCON = 0x88) ; RB4–RB7 en entrée.',
      'Interruption à l’appui et au relâchement : tester quel bouton est à 1.',
      'RBIF : lire PORTB, puis effacer le drapeau.',
    ],
    templates: ['ch6-exo-rbie', 'tp6-rbie'],
  },
];

// ---------------------------------------------------------------------------------------------------------------
// Révision DS

export interface ExamQuestion {
  topic: string;
  question: string;
  answer: string;
}

/** The prof's organigramme rules (TP STATUS slide 6 and « Organigramme général »). */
export const ORGANIGRAMME_RULES: readonly string[] = [
  'Début : un petit cercle vide, avec « Début » à droite. Fin : une cible (cercle avec un disque noir), avec « Fin » à droite, même après une boucle infinie.',
  'CONFIGURATION (rectangle jaune) : en phrases, jamais en registres (« RB0,RB1 et RB2 sont des sorties », « Déclaration des variables »).',
  'INITIALISATION (rectangle orange) : les valeurs de départ (« x=5 et y = 6 », « Les Leds sont éteintes »).',
  'Actions (rectangles verts) : ce que fait le programme, en français (« Led égalité allumée », « Z= x-y »). On écrit = pour donner une valeur, jamais ←.',
  'Tests (losanges bleus, texte blanc) : la condition écrite comme en C avec == (« ZERO==1 », « L0==1 »), sans point d’interrogation. « oui » sort en bas, « non » sort à droite.',
  'Une chaîne if / else if / else descend en diagonale vers la droite ; chaque branche rejoint l’axe principal.',
  'La boucle infinie : une ligne de retour à gauche qui remonte au début du traitement, avec l’étiquette « Boucle infinie ».',
  'Chaque exigence de l’énoncé doit apparaître dans l’organigramme (un rectangle ou un losange) : c’est ce qui est noté.',
];

export const DS_QUESTIONS: readonly ExamQuestion[] = [
  { topic: 'Généralités', question: 'Combien d’instructions possède le PIC16F84A ? Sur combien de bits sont-elles codées ?', answer: '35 instructions (architecture RISC), codées sur 14 bits (famille Mid-Range).' },
  { topic: 'Généralités', question: 'Que signifie « PIC 16F84-20 » ?', answer: '16 : famille Mid-Range (instructions de 14 bits) ; F : mémoire Flash ; 84 : type ; 20 : quartz de 20 MHz au maximum.' },
  { topic: 'Architecture', question: 'Qu’est-ce que l’architecture Harvard ? Quel avantage ?', answer: 'Mémoire de programme et mémoire de données séparées, avec des bus séparés. Le PIC lit l’instruction suivante pendant qu’il accède aux données, et les instructions (14 bits) peuvent être plus larges que les données (8 bits).' },
  { topic: 'Architecture', question: 'Quelle est la taille de la mémoire de programme ? Où sont les vecteurs ?', answer: '1K mots de 14 bits (0000h à 03FFh). Vecteur de reset : 0000h. Vecteur d’interruption : 0004h.' },
  { topic: 'Architecture', question: 'Taille du PC et de la pile ?', answer: 'PC sur 13 bits (8K adressables, 1K implémenté), il contient l’adresse de la prochaine instruction. Pile de 8 niveaux de 13 bits.' },
  { topic: 'Mémoire', question: 'Décrire la mémoire de données.', answer: 'RAM : 68 octets de GPR (0x0C à 0x4F) + les SFR, en 2 banques de 128 octets choisies par RP0 (STATUS.5). EEPROM : 64 octets non volatiles.' },
  { topic: 'Mémoire', question: 'Pourquoi le compilateur met-il RP0 à 1 avant d’écrire TRISB ?', answer: 'TRISA, TRISB et OPTION_REG sont en banque 1 (85h, 86h, 81h) ; PORTA et PORTB sont en banque 0. RP0 = 1 sélectionne la banque 1.' },
  { topic: 'Cycles', question: 'Durée d’un cycle d’instruction avec un quartz de 4 MHz ? de 1 MHz ?', answer: '1 cycle = 4 périodes d’horloge : 4 / 4 MHz = 1 µs ; 4 / 1 MHz = 4 µs.' },
  { topic: 'Cycles', question: 'Combien de cycles prennent GOTO, CALL et BTFSS ?', answer: 'GOTO et CALL : 2 cycles. BTFSS : 1 cycle, ou 2 si le saut a lieu (le bit vaut 1).' },
  { topic: 'Cycles', question: 'Comment calculer la durée d’un morceau de programme ?', answer: 'Compter les cycles de chaque instruction exécutée (1, ou 2 pour les sauts), y compris les tours de boucle, puis multiplier par la durée d’un cycle (4 / f_osc).' },
  { topic: 'Entrées / sorties', question: 'Que fait TRISB = 0x0F ?', answer: '0x0F = 0000 1111 : RB0 à RB3 en entrée (bits à 1), RB4 à RB7 en sortie (bits à 0).' },
  { topic: 'Entrées / sorties', question: 'Pourquoi une LED reliée de RA4 vers la masse ne s’allume pas ?', answer: 'RA4 est à drain ouvert : elle peut tirer la broche à 0 mais pas fournir 5 V. Il faut une résistance de pull-up, ou brancher la LED entre +5 V et RA4.' },
  { topic: 'STATUS', question: 'Valeurs de C, DC et Z après 200 + 100 sur 8 bits ?', answer: 'Résultat 44 (300 − 256). C = 1 (dépassement), DC = 0 (8 + 4 = 12 ≤ 15), Z = 0. STATUS = 0x19.' },
  { topic: 'STATUS', question: 'Valeurs de C et Z après x − y avec x = 5 et y = 6 ?', answer: 'Résultat 0xFF (255). C = 0 car il y a eu un emprunt (x < y), Z = 0 car le résultat n’est pas nul.' },
  { topic: 'STATUS', question: 'Comment comparer deux nombres x et y ?', answer: 'z = x − y, puis : si Z = 1 → x = y ; sinon si C = 1 → x > y ; sinon → x < y. Tester Z avant C, avec else if.' },
  { topic: 'STATUS', question: 'Que vaut Z après CLRF STATUS (STATUS = 0 en C) ?', answer: 'Z = 1 : CLRF donne toujours un résultat nul, et ce Z = 1 est écrit après l’effacement.' },
  { topic: 'Assembleur', question: 'Traduire REGISTRE = 0x8C; en assembleur.', answer: 'MOVLW 0x8C (W ← 0x8C), puis MOVWF REGISTRE (REGISTRE ← W).' },
  { topic: 'Assembleur', question: 'Différence entre GOTO et CALL ?', answer: 'Les deux sautent à une adresse, mais CALL range d’abord l’adresse de retour dans la pile ; RETURN y revient. GOTO ne range rien.' },
  { topic: 'Assembleur', question: 'Que fait SUBWF f, W ?', answer: 'W ← f − W. C = 1 s’il n’y a pas d’emprunt (f ≥ W), C = 0 sinon ; Z = 1 si le résultat est nul.' },
  { topic: 'Afficheurs', question: 'Quelle valeur envoyer sur PORTB pour afficher « H » sur un 7 segments (a sur RB0 … g sur RB6) ?', answer: 'g f e d c b a = 1 1 1 0 1 1 0 → PORTB = 0x76 (0b01110110).' },
  { topic: 'Afficheurs', question: 'Différence entre un afficheur 7 segments et un 7SEG-BCD ?', answer: 'Le 7 segments simple reçoit un bit par segment (7 broches). Le 7SEG-BCD a un décodeur : il reçoit le nombre sur 4 bits (E3..E0) et affiche 0–9, A–F.' },
  { topic: 'Interruptions', question: 'Que fait le PIC quand une interruption arrive ?', answer: 'Il finit l’instruction en cours, empile le PC, met GIE à 0 et saute à 0004h. À la fin, RETFIE dépile l’adresse et remet GIE à 1.' },
  { topic: 'Interruptions', question: 'Définir une interruption.', answer: 'Un signal généré par un événement interne ou externe qui suspend temporairement le programme en cours pour exécuter un programme plus urgent ; ensuite le programme reprend à l’endroit exact où il s’était arrêté.' },
  { topic: 'Interruptions', question: 'Quelles sont les sources d’interruption du PIC16F84A ?', answer: '4 sources : 2 externes (changement d’état de RB0/INT ; changement de niveau sur RB4 à RB7) et 2 internes (débordement de TMR0 ; fin d’écriture en EEPROM).' },
  { topic: 'Interruptions', question: 'Quelle valeur donner à INTCON pour l’interruption RB0 seule ? pour RB4–RB7 seule ?', answer: 'RB0 : GIE (bit 7) + INTE (bit 4) = 1001 0000 = 0x90. RB4–RB7 : GIE + RBIE (bit 3) = 1000 1000 = 0x88.' },
  { topic: 'Interruptions', question: 'Bouton vers +5 V avec une résistance de 10k vers la masse sur RB0 : quelle valeur pour INTEDG ?', answer: 'Résistance vers la masse = pull-down : repos 0, appui 1. L’appui fait un front montant, donc OPTION_REG.INTEDG = 1.' },
  { topic: 'Interruptions', question: 'Pourquoi remettre INTF à 0 dans la routine ? Qui le met à 1 ?', answer: 'Le matériel le met à 1 à chaque front. S’il reste à 1, l’interruption repart dès le retour (RETFIE) : la routine tourne sans fin et le programme principal est bloqué.' },
  { topic: 'Interruptions', question: 'Combien d’interruptions provoque un appui puis un relâchement d’un bouton sur RB5 (RBIE) ?', answer: 'Deux : RBIF passe à 1 à chaque changement de niveau, à l’appui et au relâchement. Il n’y a pas de choix de front pour RB4–RB7.' },
  { topic: 'Organigramme', question: 'Quelles sont les règles de l’organigramme du cours ?', answer: 'Début (cercle) → CONFIGURATION (jaune) → INITIALISATION (orange) → actions (vert) et tests (losanges bleus, « oui » en bas, « non » à droite) dans la boucle infinie (retour à gauche) → Fin (cible).' },
];

export function chapterById(id: string): Chapter | undefined {
  return CHAPTERS.find((c) => c.id === id);
}

/** Chapter a template belongs to. */
export function chapterOfTemplate(templateId: string): Chapter | undefined {
  return CHAPTERS.find((c) => c.templates.includes(templateId));
}
