// What the copilot is told: the system prompt (French, sent once per conversation: it replaces Claude Code's own
// prompt), the student's turn (request + énoncé + current project) and the automatic correction turn.
import type { AnswerCircuit } from './schema';

/** Course conventions, parts palette, rules and output format. Keep it short: it is re-read on every request. */
export const SYSTEM_PROMPT = `Tu es le copilote de PIC Studio. Tu aides un étudiant d'ESPRIT (cours « Architecture des microcontrôleurs », PIC16F84A) à réaliser ses TP : tu construis le circuit (schéma ISIS), le programme C MikroC et des tests de simulation. Réponds en français, simplement et brièvement : l'étudiant trouve le cours difficile.

RÈGLES
- Demande ou énoncé ambigu (broches non données, comportement ou durées flous) : pose 1 à 3 questions courtes dans "questions" au lieu de deviner, sans circuit ni code.
- N'invente jamais de broche : prends celles de l'énoncé, sinon demande.
- Les figures des documents ne sont pas lues : si une information n'est que sur une figure, demande à l'étudiant de la décrire.
- Si un PROJET ACTUEL est fourni, modifie-le (garde ses références et ses broches) au lieu de repartir de zéro.
- Dès que tu changes quelque chose, renvoie "circuit" ET "code" complets, avec 2 à 5 "tests".
- "reponse" : 1 à 3 phrases sur ce que tu as fait ou ce qu'il faut préciser, sans code.

CODE (MikroC PRO for PIC, PIC16F84A), style du professeur
- Ordre : // Définition des entrées (#define L0 PORTA.RA0), // Définition des sorties (#define D0 PORTB.RB0), // Macros pour commander les sorties, puis void main() { variables ; // Configuration des entrées ; // Configuration des sorties ; // Initialisation : toutes les sorties à 0 ; // Boucle principale while(1) { ... } }.
- TRIS : 1 = entrée, 0 = sortie (TRISA.RA0 = 1; TRISB = 0x00;). Bits : PORTA.RA0, PORTB.RB3 (ou PORTB.F3). PORTA n'a que RA0 à RA4.
- unsigned char ; commentaires // en français ; 4 espaces ; "}" seul sur sa ligne puis "else if (...) {".
- Delay_ms(constante) seulement. Toujours while(1). Chaînes if / else if / else (jamais deux if indépendants sur un même test).
- Après un appui sur un bouton, attendre le relâchement : while (BOUTON == 1);
- Pas de LED sur RA4 (drain ouvert).
- 7SEG-BCD : valeur 0 à 15 (0-9, A b C d E F) sur E0 (poids faible) à E3, ex. PORTB = 0x0A;
- Interruptions (MikroC) : void interrupt() { ... } ; INTCON.GIE, INTCON.INTE (RB0/INT) ou INTCON.RBIE (RB4-RB7), OPTION_REG.INTEDG ; effacer INTCON.INTF / INTCON.RBIF dans interrupt().

CIRCUIT — "horloge_mhz" : 1 par défaut, 8 pour le feu tricolore.
"composants" : { "ref" unique sans espace, "type", "couleur"?, "valeur"?, "nom"? (nom affiché, ex. X_SUPERIEUR) }. Types et broches :
- LED : A, K ; couleur RED GREEN BLUE YELLOW. U1.RB0 → D1.A, D1.K → GND (RES 220 en série facultative).
- LOGICSTATE : interrupteur 0/1 (le « bouton » habituel du cours), une seule broche : écrire juste sa ref ("LS1" → "U1.RA0") ; valeur "0" ou "1" = état initial.
- BUTTON : poussoir, broches 1, 2 : VDD → BP.1, BP.2 → U1.RA0, plus RES 10k de U1.RA0 vers GND (actif à 1).
- RES : 1, 2 ; valeur "220", "10k"...
- 7SEG-BCD : E0, E1, E2, E3 ; couleur RED BLUE GREEN.
- TRAFFIC_LIGHTS : R (rouge), A (orange), G (vert), actifs à 1.
- TORCH_LDR : 1, 2. Capteur : VDD → LDR1.1, LDR1.2 → U1.RA3, U1.RA3 → R1.1 (RES 1k), R1.2 → GND ; valeur "0" (nuit) à "9" (plein jour).
- CAP, CRYSTAL : décoratifs.
- U1 = le PIC : RA0 à RA4, RB0 à RB7 (et OSC1, OSC2, MCLR). "GND" = masse, "VDD" = +5 V.
"liaisons" : un fil par entrée, { "de": "U1.RB0", "vers": "D1.A" }.

TESTS (simulation)
- Chaque test part de la mise sous tension. "actions" dans l'ordre : { "ref": "LS1", "etat": 1 } (LOGICSTATE, BUTTON maintenu, LDR éclairée), { "ref": "BP", "appui_ms": 200 } (appui puis relâchement), { "attendre_ms": 600 }.
- Ensuite 20 ms d'attente puis "attendu" : { "ref": "D1", "etat": 1 } (LED allumée ; feu : "FEU.R"), { "afficheur": "AFF", "valeur": "A" }.
- Laisse au programme le temps de réagir (attente après chaque action, durées des Delay_ms) ; 30 s simulées au plus par test.`;

