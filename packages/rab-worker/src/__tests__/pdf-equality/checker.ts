import { DocumentExpectation, LINE_BREAK, ParseBackField } from './documents';
import { compact, normaliseText, PdfExtraction } from './extract';
import { F1_MARKER, joinLineBreaks, markerOccurrences, TextReference, tokensJoiningForcedBreaks, valueLines } from './native-reference';

/**
 * EQUALITY CHECKER — the P0 plan's §5.2 equality design (docs/PDF_RENDERER_P0_PLAN_2026-11-03.md, owner-approved
 * 2026-11-04). Compares two extractions of PDFs rendered from the SAME input (Chromium vs native; or one renderer twice
 * for the self-test), each against the input and against each other — or, in native-only mode (P5: no Chromium), one
 * native extraction against the input and against the document's own text (`checkAgainstDocument`):
 *
 *   values         every business value (names, venue, dates, clock times, worked minutes, money, report ids, signature
 *                  names) is printed, and printed the same number of times by both renderers            (§5.2 4(a), 4(c))
 *   parse-back     every "Xh Ym" parses back to the STORED minutes and every "£…" to the exact pence, with a bigint string
 *                  parser (no float); totals, counts and "To be confirmed" ×2                           (§5.2 4(b))
 *   page-count     equal; under D4 (40-row table segments) it may differ by at most one page per segment boundary;
 *                  OWNER-ACCEPTED (2026-11-04): the render named in `extraPageAccepted` (native) may print exactly ONE page
 *                  more than that, and only when every other check of the comparison passes (`acceptOneExtraPage`)
 *   footer         "Page n of N" on every page with N = that render's page count; the footer text (workspace, reference,
 *                  generatedAt) identical between renderers; a footer-less document has none           (§5.2 4(d))
 *   table-header   the header line on every page that carries table rows
 *   qr             decoded payloads identical and equal to the signed token                             (§5.2 4(e))
 *   logo           the 166×70 logo is embedded                                                         (§5.2 4(f))
 *   tokens         no missing or extra words (multiset of normalised words over the document)
 *   line-breaks    every line of a multi-line note starts a printed line, in order (owner decision 2026-11-04)
 *   active content no /JavaScript, /JS, /OpenAction, /Launch, /URI, /EmbeddedFile, /AA, /AcroForm      (§8 P3)
 *   bounds         no text drawn outside the page, no text drawn over other text (strict for the native renderer;
 *                  INFO for Chromium)                                                                  (§8 P3, D6)
 *   pdf-inspect    the repo's own oracle reads the same page count
 *
 * D6 (approved with conditions, FINAL brief 2026-11-04). Format deltas (column widths, PDF version, file size, A4 point
 * rounding) never fail a comparison: page sizes and per-page word placement are INFO, and owner-reviewed golden rasters
 * (pdf-equality.native.spec.ts) are the visual reference. The hyphen-wrap delta — Chromium breaks a line after a word's
 * own hyphen ("Worthington-" / "Smythe"), react-pdf moves the whole word ("Worthington-Smythe"), or the other way round
 * — is accepted by `tokens` ONLY when the text with those line breaks rejoined is identical (`joinLineBreaks`: a truncated
 * name or a dropped character still differs), AND every other check of the comparison passes: nothing missing or added,
 * no line outside the page, no overlap, footers and repeated headers correct, notes' line breaks kept. Otherwise the
 * `tokens` finding fails and names the checks that blocked D6.
 *
 * The NATIVE side (CheckOptions `expectB` / `referenceB` / `forcedBreakHyphens`, built in native-reference.ts) is held
 * to owner decision F1 (□ for each unprintable character, from the runtime's GlyphCoverage) and may draw react-pdf's
 * forced-break hyphen at a line end; where F1 changes the document or Chromium drops text (F-PDF-1) its cross-checks
 * run against the document's own text instead of Chromium. A value holding □ is counted as a whole field only
 * (`markerOccurrences`), so it keeps its exact count without matching inside another run of markers.
 */

export interface CheckOptions {
  /** Allowed |pages(a) − pages(b)| on top of D4. Default 0. */
  pageCountTolerance?: number;
  /** D4: table segment size of the native renderer (40, owner-approved). Each segment boundary may add one page. */
  segmentRows?: number;
  /**
   * OWNER-ACCEPTED page-count delta (2026-11-04, long notes: react-pdf's 9.49 pt line box vs Chromium's 9.00 pt): the render
   * of this name (the second, i.e. native) may print exactly one page MORE than the first plus the allowed difference,
   * and only when every other finding of the comparison passes. Never fewer pages, never two more. Default: none.
   */
  extraPageAccepted?: string;
  /** Fail (instead of INFO) when a page's words differ although the document's words are equal. */
  strictPagePlacement?: boolean;
  /** Render names held to the page geometry: no text outside the page, no text over other text (default: ['native']). */
  boundsStrict?: string[];
  /** Render names whose renderer draws a "-" at a forced break of an over-long token (react-pdf): see `countValue`. */
  forcedBreakHyphens?: string[];
  /**
   * Render names whose `line-breaks` problems are INFO, not failures: ONLY the Chromium renders of a tree whose templates
   * do not keep notes' line breaks yet (known-findings.ts NOTES_LINE_BREAKS_IN_TEMPLATE false, i.e. origin/main before
   * the template change); that gap is pinned by its own `test.failing`. Never a native render.
   */
  lineBreaksInfo?: string[];
  /** The second render's own expectation (F1: the native values with □ for unprintable characters). Default: `expect`. */
  expectB?: DocumentExpectation;
  /**
   * The reference for the second render's cross-checks (values printed as often; same words) INSTEAD of the first render
   * — where the first is not a valid reference for it (F1, F-PDF-1; native-reference.ts). Required when `expectB`
   * changes a value, because then the two renders are meant to print different text.
   */
  referenceB?: Pick<TextReference, 'label' | 'count' | 'tokens'>;
  /**
   * The document's words, per side (`documentWords` / the F1-transformed reference tokens): what decides where a line-end
   * hyphen joins two pieces into one word (forced breaks; D6 hyphen wraps). Without them no D6 join is made.
   */
  documentWords?: { a?: readonly string[]; b?: readonly string[] };
}

