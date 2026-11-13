// Semantic checks of a program, optionally against its schematic. Messages are French, for the student.
import { buildNetlist, type Schematic } from '@pic/circuit';
import { deriveSignals } from './derive';
import { busById, signalById } from './describe';
import { busPins, isPinName, pinBit, pinPort, schematicPinName } from './pins';
import { forEachStmt, interruptRoutine, stmtConds, stmtExprs, walkCond, walkExpr, walkStmts } from './walk';
import type { Cond, Expr, Issue, PinName, Program, Stmt } from './types';

const C_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Names the code cannot redefine (registers, bits and the MikroC built-ins used by the generator). */
const RESERVED = new Set([
  'PORTA', 'PORTB', 'TRISA', 'TRISB', 'STATUS', 'INTCON', 'OPTION_REG', 'TMR0', 'PCL', 'PCLATH', 'FSR', 'INDF',
  'EEDATA', 'EEADR', 'EECON1', 'EECON2', 'GIE', 'INTE', 'INTF', 'RBIE', 'RBIF', 'T0IE', 'T0IF',
  'MAIN', 'INTERRUPT', 'DELAY_MS', 'DELAY_US', 'VDELAY_MS', 'BUTTON', 'LED_ON', 'LED_OFF',
  'IF', 'ELSE', 'WHILE', 'FOR', 'DO', 'SWITCH', 'CASE', 'BREAK', 'CONTINUE', 'RETURN', 'VOID', 'CHAR', 'INT',
  'UNSIGNED', 'SIGNED', 'SHORT', 'LONG', 'CONST', 'VOLATILE', 'STATIC', 'BIT', 'SBIT', 'ABSOLUTE', 'AT',
  ...['RA0', 'RA1', 'RA2', 'RA3', 'RA4', 'RB0', 'RB1', 'RB2', 'RB3', 'RB4', 'RB5', 'RB6', 'RB7'],
]);

export interface ValidateOptions {
  /** Netlist of `schematic` when the caller already has one. */
  netlist?: ReturnType<typeof buildNetlist>;
}

