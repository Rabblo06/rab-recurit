import { Image, Page, Styles, Text as PdfText, TextProps, View } from '@react-pdf/renderer';
import { createElement, Fragment, PropsWithChildren, ReactElement, ReactNode } from 'react';

import type { ShiftDetailsView } from '@rab/server/modules/attendance/templates/adolphus-document';
import { ADOLPHUS_LOGO_DATA_URI } from '@rab/server/modules/attendance/templates/adolphus-logo';

import { FONT_FAMILY_STACK } from './fonts';

/**
 * Shared building blocks for the native (Chromium-free) PDF renderer — PDF renderer migration P1. ONE place for the
 * document typography, the Adolphus header (logo + title + orange rule), the shift-details block, the data table with a
 * header row that repeats on every page (in 40-row page segments, owner decision D4), the sign-off block, a QR image
 * and the page-number footer, so the pre-shift roster and the shift statement reuse them when they are converted.
 *
 * Rules every component here follows (the security properties the Chromium renderer gets from its hardening):
 *   - TEXT ONLY. Every value is passed to `<Text>` as a string child. @react-pdf/renderer lays out text; it has no HTML,
 *     CSS or script parser, so `<script>`, `<img src=…>` or entity-looking input prints literally (hostile-text specs).
 *   - NO NETWORK, NO FILE BY NAME FROM DATA. Images are accepted only as in-memory bytes (`{ data: Buffer, format }`),
 *     never a URL or path string (react-pdf would fetch a URL); fonts are the vendored files (`fonts.ts`).
 *     No emoji source is ever registered (react-pdf would fetch emoji images from it).
 *   - NO BUSINESS LOGIC. Components print the view-model strings they are given; they never format a date, sum
 *     minutes or decide a label.
 *
 * Units: react-pdf works in PDF points. The Chromium template's CSS pixels are 0.75 pt each (`px()` below), so the two
 * renderers share one set of design numbers.
 */

export const h = createElement;

/** One react-pdf style object. */
export type Style = Styles[string];

/**
 * textkit's penalty for breaking inside a word, set to its "never" (linebreak.infinity = 10000). Knuth-Plass then never
 * breaks inside a word; only when it finds no feasible paragraph (a token wider than its box) does textkit fall back to
 * its greedy best fit, which breaks inside that token only where the line would overflow, preferring any space. With the
 * word-breaking rule in fonts.ts (only tokens longer than 24 characters are breakable at all) a hyphenated name that fits
 * stays whole, as in Chromium (MEASURED: at textkit's default 600, and at 9999, "Fitzgerald-…" became "Fitzg-erald").
 */
export const IN_WORD_BREAK_PENALTY = 10000;

/**
 * HTML's `white-space: normal`, which the Chromium templates print with: every run of ASCII whitespace (space, TAB, LF,
 * CR, FF) is one space; NBSP and other Unicode spaces are kept. Applied to every string a layout prints, so both
 * renderers lay out the same characters (MEASURED: a note's blank lines are collapsed by Chromium; printing them natively
 * made 56 paragraphs out of Chromium's one, and 7 pages instead of 5). Preserving line breaks in notes would be a
 * template change for BOTH renderers (`white-space: pre-line`), an owner decision.
 */
export function collapseWhitespace(text: string): string {
  return text.replace(/[ \t\n\r\f]+/g, ' ');
}

/**
 * The ONLY text primitive layouts use (instead of react-pdf's `Text`): the same component with IN_WORD_BREAK_PENALTY, and
 * string children collapsed like HTML (`collapseWhitespace`). Children are plain strings (view-model values), never markup.
 */
export function Text(props: PropsWithChildren<TextProps>): ReactElement {
  const children = typeof props.children === 'string' ? collapseWhitespace(props.children) : props.children;
  return h(PdfText, { hyphenationPenalty: IN_WORD_BREAK_PENALTY, ...props }, children);
}

