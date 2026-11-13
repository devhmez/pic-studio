// The copilot's structured answer: the JSON Schema passed to `claude -p --json-schema` (kept compact: every token
// of it is re-sent with each request) and a tolerant reader that turns the CLI's structured_output into typed data,
// reporting what it had to drop (in French, for the automatic correction turn).
import { AUTO_PART_KINDS, type AutoPartKind } from '@pic/circuit';

export type AnswerPartType = AutoPartKind;

export interface AnswerPart {
  ref: string;
  type: AnswerPartType;
  couleur?: string;
  valeur?: string;
  nom?: string;
}

export interface AnswerLink { de: string; vers: string }

export interface AnswerCircuit {
  horloge_mhz: number;
  composants: AnswerPart[];
  liaisons: AnswerLink[];
}

export type TestAction =
  | { ref: string; etat: 0 | 1 }
  | { ref: string; appui_ms: number }
  | { attendre_ms: number };

export type TestExpectation =
  | { ref: string; etat: 0 | 1 }
  | { afficheur: string; valeur: string };

export interface AnswerTest {
  description: string;
  actions: TestAction[];
  attendu: TestExpectation[];
}

export interface CopilotAnswer {
  /** Short French answer for the chat. */
  reponse: string;
  /** Questions when the request is ambiguous (the copilot asks instead of guessing). */
  questions?: string[];
  circuit?: AnswerCircuit;
  /** Complete MikroC program for the PIC16F84A. */
  code?: string;
  tests?: AnswerTest[];
}

const str = { type: 'string' } as const;
const num = { type: 'number' } as const;
const bit = { enum: [0, 1] } as const;

/** JSON Schema (draft-07) of CopilotAnswer, for --json-schema. */
export const ANSWER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    reponse: str,
    questions: { type: 'array', items: str },
    circuit: {
      type: 'object',
      properties: {
        horloge_mhz: num,
        composants: {
          type: 'array',
          items: {
            type: 'object',
            properties: { ref: str, type: { enum: [...AUTO_PART_KINDS] }, couleur: str, valeur: str, nom: str },
            required: ['ref', 'type'],
          },
        },
        liaisons: {
          type: 'array',
          items: { type: 'object', properties: { de: str, vers: str }, required: ['de', 'vers'] },
        },
      },
      required: ['horloge_mhz', 'composants', 'liaisons'],
    },
    code: str,
    tests: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: str,
          actions: {
            type: 'array',
            items: { type: 'object', properties: { ref: str, etat: bit, appui_ms: num, attendre_ms: num } },
          },
          attendu: {
            type: 'array',
            items: { type: 'object', properties: { ref: str, etat: bit, afficheur: str, valeur: { type: ['string', 'number'] } } },
          },
        },
        required: ['description', 'actions', 'attendu'],
      },
    },
  },
  required: ['reponse'],
} as const;

// ------------------------------------------------------------------------------------------------ reader

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);
const finite = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const asBit = (v: unknown): 0 | 1 | undefined => {
  if (v === 0 || v === 1) return v;
  if (v === '0' || v === '1') return Number(v) as 0 | 1;
  if (v === true || v === false) return v ? 1 : 0;
  return undefined;
};

export interface ParsedAnswer {
  answer: CopilotAnswer;
  /** What was malformed and dropped (French). */
  problems: string[];
}

