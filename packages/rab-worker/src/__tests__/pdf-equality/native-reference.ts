import { BusinessValue, DocumentExpectation, renderCall, ReportDocument } from './documents';
import { compact, normaliseText, PdfExtraction } from './extract';
import { GlyphTransform } from './glyph-transform';

/**
 * The NATIVE side's expectations (Chromium vs native suite), after two owner decisions that make the native output
 * intentionally differ from Chromium's:
 *
 *  F1 (plan §15): an unprintable character is printed as □ — the native expectation of every business value is the
 *     F1-transformed value (`nativeExpectation`), character for character, from the runtime's own GlyphCoverage.
 *  F-PDF-1 (known-findings.ts): on the unbroken-token fixtures Chromium DROPS the right-hand column, so its counts and
 *     words are not a valid reference for native.
 *
 * Where either applies, the native render's cross-checks (each value printed the same number of times; no missing or
 * extra word) are made against the DOCUMENT itself instead of against Chromium: the text of the template HTML (exactly
 * what Chromium is asked to print: the body, plus the footer template once per native page with its page numbers), F1
 * applied (`htmlReference`). Everywhere else Chromium stays the reference, so the owner-pending D6 delta is not absorbed.
 */

/** Classes the document's own `<style>` renders upper-case (`.doc-title`, `.label`: `text-transform: uppercase`). */
function upperCaseClasses(html: string): string[] {
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!).join('\n');
  return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => /text-transform\s*:\s*uppercase/i.test(m[2]!))
    .flatMap((m) => [...m[1]!.matchAll(/^\s*\.([A-Za-z0-9_-]+)\s*$/gm)].map((c) => c[1]!));
}

/**
 * Text content of an HTML document's body, as the template prints it: every tag a word boundary, the document's
 * `text-transform: uppercase` classes upper-cased (a simple `.class` rule on an element without nested elements, which
 * is how the templates use it), entities decoded.
 */
export function htmlText(html: string): string {
  let body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  for (const cls of upperCaseClasses(html)) {
    body = body.replace(new RegExp(`(<(\\w+)\\b[^>]*\\bclass="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"[^>]*>)([^<]*)(</\\2>)`, 'g'), (_m, open: string, _t, text: string, close: string) => open + text.toUpperCase() + close);
  }
  return body
    .replace(/<(style|script|title)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_m, e: string) => {
      const k = e.toLowerCase();
      if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
      return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[k]!;
    });
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

/** The expectation with F1 applied to every printed value and row marker (labels, parse-back patterns: ASCII, unchanged). */
export async function nativeExpectation(expect: DocumentExpectation, transform: GlyphTransform): Promise<DocumentExpectation> {
  const values = await transform(expect.values.map((v) => v.value));
  const rowMarkers = await transform(expect.rowMarkers);
  return { ...expect, values: merge(expect.values.map((v, i) => ({ ...v, value: values[i]! }))), rowMarkers };
}

export interface TextReference {
  label: string;
  /** How many times the document prints the value. */
  count(value: string): number;
  /** The document's words (normalised), as a multiset. */
  tokens: string[];
}

/**
 * The document's own text for the render `x`, F1 applied: the reference for the native render's cross-checks. Layout
 * decides only how often the per-page parts repeat, and that is taken from `x` and checked elsewhere: the footer template
 * once per page (`footer-numbering`), the table header once more per extra page that carries it (`thead` repeats;
 * `table-header-repeated`).
 */
