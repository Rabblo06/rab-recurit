/**
 * Native PDF renderer fonts: the runtime (runtime/native-fonts.ts) owns the vendored, sha256-pinned fonts (Liberation
 * Sans 2.1.5 + the Noto Sans LGC fallback, D11/D3) and registers them inside the render thread, with the word-breaking
 * rule of word-breaking.ts. Layouts only need the family stack: every `fontFamily` is `[...FONT_FAMILY_STACK]`, so the
 * glyph guard and the fonts that draw agree.
 */
export { FONT_DIR, FONT_FAMILY_STACK, PRIMARY_FONT_FAMILY as FONT_FAMILY } from './runtime/native-fonts';
export { OVERLONG_TOKEN_CHARS, wordBreakParts } from './word-breaking';
