// The assistant's block palette: what each block is called in French, when it can be added, the statement it creates
// and the one-line summary shown on its row.
import {
  busById, describeCond, formatDuration, glyphName, negateCond, signalById,
  type Cond, type Expr, type Level, type Program, type Signal, type Stmt, type StmtKind,
} from '@pic/program-model';
import { exprC } from '@pic/style-c';
import { addVariable, idFactory, inputs, outputs, type IdFactory } from './model';

export type BlockType =
  | 'on' | 'off' | 'toggle' | 'setAll' | 'display'
  | 'delay' | 'waitPress' | 'waitRelease'
  | 'if' | 'while' | 'repeat'
  | 'assign' | 'incr' | 'decr'
  | 'clearFlag' | 'call' | 'comment' | 'raw';

export type BlockTone = 'output' | 'time' | 'control' | 'data' | 'other';

export interface BlockTypeInfo {
  type: BlockType;
  label: string;
  hint: string;
  tone: BlockTone;
}

export interface BlockGroup {
  title: string;
  items: BlockTypeInfo[];
}

const info = (type: BlockType, label: string, hint: string, tone: BlockTone): BlockTypeInfo => ({ type, label, hint, tone });

/** Palette shown by « Ajouter un bloc », in the order a student thinks of them. */
export function blockGroups(inInterrupt: boolean): BlockGroup[] {
  const others: BlockTypeInfo[] = [
    info('comment', 'Commentaire', 'Une ligne // dans le code', 'other'),
    info('raw', 'Code C libre', 'Instructions C écrites telles quelles', 'other'),
  ];
  if (inInterrupt) others.unshift(info('clearFlag', 'Effacer un drapeau', 'INTCON.INTF = 0 : acquitter l’interruption', 'other'));
  return [
    {
      title: 'Sorties',
      items: [
        info('on', 'Allumer', 'Mettre une sortie à son niveau actif (LED allumée)', 'output'),
        info('off', 'Éteindre', 'Mettre une sortie au repos (LED éteinte)', 'output'),
        info('toggle', 'Inverser', 'Changer l’état d’une sortie (clignotement)', 'output'),
        info('setAll', 'Plusieurs sorties', 'Allumer ou éteindre plusieurs sorties d’un coup', 'output'),
        info('display', 'Afficher', 'Écrire un chiffre ou une lettre (0 à F) sur l’afficheur', 'output'),
      ],
    },
    {
      title: 'Temps et attente',
      items: [
        info('delay', 'Attendre', 'Temporisation Delay_ms', 'time'),
        info('waitPress', 'Attendre l’appui sur…', 'Bloque jusqu’à l’appui sur un bouton', 'time'),
        info('waitRelease', 'Attendre le relâchement de…', 'Évite de compter deux fois le même appui', 'time'),
      ],
    },
    {
      title: 'Décisions et boucles',
      items: [
        info('if', 'Si … sinon', 'Tester une entrée, un drapeau ou une variable', 'control'),
        info('while', 'Tant que', 'Répéter tant qu’une condition est vraie', 'control'),
        info('repeat', 'Répéter N fois', 'Boucle for avec un compteur', 'control'),
      ],
    },
    {
      title: 'Variables',
      items: [
        info('assign', 'Affecter', 'x = valeur, z = x - y…', 'data'),
        info('incr', 'Incrémenter', 'x = x + 1', 'data'),
        info('decr', 'Décrémenter', 'x = x - 1', 'data'),
      ],
    },
    { title: 'Autres', items: others },
  ];
}

/** Why a block cannot be added yet (French), or null when it can. */
export function blockUnavailable(program: Program, type: BlockType): string | null {
  const outs = outputs(program);
  switch (type) {
    case 'on':
    case 'off':
    case 'toggle':
    case 'setAll':
      return outs.length ? null : 'Ajoutez d’abord une sortie dans « Broches ».';
    case 'display':
      return program.buses.some((b) => b.dir === 'out') ? null : 'Aucun afficheur : branchez un 7SEG-BCD puis « Synchroniser avec le schéma ».';
    case 'waitPress':
    case 'waitRelease':
      return inputs(program).length ? null : 'Ajoutez d’abord une entrée (bouton, interrupteur) dans « Broches ».';
    case 'call':
      return program.functions.some((f) => f.kind === 'function') ? null : 'Le programme n’a pas de sous-programme.';
    default:
      return null;
  }
}

const offLevel = (s: Signal): Level => (s.activeLevel === 1 ? 0 : 1);

/** Prefer LEDs and lamps for the default target of an output block. */
function defaultOutput(program: Program): Signal | undefined {
  const outs = outputs(program);
  return outs.find((s) => s.device === 'led' || s.device === 'lamp') ?? outs[0];
}

