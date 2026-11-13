import type { BaseTypeName, CType, IntType, TypeSpec } from '../ast';
import { Codes } from '../diagnostics';
import type { TokenStream } from './stream';

const BASE_KEYWORDS = new Set(['void', 'char', 'short', 'int', 'long', 'bit', 'sbit', 'float', 'double']);
const QUALIFIERS = new Set(['const', 'volatile', 'static', 'extern', 'register', 'sfr', 'code', 'data', 'rx', 'unsigned', 'signed']);
const UNSUPPORTED_TYPES = new Set(['struct', 'union', 'enum']);
/** Keywords that fully determine the type on their own. */
const STANDALONE = new Set(['void', 'char', 'bit', 'sbit', 'float', 'double']);

export const u8: IntType = { kind: 'int', size: 1, signed: false };

/** True when the current token starts a type (declaration). */
export function isTypeStart(p: TokenStream, offset = 0): boolean {
  const t = p.peek(offset);
  if (t.kind !== 'ident') return false;
  return BASE_KEYWORDS.has(t.value) || QUALIFIERS.has(t.value) || UNSUPPORTED_TYPES.has(t.value) || p.typedefs.has(t.value.toLowerCase());
}

/** Parse declaration specifiers, e.g. `static const unsigned char`. */
export function parseTypeSpec(p: TokenStream, typedefTypes: Map<string, CType>): TypeSpec {
  const start = p.pos;
  const seen = new Map<string, number>();
  let signedness: TypeSpec['signedness'] = 'default';
  let isConst = false;
  let isVolatile = false;
  let isSfr = false;
  let storage: TypeSpec['storage'] = 'none';
  let typedefName: string | undefined;

  for (;;) {
    const t = p.peek();
    if (t.kind !== 'ident') break;
    const v = t.value;
    if (v === 'const') isConst = true;
    else if (v === 'volatile') isVolatile = true;
    else if (v === 'static' || v === 'extern' || v === 'register') storage = v;
    else if (v === 'sfr') isSfr = true;
    else if (v === 'code' || v === 'data' || v === 'rx') { /* MikroC memory specifiers: placement is implicit here */ }
    else if (v === 'unsigned' || v === 'signed') signedness = v;
    else if (UNSUPPORTED_TYPES.has(v)) p.error(Codes.UNSUPPORTED, `'${v}' n'est pas supporté`, t.span);
    else if (BASE_KEYWORDS.has(v)) seen.set(v, (seen.get(v) ?? 0) + 1);
    else if (seen.size === 0 && typedefName === undefined && signedness === 'default' && p.typedefs.has(v.toLowerCase())) typedefName = v;
    else break;
    p.next();
  }

  if (p.pos === start) p.errorExpected('Type');
  const span = p.spanFrom(start);
  const standalone = [...seen.keys()].filter((k) => STANDALONE.has(k));
  const sizeWords = ['short', 'long'].filter((k) => seen.has(k));
  const invalid =
    standalone.length > 1 ||
    (standalone.length === 1 && (sizeWords.length > 0 || seen.has('int'))) ||
    sizeWords.length > 1 ||
    [...seen.values()].some((n) => n > 1) ||
    (typedefName !== undefined && seen.size > 0);
  if (invalid) {
    const longLong = (seen.get('long') ?? 0) > 1;
    p.diags.error(Codes.UNSUPPORTED, longLong ? "'long long' n'est pas supporté" : 'Combinaison de types invalide', span);
  }

  let base: BaseTypeName = standalone[0] as BaseTypeName | undefined ?? (sizeWords[0] as BaseTypeName | undefined) ?? 'int';
  let type: CType;
  if (typedefName !== undefined) {
    type = typedefTypes.get(typedefName.toLowerCase()) ?? { kind: 'int', size: 2, signed: true };
    base = baseNameOf(type);
  } else {
    type = resolveBaseType(base, signedness);
  }
  if (base === 'float' || base === 'double') {
    p.diags.error(Codes.UNSUPPORTED, 'Les types à virgule flottante ne sont pas supportés', span);
  }
  return {
    kind: 'TypeSpec',
    ...p.base(start),
    base,
    signedness,
    isConst,
    isVolatile,
    storage,
    isSfr,
    typedefName,
    type,
  };
}

function baseNameOf(t: CType): BaseTypeName {
  if (t.kind === 'void') return 'void';
  if (t.kind === 'bit') return 'bit';
  if (t.kind === 'int') return t.size === 1 ? 'char' : t.size === 2 ? 'int' : 'long';
  return 'int';
}

/** MikroC sizes: char = unsigned 8, short = signed 8, int = signed 16, long = signed 32. */
export function resolveBaseType(base: BaseTypeName, signedness: TypeSpec['signedness']): CType {
  switch (base) {
    case 'void':
      return { kind: 'void' };
    case 'bit':
    case 'sbit':
      return { kind: 'bit' };
    case 'char':
      return { kind: 'int', size: 1, signed: signedness === 'signed' };
    case 'short':
      return { kind: 'int', size: 1, signed: signedness !== 'unsigned' };
    case 'int':
      return { kind: 'int', size: 2, signed: signedness !== 'unsigned' };
    case 'long':
    case 'float':
    case 'double':
      return { kind: 'int', size: 4, signed: signedness !== 'unsigned' };
  }
}
