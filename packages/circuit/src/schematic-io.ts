// JSON (de)serialisation of schematics (templates/*.schematic.json and saved projects).
import type { ComponentInstance, Point, Schematic, Wire } from './api';
import { COMPONENT_KINDS } from './symbols';

export interface SchematicMeta {
  /** Template / project name shown to the student. */
  name?: string;
  /** Where the circuit comes from (e.g. "cours/EXEMPLE1.DSN"). */
  source?: string;
  description?: string;
}

/** On-disk shape: a Schematic plus optional metadata. */
export type SchematicFile = SchematicMeta & Schematic;

/** Stable key order: id, kind, ref, value, at, rotation, mirror, props. */
function orderedComponent(c: ComponentInstance): ComponentInstance {
  return {
    id: c.id,
    kind: c.kind,
    ref: c.ref,
    ...(c.value !== undefined ? { value: c.value } : {}),
    at: { x: c.at.x, y: c.at.y },
    rotation: c.rotation,
    ...(c.mirror ? { mirror: true } : {}),
    props: { ...c.props },
  };
}

/** Stable, diff-friendly JSON (points kept on one line). */
export function serializeSchematic(schematic: Schematic, meta: SchematicMeta = {}): string {
  const file = {
    ...(meta.name !== undefined ? { name: meta.name } : {}),
    ...(meta.source !== undefined ? { source: meta.source } : {}),
    ...(meta.description !== undefined ? { description: meta.description } : {}),
    clockHz: schematic.clockHz,
    components: schematic.components.map(orderedComponent),
    wires: schematic.wires.map((w) => ({ id: w.id, points: w.points.map((p) => ({ x: p.x, y: p.y })) })),
  };
  return `${JSON.stringify(file, null, 2)
    .replace(/\{\n\s*"x": (-?[\d.e+-]+),\n\s*"y": (-?[\d.e+-]+)\n\s*\}/g, '{ "x": $1, "y": $2 }')
    .replace(/"points": \[\n\s*([^\]]*?)\n\s*\]/g, (_m, inner: string) => `"points": [${inner.replace(/\n\s*/g, ' ')}]`)}\n`;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPoint = (v: unknown): v is Point => typeof v === 'object' && v !== null && isNum((v as Point).x) && isNum((v as Point).y);

/** Check an untrusted value (parsed JSON). Errors are French, ready to show to the student. */
export function validateSchematic(value: unknown): { schematic: Schematic | null; errors: string[] } {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null) return { schematic: null, errors: ['Le schéma doit être un objet JSON.'] };
  const v = value as Partial<SchematicFile>;
  if (!isNum(v.clockHz) || v.clockHz <= 0) errors.push('clockHz doit être une fréquence positive (Hz).');
  if (!Array.isArray(v.components)) errors.push('« components » doit être une liste.');
  if (!Array.isArray(v.wires)) errors.push('« wires » doit être une liste.');
  if (errors.length) return { schematic: null, errors };

  const ids = new Set<string>();
  v.components!.forEach((c: Partial<ComponentInstance>, i) => {
    const where = `Composant n°${i + 1}${typeof c?.id === 'string' ? ` (${c.id})` : ''}`;
    if (typeof c !== 'object' || c === null) { errors.push(`${where} : objet attendu.`); return; }
    if (typeof c.id !== 'string' || c.id === '') errors.push(`${where} : identifiant manquant.`);
    else if (ids.has(c.id)) errors.push(`${where} : identifiant en double.`);
    else ids.add(c.id);
    if (!COMPONENT_KINDS.includes(c.kind as never)) errors.push(`${where} : type inconnu « ${String(c.kind)} ».`);
    if (typeof c.ref !== 'string') errors.push(`${where} : référence (ref) manquante.`);
    if (c.value !== undefined && typeof c.value !== 'string') errors.push(`${where} : valeur (value) invalide.`);
    if (!isPoint(c.at)) errors.push(`${where} : position (at) invalide.`);
    if (![0, 90, 180, 270].includes(c.rotation as number)) errors.push(`${where} : rotation invalide (0, 90, 180 ou 270).`);
    if (c.mirror !== undefined && typeof c.mirror !== 'boolean') errors.push(`${where} : mirror doit être un booléen.`);
    if (typeof c.props !== 'object' || c.props === null) errors.push(`${where} : props manquant.`);
  });
  const wireIds = new Set<string>();
  v.wires!.forEach((w: Partial<Wire>, i) => {
    const where = `Fil n°${i + 1}${typeof w?.id === 'string' ? ` (${w.id})` : ''}`;
    if (typeof w !== 'object' || w === null) { errors.push(`${where} : objet attendu.`); return; }
    if (typeof w.id !== 'string' || w.id === '') errors.push(`${where} : identifiant manquant.`);
    else if (wireIds.has(w.id)) errors.push(`${where} : identifiant en double.`);
    else wireIds.add(w.id);
    if (!Array.isArray(w.points) || w.points.length < 2 || !w.points.every(isPoint)) {
      errors.push(`${where} : au moins deux points (x, y) sont nécessaires.`);
    }
  });
  if (errors.length) return { schematic: null, errors };
  return {
    schematic: { clockHz: v.clockHz!, components: v.components as ComponentInstance[], wires: v.wires as Wire[] },
    errors,
  };
}

/** Parse a .schematic.json text. Throws an Error whose message lists the problems (French). */
export function parseSchematicJson(text: string): Schematic {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Fichier de schéma illisible : JSON invalide.');
  }
  const { schematic, errors } = validateSchematic(value);
  if (!schematic) throw new Error(`Schéma invalide :\n- ${errors.join('\n- ')}`);
  return schematic;
}

/** Like parseSchematicJson, keeping the template metadata (name, source, description). */
export function parseSchematicFile(text: string): SchematicFile {
  const schematic = parseSchematicJson(text);
  const raw = JSON.parse(text) as Record<string, unknown>;
  const meta: SchematicMeta = {};
  for (const key of ['name', 'source', 'description'] as const) {
    const v = raw[key];
    if (typeof v === 'string') meta[key] = v;
  }
  return { ...meta, ...schematic };
}
