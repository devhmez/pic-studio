// « Glossaire »: every word of the course a struggling student may stumble on, with a short definition and, when
// useful, a few more lines. Searchable without accents (« pull up », « drapeau », « INTEDG »…).
import { fold } from './text';

export type GlossaryCategory = 'Registre' | 'Bit' | 'Notion' | 'Composant' | 'Langage C' | 'Organigramme' | 'Assembleur';

export interface GlossaryEntry {
  id: string;
  term: string;
  /** Other spellings searched too. */
  aliases?: readonly string[];
  category: GlossaryCategory;
  /** One-line definition. */
  short: string;
  /** Further explanation. */
  body?: readonly string[];
  /** Related entry ids. */
  see?: readonly string[];
}

const e = (entry: GlossaryEntry): GlossaryEntry => entry;

export const GLOSSARY: readonly GlossaryEntry[] = [
  // ------------------------------------------------------------------ registres
  e({ id: 'w', term: 'W (registre de travail)', aliases: ['accumulateur', 'working register', 'W'], category: 'Registre',
    short: 'Le seul accumulateur du PIC : presque tous les calculs passent par W.',
    body: ['Exemple : x = 5 devient MOVLW 5 (W ← 5) puis MOVWF x (x ← W). W n’a pas d’adresse dans la RAM.'], see: ['ual', 'status'] }),
  e({ id: 'pc', term: 'PC (compteur ordinal)', aliases: ['program counter', 'compteur de programme'], category: 'Registre',
    short: 'Registre de 13 bits qui contient l’adresse de la PROCHAINE instruction à exécuter.',
    body: ['Il avance de 1 à chaque instruction ; GOTO, CALL, RETURN et les interruptions le modifient. Son octet bas est lisible dans PCL.'], see: ['pile', 'vecteur'] }),
  e({ id: 'pile', term: 'Pile', aliases: ['stack', 'pile matérielle'], category: 'Notion',
    short: '8 cases où le PIC range les adresses de retour (CALL, interruption) ; RETURN / RETFIE les reprennent.',
    body: ['C’est une pile LIFO : la dernière adresse rangée est la première reprise. Au 9e appel imbriqué, la plus ancienne adresse est écrasée.'], see: ['pc', 'interruption'] }),
  e({ id: 'trisa', term: 'TRISA', category: 'Registre',
    short: 'Direction des broches RA0 à RA4 : bit à 1 = entrée, bit à 0 = sortie.',
    body: ['Adresse 85h (banque 1). Après un reset, TRISA = 0x1F : toutes les broches sont des entrées. Exemple : TRISA.RA0 = 0 met RA0 en sortie.'], see: ['porta', 'banque'] }),
  e({ id: 'trisb', term: 'TRISB', category: 'Registre',
    short: 'Direction des broches RB0 à RB7 : bit à 1 = entrée, bit à 0 = sortie.',
    body: ['Adresse 86h (banque 1). Après un reset, TRISB = 0xFF. TRISB = 0x00 met tout le PORTB en sortie.'], see: ['portb', 'banque'] }),
  e({ id: 'porta', term: 'PORTA', aliases: ['RA0', 'RA1', 'RA2', 'RA3', 'RA4'], category: 'Registre',
    short: 'Les 5 broches RA0 à RA4 : on y lit les entrées et on y écrit les sorties.',
    body: ['Adresse 05h (banque 0). RA4 est à drain ouvert et sert aussi d’entrée au timer (T0CKI). Notations : PORTA.RA0, PORTA.F0.'], see: ['trisa', 'open-drain'] }),
  e({ id: 'portb', term: 'PORTB', aliases: ['RB0', 'RB7'], category: 'Registre',
    short: 'Les 8 broches RB0 à RB7 : lecture des entrées, écriture des sorties.',
    body: ['Adresse 06h (banque 0). RB0 sert aussi d’entrée d’interruption (INT) ; RB4 à RB7 peuvent déclencher une interruption quand elles changent ; PORTB a des pull-up internes (bit /RBPU).'], see: ['trisb', 'pull-up', 'interruption'] }),
  e({ id: 'status', term: 'STATUS', aliases: ['registre d’état'], category: 'Registre',
    short: 'Registre d’état : drapeaux du dernier calcul (C, DC, Z), état après reset (/TO, /PD) et choix de banque (RP0).',
    body: ['Bits, du 7 au 0 : IRP, RP1, RP0, /TO, /PD, Z, DC, C. Adresse 03h et 83h : accessible dans les deux banques. En MikroC : STATUS.F2 = Z, STATUS.F0 = C.'], see: ['carry', 'zero', 'dc', 'rp0', 'to', 'pd'] }),
  e({ id: 'intcon', term: 'INTCON', category: 'Registre',
    short: 'Contrôle des interruptions : autorisations (GIE, EEIE, T0IE, INTE, RBIE) et drapeaux (T0IF, INTF, RBIF).',
    body: ['Bits, du 7 au 0 : GIE, EEIE, T0IE, INTE, RBIE, T0IF, INTF, RBIF. Adresse 0Bh / 8Bh.'], see: ['gie', 'inte', 'intf', 'rbie', 'rbif', 't0ie', 't0if'] }),
  e({ id: 'option_reg', term: 'OPTION_REG', aliases: ['OPTION'], category: 'Registre',
    short: 'Options : pull-up de PORTB (/RBPU), front de RB0/INT (INTEDG), réglage de TMR0 (T0CS, T0SE) et du prédiviseur (PSA, PS2:PS0).',
    body: ['Adresse 81h (banque 1). Après un reset, OPTION_REG = 0xFF.'], see: ['rbpu', 'intedg', 't0cs', 'psa', 'prediviseur'] }),
  e({ id: 'tmr0', term: 'TMR0 (timer 0)', aliases: ['timer', 'temporisateur'], category: 'Registre',
    short: 'Compteur 8 bits qui avance tout seul ; en passant de 255 à 0 (débordement) il met T0IF à 1.',
    body: ['Il compte les cycles d’instruction (T0CS = 0) ou les fronts sur RA4/T0CKI (T0CS = 1), éventuellement divisés par le prédiviseur.'], see: ['prediviseur', 't0if', 't0cs'] }),
  e({ id: 'fsr', term: 'FSR et INDF', aliases: ['adressage indirect', 'INDF'], category: 'Registre',
    short: 'Adressage indirect : FSR contient une adresse, INDF donne accès à la case pointée.' }),
  e({ id: 'eeprom', term: 'EEPROM de données', aliases: ['EEDATA', 'EEADR', 'EECON1'], category: 'Notion',
    short: '64 octets qui gardent leur valeur sans alimentation (non volatile), plus lents que la RAM.',
    body: ['Une écriture dure environ 10 ms. En MikroC : EEPROM_Write(adresse, valeur), EEPROM_Read(adresse).'] }),

  // ------------------------------------------------------------------ bits de STATUS
  e({ id: 'carry', term: 'C (Carry, retenue)', aliases: ['carry', 'retenue', 'emprunt', 'C'], category: 'Bit',
    short: 'Bit 0 de STATUS. Addition : 1 si le résultat dépasse 255. Soustraction : 1 s’il n’y a PAS eu d’emprunt.',
    body: ['Après z = x − y : C = 1 ⇔ x ≥ y ; C = 0 ⇔ x < y. Le support du cours (p. 7) dit l’inverse pour la soustraction : c’est une erreur, le PIC fonctionne comme ici.', 'RLF / RRF font aussi passer un bit par C.'], see: ['status', 'zero'] }),
  e({ id: 'zero', term: 'Z (Zero)', aliases: ['zéro', 'ZERO', 'Z'], category: 'Bit',
    short: 'Bit 2 de STATUS : vaut 1 quand le résultat de la dernière opération est nul.',
    body: ['Après z = x − y : Z = 1 ⇔ x = y. Attention : CLRF met toujours Z à 1, même CLRF STATUS.'], see: ['status', 'carry'] }),
  e({ id: 'dc', term: 'DC (Digit Carry)', aliases: ['retenue décimale', 'DC'], category: 'Bit',
    short: 'Bit 1 de STATUS : retenue du bit 3 vers le bit 4 (entre les deux quartets), utile en BCD.',
    body: ['Comme C, il veut dire « pas d’emprunt » après une soustraction.'] }),
  e({ id: 'pd', term: '/PD (Power-down)', aliases: ['PD'], category: 'Bit',
    short: 'Bit 3 de STATUS, actif à 0 : passe à 0 après l’instruction SLEEP. Lecture seule.' }),
  e({ id: 'to', term: '/TO (Time-out)', aliases: ['TO'], category: 'Bit',
    short: 'Bit 4 de STATUS, actif à 0 : passe à 0 quand le chien de garde déborde. Lecture seule.', see: ['wdt'] }),
  e({ id: 'rp0', term: 'RP0', category: 'Bit',
    short: 'Bit 5 de STATUS : choix de la banque de RAM (0 = banque 0, 1 = banque 1).', see: ['banque'] }),
  e({ id: 'rp1', term: 'RP1 et IRP', aliases: ['IRP', 'RP1'], category: 'Bit',
    short: 'Bits 6 et 7 de STATUS : inutilisés sur le PIC16F84A (servent sur les PIC à 4 banques). Il faut les laisser à 0 (le programme pourrait les écrire, rien ne les force).' }),
  e({ id: 'banque', term: 'Banque (bank)', aliases: ['bancarisation', 'bank'], category: 'Notion',
    short: 'La RAM est coupée en 2 banques de 128 octets ; RP0 choisit celle à laquelle les instructions accèdent.',
    body: ['Banque 0 : PORTA, PORTB, TMR0… ; banque 1 : TRISA, TRISB, OPTION_REG. STATUS, INTCON, PCLATH, FSR et les variables sont visibles dans les deux. Le compilateur change de banque tout seul (BSF / BCF STATUS, RP0).'], see: ['rp0'] }),

  // ------------------------------------------------------------------ bits INTCON / OPTION_REG
  e({ id: 'gie', term: 'GIE', category: 'Bit', short: 'INTCON.7 : interrupteur général des interruptions (1 = autorisées).',
    body: ['Le PIC le met à 0 en entrant dans une interruption ; RETFIE le remet à 1.'], see: ['interruption', 'intcon'] }),
  e({ id: 'eeie', term: 'EEIE', category: 'Bit', short: 'INTCON.6 : autorise l’interruption de fin d’écriture EEPROM.' }),
  e({ id: 't0ie', term: 'T0IE', aliases: ['TMR0IE'], category: 'Bit', short: 'INTCON.5 : autorise l’interruption de débordement de TMR0.' }),
  e({ id: 'inte', term: 'INTE', category: 'Bit', short: 'INTCON.4 : autorise l’interruption externe sur RB0/INT.', see: ['intf', 'intedg'] }),
  e({ id: 'rbie', term: 'RBIE', category: 'Bit', short: 'INTCON.3 : autorise l’interruption sur changement d’état de RB4 à RB7.', see: ['rbif'] }),
  e({ id: 't0if', term: 'T0IF', aliases: ['TMR0IF'], category: 'Bit', short: 'INTCON.2 : drapeau mis à 1 quand TMR0 déborde (255 → 0). À effacer par le programme.' }),
  e({ id: 'intf', term: 'INTF', category: 'Bit', short: 'INTCON.1 : drapeau mis à 1 par un front sur RB0/INT. À effacer dans la routine d’interruption.', see: ['inte', 'intedg'] }),
  e({ id: 'rbif', term: 'RBIF', category: 'Bit', short: 'INTCON.0 : drapeau mis à 1 quand une entrée RB4 à RB7 change. Lire PORTB, puis l’effacer.' }),
  e({ id: 'rbpu', term: '/RBPU', aliases: ['RBPU'], category: 'Bit', short: 'OPTION_REG.7, actif à 0 : /RBPU = 0 active les résistances de pull-up internes de PORTB.', see: ['pull-up'] }),
  e({ id: 'intedg', term: 'INTEDG', category: 'Bit', short: 'OPTION_REG.6 : front qui déclenche RB0/INT (1 = montant, 0 = descendant).', see: ['front'] }),
  e({ id: 't0cs', term: 'T0CS et T0SE', aliases: ['T0SE', 'T0CS'], category: 'Bit',
    short: 'OPTION_REG.5 (T0CS) : source de TMR0 (0 = cycles d’instruction, 1 = broche RA4/T0CKI). OPTION_REG.4 (T0SE) : front compté sur RA4.' }),
  e({ id: 'psa', term: 'PSA et PS2:PS0', aliases: ['PS0', 'PS1', 'PS2', 'PSA'], category: 'Bit',
    short: 'OPTION_REG.3 (PSA) : prédiviseur affecté à TMR0 (0) ou au chien de garde (1). PS2:PS0 : rapport de division.', see: ['prediviseur'] }),
  e({ id: 'prediviseur', term: 'Prédiviseur', aliases: ['prescaler'], category: 'Notion',
    short: 'Diviseur placé avant TMR0 (ou le chien de garde) : il ne laisse passer qu’une impulsion sur 2, 4… 256.',
    body: ['Pour TMR0, PS2:PS0 = 000 → 1:2 … 111 → 1:256. À 1 MHz avec 1:256, TMR0 déborde toutes les 256 × 256 × 4 µs ≈ 262 ms.'] }),

  // ------------------------------------------------------------------ notions
  e({ id: 'interruption', term: 'Interruption', aliases: ['interrupt', 'ISR', 'RETFIE'], category: 'Notion',
    short: 'Événement qui suspend le programme principal pour exécuter la fonction interrupt(), puis le reprend où il en était.',
    body: ['Il faut le drapeau, son autorisation et GIE à 1. Le PIC empile le PC, met GIE à 0 et saute à 0004h. RETFIE dépile et remet GIE à 1. Le drapeau doit être effacé dans la routine.'], see: ['vecteur', 'gie', 'pile'] }),
  e({ id: 'vecteur', term: 'Vecteur (reset, interruption)', aliases: ['0000h', '0004h', 'vecteur de reset', 'vecteur d’interruption'], category: 'Notion',
    short: 'Adresse fixe où le PIC saute : 0000h après un reset, 0004h pour toute interruption.' }),
  e({ id: 'drapeau', term: 'Drapeau (flag)', aliases: ['flag', 'indicateur'], category: 'Notion',
    short: 'Bit mis à 1 automatiquement pour signaler un événement (résultat nul, débordement, front…).' }),
  e({ id: 'front', term: 'Front montant / descendant', aliases: ['front', 'edge', 'front montant', 'front descendant'], category: 'Notion',
    short: 'Changement d’un signal : montant = passage de 0 à 1, descendant = passage de 1 à 0.' }),
  e({ id: 'rebond', term: 'Rebond', aliases: ['anti-rebond', 'relâchement', 'debounce'], category: 'Notion',
    short: 'Un vrai bouton « rebondit » quelques millisecondes ; et un appui dure longtemps pour le PIC. Il faut attendre le relâchement.',
    body: ['while (BOUTON == 1); attend que le bouton soit relâché, pour ne compter qu’un appui. Un petit Delay_ms (20 ms) filtre aussi les rebonds.'] }),
  e({ id: 'pull-up', term: 'Pull-up / pull-down', aliases: ['pull up', 'pull down', 'résistance de rappel', 'pull-down'], category: 'Notion',
    short: 'Résistance (souvent 10 kΩ) qui fixe le niveau d’une entrée au repos : vers +5 V (pull-up, repos = 1) ou vers la masse (pull-down, repos = 0).',
    body: ['Dans le TP pupitre : bouton VALIDER vers +5 V et 10 kΩ vers la masse (pull-down) → relâché 0, appuyé 1. Sans résistance, l’entrée est « en l’air » et lit n’importe quoi.'] }),
  e({ id: 'open-drain', term: 'Drain ouvert (RA4)', aliases: ['open drain', 'open-drain', 'RA4'], category: 'Notion',
    short: 'RA4 peut tirer la broche à 0 mais ne fournit jamais 5 V : écrire 1 la « relâche ».',
    body: ['Une LED de RA4 vers la masse ne s’allume donc pas. Il faut une résistance de pull-up, ou brancher la LED entre +5 V et RA4 (elle s’allume alors quand RA4 = 0).'] }),
  e({ id: 'cycle', term: 'Cycle d’instruction', aliases: ['Tcy', 'cycle machine'], category: 'Notion',
    short: '1 cycle d’instruction = 4 périodes d’horloge : 4 µs à 1 MHz, 1 µs à 4 MHz, 0,5 µs à 8 MHz.',
    body: ['La plupart des instructions prennent 1 cycle ; les sauts (GOTO, CALL, RETURN…) et les tests qui sautent en prennent 2.'] }),
  e({ id: 'harvard', term: 'Architecture Harvard', aliases: ['Von Neumann', 'harvard'], category: 'Notion',
    short: 'Mémoire de programme et mémoire de données séparées, avec chacune son bus (14 bits et 8 bits sur le PIC).' }),
  e({ id: 'risc', term: 'RISC', category: 'Notion', short: 'Jeu d’instructions réduit : 35 instructions simples, presque toutes en 1 cycle.' }),
  e({ id: 'flash', term: 'Mémoire Flash (programme)', aliases: ['mémoire programme', 'flash'], category: 'Notion',
    short: '1024 mots de 14 bits (0000h à 03FFh) qui contiennent le programme ; non volatile et reprogrammable.' }),
  e({ id: 'gpr', term: 'GPR et SFR', aliases: ['SFR', 'GPR', 'registres spéciaux'], category: 'Notion',
    short: 'GPR : 68 octets de RAM libres pour les variables (0x0C à 0x4F). SFR : registres spéciaux du PIC (STATUS, PORTA, TRISA…).' }),
  e({ id: 'ual', term: 'UAL (ALU)', aliases: ['ALU', 'unité arithmétique et logique'], category: 'Notion',
    short: 'Unité arithmétique et logique 8 bits : elle fait les calculs avec W et met à jour STATUS.' }),
  e({ id: 'wdt', term: 'Chien de garde (WDT)', aliases: ['watchdog', 'WDT', 'CLRWDT'], category: 'Notion',
    short: 'Minuterie qui fait un reset si le programme ne la remet pas à zéro (CLRWDT) à temps. Désactivée dans les TP (CFGWORD 0x3FFB).' }),
  e({ id: 'mclr', term: 'MCLR', aliases: ['reset'], category: 'Notion', short: 'Broche 4 : remet le PIC à zéro sans couper l’alimentation (active à 0).' }),
  e({ id: 'oscillateur', term: 'Horloge (quartz)', aliases: ['OSC1', 'OSC2', 'quartz', 'CLOCK', 'fréquence'], category: 'Notion',
    short: 'Fixe la vitesse du PIC (OSC1/OSC2, broches 16 et 15). Dans ISIS, c’est la propriété CLOCK du PIC (1 MHz dans les TP, 8 MHz pour le feu).' }),
  e({ id: 'octet', term: 'Octet, quartet, hexadécimal', aliases: ['hexadécimal', 'binaire', 'quartet', '0x', '0b'], category: 'Notion',
    short: 'Octet = 8 bits (0 à 255). Quartet = 4 bits = 1 chiffre hexadécimal (0 à F). 0x0E = 0000 1110 = 14.' }),
  e({ id: 'lecture-modif', term: 'Lecture-modification-écriture', aliases: ['read-modify-write', 'BSF', 'BCF'], category: 'Notion',
    short: 'BSF / BCF sur un port relisent les 8 broches, changent un bit et réécrivent tout le port.' }),

  // ------------------------------------------------------------------ composants
  e({ id: 'logicstate', term: 'LOGICSTATE', aliases: ['interrupteur', 'logic state'], category: 'Composant',
    short: 'Source logique d’ISIS : un clic la fait passer de 0 (bleu) à 1 (rouge) et elle reste dans sa position.',
    body: ['Dans les TP elle remplace un interrupteur. Contrairement à un bouton poussoir, elle ne revient pas toute seule à 0.'] }),
  e({ id: 'button', term: 'Bouton poussoir (BUTTON)', aliases: ['bouton', 'BUTTON'], category: 'Composant',
    short: 'Contact qui ne conduit que pendant l’appui ; il faut une résistance de rappel (pull-down ou pull-up).', see: ['pull-up', 'rebond'] }),
  e({ id: 'led', term: 'LED', aliases: ['diode', 'anode', 'cathode', 'LED-RED'], category: 'Composant',
    short: 'Diode qui s’allume quand le courant va de l’anode (+) vers la cathode (−). Anode sur la broche, cathode à la masse : allumée quand la broche = 1.',
    body: ['Sur une vraie carte, une résistance de 220 Ω à 330 Ω limite le courant. ISIS accepte une LED sans résistance.'] }),
  e({ id: 'resistance', term: 'Résistance (RES)', aliases: ['RES', 'ohm', '220', '10k'], category: 'Composant',
    short: 'Limite le courant (en série avec une LED) ou fixe le niveau d’une entrée (pull-up / pull-down).' }),
  e({ id: '7seg-bcd', term: '7SEG-BCD', aliases: ['afficheur BCD', 'BCD', '7 segments BCD'], category: 'Composant',
    short: 'Afficheur 7 segments avec décodeur : il reçoit un nombre sur 4 bits (E3..E0) et affiche 0–9 puis A b C d E F.',
    body: ['E3 (à gauche) est le poids fort. Avec E0..E3 sur RB0..RB3 : PORTB = 0x0A affiche « A ». Il ne peut pas être éteint.'], see: ['7seg'] }),
  e({ id: '7seg', term: 'Afficheur 7 segments', aliases: ['7 segments', 'segments a..g'], category: 'Composant',
    short: 'Sept LEDs a à g commandées une par une : il faut envoyer le code de chaque segment (« H » = 0x76 avec a sur RB0 … g sur RB6).' }),
  e({ id: 'ldr', term: 'LDR (photorésistance)', aliases: ['TORCH_LDR', 'capteur de luminosité', 'diviseur de tension'], category: 'Composant',
    short: 'Résistance qui baisse quand la lumière augmente ; avec une résistance fixe elle forme un diviseur de tension lu par le PIC.',
    body: ['Montage du feu tricolore : +5 V → LDR → RA3 → 1 kΩ → masse. V(RA3) = 5 × R / (R_LDR + R). Le PIC lit 1 au-dessus de 2 V, 0 au-dessous de 0,8 V.'] }),
  e({ id: 'traffic', term: 'TRAFFIC LIGHTS', aliases: ['feu tricolore'], category: 'Composant',
    short: 'Feu tricolore d’ISIS : trois lampes (rouge, orange, vert) allumées quand leur entrée vaut 1.' }),

  // ------------------------------------------------------------------ langage C
  e({ id: 'define', term: '#define', aliases: ['define', 'alias'], category: 'Langage C',
    short: 'Donne un nom à une broche ou à une constante : le compilateur remplace le nom par son texte avant de compiler.',
    body: ['#define LED PORTB.F0 permet d’écrire LED = 1. Le PIC n’exécute rien pour un #define.'] }),
  e({ id: 'macro', term: 'Macro', aliases: ['LED_ON', 'LED_OFF', 'macro fonctionnelle'], category: 'Langage C',
    short: '#define avec paramètre : #define LED_ON(pin) (pin = 1) transforme LED_ON(LED_EGAL) en (PORTB.F1 = 1).',
    body: ['Ce n’est pas une fonction : le texte est recopié, rien n’est appelé.'] }),
  e({ id: 'delay_ms', term: 'Delay_ms', aliases: ['delay_ms', 'Delay_us', 'temporisation', 'attente'], category: 'Langage C',
    short: 'Fonction de MikroC qui fait attendre le PIC dans une boucle vide (Delay_ms(500) = 0,5 s). L’argument doit être une constante.',
    body: ['La durée dépend de l’horloge du projet : à 1 MHz, 500 ms ≈ 125 000 cycles. Pendant l’attente, seules les interruptions peuvent agir.'] }),
  e({ id: 'variable', term: 'Variable (unsigned char)', aliases: ['unsigned char', 'char', 'int', 'déclaration'], category: 'Langage C',
    short: 'Case mémoire nommée. unsigned char : 1 octet de 0 à 255, le type utilisé dans tout le cours.',
    body: ['Les variables sont rangées en RAM à partir de 0x0C. Sur 8 bits, 255 + 1 = 0 et 0 − 1 = 255.'] }),
  e({ id: 'absolute', term: 'absolute', category: 'Langage C', short: 'Mot-clé MikroC qui fixe l’adresse d’une variable : unsigned char t absolute 0x0C;' }),
  e({ id: 'if', term: 'if / else if / else', aliases: ['else', 'else if', 'condition', 'test'], category: 'Langage C',
    short: 'Exécute un bloc seulement si la condition est vraie ; else if n’est testé que si les tests précédents étaient faux.',
    body: ['Avec des if séparés, plusieurs blocs peuvent s’exécuter : c’est le piège du TP STATUS. Comparer avec ==, pas =.'] }),
  e({ id: 'boucle', term: 'Boucle (while, for)', aliases: ['while', 'for', 'while(1)', 'boucle infinie'], category: 'Langage C',
    short: 'Répète un bloc : while(1) sans fin, while (condition) tant qu’elle est vraie, for (i = 0; i < 3; i++) 3 fois.',
    body: ['while (BOUTON == 1); avec un point-virgule est une attente : la boucle est vide.'] }),
  e({ id: 'mikroc', term: 'MikroC PRO for PIC', aliases: ['MikroC', 'compilateur'], category: 'Langage C',
    short: 'Le compilateur C du cours : il traduit le C en instructions du PIC et produit le fichier .hex.' }),
  e({ id: 'hex', term: 'Fichier .hex', aliases: ['hex', 'programmateur'], category: 'Langage C',
    short: 'Le programme compilé, chargé dans la mémoire Flash du PIC (ou dans le PIC d’ISIS).' }),

  // ------------------------------------------------------------------ assembleur
  e({ id: 'instructions', term: '35 instructions', aliases: ['jeu d’instructions', 'MOVLW', 'MOVWF', 'ADDWF', 'SUBWF', 'BTFSS', 'BTFSC', 'GOTO', 'CALL', 'RETURN'], category: 'Assembleur',
    short: 'Les instructions du PIC16F84A, codées sur 14 bits : orientées octet (ADDWF f, d…), orientées bit (BSF f, b…), littéral et contrôle (MOVLW k, GOTO k…).',
    body: ['d = 0 : résultat dans W ; d = 1 : résultat dans le registre f. Exemple : REGISTRE = 0x8C donne MOVLW 0x8C puis MOVWF REGISTRE.'] }),
  e({ id: 'opcode', term: 'Opcode, registre d’instruction', aliases: ['opcode', 'décodeur', 'registre d’instruction'], category: 'Assembleur',
    short: 'L’opcode est la partie d’une instruction qui dit quelle opération faire ; le registre d’instruction (14 bits) contient l’instruction en cours, analysée par le décodeur.' }),

  // ------------------------------------------------------------------ organigramme
  e({ id: 'organigramme', term: 'Organigramme (style du cours)', aliases: ['flowchart', 'symboles'], category: 'Organigramme',
    short: 'Dessin du programme : Début (cercle) → CONFIGURATION (jaune) → INITIALISATION (orange) → actions (vert) et tests (losanges bleus) dans la boucle infinie → Fin (cible).',
    see: ['losange', 'boucle-infinie', 'configuration', 'initialisation'] }),
  e({ id: 'debut-fin', term: 'Début / Fin', aliases: ['début', 'fin', 'cible'], category: 'Organigramme',
    short: 'Début : petit cercle vide. Fin : une cible (cercle avec un disque noir). Fin est dessinée même après une boucle infinie.' }),
  e({ id: 'configuration', term: 'CONFIGURATION (rectangle jaune)', category: 'Organigramme',
    short: 'Les directions des broches et les déclarations, en phrases : « RB0,RB1 et RB2 sont des sorties », « Déclaration des variables ».' }),
  e({ id: 'initialisation', term: 'INITIALISATION (rectangle orange)', category: 'Organigramme',
    short: 'Les valeurs de départ : « x=5 et y = 6 », « Les Leds sont éteintes » (en rouge).' }),
  e({ id: 'losange', term: 'Losange (test)', aliases: ['décision', 'oui', 'non'], category: 'Organigramme',
    short: 'Test écrit comme en C avec == (« ZERO==1 », « L0==1 »), sans point d’interrogation ; « oui » sort en bas, « non » à droite.' }),
  e({ id: 'boucle-infinie', term: 'Boucle infinie (étiquette)', category: 'Organigramme',
    short: 'Ligne de retour à gauche qui remonte au début du traitement, avec l’étiquette « Boucle infinie » : c’est le while(1).' }),
];