/** Problems that would make the generated C wrong or surprising. Errors block generation in the assistant. */
export function validate(program: Program, schematic?: Schematic, options: ValidateOptions = {}): Issue[] {
  const issues: Issue[] = [];
  const add = (severity: Issue['severity'], code: string, message: string, extra: Partial<Issue> = {}) =>
    issues.push({ severity, code, message, ...extra });

  // ----------------------------------------------------------------------------------------- names and pins
  const names = new Map<string, string>(); // upper-case name → what owns it
  const claim = (name: string, owner: string, extra: Partial<Issue> = {}) => {
    if (!C_IDENTIFIER.test(name)) {
      add('error', 'E_BAD_NAME', `« ${name} » n'est pas un nom valide en C (lettres, chiffres et _, sans accent ni espace, pas de chiffre au début).`, extra);
      return;
    }
    const key = name.toUpperCase();
    if (RESERVED.has(key)) add('error', 'E_RESERVED_NAME', `« ${name} » est un nom réservé (registre, bit ou fonction de MikroC) : choisissez un autre nom.`, extra);
    const prev = names.get(key);
    // MikroC identifiers are case-insensitive: LED and led are the same name.
    if (prev) add('error', 'E_DUPLICATE_NAME', `Le nom « ${name} » est déjà utilisé par ${prev} (MikroC ne distingue pas majuscules et minuscules).`, extra);
    else names.set(key, owner);
  };

  const pinOwner = new Map<PinName, string>();
  const claimPin = (pin: PinName, owner: string, extra: Partial<Issue>) => {
    const prev = pinOwner.get(pin);
    if (prev) add('error', 'E_PIN_TWICE', `La broche ${pin} est utilisée deux fois (${prev} et ${owner}).`, extra);
    else pinOwner.set(pin, owner);
  };

  const signalIds = new Set<string>();
  for (const s of program.signals) {
    const extra = { signalId: s.id };
    if (signalIds.has(s.id)) add('error', 'E_DUPLICATE_ID', `Deux signaux ont le même identifiant interne « ${s.id} ».`, extra);
    signalIds.add(s.id);
    if (!isPinName(s.pin)) {
      add('error', 'E_BAD_PIN', `${s.name} : la broche « ${String(s.pin)} » n'existe pas sur le PIC16F84A (RA0 à RA4, RB0 à RB7).`, extra);
      continue;
    }
    if (s.useDefine !== false) claim(s.name, `le signal ${s.name} (${s.pin})`, extra);
    claimPin(s.pin, s.name, extra);
    if (s.pin === 'RA4' && s.dir === 'out' && (s.device === 'led' || s.device === 'lamp') && s.activeLevel === 1) {
      add('warning', 'W_RA4_OPEN_DRAIN', `${s.name} est sur RA4 : cette sortie est à drain ouvert, elle ne peut pas fournir de courant à une LED sans résistance de tirage.`, extra);
    }
  }
  for (const b of program.buses) {
    claim(b.name, `le bus ${b.name}`);
    const width = b.port === 'A' ? 5 : 8;
    if (b.lsb < 0 || b.width < 1 || b.lsb + b.width > width) {
      add('error', 'E_BAD_BUS', `Le bus ${b.name} dépasse le PORT${b.port} (bits ${b.lsb} à ${b.lsb + b.width - 1}).`);
      continue;
    }
    for (const p of busPins(b)) claimPin(p, `le bus ${b.name}`, {});
  }
  for (const c of program.constants) claim(c.name, `la constante ${c.name}`);
  for (const v of program.variables) claim(v.name, `la variable ${v.name}`);

  // ----------------------------------------------------------------------------------------- statements
  const varNames = new Set([...program.variables.map((v) => v.name.toUpperCase()), ...program.constants.map((c) => c.name.toUpperCase())]);
  const functionNames = new Set(program.functions.map((f) => f.name.toUpperCase()));

  const checkExpr = (e: Expr, stmtId: string) => walkExpr(e, (x) => {
    if (x.kind === 'var' && !varNames.has(x.name.toUpperCase())) {
      add('error', 'E_UNKNOWN_VARIABLE', `La variable « ${x.name} » n'est pas déclarée.`, { stmtId });
    } else if (x.kind === 'signal' && !signalById(program, x.id)) {
      add('error', 'E_UNKNOWN_SIGNAL', `Signal inconnu (« ${x.id} »).`, { stmtId });
    } else if (x.kind === 'bus' && !busById(program, x.id)) {
      add('error', 'E_UNKNOWN_BUS', `Bus inconnu (« ${x.id} »).`, { stmtId });
    }
  });
  const checkCond = (c: Cond, stmtId: string) => walkCond(c, (x) => {
    if (x.kind === 'pin') {
      const s = signalById(program, x.signal);
      if (!s) add('error', 'E_UNKNOWN_SIGNAL', `Signal inconnu (« ${x.signal} »).`, { stmtId });
      else if (s.dir === 'out') add('warning', 'W_OUTPUT_TESTED', `${s.name} est une sortie : tester son niveau relit la broche (vérifiez que c'est voulu).`, { stmtId, signalId: s.id });
    }
  }, (e) => checkExpr(e, stmtId));
  const writeTo = (signalId: string, stmtId: string) => {
    const s = signalById(program, signalId);
    if (!s) add('error', 'E_UNKNOWN_SIGNAL', `Signal inconnu (« ${signalId} »).`, { stmtId });
    else if (s.dir === 'in') add('error', 'E_INPUT_WRITTEN', `${s.name} (${s.pin}) est une entrée : on ne peut pas l'allumer ou l'éteindre. Changez sa direction ou choisissez une sortie.`, { stmtId, signalId: s.id });
  };

  const checkStmt = (s: Stmt) => {
    for (const c of stmtConds(s)) checkCond(c, s.id);
    for (const e of stmtExprs(s)) checkExpr(e, s.id);
    switch (s.kind) {
      case 'set':
      case 'toggle':
        writeTo(s.signal, s.id);
        break;
      case 'setAll':
        s.signals.forEach((x) => writeTo(x, s.id));
        break;
      case 'display': {
        const b = busById(program, s.bus);
        if (!b) add('error', 'E_UNKNOWN_BUS', `Bus inconnu (« ${s.bus} »).`, { stmtId: s.id });
        else if (b.dir === 'in') add('error', 'E_INPUT_WRITTEN', `${b.name} est un bus d'entrée : on ne peut pas y afficher de valeur.`, { stmtId: s.id });
        else if (s.value.kind === 'num' && s.value.value >= 1 << b.width) {
          add('warning', 'W_VALUE_TOO_WIDE', `${b.name} n'a que ${b.width} bits : la valeur ${s.value.value} ne tient pas (maximum ${(1 << b.width) - 1}).`, { stmtId: s.id });
        }
        break;
      }
      case 'assign':
        if (s.target.kind === 'signal') writeTo(s.target.id, s.id);
        break;
      case 'incr':
      case 'decr':
        if (!varNames.has(s.variable.toUpperCase())) add('error', 'E_UNKNOWN_VARIABLE', `La variable « ${s.variable} » n'est pas déclarée.`, { stmtId: s.id });
        break;
      case 'repeat':
        if (!varNames.has(s.counter.toUpperCase())) add('error', 'E_UNKNOWN_VARIABLE', `Le compteur « ${s.counter} » n'est pas déclaré dans les variables.`, { stmtId: s.id });
        if (!Number.isInteger(s.times) || s.times < 1 || s.times > 255) add('error', 'E_BAD_COUNT', `Le nombre de répétitions doit être un entier de 1 à 255 (compteur unsigned char).`, { stmtId: s.id });
        break;
      case 'delay':
        if (!Number.isInteger(s.ms) || s.ms <= 0) add('error', 'E_BAD_DELAY', 'La durée de Delay_ms doit être un nombre entier positif (constante).', { stmtId: s.id });
        break;
      case 'call':
        if (!functionNames.has(s.name.toUpperCase())) add('error', 'E_UNKNOWN_FUNCTION', `La fonction « ${s.name} » n'existe pas.`, { stmtId: s.id });
        break;
      case 'if':
        if (s.branches.length === 0) add('error', 'E_EMPTY_IF', 'Un « si » doit avoir au moins une condition.', { stmtId: s.id });
        break;
      default:
        break;
    }
  };
  forEachStmt(program, ({ stmt }) => checkStmt(stmt));

  // ----------------------------------------------------------------------------------------- interrupts
  const it = program.interrupts;
  const isr = interruptRoutine(program);
  const enabled = !!it && (!!it.int || !!it.rbChange || !!it.tmr0);
  if (enabled && !isr) add('error', 'E_NO_ISR', "Des interruptions sont autorisées mais la fonction « void interrupt() » n'existe pas.");
  if (enabled && it && !it.gie) add('warning', 'W_NO_GIE', "Aucune interruption ne se produira : GIE (autorisation générale) n'est pas mis à 1.");
  if (isr && !enabled) add('warning', 'W_ISR_NEVER_CALLED', "La fonction « void interrupt() » ne sera jamais appelée : aucune interruption n'est autorisée.");
  if (isr && it) {
    const cleared = new Set<string>();
    walkStmts(isr.body, (s) => {
      if (s.kind === 'clearFlag') cleared.add(s.flag);
      if (s.kind === 'assign' && s.target.kind === 'reg' && s.target.name.toUpperCase() === 'INTCON' && s.target.bit) cleared.add(s.target.bit.toUpperCase());
    });
    const need: [boolean, string, string][] = [
      [!!it.int, 'INTF', 'RB0/INT'], [!!it.rbChange, 'RBIF', 'changement sur RB4 à RB7'], [!!it.tmr0, 'T0IF', 'TMR0'],
    ];
    for (const [on, f, what] of need) {
      if (on && !cleared.has(f)) add('warning', 'W_FLAG_NOT_CLEARED', `Le drapeau ${f} (${what}) n'est jamais remis à 0 dans l'interruption : elle se redéclenchera sans fin.`, { stmtId: isr.id });
    }
  }
  if (it?.int) {
    const rb0 = program.signals.find((s) => s.pin === 'RB0');
    const rb0Bus = program.buses.find((b) => busPins(b).includes('RB0'));
    if ((rb0 && rb0.dir === 'out') || (rb0Bus && rb0Bus.dir === 'out')) add('error', 'E_INT_PIN_OUTPUT', "L'interruption RB0/INT a besoin de RB0 en entrée.");
  }
  if (it?.rbChange) {
    const any = program.signals.some((s) => pinPort(s.pin) === 'B' && pinBit(s.pin) >= 4 && s.dir === 'in')
      || program.buses.some((b) => b.dir === 'in' && busPins(b).some((p) => pinPort(p) === 'B' && pinBit(p) >= 4));
    if (!any) add('warning', 'W_RBIE_NO_INPUT', "L'interruption sur changement surveille RB4 à RB7, mais aucune de ces broches n'est une entrée.");
  }

  // ----------------------------------------------------------------------------------------- schematic
  if (schematic) checkAgainstSchematic(program, schematic, options.netlist ?? buildNetlist(schematic), add);
  return issues;
}