/** Default condition of a new « si » / « tant que »: first input active, else ZERO == 1. */
export function defaultCond(program: Program): Cond {
  const input = inputs(program)[0];
  return input ? { kind: 'pin', signal: input.id, value: input.activeLevel } : { kind: 'flag', flag: 'Z', value: 1 };
}

/** A counter variable for « Répéter » (creates `i` when the program has no obvious one). */
function counterVariable(program: Program): { program: Program; name: string } {
  const existing = program.variables.find((v) => /^(i|j|k|n|compteur|cpt)$/i.test(v.name));
  if (existing) return { program, name: existing.name };
  return addVariable(program, 'i');
}

function anyVariable(program: Program, fallback: string): { program: Program; name: string } {
  const v = program.variables[0];
  return v ? { program, name: v.name } : addVariable(program, fallback);
}

/** The statement a new block of `type` starts with (and the program, which may gain a variable). */
export function createBlock(program: Program, type: BlockType, newId: IdFactory = idFactory(program)): { program: Program; stmt: Stmt } {
  const id = newId('s');
  const out = defaultOutput(program);
  switch (type) {
    case 'on':
      return { program, stmt: { id, kind: 'set', signal: out?.id ?? '', value: out?.activeLevel ?? 1 } };
    case 'off':
      return { program, stmt: { id, kind: 'set', signal: out?.id ?? '', value: out ? offLevel(out) : 0 } };
    case 'toggle':
      return { program, stmt: { id, kind: 'toggle', signal: out?.id ?? '' } };
    case 'setAll': {
      const leds = outputs(program).filter((s) => s.activeLevel === 1);
      const chosen = leds.length ? leds : outputs(program);
      return { program, stmt: { id, kind: 'setAll', signals: chosen.map((s) => s.id), value: 0 } };
    }
    case 'display': {
      const bus = program.buses.find((b) => b.dir === 'out');
      return { program, stmt: { id, kind: 'display', bus: bus?.id ?? '', value: { kind: 'num', value: 0, radix: 16 } } };
    }
    case 'delay':
      return { program, stmt: { id, kind: 'delay', ms: 500 } };
    case 'waitPress':
    case 'waitRelease': {
      const input = inputs(program)[0];
      const pressed = input?.activeLevel ?? 1;
      const value: Level = type === 'waitPress' ? pressed : (pressed === 1 ? 0 : 1);
      return {
        program,
        stmt: {
          id,
          kind: 'waitFor',
          cond: { kind: 'pin', signal: input?.id ?? '', value },
          ...(type === 'waitRelease' ? { comment: 'Attente du relâchement du bouton' } : {}),
        },
      };
    }
    case 'if':
      return { program, stmt: { id, kind: 'if', branches: [{ id: newId('b'), cond: defaultCond(program), body: [] }], otherwise: null } };
    case 'while':
      return { program, stmt: { id, kind: 'while', cond: defaultCond(program), body: [] } };
    case 'repeat': {
      const c = counterVariable(program);
      return { program: c.program, stmt: { id, kind: 'repeat', times: 3, counter: c.name, body: [] } };
    }
    case 'assign': {
      const v = anyVariable(program, 'x');
      return { program: v.program, stmt: { id, kind: 'assign', target: { kind: 'var', name: v.name }, value: { kind: 'num', value: 0 } } };
    }
    case 'incr':
    case 'decr': {
      const v = anyVariable(program, 'compteur');
      return { program: v.program, stmt: { id, kind: type, variable: v.name } };
    }
    case 'clearFlag': {
      const cfg = program.interrupts;
      const flag = cfg?.int ? 'INTF' : cfg?.rbChange ? 'RBIF' : cfg?.tmr0 ? 'T0IF' : 'INTF';
      return { program, stmt: { id, kind: 'clearFlag', flag, comment: `Effacer le drapeau ${flag}` } };
    }
    case 'call': {
      const f = program.functions.find((x) => x.kind === 'function');
      return { program, stmt: { id, kind: 'call', name: f?.name ?? '' } };
    }
    case 'comment':
      return { program, stmt: { id, kind: 'comment', text: 'Commentaire' } };
    case 'raw':
      return { program, stmt: { id, kind: 'raw', code: '' } };
  }
}

// ------------------------------------------------------------------------------------------------ summaries

export interface BlockSummary {
  /** Short verb shown as the row's badge: « Allumer », « Si », « Attendre ». */
  label: string;
  /** Rest of the line: « Led égalité (LED_EGAL) », « 0,5 s ». */
  detail: string;
  tone: BlockTone;
}