export interface Finding {
  check: string;
  ok: boolean;
  /** Informational findings never fail the comparison. */
  info?: boolean;
  detail: string;
}

export interface ComparisonResult {
  label: string;
  names: [string, string];
  ok: boolean;
  findings: Finding[];
}

// ─── exact parsers (strings → integers; never floats) ───────────────────────────────────────────────────────────────

/** "5h 28m" → 328n, "7h" → 420n; null when the text is not exactly that shape. */
export function parseMinutesText(text: string): bigint | null {
  const m = /^(\d+)h(?: (\d+)m)?$/.exec(text.trim());
  if (!m) return null;
  const minutes = m[2] === undefined ? 0n : BigInt(m[2]);
  if (minutes >= 60n || (m[2] !== undefined && minutes === 0n)) return null; // fmtMinutes never prints "0m" or ≥ 60m
  return BigInt(m[1]!) * 60n + minutes;
}

/** "£1,234.56" → 123456n, "-£0.01" → -1n; thousands groups must be well-formed; null otherwise. */
export function parsePenceText(text: string): bigint | null {
  const m = /^(-?)£(\d{1,3}(?:,\d{3})*)\.(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const value = BigInt(m[2]!.replace(/,/g, '')) * 100n + BigInt(m[3]!);
  return m[1] ? -value : value;
}

// ─── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────

function occurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Explicit bidi formatting characters: embeddings, overrides, isolates (LRE RLE PDF LRO RLO, LRI RLI FSI PDI). */
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/;

/**
 * Non-overlapping windows of `hay` that hold exactly the characters of `needle`, in any order. Only for values carrying
 * explicit bidi controls (see `countValue`): the window is contiguous and of the value's exact length, and each character
 * occurs in it exactly as often as in the value.
 */
export function permutedOccurrences(hay: string, needle: string): number {
  const h = [...hay];
  const n = [...needle];
  if (n.length === 0 || h.length < n.length) return 0;
  const want = new Map<string, number>();
  for (const c of n) want.set(c, (want.get(c) ?? 0) + 1);
  let count = 0;
  for (let i = 0; i + n.length <= h.length; ) {
    const have = new Map(want);
    let ok = true;
    for (let k = i; k < i + n.length && ok; k++) {
      const left = (have.get(h[k]!) ?? 0) - 1;
      ok = left >= 0;
      have.set(h[k]!, left);
    }
    if (ok) {
      count++;
      i += n.length;
    } else i++;
  }
  return count;
}

/**
 * Non-overlapping occurrences of `needle` in a block given as its compacted LINES, where the "-" that ends any line but
 * the last is optional: matched when the needle has a "-" there, skipped otherwise. Every other character, every other
 * hyphen included, must match exactly.
 */
export function forcedBreakOccurrences(lines: readonly string[], needle: string): number {
  const hay: string[] = [];
  const optional: boolean[] = [];
  lines.forEach((line, k) => {
    const chars = [...line];
    chars.forEach((c, i) => {
      hay.push(c);
      optional.push(c === '-' && i === chars.length - 1 && k < lines.length - 1);
    });
  });
  const n = [...needle];
  if (n.length === 0) return 0;
  /** End index of a match of n[1..] starting at hay[i0], or -1 (iterative backtracking over optional hyphens). */
  const matchFrom = (i0: number): number => {
    const stack: Array<[number, number]> = [[i0, 1]];
    while (stack.length) {
      let [i, j] = stack.pop()!;
      for (;;) {
        if (j === n.length) return i;
        if (i === hay.length) break;
        if (optional[i]) {
          if (hay[i] === n[j]) stack.push([i + 1, j]); // alternative: skip it
          if (hay[i] === n[j]) {
            i++;
            j++;
          } else i++;
          continue;
        }
        if (hay[i] !== n[j]) break;
        i++;
        j++;
      }
    }
    return -1;
  };
  let count = 0;
  for (let i = 0; i < hay.length; ) {
    const end = hay[i] === n[0] ? matchFrom(i + 1) : -1;
    if (end >= 0) {
      count++;
      i = end;
    } else i++;
  }
  return count;
}

/**
 * Consecutive WHOLE lines of one block (2+ lines) that together are exactly `value`: a field wrapped inside its cell.
 * Each line break stands for the space it replaced (word wrap) or — with `forcedBreaks`, react-pdf's break of an over-long
 * token — for nothing, its drawn "-" dropped. Nothing else is optional.
 */
function wrappedFieldOccurrences(lines: readonly string[], value: string, forcedBreaks: boolean): number {
  const forms = (i: number, j: number): boolean => {
    const go = (k: number, acc: string): boolean => {
      if (!value.startsWith(acc) && !(forcedBreaks && k < j && acc.endsWith('-') && value.startsWith(acc.slice(0, -1)))) return false;
      if (k === j) return acc === value;
      const next = lines[k + 1]!;
      return go(k + 1, `${acc} ${next}`) || (forcedBreaks && acc.endsWith('-') && go(k + 1, acc.slice(0, -1) + next));
    };
    return go(i, lines[i]!);
  };
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (forms(i, j)) {
        count++;
        i = j;
        break;
      }
    }
  }
  return count;
}