const BY_ID: ReadonlyMap<string, GlossaryEntry> = new Map(GLOSSARY.map((g) => [g.id, g]));

export function glossaryEntry(id: string): GlossaryEntry | undefined {
  return BY_ID.get(id);
}

/** Entries matching `query` (accents and case ignored), best matches first. Empty query: all, alphabetical. */
export function searchGlossary(query: string): GlossaryEntry[] {
  const q = fold(query.trim()).replace(/[-_]/g, ' ');
  const norm = (s: string) => fold(s).replace(/[-_]/g, ' ');
  if (!q) return [...GLOSSARY].sort((a, b) => norm(a.term).localeCompare(norm(b.term)));
  const scored: { g: GlossaryEntry; score: number }[] = [];
  for (const g of GLOSSARY) {
    const term = norm(g.term);
    const aliases = (g.aliases ?? []).map(norm);
    let score = 0;
    if (term === q || aliases.includes(q)) score = 100;
    else if (term.startsWith(q)) score = 80;
    else if (aliases.some((a) => a.startsWith(q))) score = 70;
    else if (term.includes(q)) score = 60;
    else if (aliases.some((a) => a.includes(q))) score = 50;
    else if (norm(g.short).includes(q)) score = 30;
    else if ((g.body ?? []).some((b) => norm(b).includes(q))) score = 10;
    if (score) scored.push({ g, score });
  }
  return scored.sort((a, b) => b.score - a.score || norm(a.g.term).localeCompare(norm(b.g.term))).map((x) => x.g);
}