function checkAgainstSchematic(
  program: Program,
  schematic: Schematic,
  netlist: ReturnType<typeof buildNetlist>,
  add: (severity: Issue['severity'], code: string, message: string, extra?: Partial<Issue>) => void,
): void {
  const pic = schematic.components.find((c) => c.kind === 'PIC16F84A');
  if (!pic) {
    add('warning', 'W_NO_PIC', 'Le schéma ne contient pas de PIC16F84A.');
    return;
  }
  if (schematic.clockHz !== program.clockHz) {
    add('warning', 'W_CLOCK_MISMATCH', `L'horloge du programme (${program.clockHz / 1e6} MHz) diffère de celle du schéma (${schematic.clockHz / 1e6} MHz) : les temporisations seront fausses.`);
  }
  const ids = new Set(schematic.components.map((c) => c.id));
  const derived = deriveSignals(schematic, netlist);
  const derivedByPin = new Map(derived.signals.map((s) => [s.pin, s] as const));
  const derivedBusPins = new Set(derived.buses.flatMap((b) => busPins(b)));

  const connected = (pin: PinName) => {
    const net = netlist.pinToNet.get(`${pic.id}:${schematicPinName(pin)}`);
    const n = net ? netlist.nets.find((x) => x.id === net) : undefined;
    return !!n && n.pins.length > 1;
  };

  for (const s of program.signals) {
    const extra = { signalId: s.id };
    if (s.componentId && !ids.has(s.componentId)) add('warning', 'W_COMPONENT_MISSING', `${s.name} : le composant « ${s.componentId} » n'est plus dans le schéma.`, extra);
    if (!connected(s.pin)) {
      add('warning', 'W_PIN_UNCONNECTED', `${s.name} utilise ${s.pin}, mais rien n'est branché sur cette broche dans le schéma.`, extra);
      continue;
    }
    const d = derivedByPin.get(s.pin);
    if (!d) continue;
    if (s.dir === 'out' && d.dir === 'in') {
      add('error', 'E_OUTPUT_ON_SOURCE', `${s.name} est une sortie, mais ${s.pin} est reliée à ${d.device === 'button' ? 'un bouton' : d.device === 'sensor' ? 'un capteur' : 'un interrupteur (LOGICSTATE)'} : deux sources en conflit.`, extra);
    } else if (s.dir === 'in' && d.dir === 'out') {
      add('warning', 'W_INPUT_ON_LOAD', `${s.name} est une entrée, mais ${s.pin} est reliée à ${d.device === 'lamp' ? 'un feu' : 'une LED'} : rien ne la commandera.`, extra);
    }
  }
  for (const b of program.buses) {
    for (const p of busPins(b)) {
      if (!connected(p) && !derivedBusPins.has(p)) {
        add('warning', 'W_PIN_UNCONNECTED', `Le bus ${b.name} utilise ${p}, mais rien n'est branché sur cette broche dans le schéma.`);
        break;
      }
    }
  }
}