/**
 * Printings of a value holding F1's marker □: per page, the delimited printings inside each FIELD (a line's column
 * segment, `lineSegments`: one cell or field, located by its line and x position), plus a field wrapped over several
 * whole lines of one cell. Never a raw substring count over the page, which would find "□ □□" inside "□□ □□□" or across
 * two neighbouring cells (see `markerOccurrences`).
 */
export function markerFieldCount(x: PdfExtraction, value: string, options: { forcedBreakHyphens?: boolean } = {}): number {
  const n = normaliseText(value);
  return x.pages.reduce((sum, p) => {
    const inFields = p.lineSegments.reduce((s, segments) => s + segments.reduce((t, g) => t + markerOccurrences(g, n), 0), 0);
    const wrapped = p.blockLines.reduce((s, lines) => s + wrappedFieldOccurrences(lines, n, options.forcedBreakHyphens === true), 0);
    return sum + inFields + wrapped;
  }, 0);
}

/**
 * How many times a value is printed: per page over lines AND over blocks (a value wrapped across lines of one cell is
 * found in its block), taking the larger, so wrapping never hides a value; plus the printings that straddle a page break
 * inside one paragraph (`x.continuations`: matched over the joined parts, minus those already inside a single part).
 *
 * Matching is whitespace-insensitive (`compact`), because that is all wrapping changes. It is never order-insensitive,
 * with ONE exception: a value that itself carries explicit bidi controls (U+202A–U+202E, U+2066–U+2069). Those are
 * reordering instructions and the renderer obeys them, so the text layer holds the value's characters in the order they
 * are SEEN, and that order depends on how the producer split the text into runs (Skia splits at every font fallback,
 * which differs between Windows and Linux fonts). For such a value, a contiguous window holding exactly its characters
 * counts as one printing (`permutedOccurrences`).
 *
 * A value with LINE BREAKS (a multi-line note) counts as often as its rarest line is printed (each line divided by how
 * often the value itself repeats it): the lines are separate printed lines, separate blocks once a blank line divides
 * them, so the whole value is no longer one block. That every line starts a printed line, in order, is the
 * `line-breaks` check.
 *
 * A value holding F1's marker □ counts whole fields only (`markerFieldCount`).
 *
 * `forcedBreakHyphens` (the NATIVE side only): react-pdf/textkit draws a visible "-" where it force-breaks an over-long
 * unbroken token (word-breaking.ts; cannot be turned off). Inside a block, a "-" that ENDS a line, with the block (same
 * column) carrying on in the next line, may then be skipped when the value has no "-" there (`forcedBreakOccurrences`).
 * A "-" that is in the value is always required, and no other hyphen is ever optional.
 */
export function countValue(x: PdfExtraction, value: string, options: { forcedBreakHyphens?: boolean } = {}): number {
  const lines = valueLines(value);
  if (lines.size > 1 || [...lines.values()].some((m) => m > 1)) return Math.min(...[...lines].map(([l, m]) => Math.floor(countValue(x, l, options) / m)));
  if (value.includes(F1_MARKER)) return markerFieldCount(x, value, options);
  const needle = compact(value);
  const count = BIDI_CONTROLS.test(value)
    ? (hay: string) => Math.max(occurrences(hay, needle), permutedOccurrences(hay, needle))
    : (hay: string) => occurrences(hay, needle);
  const countBlock = (block: string, blockLines: readonly string[] | undefined) =>
    options.forcedBreakHyphens && blockLines && blockLines.length > 1 ? Math.max(count(compact(block)), forcedBreakOccurrences(blockLines.map(compact), needle)) : count(compact(block));
  const perPage = x.pages.reduce((sum, p) => {
    const byLine = p.lines.reduce((s, l) => s + count(compact(l)), 0);
    const byBlock = p.blocks.reduce((s, b, k) => s + countBlock(b, p.blockLines?.[k]), 0);
    return sum + Math.max(byLine, byBlock);
  }, 0);
  const straddling = x.continuations.reduce((sum, c) => {
    const parts = c.parts.map(compact);
    return sum + Math.max(0, count(parts.join('')) - parts.reduce((s, part) => s + count(part), 0));
  }, 0);
  return perPage + straddling;
}

/**
 * Problems with a multi-line field's line breaks (empty = kept): every non-blank line of the value must START a printed
 * line (a line of a block: one cell or paragraph), in reading order (pages, then blocks top to bottom, then lines), each
 * after the previous one. From that line start the block must hold the value's line in full; only where the block ends
 * first (the paragraph carries on after a page break) is the printed beginning, at least 10 characters, enough.
 * A renderer that collapses the breaks prints line k+1 in the middle of a printed line, and fails here.
 */
export function lineBreakProblems(x: PdfExtraction, value: string): string[] {
  const wanted = value.split(LINE_BREAK).map(compact).filter(Boolean);
  if (wanted.length < 2) return [];
  const starts: string[] = [];
  for (const p of x.pages) {
    for (const lines of p.blockLines) {
      const c = lines.map(compact);
      for (let k = 0; k < c.length; k++) starts.push(c.slice(k).join(''));
    }
  }
  const problems: string[] = [];
  let after = -1;
  wanted.forEach((line, k) => {
    let found = -1;
    for (let i = after + 1; i < starts.length && found < 0; i++) {
      const rest = starts[i]!;
      if (rest.startsWith(line) || (rest.length >= Math.min(line.length, 10) && line.startsWith(rest))) found = i;
    }
    if (found < 0) problems.push(`line ${k + 1} of ${wanted.length} (${show(line, 40)}) does not start a printed line${k ? ` after line ${k}` : ''}`);
    else after = found;
  });
  return problems;
}