/** CSS px → PDF pt (96 px = 72 pt), so sizes read exactly as in DOCUMENT_CSS. */
export const px = (n: number): number => n * 0.75;
/** mm → PDF pt. */
export const mm = (n: number): number => (n * 72) / 25.4;

export const COLOR = Object.freeze({
  ink: '#1F2321',
  detail: '#6B7270',
  muted: '#8A8F8C',
  orange: '#E8711C',
  headBg: '#2A2B29',
  headInk: '#FFFFFF',
  rowAlt: '#F4F5F3',
  rowRule: '#ECEDEB',
  avatarBg: '#E6E7E5',
  avatarInk: '#4A4F4C',
  flag: '#B45309',
});

// ─── images (bytes only) ───────────────────────────────────────────────────────────────────────────────────────────────

export interface ImageBytes {
  data: Buffer;
  format: 'png' | 'jpg';
}

const DATA_URI = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * A server-generated `data:image/png|jpeg;base64,…` URI (the logo module, the QR service output) → in-memory bytes.
 * Anything else — a remote URL, a file path, another media type — is refused: the native renderer never fetches.
 */
export function imageBytesFromDataUri(uri: string): ImageBytes {
  const m = DATA_URI.exec(uri);
  if (!m) throw new Error('native PDF renderer: images must be base64 PNG/JPEG data URIs');
  return { data: Buffer.from(m[2]!, 'base64'), format: m[1] === 'png' ? 'png' : 'jpg' };
}

/** The Adolphus logo (owner-supplied 166×70 JPEG from the server's logo module) as bytes, decoded once; width / height. */
export const ADOLPHUS_LOGO_ASPECT = 166 / 70;
let adolphusLogoBytes: ImageBytes | undefined;
export function adolphusLogo(): ImageBytes {
  return (adolphusLogoBytes ??= imageBytesFromDataUri(ADOLPHUS_LOGO_DATA_URI));
}

/** PNG bytes (e.g. `QrImageService.generatePng`) → image source; refuses anything that is not a PNG. */
export function pngBytes(data: Buffer): ImageBytes {
  if (!Buffer.isBuffer(data) || data.length < 8 || data.readUInt32BE(0) !== 0x89504e47) throw new Error('native PDF renderer: not a PNG');
  return { data, format: 'png' };
}

// ─── typography ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * DOCUMENT_CSS's body: Arial-metric font, 11 px, ink colour. The family is the font stack (fonts.ts; with the render
 * runtime: Liberation Sans, then the Noto Sans fallback): the glyph check accepts exactly what this stack draws, so no
 * layout may name a family of its own. No `lineHeight` here: react-pdf resolves a unitless line
 * height against the font size where it is declared and inherits the absolute value, which would squash larger text;
 * left unset, every text uses the font's own line spacing, as Chromium's `line-height: normal` does.
 */
export const BASE_TEXT = Object.freeze({ fontFamily: [...FONT_FAMILY_STACK], fontSize: px(11), color: COLOR.ink });

// ─── page ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PageMargin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Chromium's page.pdf() margins when a footer template is given: 12 mm, 16 mm at the bottom (the footer sits in it). */
export const PAGE_MARGIN: Readonly<PageMargin> = Object.freeze({ top: mm(12), right: mm(12), bottom: mm(16), left: mm(12) });

/** Distance from the page's bottom edge to the footer line's box (matched to Chromium's footer placement). */
const FOOTER_BOTTOM = mm(5);

/** The `<Page>` style: base typography plus the page margins (default: the footer-template margins above). */
export function pageStyle(margin: Readonly<PageMargin> = PAGE_MARGIN): Style {
  return { ...BASE_TEXT, paddingTop: margin.top, paddingRight: margin.right, paddingBottom: margin.bottom, paddingLeft: margin.left };
}

/**
 * The per-page footer: `left` on the left, `<generated> · Page x of y` on the right — the same strings as the Chromium
 * footer template (`documentFooterView`). Fixed, so react-pdf draws it on every page with that page's numbers.
 */