/** Read the CLI's structured_output (already schema-checked by the CLI, but never trusted). Null when unusable. */
export function readAnswer(value: unknown): ParsedAnswer | null {
  const v = typeof value === 'string' ? safeJson(value) : value;
  if (!isRecord(v)) return null;
  const problems: string[] = [];
  const reponse = text(v.reponse)?.trim() ?? '';
  const answer: CopilotAnswer = { reponse };

  if (Array.isArray(v.questions)) {
    const qs = v.questions.map(text).filter((q): q is string => !!q && q.trim() !== '').map((q) => q.trim());
    if (qs.length > 0) answer.questions = qs;
  }

  if (isRecord(v.circuit)) {
    const c = v.circuit;
    const mhz = finite(c.horloge_mhz);
    const composants: AnswerPart[] = [];
    for (const raw of Array.isArray(c.composants) ? c.composants : []) {
      if (!isRecord(raw)) continue;
      const ref = text(raw.ref)?.trim();
      const type = text(raw.type)?.trim().toUpperCase().replace(/\s+/g, '_');
      const kind = type === 'TRAFFIC_LIGHT' ? 'TRAFFIC_LIGHTS' : type === '7SEG' || type === '7SEG_BCD' ? '7SEG-BCD' : type;
      if (!ref || !kind || !(AUTO_PART_KINDS as readonly string[]).includes(kind)) {
        problems.push(`composant ignoré (référence ou type invalide) : ${JSON.stringify(raw).slice(0, 80)}`);
        continue;
      }
      const part: AnswerPart = { ref, type: kind as AnswerPartType };
      const couleur = text(raw.couleur)?.trim(); if (couleur) part.couleur = couleur;
      const valeur = text(raw.valeur)?.trim(); if (valeur) part.valeur = valeur;
      const nom = text(raw.nom)?.trim(); if (nom) part.nom = nom;
      composants.push(part);
    }
    const liaisons: AnswerLink[] = [];
    for (const raw of Array.isArray(c.liaisons) ? c.liaisons : []) {
      if (!isRecord(raw)) continue;
      const de = text(raw.de)?.trim(); const vers = text(raw.vers)?.trim();
      if (de && vers) liaisons.push({ de, vers });
      else problems.push(`liaison ignorée : ${JSON.stringify(raw).slice(0, 80)}`);
    }
    // Models often fill the optional objects of the schema with empty values (a question turn with
    // "circuit": { "composants": [], "liaisons": [] }): an empty circuit is no proposal.
    const raw = (Array.isArray(c.composants) ? c.composants.length : 0) + (Array.isArray(c.liaisons) ? c.liaisons.length : 0);
    if (raw > 0) {
      if (mhz === undefined || mhz <= 0 || mhz > 20) problems.push('horloge_mhz manquante ou invalide (1 MHz par défaut, 8 MHz pour le feu tricolore ; 20 MHz au maximum)');
      answer.circuit = { horloge_mhz: mhz !== undefined && mhz > 0 && mhz <= 20 ? mhz : 1, composants, liaisons };
    }
  }

  const code = text(v.code);
  if (code && code.trim()) answer.code = code.replace(/\r\n?/g, '\n');

  if (Array.isArray(v.tests)) {
    const tests: AnswerTest[] = [];
    v.tests.forEach((raw, i) => {
      if (!isRecord(raw)) return;
      const description = text(raw.description)?.trim() || `Test ${i + 1}`;
      const actions: TestAction[] = [];
      for (const a of Array.isArray(raw.actions) ? raw.actions : []) {
        if (!isRecord(a)) continue;
        const wait = finite(a.attendre_ms);
        const press = finite(a.appui_ms);
        const ref = text(a.ref)?.trim();
        const etat = asBit(a.etat);
        if (wait !== undefined && !ref) actions.push({ attendre_ms: Math.max(0, wait) });
        else if (ref && press !== undefined) actions.push({ ref, appui_ms: Math.max(0, press) });
        else if (ref && etat !== undefined) actions.push({ ref, etat });
        else problems.push(`test « ${description} » : action incomprise ${JSON.stringify(a).slice(0, 80)}`);
      }
      const attendu: TestExpectation[] = [];
      for (const e of Array.isArray(raw.attendu) ? raw.attendu : []) {
        if (!isRecord(e)) continue;
        const aff = text(e.afficheur)?.trim();
        const ref = text(e.ref)?.trim();
        const etat = asBit(e.etat);
        const valeur = text(e.valeur)?.trim();
        if (aff && valeur !== undefined) attendu.push({ afficheur: aff, valeur });
        else if (ref && etat !== undefined) attendu.push({ ref, etat });
        else problems.push(`test « ${description} » : vérification incomprise ${JSON.stringify(e).slice(0, 80)}`);
      }
      if (attendu.length > 0) tests.push({ description, actions, attendu });
    });
    if (tests.length > 0) answer.tests = tests;
  }
  return { answer, problems };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** True when the answer changes the project (and must be verified). */
export function hasProposal(a: CopilotAnswer): boolean {
  return !!a.circuit || !!a.code;
}
