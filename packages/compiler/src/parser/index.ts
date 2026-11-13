import type { TranslationUnit } from '../ast';
import type { DiagnosticBag } from '../diagnostics';
import type { LexResult } from '../lexer';
import type { PreprocessResult } from '../preprocessor';
import { attachComments } from './comments';
import { StatementParser } from './statements';
import { TokenStream } from './stream';

/** Parse the preprocessed token stream into a TranslationUnit, with comments attached to statements. */
export function parse(lexed: LexResult, pp: PreprocessResult, diags: DiagnosticBag): TranslationUnit {
  const source = lexed.lines.text;
  const stream = new TokenStream(pp.tokens, source, diags);
  const parser = new StatementParser(stream);
  const body = parser.parseTopLevel();
  attachComments(body, pp.macros, lexed.comments, lexed.tokens);
  return {
    kind: 'TranslationUnit',
    body,
    macros: pp.macros,
    includes: pp.includes,
    comments: lexed.comments,
    dialect: pp.dialect,
    span: lexed.lines.span(0, source.length),
    source,
  };
}

export { TokenStream, ParseError } from './stream';
export { StatementParser } from './statements';