export function PageFooter(props: { left: string; generated: string }): ReactElement {
  // A fixed absolute row: the two texts share the width (flexBasis 0) and wrap instead of overlapping, as the Chromium
  // footer's flex row does. `fixed` on every node: react-pdf only resolves `render` (page numbers) on fixed nodes.
  const text: Style = { fontSize: px(7.5), color: COLOR.muted, flexGrow: 1, flexShrink: 1, flexBasis: 0 };
  return h(
    View,
    { fixed: true, style: { position: 'absolute', left: PAGE_MARGIN.left, right: PAGE_MARGIN.right, bottom: FOOTER_BOTTOM, flexDirection: 'row' } },
    h(Text, { fixed: true, style: text }, props.left),
    h(Text, {
      fixed: true,
      style: { ...text, textAlign: 'right', marginLeft: px(12) },
      render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => `${props.generated} · Page ${pageNumber} of ${totalPages}`,
    }),
  );
}

// ─── header ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Logo (52 px high, aspect kept) left, upper-case title right, aligned to the bottom; then the 2 px orange rule. */
export function DocumentHeader(props: { title: string; logo?: ImageBytes; logoAspect?: number }): ReactElement {
  const logoHeight = px(52);
  const logo = props.logo ?? adolphusLogo();
  const aspect = props.logoAspect ?? ADOLPHUS_LOGO_ASPECT;
  return h(
    Fragment,
    null,
    h(
      View,
      { style: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' } },
      h(Image, { src: logo, style: { height: logoHeight, width: logoHeight * aspect } }),
      h(Text, { style: { fontSize: px(15), fontWeight: 700, letterSpacing: px(0.4), textTransform: 'uppercase', paddingBottom: px(6) } }, props.title),
    ),
    h(View, { style: { height: px(2), backgroundColor: COLOR.orange, marginTop: px(10), marginBottom: px(18) } }),
  );
}

// ─── shift details ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Venue heading and the detail lines (optional lines only when present), as `shiftDetailsHtmlFromView` prints them. */
export function ShiftDetails(props: { details: ShiftDetailsView }): ReactElement {
  const d = props.details;
  const line = (text: string) => h(Text, null, text);
  return h(
    View,
    null,
    h(Text, { style: { fontSize: px(22), fontWeight: 700, marginBottom: px(8) } }, d.venueName),
    h(
      View,
      { style: { color: COLOR.detail, fontSize: px(11.5), lineHeight: 1.7 } },
      d.address ? line(d.address) : null,
      line(d.role),
      // Chromium prints "Date: X␣&nbsp;&nbsp;␣Scheduled: Y" — two no-break spaces between single spaces.
      line(`Date: ${d.date} \u00a0\u00a0 Scheduled: ${d.scheduled}`),
      d.contact ? line(`Contact: ${d.contact}`) : null,
      line(`Shift reference: ${d.shiftReference}`),
    ),
  );
}

// ─── table ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TableColumn {
  label: string;
  /** Share of the table width, in percent; the columns' widths must add up to 100. */
  widthPct: number;
}

const CELL_PAD = Object.freeze({ th: { v: px(9), h: px(10) }, td: { v: px(8), h: px(10) } });

/**
 * A full-width table whose header row repeats at the top of every page the table continues on (react-pdf `fixed`
 * inside a node that is split across pages), with rows that never split across a page (`wrap={false}`, the template's
 * `tr { page-break-inside: avoid }`) and alternating light rows. `rows` are already-built cell contents; `rowOffset`
 * (the index of the first row in the whole table) keeps the zebra striping continuous across page segments.
 */