export function tokens(text: string): string[] {
  return normaliseText(text)
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function multisetDiff<T extends string | number>(a: T[], b: T[]): { onlyA: T[]; onlyB: T[] } {
  const counts = new Map<T, number>();
  for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const t of b) counts.set(t, (counts.get(t) ?? 0) - 1);
  const onlyA: T[] = [];
  const onlyB: T[] = [];
  for (const [t, c] of counts) {
    for (let k = 0; k < c; k++) onlyA.push(t);
    for (let k = 0; k < -c; k++) onlyB.push(t);
  }
  const cmp = (x: T, y: T) => (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y)));
  return { onlyA: onlyA.sort(cmp), onlyB: onlyB.sort(cmp) };
}

const show = (s: string, max = 120) => JSON.stringify(s.length > max ? `${s.slice(0, max)}…` : s);
const list = (xs: Array<string | number>, max = 25) =>
  `${xs
    .slice(0, max)
    .map((x) => (typeof x === 'number' ? String(x) : show(x, 60)))
    .join(', ')}${xs.length > max ? ` … (+${xs.length - max} more)` : ''}`;
const label = (l: string) => {
  const parts = l.split('; ');
  return parts.length > 3 ? `${parts.slice(0, 3).join('; ')} (+${parts.length - 3} more)` : l;
};
const withoutNumbering = (footer: string) => footer.replace(/Page\s*\d+\s*of\s*\d+/i, 'Page # of #');

/** Every printed "Xh Ym" in document order, as minutes. */
export function printedDurations(x: PdfExtraction): number[] {
  return [...x.text.matchAll(/(?<![\w:£.,])(\d+h(?: \d+m)?)(?![\w])/g)].map((m) => Number(parseMinutesText(m[1]!) ?? -1));
}
/** Every printed "N min". */
export function printedBreaks(x: PdfExtraction): number[] {
  return [...x.text.matchAll(/(?<![\w.,])(\d+) min\b/g)].map((m) => Number(m[1]));
}

function checkField(x: PdfExtraction, f: ParseBackField): string | null {
  const flags = f.pattern.flags.includes('g') ? f.pattern.flags : `${f.pattern.flags}g`;
  const matches = [...x.text.replace(/\n/g, ' ').matchAll(new RegExp(f.pattern.source, flags))];
  if (f.parse === 'count') return BigInt(matches.length) === f.want ? null : `${f.label}: printed ${matches.length}×, want ${f.want}×`;
  if (matches.length !== 1) return `${f.label}: printed ${matches.length}× (want exactly once)`;
  const printed = matches[0]![1]!;
  const parsed = f.parse === 'minutes' ? parseMinutesText(printed) : f.parse === 'pence' ? parsePenceText(printed) : /^\d+$/.test(printed) ? BigInt(printed) : null;
  if (parsed === null) return `${f.label}: ${show(printed)} does not parse`;
  return parsed === f.want ? null : `${f.label}: ${show(printed)} parses to ${parsed}, source is ${f.want}`;
}

