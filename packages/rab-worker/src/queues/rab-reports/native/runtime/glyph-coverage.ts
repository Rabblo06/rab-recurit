import { fieldSegment } from './render-protocol';

/**
 * Glyph coverage, owner decision F1 (2026-11-04, plan §15; supersedes D3's fail-closed refusal).
 *
 * fontkit/pdfkit (under react-pdf) draw NOTHING for a character no embedded font has: no error, just a blank (MEASURED
 * in P0 for CJK, Arabic and emoji). That silent loss must never happen, but neither may an unusual character refuse a
 * timesheet or a pay statement. So, BEFORE layout, every string of the view-model is rewritten:
 *
 *  - CRLF becomes LF and TAB becomes one space (layout normalisation; not counted);
 *  - every character the stack cannot print visibly is replaced by REPLACEMENT_MARKER, a glyph that really prints
 *    (verified at thread start in both weights of the primary font);
 *  - the caller gets, per field, only the COUNT of replaced characters. Never the text, the character or its code point.
 *
 * "Cannot print visibly" means: not mapped by every weight of a family in the font stack (Liberation Sans, then the
 * Noto Sans fallback), OR one of the characters react-pdf maps but never prints (MEASURED with react-pdf 4.9.0: drawn
 * as nothing or consumed by the text engine and absent from the text layer):
 *  - controls (Cc) other than LF: NUL, CR, ESC, DEL, C1 (TAB is normalised first). Noto maps U+0000/U+000D to empty glyphs;
 *  - format and default-ignorable characters: soft hyphen, ZWSP/ZWNJ/ZWJ, LRM/RLM, bidi embeddings/overrides
 *    U+202A-U+202E and isolates U+2066-U+2069 (which would otherwise silently REORDER visible text), word joiner,
 *    BOM, variation selectors, CGJ;
 *  - U+2028/U+2029, lone surrogates (Cs), private use (Co), unassigned and noncharacters (Cn).
 *
 * The fallback family is LOADED LAZILY (F3): its fontkit objects are only requested when a string holds a character the
 * primary font lacks.
 *
 * Within one family a character must exist in EVERY registered weight (a bold run can only fall back down the stack,
 * so a glyph present only in Regular would still be blank in bold). The font objects are the ones react-pdf itself uses
 * for per-character substitution (`Font.getFont(...).data`, fontkit `hasGlyphForCodePoint`), so this check and the
 * renderer can never disagree.
 */

/** U+25A1 WHITE SQUARE: in Liberation Sans 2.1.5 Regular and Bold with a real outline (checked at thread start). */
export const REPLACEMENT_MARKER = '□';

export interface GlyphFont {
  hasGlyphForCodePoint(codePoint: number): boolean;
}

const LINE_FEED = 0x0a;
const NEVER_PRINTABLE =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

function neverPrintable(cp: number): boolean {
  if (cp === LINE_FEED) return false;
  // A lone surrogate cannot round-trip through String.fromCodePoint as a scalar; test it numerically.
  if (cp >= 0xd800 && cp <= 0xdfff) return true;
  return NEVER_PRINTABLE.test(String.fromCodePoint(cp));
}

/** One field that needed replacements: its structural path and how many characters. Nothing else, by design. */
export interface GlyphSubstitution {
  field: string;
  count: number;
}

export interface SubstitutionResult {
  value: unknown;
  substitutions: GlyphSubstitution[];
}

export class GlyphCoverage {
  private readonly memo = new Map<number, boolean>();
  private fallback: readonly GlyphFont[] | undefined;
  private fallbackLoads = 0;

  /**
   * @param primary every weight of the primary family (loaded at thread start)
   * @param loadFallback loads every weight of the fallback family; called at most once, and only when needed
   */
  constructor(
    private readonly primary: readonly GlyphFont[],
    private readonly loadFallback: () => Promise<readonly GlyphFont[]>,
  ) {
    if (primary.length === 0)
      throw new Error(
        'native PDF renderer: glyph coverage needs the primary font',
      );
  }

  /** How many times the fallback family has been loaded in this thread (0 until a string needs it, then 1). */
  get fallbackLoadCount(): number {
    return this.fallbackLoads;
  }

  private inPrimary(cp: number): boolean {
    return this.primary.every((f) => f.hasGlyphForCodePoint(cp));
  }

  private printable(cp: number): boolean {
    let hit = this.memo.get(cp);
    if (hit === undefined) {
      hit =
        cp === LINE_FEED ||
        (!neverPrintable(cp) &&
          (this.inPrimary(cp) ||
            (this.fallback?.every((f) => f.hasGlyphForCodePoint(cp)) ??
              false)));
      this.memo.set(cp, hit);
    }
    return hit;
  }

  /** True when some string holds a character the primary font lacks (and that is not refused outright anyway). */
  private needsFallback(value: unknown): boolean {
    if (typeof value === 'string') {
      for (const ch of value) {
        const cp = ch.codePointAt(0)!;
        if (cp !== LINE_FEED && !neverPrintable(cp) && !this.inPrimary(cp))
          return true;
      }
      return false;
    }
    if (
      value === null ||
      typeof value !== 'object' ||
      value instanceof Uint8Array
    )
      return false;
    return (Array.isArray(value) ? value : Object.values(value)).some((v) =>
      this.needsFallback(v),
    );
  }

  /** Returns a copy of the view-model with every string normalised and every unprintable character replaced. */
  async substitute(viewModel: unknown): Promise<SubstitutionResult> {
    if (this.fallback === undefined && this.needsFallback(viewModel)) {
      this.fallback = await this.loadFallback();
      this.fallbackLoads += 1;
      this.memo.clear(); // earlier "no" answers may now be "yes"
    }
    const substitutions: GlyphSubstitution[] = [];
    const value = this.walk(viewModel, 'viewModel', substitutions);
    return { value, substitutions };
  }

  private replaceIn(text: string): { text: string; count: number } {
    const normalised = text.replace(/\r\n/g, '\n').replace(/\t/g, ' ');
    let out = '';
    let count = 0;
    for (let i = 0; i < normalised.length;) {
      const cp = normalised.codePointAt(i)!; // a lone surrogate comes back as itself (0xD800-0xDFFF)
      const len = cp > 0xffff ? 2 : 1;
      if (this.printable(cp)) out += normalised.slice(i, i + len);
      else {
        out += REPLACEMENT_MARKER;
        count += 1;
      }
      i += len;
    }
    return { text: out, count };
  }

  private walk(
    value: unknown,
    path: string,
    subs: GlyphSubstitution[],
  ): unknown {
    if (typeof value === 'string') {
      const { text, count } = this.replaceIn(value);
      if (count > 0) subs.push({ field: path, count });
      return text;
    }
    if (
      value === null ||
      typeof value !== 'object' ||
      value instanceof Uint8Array
    )
      return value;
    if (Array.isArray(value))
      return value.map((item, i) => this.walk(item, `${path}[${i}]`, subs));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = this.walk(
        (value as Record<string, unknown>)[key],
        `${path}${fieldSegment(key)}`,
        subs,
      );
    }
    return out;
  }
}