const KIND_TONE: Readonly<Record<StmtKind, BlockTone>> = {
  set: 'output', setAll: 'output', toggle: 'output', display: 'output',
  delay: 'time', waitFor: 'time',
  if: 'control', while: 'control', repeat: 'control', for: 'control',
  assign: 'data', incr: 'data', decr: 'data',
  call: 'other', clearFlag: 'other', comment: 'other', raw: 'other',
};

function signalText(program: Program, id: string): string {
  const s = signalById(program, id);
  if (!s) return id ? `« ${id} » (introuvable)` : 'aucune sortie choisie';
  return s.label && s.label !== s.name ? `${s.label} (${s.name})` : s.name;
}

/** C-like text of an expression for summaries and inputs (`var1 - var2`, `0x0A`). */
export function exprText(program: Program, e: Expr): string {
  try {
    return exprC(program, e);
  } catch {
    return '?';
  }
}

/** Verb + detail of a statement's row. */
export function blockSummary(program: Program, s: Stmt): BlockSummary {
  const tone = KIND_TONE[s.kind];
  const opts = { logic: 'words' as const };
  switch (s.kind) {
    case 'set': {
      const sig = signalById(program, s.signal);
      const active = sig ? s.value === sig.activeLevel : s.value === 1;
      const ledLike = sig?.device === 'led' || sig?.device === 'lamp';
      const label = ledLike || !sig ? (active ? 'Allumer' : 'Éteindre') : `Mettre à ${s.value}`;
      return { label, detail: signalText(program, s.signal), tone };
    }
    case 'setAll': {
      const names = s.signals.map((id) => signalById(program, id)?.name ?? id);
      const allActiveHigh = s.signals.every((id) => (signalById(program, id)?.activeLevel ?? 1) === 1);
      const label = allActiveHigh ? (s.value === 1 ? 'Allumer' : 'Éteindre') : `Mettre à ${s.value}`;
      return { label, detail: names.length ? names.join(', ') : 'aucune sortie', tone };
    }
    case 'toggle':
      return { label: 'Inverser', detail: signalText(program, s.signal), tone };
    case 'display': {
      const bus = busById(program, s.bus);
      const what = s.value.kind === 'num' && bus?.device === 'bcd' ? glyphName(s.value.value) : exprText(program, s.value);
      return { label: 'Afficher', detail: `${what}${bus ? ` sur ${bus.name}` : ''}`, tone };
    }
    case 'delay':
      return { label: 'Attendre', detail: formatDuration(s.ms, s.unit), tone };
    case 'waitFor': {
      if (s.cond.kind === 'pin') {
        const sig = signalById(program, s.cond.signal);
        if (sig && (sig.device === 'button' || sig.device === 'logicstate')) {
          const press = s.cond.value === sig.activeLevel;
          return { label: press ? 'Attendre l’appui' : 'Attendre le relâchement', detail: `${sig.name} == ${s.cond.value}`, tone };
        }
      }
      return { label: 'Attendre que', detail: describeCond(program, s.cond, opts), tone };
    }
    case 'if': {
      const first = s.branches[0];
      const extra = s.branches.length - 1;
      const more = [extra > 0 ? `${extra} sinon si` : '', s.otherwise ? 'sinon' : ''].filter(Boolean).join(', ');
      return { label: 'Si', detail: `${first ? describeCond(program, first.cond, opts) : '…'}${more ? ` · ${more}` : ''}`, tone };
    }
    case 'while':
      return { label: 'Tant que', detail: describeCond(program, s.cond, opts), tone };
    case 'repeat':
      return { label: 'Répéter', detail: `${s.times} fois (compteur ${s.counter})`, tone };
    case 'for':
      return { label: 'Pour', detail: `${exprText(program, s.init.target)} = ${exprText(program, s.init.value)} ; ${describeCond(program, s.cond, opts)}`, tone };
    case 'assign':
      return { label: 'Affecter', detail: `${exprText(program, s.target)} = ${exprText(program, s.value)}`, tone };
    case 'incr':
      return { label: 'Incrémenter', detail: `${s.variable} = ${s.variable} + 1`, tone };
    case 'decr':
      return { label: 'Décrémenter', detail: `${s.variable} = ${s.variable} - 1`, tone };
    case 'call':
      return { label: 'Appeler', detail: `${s.name || '…'}()`, tone };
    case 'clearFlag':
      return { label: 'Effacer', detail: `drapeau ${s.flag}`, tone };
    case 'comment':
      return { label: 'Commentaire', detail: s.text, tone };
    case 'raw': {
      const first = s.code.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '(vide)';
      return { label: 'Code C', detail: first, tone };
    }
  }
}

/** « Attendre l'appui » ↔ « Attendre le relâchement » for a waitFor on a pin. */
export function flipWait(cond: Cond): Cond {
  return cond.kind === 'pin' ? negateCond(cond) : cond;
}