// ─── checks ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Checks of ONE render against the input (run on both sides, so a value missing from BOTH is still caught). */
export function checkAgainstInput(expect: DocumentExpectation, x: PdfExtraction, name: string, options: CheckOptions = {}): Finding[] {
  const out: Finding[] = [];
  const hyphens = { forcedBreakHyphens: (options.forcedBreakHyphens ?? []).includes(name) };
  const missing = expect.values.filter((v) => countValue(x, v.value, hyphens) < v.min);
  out.push({
    check: `values-present(${name})`,
    ok: missing.length === 0,
    detail: missing.length
      ? `${missing.length} of ${expect.values.length} expected values missing or printed too few times: ${missing
          .slice(0, 15)
          .map((v) => `${label(v.label)} ${show(v.value, 60)} (want >= ${v.min}, got ${countValue(x, v.value, hyphens)})`)
          .join('; ')}`
      : `all ${expect.values.length} expected values printed`,
  });

  // Parse-back: durations / breaks as multisets, labelled fields exactly.
  const pb = expect.parseBack;
  const problems: string[] = [];
  if (expect.kind === 'final-timesheet' || expect.kind === 'final-timesheet-original') {
    const d = multisetDiff(pb.durations, printedDurations(x));
    if (d.onlyA.length || d.onlyB.length) problems.push(`durations: stored minutes not printed ${list(d.onlyA)}; printed but not stored ${list(d.onlyB)}`);
  }
  if (expect.kind !== 'approved-shift-statement') {
    const d = multisetDiff(pb.breaks, printedBreaks(x));
    if (d.onlyA.length || d.onlyB.length) problems.push(`breaks: source not printed ${list(d.onlyA)}; printed but not in source ${list(d.onlyB)}`);
  }
  for (const f of pb.fields) {
    const p = checkField(x, f);
    if (p) problems.push(p);
  }
  out.push({
    check: `parse-back(${name})`,
    ok: problems.length === 0,
    detail: problems.length
      ? problems.join('; ')
      : `${pb.durations.length} duration(s), ${pb.breaks.length} break(s) and ${pb.fields.length} labelled field(s) parse back exactly`,
  });

  if (expect.spec.hasFooter) {
    const bad = x.pages.filter((p) => !p.footerNumbering || p.footerNumbering.page !== p.number || p.footerNumbering.of !== x.pageCount);
    out.push({
      check: `footer-numbering(${name})`,
      ok: bad.length === 0,
      detail: bad.length
        ? `pages without a correct "Page n of ${x.pageCount}": ${bad.map((p) => `${p.number} -> ${show(p.footer ?? '(none)')}`).join('; ')}`
        : `every page reads "Page n of ${x.pageCount}"`,
    });
  } else {
    const withFooter = x.pages.filter((p) => p.footerNumbering);
    out.push({
      check: `no-footer(${name})`,
      ok: withFooter.length === 0,
      detail: withFooter.length ? `unexpected page footer on pages ${withFooter.map((p) => p.number).join(', ')}` : 'no page footer (as the job renders it)',
    });
  }
  if (expect.spec.tableHeader) {
    const markers = expect.rowMarkers.map(compact).filter((m) => m.length > 0);
    const rowPages = x.pages.filter((p) => p.blocks.some((b) => markers.some((m) => compact(b).includes(m))));
    const required = rowPages.length ? rowPages : x.pages.slice(0, 1);
    const bad = required.filter((p) => p.tableHeaderLines.length === 0);
    out.push({
      check: `table-header-repeated(${name})`,
      ok: bad.length === 0,
      detail: bad.length ? `table rows without the header on pages ${bad.map((p) => p.number).join(', ')}` : `header present on all ${required.length} page(s) with table rows`,
    });
  }
  const breakProblems = expect.multiLine.flatMap((f) => lineBreakProblems(x, f.value).map((p) => `${f.label}: ${p}`));
  const breakLines = expect.multiLine.reduce((s, f) => s + f.value.split(LINE_BREAK).filter((l) => l.trim()).length, 0);
  const breaksPending = breakProblems.length > 0 && (options.lineBreaksInfo ?? []).includes(name);
  out.push({
    check: `line-breaks(${name})`,
    ok: breakProblems.length === 0 || breaksPending,
    info: breaksPending,
    detail: breakProblems.length
      ? `${breaksPending ? 'PENDING (the template in this tree does not keep line breaks yet; pinned by test.failing): ' : ''}${breakProblems.length} line(s) of a multi-line note not printed on their own line: ${breakProblems.slice(0, 6).join('; ')}${breakProblems.length > 6 ? ` … (+${breakProblems.length - 6} more)` : ''}`
      : expect.multiLine.length
        ? `${breakLines} line(s) of ${expect.multiLine.length} multi-line field(s) each start a printed line, in order`
        : 'no multi-line field in this document',
  });
  const wantQr = [...expect.qrPayloads].sort();
  const qrOk = JSON.stringify(x.qrPayloads) === JSON.stringify(wantQr);
  out.push({ check: `qr-payloads(${name})`, ok: qrOk, detail: qrOk ? `${wantQr.length} QR payload(s) as encoded` : `decoded ${list(x.qrPayloads)}; expected ${list(wantQr)}` });
  const logo = x.images.some((i) => i.width === 166 && i.height === 70);
  out.push({ check: `logo-166x70(${name})`, ok: logo, detail: logo ? 'logo embedded at 166×70' : `no 166×70 image; images ${list(x.images.map((i) => `${i.width}x${i.height}`))}` });
  out.push({
    check: `no-active-content(${name})`,
    ok: x.activeContentKeys.length === 0,
    detail: x.activeContentKeys.length ? `active-content keys: ${x.activeContentKeys.join(', ')}` : 'no script, action, link, attachment or form keys',
  });
  const outside = x.outOfPageRuns.reduce((a, b) => a + b, 0);
  const strict = (options.boundsStrict ?? ['native']).includes(name);
  out.push({
    check: `within-page(${name})`,
    ok: outside === 0 || !strict,
    info: !strict,
    detail: outside ? `${outside} text run(s) drawn outside the page (pages ${x.outOfPageRuns.map((n, i) => (n ? i + 1 : 0)).filter(Boolean).join(', ')})` : 'all text inside the page',
  });
  const overlaps = x.overlaps.flatMap((o, i) => o.map((v) => ({ page: i + 1, ...v })));
  out.push({
    check: `no-overlap(${name})`,
    ok: overlaps.length === 0 || !strict,
    info: !strict,
    detail: overlaps.length
      ? `${overlaps.length} text run(s) drawn over other text: ${overlaps
          .slice(0, 6)
          .map((o) => `page ${o.page}: ${show(o.a, 30)} / ${show(o.b, 30)} (${o.overlapX} pt across, baselines ${o.dy} pt apart)`)
          .join('; ')}`
      : 'no text drawn over other text',
  });
  out.push({ check: `pdf-inspect(${name})`, ok: x.oracle.pageCount === x.pageCount, info: x.oracle.pageCount === x.pageCount && !x.oracle.agrees, detail: x.oracle.detail });
  return out;
}

