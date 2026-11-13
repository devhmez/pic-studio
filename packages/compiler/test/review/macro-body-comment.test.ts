import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/compile';

// ast.ts, MacroDefinition.body: "Replacement text as written (trimmed, comments removed)". A block comment inside the
// replacement list is kept in `body`, and the same comment is also attached as the macro's trailingComment although
// it is not at the end of the line (it is inside the body, before `+ 2`).

describe('MacroDefinition : commentaire à l’intérieur du corps', () => {
  const r = analyze(`#define X (1 /* un */ + 2)
void main() { PORTB = X; }`);
  const x = r.ast!.macros.find((m) => m.name === 'X')!;

  it('le corps ne contient pas le commentaire', () => {
    expect(x.body).not.toContain('/*');
    expect(x.body.replace(/\s+/g, ' ')).toBe('(1 + 2)');
  });

  it("le commentaire intérieur n'est pas pris pour un commentaire de fin de ligne", () => {
    expect(x.trailingComment).toBeUndefined();
  });
});
