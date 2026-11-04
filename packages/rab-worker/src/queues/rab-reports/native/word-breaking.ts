/**
 * Word breaking for the native PDF renderer — the ONE rule, registered with react-pdf's font store in the render thread
 * (runtime/native-fonts.ts) as its hyphenation callback. Dependency-free so the render thread can load it.
 *
 * textkit (react-pdf's text engine) splits a paragraph into "words" on spaces only and asks this callback for each
 * word's parts. Between two parts it inserts a PENALTY node, and a line broken at a penalty gets a "-" glyph appended
 * (textkit `breakLines`; cannot be turned off). An EMPTY part, however, becomes a zero-width GLUE node (textkit
 * `getNodes`: `s.trim() === ''`): a line may break there as at a space, and nothing is drawn or added to the text
 * (MEASURED with react-pdf 4.9.0 / textkit 7.0.1). So the parts returned here encode two kinds of break opportunity:
 *
 *   1. AFTER AN EXISTING HYPHEN (owner decision D6, approved with conditions, 2026-11-04): "Worthington-Smythe" is
 *      returned as ["Worthington-", "", "Smythe"]. When the name does not fit it wraps after its own hyphen —
 *      "Worthington-" / "Smythe", as Chromium wraps it — with no second "-" drawn and no character added, dropped or
 *      truncated; when it fits it stays on one line. Only a hyphen with a non-hyphen character on both sides and no
 *      digit after it is a break opportunity: never a leading or trailing hyphen, never inside "--", never before a
 *      digit (UAX #14 LB25: "2026-11-04" and "-5" stay whole).
 *   2. INSIDE AN OVER-LONG SEGMENT (a run between two hyphen breaks of more than OVERLONG_TOKEN_CHARS code points: a
 *      URL, an ID, a 1,000-character paste): every boundary between two of its code points (never inside a surrogate
 *      pair) is a penalty break, so a token wider than its box is force-broken instead of being drawn over the
 *      neighbouring column. textkit draws a visible "-" at such a forced break (owner-accepted D6 delta). The layouts'
 *      Text sets the in-word penalty to textkit's "never" (document-components.ts IN_WORD_BREAK_PENALTY), so a forced
 *      break is used only when the line cannot fit otherwise. A forced break is never placed right before or right
 *      after a hyphen character, so a line never ends in a doubled "--". A long hyphenated NAME whose parts are each
 *      at most OVERLONG_TOKEN_CHARS long ("Fitzgerald-Montgomery-Worthington") has no forced break at all: it can
 *      only wrap at its own hyphens.
 *
 * A word without a hyphen break and of at most OVERLONG_TOKEN_CHARS code points stays whole, as in Chromium, which
 * never hyphenates these templates. Always `wordBreakParts(word).join('') === word`.
 */
export const OVERLONG_TOKEN_CHARS = 24;

/** U+002D HYPHEN-MINUS and U+2010 HYPHEN (line-break classes HY / BA: a break is allowed after them). */
const HYPHENS: ReadonlySet<string> = new Set(['-', '\u2010']);
const DIGIT = /^\p{Nd}$/u;

function isHyphenBreak(prev: string | undefined, ch: string, next: string | undefined): boolean {
  return HYPHENS.has(ch) && prev !== undefined && next !== undefined && !HYPHENS.has(prev) && !HYPHENS.has(next) && !DIGIT.test(next);
}

/** One segment (no hyphen break inside): whole, or, when over-long, one part per code point except next to a hyphen. */
function segmentParts(cps: readonly string[]): string[] {
  if (cps.length <= OVERLONG_TOKEN_CHARS) return [cps.join('')];
  const parts: string[] = [];
  let current = '';
  cps.forEach((ch, i) => {
    current += ch;
    const next = cps[i + 1];
    if (next !== undefined && !HYPHENS.has(ch) && !HYPHENS.has(next)) {
      parts.push(current); // penalty: a forced break here draws textkit's "-"
      current = '';
    }
  });
  if (current !== '') parts.push(current);
  return parts;
}

export function wordBreakParts(word: string): string[] {
  const cps = Array.from(word);
  const parts: string[] = [];
  let segment: string[] = [];
  cps.forEach((ch, i) => {
    segment.push(ch);
    if (isHyphenBreak(cps[i - 1], ch, cps[i + 1])) {
      parts.push(...segmentParts(segment), ''); // '' = zero-width glue: a break here draws nothing extra
      segment = [];
    }
  });
  if (segment.length > 0) parts.push(...segmentParts(segment));
  return parts.length > 0 ? parts : [word];
}