/** The `tokens` finding: words of the reference vs the render, with the D6 hyphen-wrap rule (see the file header). */
function tokensFinding(
  refName: string,
  nb: string,
  words: { refRaw: string[]; refJoined: string[]; raw: string[]; joined: string[]; d6: string[] },
  repeated: ReadonlySet<string>,
): Finding & { d6Needed: boolean } {
  const residual = (ta: string[], tb: string[]) => {
    const { onlyA, onlyB } = multisetDiff(ta, tb);
    return { onlyA: onlyA.filter((t) => !repeated.has(t)), onlyB: onlyB.filter((t) => !repeated.has(t)), any: onlyA.length + onlyB.length > 0 };
  };
  const raw = residual(words.refRaw, words.raw);
  const describe = (d: { onlyA: string[]; onlyB: string[] }) =>
    [d.onlyA.length ? `only in ${refName} (missing from ${nb}): ${list(d.onlyA)}` : '', d.onlyB.length ? `only in ${nb} (extra): ${list(d.onlyB)}` : ''].filter(Boolean).join(' | ');
  if (raw.onlyA.length === 0 && raw.onlyB.length === 0) {
    return { check: 'tokens', ok: true, d6Needed: false, detail: `${words.refRaw.length} words, identical multiset${raw.any ? ' (apart from header/footer repeats on D4 extra pages)' : ''}` };
  }
  const joined = residual(words.refJoined, words.joined);
  if (joined.onlyA.length === 0 && joined.onlyB.length === 0) {
    return {
      check: 'tokens',
      ok: true,
      d6Needed: true,
      detail: `D6 hyphen wrap: the words differ only where a line breaks at a word's own hyphen (${describe(raw)}); with those breaks rejoined the text is identical (${list([...new Set(words.d6)], 8)})`,
    };
  }
  return { check: 'tokens', ok: false, d6Needed: false, detail: describe(joined) };
}

/** D6 is accepted only when every other check of the comparison passes (FINAL brief conditions). */
function applyD6Conditions(findings: Finding[], tokens: Finding & { d6Needed: boolean }): void {
  const { d6Needed, ...finding } = tokens;
  if (d6Needed) {
    const blocking = findings.filter((f) => !f.ok && !f.info).map((f) => f.check);
    if (blocking.length) {
      finding.ok = false;
      finding.detail = `D6 hyphen-wrap difference NOT accepted: other checks fail (${blocking.join(', ')}). ${finding.detail}`;
    } else {
      findings.push({ check: 'd6-hyphen-wrap', ok: true, info: true, detail: 'accepted: joined text identical; nothing missing or added, inside the page, no overlap, footers, headers and line breaks correct' });
    }
  }
  findings.push(finding);
}

