import { BusinessValue, DocumentExpectation, LINE_BREAK, renderCall, ReportDocument } from './documents';
import { compact, normaliseText, PdfExtraction } from './extract';
import { GlyphTransform } from './glyph-transform';

/**
 * The NATIVE side's expectations, after owner decisions that make the native output intentionally differ from
 * Chromium's:
 *
 *  F1 (plan §15): an unprintable character is printed as □ — the native expectation of every business value is the
 *     F1-transformed value (`nativeExpectation`), character for character, from the runtime's own GlyphCoverage.
 *  F-PDF-1 (known-findings.ts): on the unbroken-token fixtures Chromium DROPS the right-hand column, so its counts and
 *     words are not a valid reference for native.
 *  D6 (approved with conditions, FINAL brief 2026-11-04): a hyphenated word may wrap at its hyphen in one renderer and
 *     not in the other. `joinLineBreaks` rejoins the two pieces only where the document holds the joined word; the
 *     checker accepts the difference only when the joined text is identical and every other check passes.
 *
 * Where F1 or F-PDF-1 applies, and always in native-only mode (P5: no Chromium), the native render's cross-checks (each
 * value printed the same number of times; no missing or extra word; each page's footer) are made against the DOCUMENT
 * itself: the text of the template HTML (exactly what Chromium was asked to print: the body, plus the footer template
 * once per native page with its page numbers), F1 applied (`htmlReference`). The HTML templates stay until D10 deletes
 * them after one native-only release; the view-models they print from are the same ones the native layouts print.
 */

/** Classes the document's own `<style>` renders upper-case (`.doc-title`, `.label`: `text-transform: uppercase`). */
function upperCaseClasses(html: string): string[] {
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!).join('\n');
  return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => /text-transform\s*:\s*uppercase/i.test(m[2]!))
    .flatMap((m) => [...m[1]!.matchAll(/^\s*\.([A-Za-z0-9_-]+)\s*$/gm)].map((c) => c[1]!));
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_m, e: string) => {
    const k = e.toLowerCase();
    if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[k]!;
  });
}

/** The body with the document's upper-case classes applied and style / script / title removed; tags still in place. */
function htmlBody(html: string): string {
  let body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  for (const cls of upperCaseClasses(html)) {
    body = body.replace(new RegExp(`(<(\\w+)\\b[^>]*\\bclass="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"[^>]*>)([^<]*)(</\\2>)`, 'g'), (_m, open: string, _t, text: string, close: string) => open + text.toUpperCase() + close);
  }
  return body.replace(/<(style|script|title)\b[\s\S]*?<\/\1>/gi, ' ');
}

/**
 * Text content of an HTML document's body, as the template prints it: every tag a word boundary, the document's
 * `text-transform: uppercase` classes upper-cased (a simple `.class` rule on an element without nested elements, which
 * is how the templates use it), entities decoded.
 */
export function htmlText(html: string): string {
  return decodeEntities(htmlBody(html).replace(/<[^>]*>/g, ' '));
}

/**
 * The document's text nodes, in order: the text between two tags, entities decoded, blank ones dropped. A text node is
 * one printed field (a cell, a label, a paragraph), so it is the reference for counting a value as a whole field.
 */
export function htmlTextNodes(html: string): string[] {
  return htmlBody(html)
    .split(/<[^>]*>/)
    .map(decodeEntities)
    .filter((t) => t.trim().length > 0);
}

/** The footer template's text on each of `pages` pages (Playwright fills `pageNumber` / `totalPages`). */
export function footerTexts(footerTemplate: string | undefined, pages: number): string[] {
  if (!footerTemplate) return [];
  return Array.from({ length: pages }, (_, i) =>
    htmlText(footerTemplate.replace(/<span class="pageNumber"><\/span>/g, String(i + 1)).replace(/<span class="totalPages"><\/span>/g, String(pages))),
  );
}