export function DataTable(props: { columns: readonly TableColumn[]; rows: ReactNode[][]; emptyText: string; rowOffset?: number }): ReactElement {
  const offset = props.rowOffset ?? 0;
  const total = props.columns.reduce((s, c) => s + c.widthPct, 0);
  if (Math.abs(total - 100) > 0.001) throw new Error(`native PDF renderer: table columns add up to ${total}%, not 100%`);
  const header = h(
    View,
    { fixed: true, style: { flexDirection: 'row', backgroundColor: COLOR.headBg } },
    ...props.columns.map((c, i) =>
      h(
        View,
        { key: `h${i}`, style: { width: `${c.widthPct}%`, paddingVertical: CELL_PAD.th.v, paddingHorizontal: CELL_PAD.th.h } },
        h(Text, { style: { color: COLOR.headInk, fontSize: px(10.5), fontWeight: 700 } }, c.label),
      ),
    ),
  );
  const body = props.rows.length
    ? props.rows.map((cells, r) =>
        h(
          View,
          {
            key: `r${r}`,
            wrap: false,
            style: { flexDirection: 'row', alignItems: 'stretch', backgroundColor: (offset + r) % 2 === 1 ? COLOR.rowAlt : undefined, borderBottomWidth: px(1), borderBottomColor: COLOR.rowRule },
          },
          ...cells.map((cell, i) =>
            h(
              View,
              { key: `c${i}`, style: { width: `${props.columns[i]!.widthPct}%`, paddingVertical: CELL_PAD.td.v, paddingHorizontal: CELL_PAD.td.h, justifyContent: 'center', fontSize: px(10.5) } },
              cell,
            ),
          ),
        ),
      )
    : [
        h(
          View,
          { key: 'empty', wrap: false, style: { paddingVertical: CELL_PAD.td.v, paddingHorizontal: CELL_PAD.td.h, borderBottomWidth: px(1), borderBottomColor: COLOR.rowRule } },
          h(Text, { style: { color: COLOR.muted, fontSize: px(10.5) } }, props.emptyText),
        ),
      ];
  return h(View, { style: { width: '100%' } }, header, ...body);
}

/** Round initials avatar + bold name + small grey sub-line (the template's `.staff` cell). */
export function StaffCell(props: { initials: string; name: string; sub: string }): ReactElement {
  const size = px(26);
  return h(
    View,
    { style: { flexDirection: 'row', alignItems: 'center' } },
    h(
      View,
      { style: { width: size, height: size, borderRadius: size / 2, backgroundColor: COLOR.avatarBg, alignItems: 'center', justifyContent: 'center', marginRight: px(9), flexShrink: 0 } },
      h(Text, { style: { fontSize: px(9), fontWeight: 700, color: COLOR.avatarInk } }, props.initials),
    ),
    // flexBasis 0: the name column is exactly the space the avatar leaves. With the default (auto) basis yoga sizes it
    // from the name's one-line width, and a name slightly too long for the cell is then drawn unwrapped over the next
    // column (MEASURED).
    h(
      View,
      { style: { flexGrow: 1, flexShrink: 1, flexBasis: 0 } },
      h(Text, { style: { fontWeight: 700 } }, props.name),
      h(Text, { style: { fontSize: px(9), color: COLOR.muted } }, props.sub),
    ),
  );
}

/** Rows per page segment (owner decision D4): bounds react-pdf's pagination cost on long tables. */
export const TABLE_SEGMENT_ROWS = 40;

/**
 * A long table laid out as consecutive `<Page>` segments of at most `TABLE_SEGMENT_ROWS` rows (owner decision D4: a
 * page break may fall at a segment boundary where Chromium would have continued the page). Every segment repeats the
 * header row and the page footer; `before` is printed on the first segment only, `after` on the last. Page numbers
 * ("Page x of y") count across all segments. With no rows there is one segment showing `emptyText`.
 */
