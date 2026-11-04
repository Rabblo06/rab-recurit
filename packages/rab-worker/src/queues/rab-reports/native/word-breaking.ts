/**
 * Word breaking for the native PDF renderer — the ONE rule, registered with react-pdf wherever the fonts are registered
 * (fonts.ts in-process today; the render thread's font registration once the render pool is wired in). Dependency-free
 * so the render thread can load it.
 *
 * Chromium never hyphenates these templates, so ordinary words stay whole. But with no break opportunity at all an
 * unbroken token wider than its box (a 140-character name, a URL in the notes) overflows it and is drawn over the
 * neighbouring text (MEASURED; Chromium instead shrinks the whole page). A token longer than OVERLONG_TOKEN_CHARS may
 * therefore break between any two code points — and, with the layouts' `Text` (document-components.ts:
 * IN_WORD_BREAK_PENALTY = textkit's "never" for Knuth-Plass), it is broken only when it cannot fit, at the overflow
 * point. textkit draws a "-" at such a break (cannot be turned off): a visible delta, owner to confirm.
 * textkit splits "words" on spaces only, so a hyphenated name is one token.
 */
export const OVERLONG_TOKEN_CHARS = 24;

export function breakOnlyOverlongTokens(word: string): string[] {
  return word.length > OVERLONG_TOKEN_CHARS ? Array.from(word) : [word];
}