export async function htmlReference(doc: ReportDocument, x: PdfExtraction, transform: GlyphTransform): Promise<TextReference> {
  const { html, options } = renderCall(doc);
  const thead = /<thead[^>]*>[\s\S]*?<\/thead>/i.exec(html)?.[0];
  const headerRepeats = thead ? Math.max(0, x.pages.filter((p) => p.tableHeaderLines.length > 0).length - 1) : 0;
  const texts = [htmlText(html), ...footerTexts(options.footerTemplate, x.pageCount), ...Array.from({ length: headerRepeats }, () => htmlText(`<body>${thead}</body>`))];
  const [body, ...rest] = await transform(texts);
  const parts = [body!, ...rest].map(normaliseText);
  const hay = parts.map(compact);
  const occurrences = (h: string, n: string) => {
    let c = 0;
    for (let i = n ? h.indexOf(n) : -1; i >= 0; i = h.indexOf(n, i + n.length)) c++;
    return c;
  };
  return {
    label: 'document (template HTML, F1 applied)',
    count: (value) => hay.reduce((s, h) => s + occurrences(h, compact(value)), 0),
    tokens: parts.flatMap((p) => p.split(' ').filter(Boolean)),
  };
}

/** Whether the document's text changes under F1 (it holds a character the bundled fonts cannot print). */
export async function changedByF1(doc: ReportDocument, transform: GlyphTransform): Promise<boolean> {
  const { html, options } = renderCall(doc);
  const texts = [htmlText(html), ...footerTexts(options.footerTemplate, 1)].map((t) => t.replace(/\r\n/g, '\n').replace(/\t/g, ' '));
  const out = await transform(texts);
  return out.some((t, i) => t !== texts[i]);
}

/**
 * The words of a render whose renderer force-breaks over-long tokens with a visible "-" (react-pdf; word-breaking.ts).
 * Inside a block, where a line ENDS with "-" and the block carries on in the next line, the last word of the line and
 * the first word of the next are one word broken by the renderer when — and only when — the reference holds them joined
 * WITHOUT the hyphen and does not hold them joined WITH it (the hyphen is then not in the source). Every other hyphen
 * stays; chains over several lines join piece by piece.
 */
export function tokensJoiningForcedBreaks(x: PdfExtraction, reference: readonly string[]): string[] {
  const words = normaliseText(x.text).split(' ').filter(Boolean);
  const inReference = (s: string) => reference.some((t) => t.includes(s));
  const remove: string[] = [];
  const add: string[] = [];
  for (const page of x.pages) {
    for (const lines of page.blockLines) {
      const split = lines.map((l) => l.split(' ').filter(Boolean));
      type Joined = { word: string; pieces: string[] };
      let current: Joined | null = null;
      for (let k = 0; k + 1 < split.length; k++) {
        const line = split[k]!;
        const next = split[k + 1]!;
        // A break hyphen drawn as its own run ("XXXX -") is still the end of the word before it.
        const tail = line.length >= 2 && line[line.length - 1] === '-' ? [line[line.length - 2]!, '-'] : [line[line.length - 1] ?? ''];
        const open: Joined | null = current;
        const last: Joined = open && line.length === 1 ? open : { word: tail.join(''), pieces: tail };
        const first = next[0];
        if (!first || !last.word.endsWith('-')) {
          if (current) (remove.push(...current.pieces), add.push(current.word));
          current = null;
          continue;
        }
        const broken: string = last.word.slice(0, -1) + first;
        // If the next line is this one word and itself ends in a candidate break, probe without that hyphen (decided next).
        const probe = (s: string) => (next.length === 1 && k + 2 < split.length && s.endsWith('-') ? s.slice(0, -1) : s);
        if (inReference(probe(broken)) && !inReference(probe(last.word + first))) {
          current = { word: broken, pieces: [...last.pieces, first] };
          if (next.length > 1 || k + 2 === split.length) {
            remove.push(...current.pieces);
            add.push(current.word);
            current = null;
          }
        } else {
          if (current) (remove.push(...current.pieces), add.push(current.word));
          current = null;
        }
      }
      if (current) (remove.push(...current.pieces), add.push(current.word));
    }
  }
  const out = [...words];
  for (const r of remove) {
    const at = out.indexOf(r);
    if (at < 0) throw new Error(`forced-break join: piece ${JSON.stringify(r)} is not a word of the render`);
    out.splice(at, 1);
  }
  return [...out, ...add];
}