/** Re-merges values that became equal under a transform (e.g. two CJK names that both print as "□ □□"). */
function merge(values: BusinessValue[]): BusinessValue[] {
  const out: BusinessValue[] = [];
  for (const v of values) {
    const seen = out.find((o) => o.value === v.value);
    if (seen) {
      seen.min += v.min;
      if (!seen.label.includes(v.label)) seen.label = `${seen.label}; ${v.label}`;
    } else out.push({ ...v });
  }
  return out;
}

/** The expectation with F1 applied to every printed value, multi-line field and row marker (labels and parse-back patterns: ASCII, unchanged). */
export async function nativeExpectation(expect: DocumentExpectation, transform: GlyphTransform): Promise<DocumentExpectation> {
  const values = await transform(expect.values.map((v) => v.value));
  const rowMarkers = await transform(expect.rowMarkers);
  const multiLine = await transform(expect.multiLine.map((v) => v.value));
  return {
    ...expect,
    values: merge(expect.values.map((v, i) => ({ ...v, value: values[i]! }))),
    rowMarkers,
    multiLine: expect.multiLine.map((v, i) => ({ ...v, value: multiLine[i]! })),
  };
}

/** F1's replacement marker (glyph-coverage.ts REPLACEMENT_MARKER; asserted against the runtime in the unit spec). */
export const F1_MARKER = '□';
const MARKER_ONLY = /^[□ ]+$/u;

/**
 * Printings of a value that holds F1's marker □, in ONE field's text (both normalised, spaces kept; the caller passes
 * one field — a cell, located by its line and x position — at a time, never a whole page). A run of markers has no
 * identity of its own ("王 小明" and "김 민준" both print "□ □□"), so a printing counts only where it is DELIMITED:
 *   - a value starting (ending) with □ may not be preceded (followed) by another □;
 *   - a value made only of □ and spaces must be whole tokens of the field (start or space before, end or space after),
 *     and the neighbouring token on each side, if the field has one, must hold visible text: next to another token of
 *     markers ("□□ □ □□", "□ □□" for "□□") the boundary between two values is unknowable, so that is NOT a printing.
 * So "□ □□" is never found inside "□□ □□□", inside "[□□]", next to another marker token, or across two neighbouring
 * cells. An ambiguous field therefore counts zero and fails `values-present` loudly; it never passes by a guess.
 */
export function markerOccurrences(field: string, value: string): number {
  const h = normaliseText(field);
  const n = normaliseText(value);
  if (!n) return 0;
  const opaque = MARKER_ONLY.test(n);
  let count = 0;
  for (let i = h.indexOf(n); i >= 0; ) {
    const before = i > 0 ? h[i - 1] : undefined;
    const after = h[i + n.length];
    const prevToken = h.slice(0, i).trimEnd().split(' ').pop() ?? '';
    const nextToken = h.slice(i + n.length).trimStart().split(' ')[0] ?? '';
    const delimited =
      !(n.startsWith(F1_MARKER) && before === F1_MARKER) &&
      !(n.endsWith(F1_MARKER) && after === F1_MARKER) &&
      !(
        opaque &&
        ((before !== undefined && before !== ' ') ||
          (after !== undefined && after !== ' ') ||
          (prevToken !== '' && MARKER_ONLY.test(prevToken)) ||
          (nextToken !== '' && MARKER_ONLY.test(nextToken)))
      );
    if (delimited) {
      count++;
      i = h.indexOf(n, i + n.length);
    } else i = h.indexOf(n, i + 1);
  }
  return count;
}

/** A multi-line value's lines (normalised, blank ones dropped) with their multiplicity. */
export function valueLines(value: string): Map<string, number> {
  const lines = new Map<string, number>();
  for (const l of value.split(LINE_BREAK).map(normaliseText).filter(Boolean)) lines.set(l, (lines.get(l) ?? 0) + 1);
  return lines;
}

export interface TextReference {
  label: string;
  /** How many times the document prints the value (same rules as checker.ts `countValue`). */
  count(value: string): number;
  /** The document's words (normalised), as a multiset. */
  tokens: string[];
  /** The footer line the document prints on each page of the render (F1 applied); empty when it has no footer. */
  footers: string[];
}

