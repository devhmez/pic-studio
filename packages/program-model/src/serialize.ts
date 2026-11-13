// JSON (de)serialisation of programs (templates/*.program.json, project files).
import { defaultStyle, ensureIds } from './builders';
import { isPinName } from './pins';
import { PROGRAM_VERSION, type Program } from './types';

const INLINE_WIDTH = 100;

/** One-line JSON with a space after ':' and ',' (`{ "kind": "var", "name": "x" }`). */
function inline(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? '[]' : `[${value.map(inline).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return entries.length === 0 ? '{}' : `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`).join(', ')} }`;
  }
  return JSON.stringify(value);
}

/** `prefix`: characters already on the first line (the `"key": ` of an object member). */
function pretty(value: unknown, indent: string, prefix = 0): string {
  const flat = inline(value);
  if (value === null || typeof value !== 'object' || indent.length + prefix + flat.length <= INLINE_WIDTH) return flat;
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((v) => inner + pretty(v, inner)).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${pretty(v, inner, k.length + 4)}`).join(',\n')}\n${indent}}`;
}

/** Diff-friendly JSON: small objects (conditions, expressions, short statements) stay on one line. */
export function serializeProgram(program: Program): string {
  const ordered: Program = {
    version: program.version,
    title: program.title,
    ...(program.description !== undefined ? { description: program.description } : {}),
    clockHz: program.clockHz,
    style: program.style,
    signals: program.signals,
    buses: program.buses,
    constants: program.constants,
    variables: program.variables,
    ...(program.interrupts ? { interrupts: program.interrupts } : {}),
    init: program.init,
    loop: program.loop,
    functions: program.functions,
    ...(program.rawDefines?.length ? { rawDefines: program.rawDefines } : {}),
    ...(program.rawGlobals?.length ? { rawGlobals: program.rawGlobals } : {}),
  };
  return `${pretty(ordered, '')}\n`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Structural check of untrusted JSON. Errors are French, ready to show to the student. */
export function checkProgramShape(value: unknown): string[] {
  const errors: string[] = [];
  if (!isObj(value)) return ['Le programme doit être un objet JSON.'];
  if (value.version !== PROGRAM_VERSION) errors.push(`Version de programme non prise en charge : ${String(value.version)} (attendu ${PROGRAM_VERSION}).`);
  if (typeof value.title !== 'string') errors.push('« title » doit être un texte.');
  if (typeof value.clockHz !== 'number' || !(value.clockHz > 0)) errors.push('« clockHz » doit être une fréquence positive (Hz).');
  for (const key of ['signals', 'buses', 'constants', 'variables', 'init', 'functions'] as const) {
    if (!Array.isArray(value[key])) errors.push(`« ${key} » doit être une liste.`);
  }
  if (value.loop !== null && !Array.isArray(value.loop)) errors.push('« loop » doit être une liste ou null.');
  if (Array.isArray(value.signals)) {
    value.signals.forEach((s: unknown, i: number) => {
      const where = `Signal n°${i + 1}`;
      if (!isObj(s)) { errors.push(`${where} : objet attendu.`); return; }
      if (typeof s.id !== 'string' || !s.id) errors.push(`${where} : identifiant manquant.`);
      if (typeof s.name !== 'string' || !s.name) errors.push(`${where} : nom manquant.`);
      if (!isPinName(s.pin)) errors.push(`${where} : broche invalide « ${String(s.pin)} ».`);
      if (s.dir !== 'in' && s.dir !== 'out') errors.push(`${where} : direction « in » ou « out » attendue.`);
      if (s.activeLevel !== 0 && s.activeLevel !== 1) errors.push(`${where} : niveau actif 0 ou 1 attendu.`);
    });
  }
  if (Array.isArray(value.buses)) {
    value.buses.forEach((b: unknown, i: number) => {
      const where = `Bus n°${i + 1}`;
      if (!isObj(b)) { errors.push(`${where} : objet attendu.`); return; }
      if (b.port !== 'A' && b.port !== 'B') errors.push(`${where} : port A ou B attendu.`);
      if (typeof b.lsb !== 'number' || typeof b.width !== 'number' || b.width < 1) errors.push(`${where} : bits (lsb, width) invalides.`);
    });
  }
  const checkStmts = (list: unknown, where: string) => {
    if (!Array.isArray(list)) return;
    list.forEach((s: unknown, i: number) => {
      if (!isObj(s) || typeof s.kind !== 'string') errors.push(`${where}, instruction n°${i + 1} : « kind » manquant.`);
    });
  };
  checkStmts(value.init, 'Initialisation');
  checkStmts(value.loop, 'Boucle principale');
  return errors;
}

/** Parse a .program.json text; fills style defaults and missing ids. Throws an Error listing the problems (French). */
export function parseProgramJson(text: string): Program {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Fichier de programme illisible : JSON invalide.');
  }
  const errors = checkProgramShape(value);
  if (errors.length) throw new Error(`Programme invalide :\n- ${errors.join('\n- ')}`);
  return normalizeProgram(value as Program);
}

/** Fill optional parts (style fields added in later versions, ids) of a structurally valid program. */
export function normalizeProgram(program: Program): Program {
  const style = { ...defaultStyle(), ...(program.style ?? {}) };
  style.tris = { ...defaultStyle().tris, ...(program.style?.tris ?? {}) };
  return ensureIds({ ...program, style });
}

/** Deep copy (programs are plain JSON). */
export function cloneProgram(program: Program): Program {
  return JSON.parse(JSON.stringify(program)) as Program;
}