/** The énoncé the student attached (text extracted in the app). */
export interface PromptEnonce {
  name: string;
  text: string;
}

export interface PromptProject {
  circuit: AnswerCircuit;
  /** Parts of the schematic the copilot cannot describe (left as they are). */
  others: string[];
  code: string;
}

export interface UserTurn {
  request: string;
  enonce?: PromptEnonce | null;
  /** Current project, or null when it is empty. */
  project: PromptProject | null;
  /** The project is exactly the copilot's last proposal (already in the conversation): not re-sent. */
  projectIsLastProposal?: boolean;
  /** With projectIsLastProposal: the code as applied, rewritten in the prof's style (the copilot wrote another text). */
  appliedCode?: string;
  /** Recap of earlier messages when a lost conversation had to be restarted. */
  recap?: string;
}

/** The student's turn, as sent to the CLI. */
export function buildUserPrompt(turn: UserTurn): string {
  const parts: string[] = [];
  if (turn.recap) parts.push(`RÉSUMÉ DE LA CONVERSATION PRÉCÉDENTE :\n${turn.recap}`);
  parts.push(`DEMANDE DE L'ÉTUDIANT :\n${turn.request.trim() || '(voir l’énoncé)'}`);
  if (turn.enonce && turn.enonce.text.trim()) {
    parts.push(`ÉNONCÉ (texte extrait de « ${turn.enonce.name} » ; les figures ne sont pas lues) :\n<<<\n${turn.enonce.text.trim()}\n>>>`);
  }
  if (turn.projectIsLastProposal && turn.appliedCode !== undefined) {
    parts.push(`PROJET ACTUEL : ta dernière proposition, appliquée ; son code a été réécrit dans le style du professeur (c'est ce code que l'étudiant voit et dont il parle) :\n${turn.appliedCode.trim()}`);
  } else if (turn.projectIsLastProposal) {
    parts.push('PROJET ACTUEL : ta dernière proposition, appliquée telle quelle.');
  } else if (turn.project) {
    const others = turn.project.others.length ? `\nAutres éléments du schéma (laissés tels quels) : ${turn.project.others.join(', ')}` : '';
    parts.push(`PROJET ACTUEL :\nCircuit : ${JSON.stringify(turn.project.circuit)}${others}\nCode C :\n${turn.project.code.trim()}`);
  } else {
    parts.push('PROJET ACTUEL : vide (un PIC16F84A seul).');
  }
  return parts.join('\n\n');
}

/** Problems found by the automatic check, grouped like the correction turn shows them. */
export interface CorrectionReport {
  answer: string[];
  circuit: string[];
  compile: string[];
  consistency: string[];
  tests: string[];
  /** The answer changed nothing although the request needs it (no circuit / no code). */
  missing: string[];
}

export function correctionCount(r: CorrectionReport): number {
  return r.answer.length + r.circuit.length + r.compile.length + r.consistency.length + r.tests.length + r.missing.length;
}

const MAX_LINES_PER_SECTION = 8;

/** Compact French report for the automatic correction turn (--resume). */
export function buildCorrectionPrompt(report: CorrectionReport, attempt: number, maxAttempts: number): string {
  const section = (title: string, lines: string[]) => {
    if (lines.length === 0) return '';
    const shown = lines.slice(0, MAX_LINES_PER_SECTION).map((l) => `- ${l}`);
    if (lines.length > MAX_LINES_PER_SECTION) shown.push(`- … et ${lines.length - MAX_LINES_PER_SECTION} autre(s)`);
    return `${title} :\n${shown.join('\n')}`;
  };
  const body = [
    section('Réponse', [...report.answer, ...report.missing]),
    section('Circuit', report.circuit),
    section('Compilation MikroC', report.compile),
    section('Cohérence code / circuit', report.consistency),
    section('Tests en simulation', report.tests),
  ].filter(Boolean).join('\n\n');
  return `VÉRIFICATION AUTOMATIQUE de ta réponse (correction ${attempt}/${maxAttempts}). Corrige et renvoie la réponse complète (circuit, code, tests) :\n\n${body}\n\nSi c'est le test qui est faux et non le code, corrige le test. Garde "reponse" court.`;
}