export function compareExtractions(
  label_: string,
  expect: DocumentExpectation,
  a: PdfExtraction,
  b: PdfExtraction,
  names: [string, string] = ['chromium', 'native'],
  options: CheckOptions = {},
): ComparisonResult {
  const [na, nb] = names;
  const rows = expect.rowMarkers.length;
  const d4 = options.segmentRows && rows > 0 ? Math.max(0, Math.ceil(rows / options.segmentRows) - 1) : 0;
  const tolerance = (options.pageCountTolerance ?? 0) + d4;
  const expectB = options.expectB ?? expect;
  const ref = options.referenceB;
  // Printed text, not stored text: F1 turns CRLF, a lone CR, U+2028 and U+2029 into LF, which prints the same line break,
  // so a value that differs only in the form of its line breaks is not a printed difference (a □, a dropped or an added
  // character still is).
  const asPrinted = (v: string | undefined) => (v === undefined ? undefined : v.replace(/\r\n?|[\u2028\u2029]/g, '\n'));
  if (!ref && (expectB.values.length !== expect.values.length || expectB.values.some((v, i) => asPrinted(v.value) !== asPrinted(expect.values[i]?.value)))) {
    throw new Error('compareExtractions: expectB changes printed values, so a referenceB is required (the two renders are meant to differ)');
  }
  const hyphensA = (options.forcedBreakHyphens ?? []).includes(na);
  const hyphensB = (options.forcedBreakHyphens ?? []).includes(nb);
  const findings: Finding[] = [...checkAgainstInput(expect, a, na, options), ...checkAgainstInput(expectB, b, nb, options)];

  findings.push({
    check: 'page-count',
    ok: Math.abs(a.pageCount - b.pageCount) <= tolerance,
    detail: `${na} ${a.pageCount}, ${nb} ${b.pageCount}${tolerance ? ` (allowed difference ${tolerance}${d4 ? `: D4, ${rows} rows in ${options.segmentRows}-row segments` : ''})` : ''}`,
  });

  const pageDelta = Math.abs(a.pageCount - b.pageCount);
  const refName = ref ? ref.label : na;
  if (ref) {
    // Against the document itself (built for b's own page count, so no D4 allowance is needed). Every value is compared,
    // a value printed as nothing but □ under F1 included: both sides count it as a whole field (countValue / htmlReference).
    const diffs = expectB.values.map((v) => ({ v, ca: ref.count(v.value), cb: countValue(b, v.value, { forcedBreakHyphens: hyphensB }) })).filter((r) => r.ca !== r.cb);
    findings.push({
      check: 'values-equal',
      ok: diffs.length === 0,
      detail: diffs.length
        ? `${diffs.length} business value(s) printed a different number of times than the ${refName}: ${diffs
            .slice(0, 20)
            .map((r) => `${label(r.v.label)} ${show(r.v.value, 60)}: ${refName} ${r.ca} / ${nb} ${r.cb}`)
            .join('; ')}`
        : `all ${expectB.values.length} business values printed as often as in the ${refName}`,
    });
  } else {
    const valueDiffs = expect.values
      .map((v) => ({ v, ca: countValue(a, v.value, { forcedBreakHyphens: hyphensA }), cb: countValue(b, v.value, { forcedBreakHyphens: hyphensB }) }))
      .filter((r) => r.ca !== r.cb);
    // Under a D4 page-count difference, text repeated on every page (the footer, the table header) legitimately appears
    // that many more times; a value may differ by exactly (page difference × its occurrences in one footer + header).
    const perPage = (v: string) => occurrences(compact(a.pages[0]?.footer ?? ''), compact(v)) + occurrences(compact(a.pages[0]?.tableHeaderLines[0] ?? ''), compact(v));
    const realDiffs = valueDiffs.filter((r) => Math.abs(r.ca - r.cb) !== pageDelta * perPage(r.v.value) || pageDelta === 0);
    findings.push({
      check: 'values-equal',
      ok: realDiffs.length === 0,
      detail: realDiffs.length
        ? `${realDiffs.length} business value(s) printed a different number of times: ${realDiffs
            .slice(0, 20)
            .map((r) => `${label(r.v.label)} ${show(r.v.value, 60)}: ${na} ${r.ca} / ${nb} ${r.cb}`)
            .join('; ')}`
        : `all ${expect.values.length} business values printed identically${valueDiffs.length ? ` (footer repeats differ only by the D4 page difference)` : ''}`,
    });
  }

  const fa = [...new Set(a.pages.map((p) => withoutNumbering(p.footer ?? '')))];
  const fb = [...new Set(b.pages.map((p) => withoutNumbering(p.footer ?? '')))];
  findings.push({
    check: 'footer-text-equal',
    ok: JSON.stringify(fa) === JSON.stringify(fb),
    detail: JSON.stringify(fa) === JSON.stringify(fb) ? `identical footer text on every page (workspace, reference, generatedAt)` : `${na} ${list(fa)} / ${nb} ${list(fb)}`,
  });
  if (expect.spec.tableHeader) {
    const ha = [...new Set(a.pages.flatMap((p) => p.tableHeaderLines))];
    const hb = [...new Set(b.pages.flatMap((p) => p.tableHeaderLines))];
    findings.push({
      check: 'table-header-equal',
      ok: JSON.stringify(ha) === JSON.stringify(hb),
      detail: JSON.stringify(ha) === JSON.stringify(hb) ? 'identical header line' : `${na} ${list(ha)} / ${nb} ${list(hb)}`,
    });
  }

  const qrEqual = JSON.stringify(a.qrPayloads) === JSON.stringify(b.qrPayloads);
  findings.push({ check: 'qr-equal', ok: qrEqual, detail: qrEqual ? `${a.qrPayloads.length} identical payload(s)` : `${na} ${list(a.qrPayloads)} / ${nb} ${list(b.qrPayloads)}` });
  findings.push({ check: 'image-count', ok: a.imageCount === b.imageCount, detail: `${na} ${a.imageCount}, ${nb} ${b.imageCount}` });

  // Words: the first render's, or the document's own (referenceB); the second's with forced-break joins where its
  // renderer draws them. Then the same with D6 hyphen wraps rejoined on both sides (only where the document has the word).
  const docA = options.documentWords?.a;
  const docB = options.documentWords?.b ?? (ref ? ref.tokens : docA);
  // The first render's own break joins that are not D6 (its forced breaks; Chromium's unhyphenated overflow-wrap breaks
  // of an over-long token) belong to its raw words, decided by the document's words like every join.
  const refRaw = ref ? ref.tokens : docA ? joinLineBreaks(a, docA, { forcedBreaks: hyphensA, d6: false, unhyphenated: !hyphensA }).tokens : tokens(a.text);
  const raw = hyphensB ? tokensJoiningForcedBreaks(b, docB ?? refRaw) : tokens(b.text);
  const joinedA = ref || !docA ? { tokens: refRaw, d6: [] as string[] } : joinLineBreaks(a, docA, { forcedBreaks: hyphensA, d6: true, unhyphenated: !hyphensA });
  const joinedB = docB ? joinLineBreaks(b, docB, { forcedBreaks: hyphensB, d6: true }) : { tokens: raw, d6: [] as string[] };
  // Under a D4 page difference the extra pages repeat the header line and the footer: those words are not "extra values".
  const repeated = new Set(
    pageDelta > 0 && !ref
      ? [...a.pages, ...b.pages].flatMap((p) => [...tokens(p.footer ?? ''), ...p.tableHeaderLines.flatMap(tokens)])
      : [],
  );
  const tokenFinding = tokensFinding(refName, nb, { refRaw, refJoined: joinedA.tokens, raw, joined: joinedB.tokens, d6: [...joinedA.d6, ...joinedB.d6] }, repeated);

  const sizesA = JSON.stringify(a.pageSizes[0]);
  const sizesB = JSON.stringify(b.pageSizes[0]);
  findings.push({ check: 'page-size', ok: true, info: true, detail: sizesA === sizesB ? `${sizesA} pt` : `${na} ${sizesA} pt, ${nb} ${sizesB} pt (D6: A4 point rounding accepted)` });
  if (a.pageCount === b.pageCount) {
    const moved = a.pages
      .map((p, i) => ({ n: p.number, d: multisetDiff(tokens(p.text), tokens(b.pages[i]!.text)) }))
      .filter((r) => r.d.onlyA.length || r.d.onlyB.length);
    findings.push({
      check: 'page-text',
      ok: !options.strictPagePlacement || moved.length === 0,
      info: !options.strictPagePlacement,
      detail: moved.length
        ? moved.map((r) => `page ${r.n}: ${r.d.onlyA.length} word(s) only in ${na}, ${r.d.onlyB.length} only in ${nb} (e.g. ${list([...r.d.onlyA, ...r.d.onlyB], 6)})`).join('; ')
        : 'every page carries the same words',
    });
  }
  applyD6Conditions(findings, tokenFinding);
  if (options.extraPageAccepted === nb) acceptOneExtraPage(findings, b.pageCount - a.pageCount - tolerance, nb);

  return { label: label_, names, ok: findings.every((f) => f.ok || f.info), findings };
}

