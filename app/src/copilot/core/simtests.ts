// Runs the copilot's behaviour tests in the real simulator (compiled program + schematic, like the « Schéma »
// panel), so a proposal is checked before the student sees it. Each test starts from power-on.
import { pinKey, SimSession, type ComponentInstance, type Schematic } from '@pic/circuit';
import type { AnswerTest, TestAction, TestExpectation } from './schema';

export interface TestResult {
  description: string;
  passed: boolean;
  /** French lines: what differed (« D1 : attendu allumée, obtenu éteinte ») or why it could not run. */
  details: string[];
}

export interface SimTarget {
  schematic: Schematic;
  program: Uint16Array;
  clockHz: number;
  config?: number;
}

/** Simulated time after the last action before the checks. */
export const SETTLE_MS = 20;
/** Simulated time allowed per test. */
export const MAX_TEST_MS = 30_000;

const PIC_PINS: Readonly<Record<string, string>> = {
  RA0: 'RA0', RA1: 'RA1', RA2: 'RA2', RA3: 'RA3', RA4: 'RA4/T0CKI', RB0: 'RB0/INT', RB1: 'RB1', RB2: 'RB2', RB3: 'RB3',
  RB4: 'RB4', RB5: 'RB5', RB6: 'RB6', RB7: 'RB7',
};
const LAMPS: Readonly<Record<string, 'red' | 'amber' | 'green'>> = {
  R: 'red', ROUGE: 'red', RED: 'red', A: 'amber', O: 'amber', ORANGE: 'amber', AMBRE: 'amber', J: 'amber', JAUNE: 'amber',
  G: 'green', V: 'green', VERT: 'green', GREEN: 'green',
};
const LAMP_FR = { red: 'feu rouge', amber: 'feu orange', green: 'feu vert' } as const;

/** 7-segment value from '0'..'9', 'A'..'F' (b, d accepted), '0x0A', or a number 0..15. */
export function parseDisplayValue(v: string): number | null {
  const t = v.trim();
  if (/^0x[0-9a-f]+$/i.test(t)) return Number.parseInt(t, 16) & 0xf;
  if (/^\d+$/.test(t)) { const n = Number(t); return n >= 0 && n <= 15 ? n : null; }
  if (/^[a-f]$/i.test(t)) return Number.parseInt(t, 16);
  return null;
}

const HEX = '0123456789AbCdEF';

/** Resolves a test ref ('D1', 'U1.RB0', 'RB0', 'FEU.R') against the schematic, case-insensitively. */
function finder(schematic: Schematic, idOf: (ref: string) => string | undefined) {
  const byId = new Map(schematic.components.map((c) => [c.id, c] as const));
  const byUpper = new Map<string, ComponentInstance>();
  for (const c of schematic.components) {
    byUpper.set(c.id.toUpperCase(), c);
    if (c.ref) byUpper.set(c.ref.toUpperCase(), c);
  }
  return (ref: string): ComponentInstance | undefined => {
    const id = idOf(ref);
    return (id ? byId.get(id) : undefined) ?? byUpper.get(ref.trim().toUpperCase());
  };
}

export function runTest(test: AnswerTest, target: SimTarget, idOf: (ref: string) => string | undefined = () => undefined): TestResult {
  const details: string[] = [];
  const find = finder(target.schematic, idOf);
  let session: SimSession;
  try {
    session = new SimSession(target.schematic, target.program, target.clockHz, target.config !== undefined ? { config: target.config } : {});
  } catch (e) {
    return { description: test.description, passed: false, details: [`simulation impossible : ${e instanceof Error ? e.message : String(e)}`] };
  }
  let elapsed = 0;
  const wait = (ms: number) => {
    const allowed = Math.max(0, Math.min(ms, MAX_TEST_MS - elapsed));
    if (allowed < ms) details.push(`durée limitée à ${MAX_TEST_MS / 1000} s de simulation par test`);
    if (allowed > 0) session.runFor(allowed / 1000);
    elapsed += allowed;
  };

  const act = (a: TestAction): string | null => {
    if ('attendre_ms' in a) { wait(a.attendre_ms); return null; }
    const c = find(a.ref);
    if (!c) return `action sur « ${a.ref} » : composant introuvable dans le schéma`;
    const visual = session.circuit.visual(c.id);
    if ('appui_ms' in a) {
      if (c.kind === 'BUTTON') {
        session.interact(c.id, { type: 'press' });
        wait(a.appui_ms);
        session.interact(c.id, { type: 'release' });
        return null;
      }
      if (c.kind === 'LOGICSTATE') {
        session.interact(c.id, { type: 'toggle' });
        wait(a.appui_ms);
        session.interact(c.id, { type: 'toggle' });
        return null;
      }
      return `action sur « ${a.ref} » : seul un BUTTON ou un LOGICSTATE peut être appuyé`;
    }
    switch (c.kind) {
      case 'LOGICSTATE':
        if (visual.kind === 'LOGICSTATE' && visual.state !== a.etat) session.interact(c.id, { type: 'toggle' });
        return null;
      case 'BUTTON':
        session.interact(c.id, { type: a.etat ? 'press' : 'release' });
        return null;
      case 'TORCH_LDR':
        session.interact(c.id, { type: 'setLevel', level: a.etat ? 9 : 0 });
        return null;
      default:
        return `action sur « ${a.ref} » : ce composant (${c.kind}) ne se manipule pas`;
    }
  };

  try {
    for (const a of test.actions) {
      const err = act(a);
      if (err) details.push(err);
    }
    wait(SETTLE_MS);
    for (const e of test.attendu) {
      const err = check(e, session, target.schematic, find);
      if (err) details.push(err);
    }
  } catch (e) {
    details.push(`erreur de simulation : ${e instanceof Error ? e.message : String(e)}`);
  }
  const failed = details.some((d) => !d.startsWith('durée limitée'));
  return { description: test.description, passed: !failed, details };
}