export function SegmentedTablePages(props: {
  page: { size: 'A4'; orientation: 'landscape' | 'portrait'; style: Style };
  columns: readonly TableColumn[];
  rows: ReactNode[][];
  emptyText: string;
  before: ReactNode[];
  after: ReactNode[];
  footer: ReactNode;
}): ReactElement {
  const segments: ReactNode[][][] = [];
  for (let i = 0; i < props.rows.length; i += TABLE_SEGMENT_ROWS) segments.push(props.rows.slice(i, i + TABLE_SEGMENT_ROWS));
  if (segments.length === 0) segments.push([]);
  const last = segments.length - 1;
  return h(
    Fragment,
    null,
    ...segments.map((rows, s) =>
      h(
        Page,
        { key: `s${s}`, ...props.page },
        ...(s === 0 ? props.before : []),
        h(DataTable, { columns: props.columns, rows, emptyText: props.emptyText, rowOffset: s * TABLE_SEGMENT_ROWS }),
        ...(s === last ? props.after : []),
        props.footer,
      ),
    ),
  );
}

// ─── bottom section / sign-off ─────────────────────────────────────────────────────────────────────────────────────────

export interface Paragraph {
  text: string;
  muted: boolean;
}

/** A headed block of paragraphs (NOTES, MANAGER SIGN-OFF, …): the template's `.bottom h3` + `.bottom p`. */
export function SignOffBlock(props: { heading: string; paragraphs: Paragraph[] }): ReactElement {
  return h(
    View,
    null,
    h(Text, { minPresenceAhead: px(40), style: { fontSize: px(10.5), fontWeight: 700, letterSpacing: px(0.3), marginBottom: px(8) } }, props.heading),
    ...props.paragraphs.map((p, i) => h(Text, { key: `p${i}`, style: { marginBottom: px(6), color: p.muted ? COLOR.muted : undefined } }, p.text)),
  );
}

/**
 * Side-by-side blocks (40 px gap, fixed equal shares of the width: a long word can never widen one column and push the
 * other off the page, F-PDF-1). Like the template's `.bottom { page-break-inside: avoid }`, the section is kept on one
 * page — EXCEPT when its text may be taller than a page (`mayBreak`, see `mayExceedUnsplitHeight`): a react-pdf node
 * that cannot wrap and is taller than the page is drawn unsplit and everything past the page is lost (MEASURED: a 10 KB
 * note dropped the note, the counts and the page footers). Then, as Chromium does with an avoid-block taller than a
 * page, the section starts on a new page and continues across pages.
 */
export function BottomSection(props: { children: ReactNode[]; mayBreak?: boolean }): ReactElement {
  const spaced = props.children.map((c, i) => h(View, { key: `b${i}`, style: { flexGrow: 1, flexBasis: 0, marginLeft: i === 0 ? 0 : px(40) } }, c));
  const keep = props.mayBreak ? { wrap: true, break: true } : { wrap: false };
  return h(View, { ...keep, style: { flexDirection: 'row', marginTop: px(22) } }, ...spaced);
}

/**
 * Layout-only estimate (no business rule): could these paragraphs, in a column `columnPt` wide at `fontPt`, be taller
 * than `maxPt`? Deliberately pessimistic (assumes wide glyphs: 0.62 em per character, every newline a new line, 1.3
 * line spacing), so a section that might not fit is allowed to break rather than lose text. Used for BottomSection.
 */
export function mayExceedUnsplitHeight(paragraphs: readonly string[], columnPt: number, fontPt: number, maxPt: number): boolean {
  const charsPerLine = Math.max(1, Math.floor(columnPt / (fontPt * 0.62)));
  let lines = 0;
  for (const p of paragraphs) for (const line of p.split(/\n/)) lines += Math.max(1, Math.ceil(Array.from(line).length / charsPerLine));
  return lines * fontPt * 1.3 + paragraphs.length * px(6) > maxPt;
}

// ─── QR ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A QR code image from the PNG bytes the existing QR service produced (`QrImageService.generatePng` over the signed
 * token from `AttendanceQrService`). This component never encodes a payload itself: what is printed is exactly the
 * service's image, scaled to `sizePx` CSS px.
 */
export function QrCode(props: { png: Buffer; sizePx: number }): ReactElement {
  const size = px(props.sizePx);
  return h(Image, { src: pngBytes(props.png), style: { width: size, height: size } });
}