/**
 * The document's own text for the render `x`, F1 applied: the reference for the native render's cross-checks. Layout
 * decides only how often the per-page parts repeat, and that is taken from `x` and checked elsewhere: the footer template
 * once per page (`footer-numbering`), the table header once more per extra page that carries it (`thead` repeats;
 * `table-header-repeated`).
 *
 * `count` follows `countValue`: a value with line breaks counts as often as its rarest line; a value holding □ counts
 * whole fields only (`markerOccurrences` over the document's text nodes); any other value counts as a substring of the
 * whitespace-free text.
 */
export async function htmlReference(doc: ReportDocument, x: PdfExtraction, transform: GlyphTransform): Promise<TextReference> {
  const { html, options } = renderCall(doc);
  const thead = /<thead[^>]*>[\s\S]*?<\/thead>/i.exec(html)?.[0];
  const headerRepeats = thead ? Math.max(0, x.pages.filter((p) => p.tableHeaderLines.length > 0).length - 1) : 0;
  const footerParts = footerTexts(options.footerTemplate, x.pageCount);
  const theadHtml = thead ? `<body>${thead}</body>` : '';
  const texts = [htmlText(html), ...footerParts, ...Array.from({ length: headerRepeats }, () => htmlText(theadHtml))];
  const nodeGroups = [htmlTextNodes(html), ...footerParts.map((f) => [f]), ...Array.from({ length: headerRepeats }, () => htmlTextNodes(theadHtml))];
  const flatNodes = nodeGroups.flat();
  const transformed = await transform([...texts, ...flatNodes]);
  const parts = transformed.slice(0, texts.length).map(normaliseText);
  const nodes = transformed.slice(texts.length).map(normaliseText);
  const footers = parts.slice(1, 1 + footerParts.length);
  const hay = parts.map(compact);
  const occurrences = (h: string, n: string) => {
    let c = 0;
    for (let i = n ? h.indexOf(n) : -1; i >= 0; i = h.indexOf(n, i + n.length)) c++;
    return c;
  };
  const count = (value: string): number => {
    const lines = valueLines(value);
    if (lines.size > 1 || [...lines.values()].some((m) => m > 1)) return Math.min(...[...lines].map(([l, m]) => Math.floor(count(l) / m)));
    if (value.includes(F1_MARKER)) return nodes.reduce((s, node) => s + markerOccurrences(node, value), 0);
    return hay.reduce((s, h) => s + occurrences(h, compact(value)), 0);
  };
  return {
    label: 'document (template HTML, F1 applied)',
    count,
    tokens: parts.flatMap((p) => p.split(' ').filter(Boolean)),
    footers,
  };
}

/** Whether the document's text changes under F1 (it holds a character the bundled fonts cannot print). */
export async function changedByF1(doc: ReportDocument, transform: GlyphTransform): Promise<boolean> {
  const { html, options } = renderCall(doc);
  const texts = [htmlText(html), ...footerTexts(options.footerTemplate, 1)].map((t) => t.replace(/\r\n/g, '\n').replace(/\t/g, ' '));
  const out = await transform(texts);
  return out.some((t, i) => t !== texts[i]);
}

/** The document's words (template body and one footer), untransformed: what decides where a line-end hyphen joins pieces. */
export function documentWords(doc: ReportDocument): string[] {
  const { html, options } = renderCall(doc);
  return [htmlText(html), ...footerTexts(options.footerTemplate, 1)].flatMap((t) => normaliseText(t).split(' ').filter(Boolean));
}

export interface JoinedTokens {
  /** The render's words with the accepted joins applied. */
  tokens: string[];
  /** Words rejoined at a hyphen that is in the document (D6 hyphen wrap), e.g. "Worthington-" + "Smythe". */
  d6: string[];
  /** Words rejoined at a renderer-drawn break hyphen (forced break of an over-long token; the hyphen is dropped). */
  forced: string[];
}

