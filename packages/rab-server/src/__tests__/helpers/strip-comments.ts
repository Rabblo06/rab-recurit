import * as ts from 'typescript';

const isJsDoc = (n: ts.Node) => n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode;

/**
 * TypeScript source with its comments removed and everything else (strings, template literals, regular expressions,
 * whitespace, line breaks) kept byte for byte.
 *
 * Ground truth from the TypeScript parser: the file is parsed, its leaf tokens are visited in source order, and the
 * comments in the trivia around each one (`getLeadingCommentRanges` at the token's full start, `getTrailingCommentRanges`
 * at its end, and the end-of-file token's leading trivia) are cut out. The parser decides what is a string, a template,
 * a regex or a division, so a `/*` or `//` inside any of them is never mistaken for a comment — unlike a
 * `/\/\*[\s\S]*?\*\//` regex (which ate live code from a glob such as `${__dirname}/migrations/*.{ts,js}` up to the next
 * `*\/`) or a bare scanner (which must guess regex-vs-division, e.g. after `)` or a keyword-named property).
 */
export function stripComments(text: string, fileName = 'source.ts'): string {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
  const ranges: Array<[number, number]> = [];
  const add = (found: readonly ts.CommentRange[] | undefined) => {
    for (const r of found ?? []) ranges.push([r.pos, r.end]);
  };
  const visit = (node: ts.Node) => {
    if (isJsDoc(node)) return; // JSDoc nodes live inside a comment the surrounding token's trivia already covers
    const children = node.getChildren(sf);
    if (children.length === 0) {
      add(ts.getLeadingCommentRanges(text, node.pos));
      add(ts.getTrailingCommentRanges(text, node.end));
      return;
    }
    children.forEach(visit);
  };
  visit(sf);
  add(ts.getLeadingCommentRanges(text, sf.endOfFileToken.pos));
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '';
  let at = 0;
  for (const [start, end] of ranges) {
    if (end <= at) continue; // the same comment reached from both sides of a gap
    out += text.slice(at, Math.max(at, start));
    at = end;
  }
  return out + text.slice(at);
}
