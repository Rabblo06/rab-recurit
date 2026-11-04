import { fieldSegment, PdfGlyphCoverageError } from './render-protocol';

/**
 * D3 glyph-coverage guard. fontkit/pdfkit (under react-pdf) draw NOTHING for a character no embedded font has: no
 * error, the character is just blank (MEASURED in P0 for CJK, Arabic and emoji). On a timesheet or a pay statement that
 * is silent data loss, so every character of every string in the view-model is checked BEFORE layout, and one
 * uncovered character refuses the whole render with `PdfGlyphCoverageError` naming the field, never the value.
 *
 * The predicate is built from the very font objects react-pdf uses for substitution (`Font.getFont(...).data`,
 * fontkit's `hasGlyphForCodePoint`, the same call textkit's `fontSubstitution` makes), over the families of the
 * layout's font stack:
 *   - within one family a character must exist in EVERY registered weight (a bold run can only fall back within the
 *     stack, so a glyph present only in Regular would still be blank in bold);
 *   - across families it may exist in any of them (react-pdf falls back per character down the stack).
 */

export interface GlyphFont {
  hasGlyphForCodePoint(codePoint: number): boolean;
}

/**
 * LINE FEED is the one character accepted without a glyph: textkit consumes it as a paragraph break.
 *
 * Refused whatever the fonts say, because they can never be printed literally ("printed literally or refused", plan §8
 * P3). MEASURED with react-pdf 4.9.0 and these fonts: every one of them is either drawn as nothing or consumed by the
 * text engine and absent from the PDF text layer, even when a font maps it:
 *  - controls (Cc) other than LF: NUL, TAB, CR, ESC, DEL, C1. Noto Sans maps U+0000 and U+000D to empty glyphs.
 *  - format characters (Cf) and all default-ignorable code points: soft hyphen, ZWSP/ZWNJ/ZWJ, LRM/RLM, the bidi
 *    embeddings/overrides U+202A-U+202E and isolates U+2066-U+2069 (which would still REORDER the visible text: a
 *    spoofing vector), word joiner, BOM, variation selectors, CGJ;
 *  - line/paragraph separators U+2028/U+2029; lone surrogates (Cs); private use (Co); unassigned and noncharacters (Cn).
 * View-model builders that carry free text should normalise CRLF to LF and TAB to a space (a display decision that
 * belongs in the builder, not here).
 */
const LINE_FEED = 0x0a;
const NEVER_PRINTABLE =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

function neverPrintable(cp: number): boolean {
  // A lone surrogate cannot round-trip through String.fromCodePoint as a scalar; test it numerically.
  if (cp >= 0xd800 && cp <= 0xdfff) return true;
  return NEVER_PRINTABLE.test(String.fromCodePoint(cp));
}

export type CoveragePredicate = (codePoint: number) => boolean;

/** `families`: for each family in the stack, the fontkit font of every registered weight. */
export function coveragePredicate(
  families: readonly (readonly GlyphFont[])[],
): CoveragePredicate {
  if (
    families.length === 0 ||
    families.some((weights) => weights.length === 0)
  ) {
    throw new Error(
      'native PDF renderer: glyph coverage needs at least one font per family',
    );
  }
  const memo = new Map<number, boolean>();
  return (cp: number): boolean => {
    let hit = memo.get(cp);
    if (hit === undefined) {
      hit =
        cp === LINE_FEED ||
        (!neverPrintable(cp) &&
          families.some((weights) =>
            weights.every((font) => font.hasGlyphForCodePoint(cp)),
          ));
      memo.set(cp, hit);
    }
    return hit;
  };
}

function countUnsupported(text: string, covers: CoveragePredicate): number {
  let missing = 0;
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!; // a lone surrogate comes back as itself (0xD800-0xDFFF): no font has it -> refused
    if (!covers(cp)) missing += 1;
    i += cp > 0xffff ? 2 : 1;
  }
  return missing;
}

/**
 * Walks the view-model (plain data, validated by `assertPlainViewModel`) and throws `PdfGlyphCoverageError` at the first
 * string with an uncovered character. Numbers are printed as ASCII digits, which every font in the stack has; byte
 * arrays are images and are skipped.
 */
export function assertGlyphCoverage(
  value: unknown,
  covers: CoveragePredicate,
  path = 'viewModel',
): void {
  if (typeof value === 'string') {
    const missing = countUnsupported(value, covers);
    if (missing > 0) throw new PdfGlyphCoverageError(path, missing);
    return;
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    value instanceof Uint8Array
  )
    return;
  if (Array.isArray(value)) {
    value.forEach((item, i) =>
      assertGlyphCoverage(item, covers, `${path}[${i}]`),
    );
    return;
  }
  for (const key of Object.keys(value)) {
    assertGlyphCoverage(
      (value as Record<string, unknown>)[key],
      covers,
      `${path}${fieldSegment(key)}`,
    );
  }
}
