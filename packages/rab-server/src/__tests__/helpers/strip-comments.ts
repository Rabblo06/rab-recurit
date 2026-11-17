import * as ts from 'typescript';

/** A `/` after one of these is division; anywhere else it starts a regular expression literal. */
const DIVISION_FOLLOWS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.PrivateIdentifier,
  ts.SyntaxKind.ThisKeyword,
  ts.SyntaxKind.SuperKeyword,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.CloseBracketToken,
  ts.SyntaxKind.CloseBraceToken,
  ts.SyntaxKind.PlusPlusToken,
  ts.SyntaxKind.MinusMinusToken,
]);

const TRIVIA = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.WhitespaceTrivia,
  ts.SyntaxKind.NewLineTrivia,
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
  ts.SyntaxKind.ShebangTrivia,
  ts.SyntaxKind.ConflictMarkerTrivia,
]);

/**
 * TypeScript source with its comments removed and everything else (strings, template literals, regular expressions,
 * whitespace, line breaks) kept byte for byte. Uses the TypeScript scanner, so a `/*` or `//` inside a string, a
 * template or a regex is never mistaken for a comment — unlike a `/\/\*[\s\S]*?\*\//` regex, which ate live code
 * from a glob string such as `${__dirname}/migrations/*.{ts,js}` up to the next `*\/`.
 *
 * The scanner alone cannot tell a regex from a division or a template's closing `}` from a block's, so this tracks
 * the two pieces of context the parser would supply: open `${` substitutions (re-scanned as template middle/tail)
 * and the previous significant token (a `/` after an operand is division, otherwise a regex).
 */
export function stripComments(text: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ false, ts.LanguageVariant.Standard, text);
  const out: string[] = [];
  const braces: Array<'block' | 'template'> = [];
  let previous: ts.SyntaxKind = ts.SyntaxKind.Unknown;
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.CloseBraceToken) {
      if (braces.pop() === 'template') kind = scanner.reScanTemplateToken(/* isTaggedTemplate */ false);
    } else if ((kind === ts.SyntaxKind.SlashToken || kind === ts.SyntaxKind.SlashEqualsToken) && !DIVISION_FOLLOWS.has(previous)) {
      kind = scanner.reScanSlashToken();
    }
    if (kind === ts.SyntaxKind.TemplateHead || kind === ts.SyntaxKind.TemplateMiddle) braces.push('template');
    else if (kind === ts.SyntaxKind.OpenBraceToken) braces.push('block');
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) continue;
    out.push(scanner.getTokenText());
    if (!TRIVIA.has(kind)) previous = kind;
  }
  return out.join('');
}
