import type {
  Block, Comment, MacroDefinition, Span, Statement, StatementBase, SwitchCase, TopLevel,
} from '../ast';
import type { Token } from '../lexer';

interface Anchor {
  node: StatementBase | MacroDefinition;
  span: Span;
  depth: number;
}

/**
 * Attach comments to statements and macro definitions:
 * - leadingComments: comment-only lines directly above the first line (no blank line in between);
 * - trailingComment: a comment after code on the statement's first line (outermost statement starting there);
 * - endComment: a comment on the closing line of a multi-line statement;
 * - Block.danglingComments: comment-only lines in a block not followed by a statement.
 */
export function attachComments(
  body: TopLevel[],
  macros: MacroDefinition[],
  comments: Comment[],
  lexTokens: Token[],
): void {
  // Which lines hold code tokens, and where the first code token of each line starts.
  const firstCodeOnLine = new Map<number, number>();
  for (const t of lexTokens) {
    if (t.kind === 'eof') continue;
    for (let l = t.span.line; l <= t.span.endLine; l++) {
      const prev = firstCodeOnLine.get(l);
      const start = l === t.span.line ? t.span.start : -1;
      if (prev === undefined || start < prev) firstCodeOnLine.set(l, start);
    }
  }
  const isTrailing = (c: Comment) => {
    const first = firstCodeOnLine.get(c.span.line);
    return first !== undefined && first < c.span.start;
  };
  const ownLineByLine = new Map<number, Comment[]>();
  for (const c of comments) {
    if (isTrailing(c)) continue;
    const list = ownLineByLine.get(c.span.endLine) ?? [];
    list.push(c);
    ownLineByLine.set(c.span.endLine, list);
  }

  const anchors: Anchor[] = [];
  const blocks: { block: Block; depth: number }[] = [];
  const visit = (s: Statement | TopLevel | SwitchCase, depth: number) => {
    anchors.push({ node: s, span: s.span, depth });
    switch (s.kind) {
      case 'FunctionDeclaration':
        if (s.body) visit(s.body, depth + 1);
        break;
      case 'Block':
        blocks.push({ block: s, depth });
        s.body.forEach((c) => visit(c, depth + 1));
        break;
      case 'IfStatement':
        visit(s.consequent, depth + 1);
        // `else if` keeps the same depth so the chain reads as siblings.
        if (s.alternate) visit(s.alternate, s.alternate.kind === 'IfStatement' ? depth : depth + 1);
        break;
      case 'WhileStatement':
      case 'DoWhileStatement':
        visit(s.body, depth + 1);
        break;
      case 'ForStatement':
        visit(s.body, depth + 1);
        break;
      case 'SwitchStatement':
        s.cases.forEach((c) => visit(c, depth + 1));
        break;
      case 'SwitchCase':
        s.consequent.forEach((c) => visit(c, depth + 1));
        break;
      default:
        break;
    }
  };
  body.forEach((s) => visit(s, 0));
  for (const m of macros) anchors.push({ node: m, span: m.span, depth: 0 });

  const claimed = new Set<Comment>();

  // Leading comments: the outermost anchor starting on each line claims the comment lines above it.
  const byStartLine = new Map<number, Anchor>();
  for (const a of anchors) {
    const cur = byStartLine.get(a.span.line);
    if (!cur || a.depth < cur.depth || (a.depth === cur.depth && a.span.start < cur.span.start)) byStartLine.set(a.span.line, a);
  }
  for (const [line, anchor] of byStartLine) {
    // A comment line that itself is preceded by code on the same line belongs elsewhere.
    const lead: Comment[] = [];
    let l = line - 1;
    while (l >= 1 && !firstCodeOnLine.has(l)) {
      const cs = ownLineByLine.get(l);
      if (!cs || cs.length === 0) break;
      const fresh = cs.filter((c) => !claimed.has(c));
      if (fresh.length === 0) break;
      lead.unshift(...fresh);
      l = Math.min(...fresh.map((c) => c.span.line)) - 1;
    }
    if (lead.length === 0) continue;
    lead.forEach((c) => claimed.add(c));
    anchor.node.leadingComments = lead;
  }

  // Trailing and closing-line comments.
  for (const c of comments) {
    if (!isTrailing(c) || claimed.has(c)) continue;
    const line = c.span.line;
    // A comment inside a macro body (`#define X (1 /* un */ + 2)`) is not at the end of the definition.
    const insideMacro = (a: Anchor) => !('kind' in a.node) && c.span.end <= a.span.end;
    const before = anchors.filter((a) => a.span.start < c.span.start && !insideMacro(a));
    const starting = before.filter((a) => a.span.line === line);
    if (starting.length > 0) {
      const best = starting.reduce((x, y) => (y.depth < x.depth || (y.depth === x.depth && y.span.start > x.span.start) ? y : x));
      if (!best.node.trailingComment) {
        best.node.trailingComment = c;
        claimed.add(c);
        continue;
      }
    }
    const ending = before.filter((a) => a.span.endLine === line && a.span.line < line && 'kind' in a.node);
    if (ending.length > 0) {
      const best = ending.reduce((x, y) => (y.depth < x.depth ? y : x));
      const node = best.node as StatementBase;
      if (!node.endComment) {
        node.endComment = c;
        claimed.add(c);
      }
    }
  }

  // Dangling comments: own-line comments inside a block that no statement claimed (innermost block wins).
  for (const c of comments) {
    if (claimed.has(c) || isTrailing(c)) continue;
    let owner: { block: Block; depth: number } | undefined;
    for (const b of blocks) {
      if (b.block.span.start < c.span.start && c.span.end <= b.block.span.end) {
        if (!owner || b.depth > owner.depth) owner = b;
      }
    }
    if (owner) {
      owner.block.danglingComments.push(c);
      claimed.add(c);
    }
  }
}