function check(e: TestExpectation, session: SimSession, schematic: Schematic, find: (ref: string) => ComponentInstance | undefined): string | null {
  if ('afficheur' in e) {
    const c = find(e.afficheur);
    if (!c || c.kind !== '7SEG-BCD') return `afficheur « ${e.afficheur} » introuvable (il faut un 7SEG-BCD)`;
    const want = parseDisplayValue(e.valeur);
    if (want === null) return `valeur d'afficheur « ${e.valeur} » incomprise (0 à 9 ou A à F)`;
    const v = session.circuit.visual(c.id);
    const got = v.kind === '7SEG-BCD' ? v.value : null;
    if (got === want) return null;
    return `${e.afficheur} : attendu « ${HEX[want]} », obtenu ${got === null ? 'rien (entrées non pilotées)' : `« ${HEX[got]} »`}`;
  }
  const raw = e.ref.trim();
  const upper = raw.toUpperCase();
  // PIC pin: 'RB0' or 'U1.RB0'.
  const pinName = PIC_PINS[upper.replace(/^U1\./, '')];
  if (pinName && (upper.startsWith('U1.') || !find(raw))) {
    const pic = schematic.components.find((c) => c.kind === 'PIC16F84A');
    const net = pic ? session.circuit.netlist.pinToNet.get(pinKey(pic.id, pinName)) : undefined;
    const level = net ? session.circuit.netLevel(net) : 'Z';
    if (level === e.etat) return null;
    return `${raw} : attendu ${e.etat}, obtenu ${level === 'Z' ? 'flottant' : level === 'X' ? 'conflit' : level}`;
  }
  // Traffic light lamp: 'FEU.R'.
  const dot = raw.lastIndexOf('.');
  if (dot > 0) {
    const c = find(raw.slice(0, dot));
    const lamp = LAMPS[raw.slice(dot + 1).toUpperCase()];
    if (c?.kind === 'TRAFFIC_LIGHTS' && lamp) {
      const v = session.circuit.visual(c.id);
      const on = v.kind === 'TRAFFIC_LIGHTS' ? v[lamp] : false;
      if ((on ? 1 : 0) === e.etat) return null;
      return `${raw} (${LAMP_FR[lamp]}) : attendu ${e.etat ? 'allumé' : 'éteint'}, obtenu ${on ? 'allumé' : 'éteint'}`;
    }
  }
  const c = find(raw);
  if (!c) return `« ${raw} » introuvable dans le schéma`;
  const v = session.circuit.visual(c.id);
  switch (v.kind) {
    case 'LED':
      if ((v.lit ? 1 : 0) === e.etat) return null;
      return `${raw} : attendue ${e.etat ? 'allumée' : 'éteinte'}, obtenue ${v.lit ? 'allumée' : 'éteinte'}`;
    case 'LOGICSTATE':
      return v.state === e.etat ? null : `${raw} : attendu ${e.etat}, obtenu ${v.state}`;
    case 'BUTTON':
      return (v.pressed ? 1 : 0) === e.etat ? null : `${raw} : attendu ${e.etat ? 'appuyé' : 'relâché'}`;
    case 'TRAFFIC_LIGHTS':
      return `${raw} : préciser le feu (« ${raw}.R », « ${raw}.A » ou « ${raw}.G »)`;
    default:
      return `${raw} (${c.kind}) : on ne peut vérifier que des LED, des feux, des broches du PIC ou un afficheur`;
  }
}

/** Run every test, yielding to the UI between tests. */
export async function runTests(
  tests: readonly AnswerTest[], target: SimTarget, idOf: (ref: string) => string | undefined,
  yieldToUi: () => Promise<void> = () => Promise.resolve(),
): Promise<TestResult[]> {
  const out: TestResult[] = [];
  for (const t of tests) {
    out.push(runTest(t, target, idOf));
    await yieldToUi();
  }
  return out;
}
