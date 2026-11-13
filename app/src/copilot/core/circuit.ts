// Circuits between the copilot's answer format (parts + links) and the app's schematics:
//   - answer → AutoNetlist → autolayout (a tidy schematic);
//   - current schematic → the same compact format, sent with follow-up requests so the copilot edits the existing
//     project instead of starting over.
import {
  AUTO_MCU_REF, autolayout, buildNetlist, pinKey, type AutoLayoutResult, type AutoNetlist, type AutoPartKind,
  type ComponentInstance, type Schematic,
} from '@pic/circuit';
import type { AnswerCircuit, AnswerLink, AnswerPart } from './schema';

const MHZ = 1_000_000;

export function toAutoNetlist(c: AnswerCircuit): AutoNetlist {
  return {
    clockHz: Math.round(c.horloge_mhz * MHZ),
    parts: c.composants.map((p) => ({
      ref: p.ref,
      kind: p.type,
      ...(p.nom ? { label: p.nom } : {}),
      ...(p.couleur ? { color: p.couleur } : {}),
      ...(p.valeur ? { value: p.valeur } : {}),
    })),
    links: c.liaisons.map((l) => ({ from: l.de, to: l.vers })),
  };
}

/** Lay the answer's circuit out (never throws). */
export function layoutCircuit(c: AnswerCircuit): AutoLayoutResult {
  return autolayout(toAutoNetlist(c));
}

// ------------------------------------------------------------------------------------------------ schematic → answer format

const AUTO_KINDS: ReadonlySet<string> = new Set<AutoPartKind>([
  'LED', 'LOGICSTATE', 'BUTTON', 'RES', '7SEG-BCD', 'TRAFFIC_LIGHTS', 'TORCH_LDR', 'CAP', 'CRYSTAL',
]);

/** PIC symbol pin → the short name the copilot uses. */
const SHORT_PIN: Readonly<Record<string, string>> = {
  'RA4/T0CKI': 'RA4', 'RB0/INT': 'RB0', 'OSC1/CLKIN': 'OSC1', 'OSC2/CLKOUT': 'OSC2',
};

/** Reference the copilot uses for a component (unique, C-like). */
function refsOf(components: readonly ComponentInstance[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const c of components) {
    if (c.kind === 'PIC16F84A') { out.set(c.id, AUTO_MCU_REF); used.add(AUTO_MCU_REF); break; }
  }
  for (const c of components) {
    if (out.has(c.id) || !AUTO_KINDS.has(c.kind)) continue;
    let base = (/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.id) ? c.id : (c.ref || c.kind)).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!/^[A-Z_]/.test(base)) base = `P_${base}`;
    let ref = base;
    for (let n = 2; used.has(ref); n++) ref = `${base}_${n}`;
    used.add(ref);
    out.set(c.id, ref);
  }
  return out;
}

const COLOR_OUT: Readonly<Record<string, string>> = { RED: 'RED', GREEN: 'GREEN', BLUE: 'BLUE', YELLOW: 'YELLOW' };

function partOf(c: ComponentInstance, ref: string): AnswerPart {
  const part: AnswerPart = { ref, type: c.kind as AutoPartKind };
  if ((c.kind === 'LED' || c.kind === '7SEG-BCD') && typeof c.props.color === 'string' && COLOR_OUT[c.props.color]) part.couleur = c.props.color;
  if (c.kind === 'RES' || c.kind === 'CAP' || c.kind === 'CRYSTAL') { if (c.value) part.valeur = c.value; }
  if (c.kind === 'LOGICSTATE') part.valeur = String(Number(c.props.state) === 1 ? 1 : 0);
  if (c.kind === 'TORCH_LDR' && c.props.level !== undefined) part.valeur = String(c.props.level);
  if (c.ref && c.ref.toUpperCase() !== ref) part.nom = c.ref;
  return part;
}

/**
 * The project's schematic in the answer format: the parts the copilot knows and one link chain per net
 * (first pin → each other pin, rails as GND / VDD). Parts the copilot cannot describe are listed in `autres`.
 */
export function schematicToCircuit(schematic: Schematic): { circuit: AnswerCircuit; autres: string[] } {
  const refs = refsOf(schematic.components);
  const composants: AnswerPart[] = [];
  const autres: string[] = [];
  for (const c of schematic.components) {
    const ref = refs.get(c.id);
    if (ref && ref !== AUTO_MCU_REF) composants.push(partOf(c, ref));
    else if (!ref && c.kind !== 'POWER' && c.kind !== 'GROUND' && c.kind !== 'PIC16F84A') autres.push(`${c.ref || c.id} (${c.kind})`);
  }
  const netlist = buildNetlist(schematic);
  const liaisons: AnswerLink[] = [];
  for (const net of netlist.nets) {
    const ends: string[] = [];
    for (const p of net.pins) {
      const ref = refs.get(p.componentId);
      if (!ref) continue;
      const pin = ref === AUTO_MCU_REF ? (SHORT_PIN[p.pin] ?? p.pin) : p.pin;
      ends.push(schematic.components.find((c) => c.id === p.componentId)?.kind === 'LOGICSTATE' ? ref : `${ref}.${pin}`);
    }
    const head = net.rail ?? ends.shift();
    if (!head) continue;
    for (const e of ends) liaisons.push({ de: head, vers: e });
  }
  return { circuit: { horloge_mhz: schematic.clockHz / MHZ, composants, liaisons }, autres };
}

/** Compact one-line-per-item text of a circuit (what the prompt carries). */
export function circuitToText(c: AnswerCircuit): string {
  return JSON.stringify(c);
}

/** True when the schematic holds nothing but the PIC (a blank project). */
export function isEmptySchematic(s: Schematic): boolean {
  return s.components.every((c) => c.kind === 'PIC16F84A' || c.kind === 'POWER' || c.kind === 'GROUND') && s.wires.length === 0;
}

/** Component id of an answer ref in a laid-out schematic (case-insensitive), or undefined. */
export function componentIdOf(layout: Pick<AutoLayoutResult, 'ids'>, ref: string): string | undefined {
  return layout.ids[ref.trim().toUpperCase()];
}

export { pinKey };
