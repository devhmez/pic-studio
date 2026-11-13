// Data for MikroC autocomplete, gathered from the compiler's AST and symbol table (pure; no CodeMirror imports).
import type { CompileResultEx, Statement, SymbolInfo, TranslationUnit } from '@pic/compiler';
import { SFRS } from '@pic/compiler';
import { sfrByName } from '@pic/emulator';

export type UserSymbolKind = 'macro' | 'variable' | 'function' | 'sbit';

export interface UserSymbol {
  name: string;
  kind: UserSymbolKind;
  /** Short French detail, e.g. '#define PORTB.F0', 'unsigned char · main', 'fonction'. */
  detail: string;
}

export interface CompletionData {
  user: UserSymbol[];
}

export const EMPTY_COMPLETION_DATA: CompletionData = { user: [] };

function typeText(spec: { text: string } | undefined): string {
  return spec ? spec.text.replace(/\s+/g, ' ').trim() : '';
}

function collectStatement(s: Statement, scope: string, out: UserSymbol[]): void {
  switch (s.kind) {
    case 'DeclarationStatement':
      for (const d of s.declarations) out.push({ name: d.name, kind: 'variable', detail: `${typeText(d.typeSpec)}${d.isArray ? '[]' : ''} · ${scope}` });
      return;
    case 'SbitDeclaration':
      out.push({ name: s.name, kind: 'sbit', detail: s.target ? `sbit → ${s.target.text}` : 'sbit' });
      return;
    case 'Block':
      for (const b of s.body) collectStatement(b, scope, out);
      return;
    case 'IfStatement':
      collectStatement(s.consequent, scope, out);
      if (s.alternate) collectStatement(s.alternate, scope, out);
      return;
    case 'WhileStatement':
    case 'DoWhileStatement':
      collectStatement(s.body, scope, out);
      return;
    case 'ForStatement':
      if (s.init && s.init.kind === 'DeclarationStatement') collectStatement(s.init, scope, out);
      collectStatement(s.body, scope, out);
      return;
    case 'SwitchStatement':
      for (const c of s.cases) for (const b of c.consequent) collectStatement(b, scope, out);
      return;
    default:
      return;
  }
}

/** #define names, globals, locals, parameters, sbits and functions declared in the program. */
export function collectUserSymbols(ast: TranslationUnit | undefined, symbols: readonly SymbolInfo[] = []): UserSymbol[] {
  const out: UserSymbol[] = [];
  if (ast) {
    for (const m of ast.macros) {
      if (m.undefinedAtLine !== undefined) continue;
      const params = m.params ? `(${m.params.join(', ')})` : '';
      out.push({ name: m.name, kind: 'macro', detail: `#define${params} ${m.body}`.trim() });
    }
    for (const top of ast.body) {
      if (top.kind === 'FunctionDeclaration') {
        if (top.name.toLowerCase() !== 'main' && !top.isInterrupt) out.push({ name: top.name, kind: 'function', detail: 'fonction' });
        for (const p of top.params) if (p.name) out.push({ name: p.name, kind: 'variable', detail: `${typeText(p.typeSpec)} · paramètre de ${top.name}` });
        if (top.body) collectStatement(top.body, top.name, out);
      } else {
        collectStatement(top, 'globale', out);
      }
    }
  }
  // Symbols the compiler placed in RAM (covers code that no longer parses but compiled before).
  for (const s of symbols) out.push({ name: s.name, kind: 'variable', detail: `${s.type} · ${s.scope === 'global' ? 'globale' : s.scope}` });
  // De-duplicate case-insensitively (MikroC identifiers are case-insensitive), first occurrence wins.
  const seen = new Set<string>();
  return out.filter((u) => {
    const k = u.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function completionDataFrom(result: CompileResultEx | null): CompletionData {
  if (!result) return EMPTY_COMPLETION_DATA;
  return { user: collectUserSymbols(result.ast, result.symbols) };
}

export interface BitOption {
  label: string;
  detail: string;
}

/**
 * Bit selectors offered after `REG.`: the register's own bit names (TRIS registers also get the port pin names, as
 * the prof writes `TRISA.RA0`), then F0–F7. Unknown objects (variables, aliases) get F0–F7 and B0–B7.
 */
export function bitOptionsFor(objectName: string | null): BitOption[] {
  const sfr = objectName ? SFRS.find((s) => s.name === objectName.toUpperCase().replace(/BITS$/, '')) : undefined;
  const out: BitOption[] = [];
  if (sfr) {
    const info = sfrByName(sfr.name);
    const portFor: Record<string, string> = { TRISA: 'PORTA', TRISB: 'PORTB' };
    const pinsOf = portFor[sfr.name] ? SFRS.find((s) => s.name === portFor[sfr.name]) : undefined;
    const names = pinsOf ? pinsOf.bits : sfr.bits;
    names.forEach((n, bit) => {
      if (!n) return;
      const what = pinsOf ? `bit ${bit} de ${sfr.name} (${(info?.bits[bit] ?? n)})` : `bit ${bit} de ${sfr.name}`;
      out.push({ label: n, detail: what });
    });
    for (let bit = 0; bit < sfr.width; bit++) out.push({ label: `F${bit}`, detail: `bit ${bit} de ${sfr.name}` });
    return out;
  }
  for (let bit = 0; bit < 8; bit++) out.push({ label: `F${bit}`, detail: `bit ${bit}` });
  for (let bit = 0; bit < 8; bit++) out.push({ label: `B${bit}`, detail: `bit ${bit}` });
  return out;
}
