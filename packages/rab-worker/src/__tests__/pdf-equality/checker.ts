import { DocumentExpectation, ParseBackField } from './documents';
import { compact, normaliseText, PdfExtraction } from './extract';

/**
 * EQUALITY CHECKER — the P0 plan's §5.2 equality design (docs/PDF_RENDERER_P0_PLAN_2026-11-03.md, owner-approved
 * 2026-11-04). Compares two extractions of PDFs rendered from the SAME input (Chromium vs native; or Chromium vs
 * Chromium for the self-test), each against the input and against each other:
 *
 *   values         every business value (names, venue, dates, clock times, worked minutes, money, report ids, signature
 *                  names) is printed, and printed the same number of times by both renderers            (§5.2 4(a), 4(c))
 *   parse-back     every "Xh Ym" parses back to the STORED minutes and every "£…" to the exact pence, with a bigint string
 *                  parser (no float); totals, counts and "To be confirmed" ×2                           (§5.2 4(b))
 *   page-count     equal; under D4 (40-row table segments) it may differ by at most one page per segment boundary
 *   footer         "Page n of N" on every page with N = that render's page count; the footer text (workspace, reference,
 *                  generatedAt) identical between renderers; a footer-less document has none           (§5.2 4(d))
 *   table-header   the header line on every page that carries table rows
 *   qr             decoded payloads identical and equal to the signed token                             (§5.2 4(e))
 *   logo           the 166×70 logo is embedded                                                         (§5.2 4(f))
 *   tokens         no missing or extra words (multiset of normalised words over the document)
 *   active content no /JavaScript, /JS, /OpenAction, /Launch, /URI, /EmbeddedFile, /AA, /AcroForm      (§8 P3)
 *   bounds         no text drawn outside the page (strict for the native renderer; INFO for Chromium)  (§8 P3)
 *   pdf-inspect    the repo's own oracle reads the same page count
 *
 * D6 (owner-approved format deltas: column widths, PDF version, file size, A4 point rounding) never fails a comparison:
 * page sizes and per-page word placement are reported as INFO, and golden rasters (pdf-equality.native.spec.ts) are the
 * visual reference.
 */

export interface CheckOptions {
  /** Allowed |pages(a) − pages(b)| on top of D4. Default 0. */
  pageCountTolerance?: number;
  /** D4: table segment size of the native renderer (40, owner-approved). Each segment boundary may add one page. */
  segmentRows?: number;
  /** Fail (instead of INFO) when a page's words differ although the document's words are equal. */
  strictPagePlacement?: boolean;
  /** Render names whose text must stay inside the page (default: ['native']). */
  boundsStrict?: string[];
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
 */
export function countValue(x: PdfExtraction, value: string): number {
  const needle = compact(value);
  const count = BIDI_CONTROLS.test(value)
    ? (hay: string) => Math.max(occurrences(hay, needle), permutedOccurrences(hay, needle))
    : (hay: string) => occurrences(hay, needle);
  const perPage = x.pages.reduce((sum, p) => {
    const byLine = p.lines.reduce((s, l) => s + count(compact(l)), 0);
    const byBlock = p.blocks.reduce((s, b) => s + count(compact(b)), 0);
    return sum + Math.max(byLine, byBlock);
  }, 0);
  const straddling = x.continuations.reduce((sum, c) => {
    const parts = c.parts.map(compact);
    return sum + Math.max(0, count(parts.join('')) - parts.reduce((s, part) => s + count(part), 0));
  }, 0);
  return perPage + straddling;
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
  const missing = expect.values.filter((v) => countValue(x, v.value) < v.min);
  out.push({
    check: `values-present(${name})`,
    ok: missing.length === 0,
    detail: missing.length
      ? `${missing.length} of ${expect.values.length} expected values missing or printed too few times: ${missing
          .slice(0, 15)
          .map((v) => `${label(v.label)} ${show(v.value, 60)} (want >= ${v.min}, got ${countValue(x, v.value)})`)
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
  out.push({ check: `pdf-inspect(${name})`, ok: x.oracle.pageCount === x.pageCount, info: x.oracle.pageCount === x.pageCount && !x.oracle.agrees, detail: x.oracle.detail });
  return out;
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
  const findings: Finding[] = [...checkAgainstInput(expect, a, na, options), ...checkAgainstInput(expect, b, nb, options)];

  findings.push({
    check: 'page-count',
    ok: Math.abs(a.pageCount - b.pageCount) <= tolerance,
    detail: `${na} ${a.pageCount}, ${nb} ${b.pageCount}${tolerance ? ` (allowed difference ${tolerance}${d4 ? `: D4, ${rows} rows in ${options.segmentRows}-row segments` : ''})` : ''}`,
  });

  const valueDiffs = expect.values.map((v) => ({ v, ca: countValue(a, v.value), cb: countValue(b, v.value) })).filter((r) => r.ca !== r.cb);
  // Under a D4 page-count difference, text repeated on every page (the footer, the table header) legitimately appears
  // that many more times; a value may differ by exactly (page difference × its occurrences in one footer + header).
  const pageDelta = Math.abs(a.pageCount - b.pageCount);
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

  const ta = tokens(a.text);
  const tb = tokens(b.text);
  const { onlyA, onlyB } = multisetDiff(ta, tb);
  // Under a D4 page difference the extra pages repeat the header line and the footer: those words are not "extra values".
  const repeated = new Set(
    pageDelta > 0
      ? [...a.pages, ...b.pages].flatMap((p) => [...tokens(p.footer ?? ''), ...p.tableHeaderLines.flatMap(tokens)])
      : [],
  );
  const tokOnlyA = onlyA.filter((t) => !repeated.has(t));
  const tokOnlyB = onlyB.filter((t) => !repeated.has(t));
  findings.push({
    check: 'tokens',
    ok: tokOnlyA.length === 0 && tokOnlyB.length === 0,
    detail:
      tokOnlyA.length || tokOnlyB.length
        ? [tokOnlyA.length ? `only in ${na} (missing from ${nb}): ${list(tokOnlyA)}` : '', tokOnlyB.length ? `only in ${nb} (extra): ${list(tokOnlyB)}` : '']
            .filter(Boolean)
            .join(' | ')
        : `${ta.length} words, identical multiset${onlyA.length + onlyB.length ? ' (apart from header/footer repeats on D4 extra pages)' : ''}`,
  });

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

  return { label: label_, names, ok: findings.every((f) => f.ok || f.info), findings };
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
