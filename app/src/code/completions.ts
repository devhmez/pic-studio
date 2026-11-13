// CodeMirror completion source for MikroC: SFRs, bit selectors after '.', built-ins (with snippets), keywords,
// and the program's own #defines, variables and functions (from the latest compile result).
import { snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { SFR_TABLE } from '@pic/emulator';
import { bitOptionsFor, type CompletionData } from './completionData';
import { BUILTINS } from './vocabulary';

const SFR_COMPLETIONS: readonly Completion[] = SFR_TABLE.filter((s) => s.name !== 'EECON2').map((s) => ({
  label: s.name,
  type: 'constant',
  detail: `registre 0x${s.addr.toString(16).toUpperCase().padStart(2, '0')}`,
  info: s.description,
  boost: 2,
}));

const BUILTIN_COMPLETIONS: readonly Completion[] = BUILTINS.map((b) =>
  snippetCompletion(b.snippet, { label: b.name, type: 'function', detail: 'MikroC', info: `${b.signature}\n\n${b.doc}`, boost: 3 }),
);

const KEYWORD_COMPLETIONS: readonly Completion[] = [
  ...['unsigned', 'signed', 'char', 'short', 'int', 'long', 'void', 'const', 'volatile', 'static', 'return', 'break',
    'continue', 'else', 'case', 'default', 'sbit', 'bit', 'absolute', 'at'].map((k) => ({ label: k, type: 'keyword' })),
  snippetCompletion('while (1) {\n\t${}\n}', { label: 'while (1)', type: 'keyword', detail: 'boucle infinie', boost: 1 }),
  snippetCompletion('while (${condition}) {\n\t${}\n}', { label: 'while', type: 'keyword', detail: 'boucle' }),
  snippetCompletion('if (${condition}) {\n\t${}\n}', { label: 'if', type: 'keyword', detail: 'si' }),
  snippetCompletion('if (${condition}) {\n\t${}\n}\nelse {\n\t${}\n}', { label: 'if … else', type: 'keyword', detail: 'si / sinon' }),
  snippetCompletion('for (${i} = 0; ${i} < ${n}; ${i}++) {\n\t${}\n}', { label: 'for', type: 'keyword', detail: 'boucle comptée' }),
  snippetCompletion('switch (${x}) {\n\tcase ${0}:\n\t\t${}\n\t\tbreak;\n\tdefault:\n\t\tbreak;\n}', { label: 'switch', type: 'keyword' }),
  snippetCompletion('void main() {\n\n\t${}\n}', { label: 'void main()', type: 'keyword', detail: 'programme principal' }),
  snippetCompletion('void interrupt() {\n\t${}\n}', { label: 'void interrupt()', type: 'keyword', detail: 'routine d’interruption' }),
  snippetCompletion('#define ${NOM} ${PORTB.F0}', { label: '#define', type: 'keyword', detail: 'alias / constante' }),
  snippetCompletion('unsigned char ${x};', { label: 'unsigned char', type: 'type', detail: 'octet 0–255', boost: 1 }),
];

const USER_TYPE: Record<string, string> = { macro: 'constant', variable: 'variable', function: 'function', sbit: 'variable' };

/** Completion source bound to a mutable holder that the panel refreshes after each build. */
export function picCompletionSource(holder: { current: CompletionData }) {
  return (ctx: CompletionContext): CompletionResult | null => {
    // Bit selector: `PORTB.` / `STATUS.F` / `TRISA.RA`
    const member = ctx.matchBefore(/([A-Za-z_]\w*)\s*\.\s*\w*$/);
    if (member) {
      const m = /([A-Za-z_]\w*)\s*\.\s*(\w*)$/.exec(member.text)!;
      const from = member.to - m[2].length;
      // Resolve one level of #define alias (e.g. `#define LEDS PORTB` then `LEDS.`).
      let object = m[1];
      const alias = holder.current.user.find((u) => u.kind === 'macro' && u.name.toLowerCase() === object.toLowerCase());
      const aliased = alias ? /^#define\s+([A-Za-z_]\w*)$/.exec(alias.detail) : null;
      if (aliased) object = aliased[1];
      return {
        from,
        options: bitOptionsFor(object).map((b, i) => ({ label: b.label, type: 'property', detail: b.detail, boost: -i / 100 })),
        validFor: /^\w*$/,
      };
    }
    const word = ctx.matchBefore(/#?[A-Za-z_]\w*/);
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    // Nothing inside comments or strings.
    const before = ctx.state.sliceDoc(ctx.state.doc.lineAt(ctx.pos).from, word.from);
    if (before.includes('//') || /"[^"]*$/.test(before)) return null;
    const user: Completion[] = holder.current.user.map((u) => ({ label: u.name, type: USER_TYPE[u.kind], detail: u.detail, boost: 4 }));
    return {
      from: word.from,
      options: [...user, ...BUILTIN_COMPLETIONS, ...SFR_COMPLETIONS, ...KEYWORD_COMPLETIONS],
      validFor: /^#?\w*$/,
    };
  };
}