/**
 * The words of a render, with words that a line break split rejoined. Inside a block (one cell or paragraph), where a
 * line ENDS with "-" and the block carries on in the next line, the last word of the line and the first word of the
 * next are pieces of ONE word when — and only when — the document says so:
 *
 *   forced break (only with `forcedBreaks`: react-pdf draws a visible "-" where it force-breaks an over-long token,
 *       word-breaking.ts): the document holds them joined WITHOUT the hyphen and not WITH it — the hyphen is dropped;
 *   D6 hyphen wrap (with `d6`, any renderer): the document holds them joined WITH the hyphen ("Worthington-Smythe") —
 *       the hyphen is the word's own and stays; Chromium wraps there, react-pdf may not, or the other way round.
 *
 * Every other hyphen and every other line end stays a word boundary; chains over several lines join piece by piece.
 * A truncated or altered piece is joined as it is printed, so the joined word differs from the document's and the
 * token comparison still fails: joining never repairs text, it only removes the line break.
 */
export function joinLineBreaks(x: PdfExtraction, reference: readonly string[], options: { forcedBreaks: boolean; d6: boolean }): JoinedTokens {
  const words = normaliseText(x.text).split(' ').filter(Boolean);
  const inReference = (s: string) => reference.some((t) => t.includes(s));
  const remove: string[] = [];
  const add: string[] = [];
  const d6: string[] = [];
  const forced: string[] = [];
  type Joined = { word: string; pieces: string[]; d6: boolean; forced: boolean };
  const close = (j: Joined | null) => {
    if (!j) return;
    remove.push(...j.pieces);
    add.push(j.word);
    if (j.d6) d6.push(j.word);
    if (j.forced) forced.push(j.word);
  };
  for (const page of x.pages) {
    for (const lines of page.blockLines) {
      const split = lines.map((l) => l.split(' ').filter(Boolean));
      let current: Joined | null = null;
      for (let k = 0; k + 1 < split.length; k++) {
        const line = split[k]!;
        const next = split[k + 1]!;
        // A break hyphen drawn as its own run ("XXXX -") is still the end of the word before it.
        const tail = line.length >= 2 && line[line.length - 1] === '-' ? [line[line.length - 2]!, '-'] : [line[line.length - 1] ?? ''];
        const open: Joined | null = current;
        const last: Joined = open && line.length === 1 ? open : { word: tail.join(''), pieces: tail, d6: false, forced: false };
        const first = next[0];
        if (!first || !last.word.endsWith('-')) {
          close(current);
          current = null;
          continue;
        }
        const broken = last.word.slice(0, -1) + first; // forced break: the hyphen is the renderer's
        const kept = last.word + first; // D6: the hyphen is the word's
        // If the next line is this one word and itself ends in a candidate break, probe without that hyphen (decided next).
        const probe = (s: string) => (next.length === 1 && k + 2 < split.length && s.endsWith('-') ? s.slice(0, -1) : s);
        let joined: Joined | null = null;
        if (options.forcedBreaks && inReference(probe(broken)) && !inReference(probe(kept))) joined = { ...last, word: broken, pieces: [...last.pieces, first], forced: true };
        else if (options.d6 && inReference(probe(kept))) joined = { ...last, word: kept, pieces: [...last.pieces, first], d6: true };
        if (joined) {
          current = joined;
          if (next.length > 1 || k + 2 === split.length) {
            close(current);
            current = null;
          }
        } else {
          close(current);
          current = null;
        }
      }
      close(current);
    }
  }
  const out = [...words];
  for (const r of remove) {
    const at = out.indexOf(r);
    if (at < 0) throw new Error(`line-break join: piece ${JSON.stringify(r)} is not a word of the render`);
    out.splice(at, 1);
  }
  return { tokens: [...out, ...add], d6, forced };
}

/** The words of a render whose renderer force-breaks over-long tokens with a visible "-": forced breaks joined, nothing else. */
export function tokensJoiningForcedBreaks(x: PdfExtraction, reference: readonly string[]): string[] {
  return joinLineBreaks(x, reference, { forcedBreaks: true, d6: false }).tokens;
}