/**
 * OWNER-ACCEPTED page-count delta (2026-11-04): a failing `page-count` becomes INFO, marked ACCEPTED, only when `over`
 * (pages of `name` beyond the first render's count plus the allowed difference) is exactly 1 AND every other finding
 * passes (ok, or INFO by its own rule). Anything else leaves it a failure: fewer pages, two or more extra pages, or an
 * extra page together with any other failing check (a dropped value, a missing footer, a lost line break...).
 */
export function acceptOneExtraPage(findings: Finding[], over: number, name: string): void {
  const page = findings.find((f) => f.check === 'page-count');
  if (!page || page.ok || over !== 1) return;
  if (findings.some((f) => f !== page && !f.ok && !f.info)) return;
  page.info = true;
  page.detail = `${page.detail} — ACCEPTED (owner 2026-11-04): ${name} prints one page more; every other check passed`;
}

/**
 * NATIVE-ONLY MODE (P5: the tree has no Chromium; INTEGRATION-ISSUES I-6). One render checked against the input
 * (`checkAgainstInput`, every check) and against the DOCUMENT's own text (`reference`: the template HTML's text and footer,
 * F1 applied; never a Chromium render): every business value printed exactly as often as the document prints it, the
 * same words (D6 hyphen wraps and forced breaks rejoined only where the document has the word), each page's footer the
 * document's footer for that page, and exactly the document's images (the logo, plus the Shift QR on the roster). The
 * visual reference is the owner-reviewed golden rasters (pdf-equality.native.spec.ts).
 */
export function checkAgainstDocument(
  label_: string,
  expect: DocumentExpectation,
  x: PdfExtraction,
  name: string,
  reference: TextReference,
  options: CheckOptions & { images: number },
): ComparisonResult {
  const hyphens = (options.forcedBreakHyphens ?? []).includes(name);
  const findings = checkAgainstInput(expect, x, name, options);
  const diffs = expect.values.map((v) => ({ v, ca: reference.count(v.value), cb: countValue(x, v.value, { forcedBreakHyphens: hyphens }) })).filter((r) => r.ca !== r.cb);
  findings.push({
    check: 'values-equal',
    ok: diffs.length === 0,
    detail: diffs.length
      ? `${diffs.length} business value(s) printed a different number of times than the ${reference.label}: ${diffs
          .slice(0, 20)
          .map((r) => `${label(r.v.label)} ${show(r.v.value, 60)}: document ${r.ca} / ${name} ${r.cb}`)
          .join('; ')}`
      : `all ${expect.values.length} business values printed as often as in the ${reference.label}`,
  });
  if (expect.spec.hasFooter) {
    const wrong = x.pages.filter((p, i) => compact(p.footer ?? '') !== compact(reference.footers[i] ?? ''));
    findings.push({
      check: 'footer-text',
      ok: wrong.length === 0,
      detail: wrong.length
        ? `pages whose footer is not the document's: ${wrong.map((p) => `${p.number}: ${show(p.footer ?? '(none)', 80)} / want ${show(reference.footers[p.number - 1] ?? '(none)', 80)}`).join('; ')}`
        : `every page carries the document's footer (workspace, reference, generatedAt, "Page n of ${x.pageCount}")`,
    });
  }
  findings.push({ check: 'image-count', ok: x.imageCount === options.images, detail: `${name} ${x.imageCount}, document ${options.images}` });
  const docWords = options.documentWords?.b ?? reference.tokens;
  const raw = hyphens ? tokensJoiningForcedBreaks(x, docWords) : tokens(x.text);
  const joined = joinLineBreaks(x, docWords, { forcedBreaks: hyphens, d6: true });
  const tokenFinding = tokensFinding(reference.label, name, { refRaw: reference.tokens, refJoined: reference.tokens, raw, joined: joined.tokens, d6: joined.d6 }, new Set());
  findings.push({ check: 'page-size', ok: true, info: true, detail: `${JSON.stringify(x.pageSizes[0])} pt` });
  applyD6Conditions(findings, tokenFinding);
  return { label: label_, names: [reference.label, name], ok: findings.every((f) => f.ok || f.info), findings };
}

/** A plain-text diff report: one block per document, failures first, then a summary. */
export function formatReport(results: ComparisonResult[], title = 'PDF equality report'): string {
  const lines: string[] = [title, '='.repeat(title.length), ''];
  for (const r of results) {
    lines.push(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}  (${r.names[0]} vs ${r.names[1]})`);
    const rank = (f: Finding) => (f.ok ? (f.info ? 1 : 2) : f.info ? 1 : 0);
    for (const f of [...r.findings].sort((x, y) => rank(x) - rank(y))) lines.push(`      [${!f.ok && !f.info ? 'FAIL' : f.info ? 'INFO' : 'ok  '}] ${f.check}: ${f.detail}`);
    lines.push('');
  }
  const failed = results.filter((r) => !r.ok);
  lines.push(`SUMMARY: ${results.length - failed.length} of ${results.length} comparisons equal${failed.length ? `; FAILED: ${failed.map((r) => r.label).join(', ')}` : ''}`);
  return lines.join('\n');
}
