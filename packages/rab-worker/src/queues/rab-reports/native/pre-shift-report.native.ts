import { Document, View } from '@react-pdf/renderer';
import { ReactElement, ReactNode } from 'react';

import type { PreShiftReportRowView, PreShiftReportViewModel } from '@rab/server/modules/attendance/templates/pre-shift-report.view-model';

import {
  BottomSection,
  COLOR,
  DocumentHeader,
  h,
  mayExceedUnsplitHeight,
  PAGE_MARGIN,
  PageFooter,
  pageStyle,
  px,
  QrCode,
  SegmentedTablePages,
  ShiftDetails,
  SignOffBlock,
  StaffCell,
  TableColumn,
  Text,
} from './document-components';

/**
 * PRE-SHIFT ATTENDANCE SHEET (the roster), native layout (PDF renderer P2). Lays out exactly the strings of the shared
 * view-model (`buildPreShiftReportViewModel`, rab-server) that the Chromium HTML template prints: nothing is formatted,
 * counted or labelled here. A4 landscape with the DOCUMENT_CSS margins, colours and type sizes; the staff table in
 * 40-row page segments (D4) with its header repeated on every page and the per-page footer.
 *
 * The QR is the signed Shift QR PNG exactly as `QrImageService.generatePng` produced it (carried in the view-model as
 * base64); this file only decodes those bytes back into a Buffer for `QrCode`, which refuses anything that is not a PNG.
 * It never encodes a payload, so the printed QR carries the same token as the Chromium document.
 */

/**
 * The template fixes the staff column at 44% and lets Chromium size the other three from their content; these are the
 * widths Chromium chose, measured from its output (owner decision D6: fixed widths, golden rasters are the reference).
 */
const COLUMN_WIDTHS = Object.freeze([44, 18.8, 19.8, 17.4]);

/** The template's `.qr` panel: 150 px wide, 1 px #E3E5E2 border, 10 px radius, #F6F7F5 fill, centred content. */
const QR_PANEL = Object.freeze({ width: 150, image: 128, border: '#E3E5E2', fill: '#F6F7F5' });

function QrPanel(props: { qr: PreShiftReportViewModel['qr'] }): ReactElement {
  return h(
    View,
    {
      style: {
        width: px(QR_PANEL.width),
        flexShrink: 0,
        borderWidth: px(1),
        borderColor: QR_PANEL.border,
        borderRadius: px(10),
        backgroundColor: QR_PANEL.fill,
        padding: px(10),
        alignItems: 'center',
      },
    },
    h(View, { style: { marginBottom: px(6) } }, h(QrCode, { png: Buffer.from(props.qr.pngBase64, 'base64'), sizePx: QR_PANEL.image })),
    h(Text, { style: { fontSize: px(10), fontWeight: 700, letterSpacing: px(0.3), textAlign: 'center' } }, props.qr.label),
    h(Text, { style: { fontSize: px(8.5), color: COLOR.muted, textAlign: 'center' } }, props.qr.caption),
  );
}

/** The template's `.top`: shift details on the left, the QR panel on the right, 24 px apart, aligned to the top. */
function TopRow(props: { vm: PreShiftReportViewModel }): ReactElement {
  return h(
    View,
    { style: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' } },
    // flexBasis 0: the column takes only the width left beside the fixed QR panel, so a long venue name wraps there
    // (with the default content basis yoga sizes it to the unwrapped heading and the text runs under the panel).
    h(View, { style: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, marginRight: px(24) } }, h(ShiftDetails, { details: props.vm.details })),
    h(QrPanel, { qr: props.vm.qr }),
  );
}

function rowCells(r: PreShiftReportRowView): ReactNode[] {
  return [h(StaffCell, { initials: r.initials, name: r.name, sub: r.sub }), h(Text, null, r.start), h(Text, null, r.finish), h(Text, null, r.breakText)];
}

/** A4 landscape: each bottom column's width and the page's content height, in pt (layout constants of this file). */
const BOTTOM_COLUMN_PT = (841.89 - PAGE_MARGIN.left - PAGE_MARGIN.right - px(40)) / 2;
const PAGE_CONTENT_PT = 595.28 - PAGE_MARGIN.top - PAGE_MARGIN.bottom;

/**
 * May the bottom section (NOTES / BEFORE-SHIFT DOCUMENT) be taller than what can stay unsplit on one page? Then it must
 * be allowed to break (BottomSection `mayBreak`, the I-9 rule): react-pdf draws an unsplittable node taller than the
 * page in one piece and loses everything past the page — MEASURED on the long-text roster (a 10 KB note): 2 pages
 * instead of 4, 29 of 56 note paragraphs and the page-2 footer missing, text drawn below the page.
 */
function bottomMayBreak(vm: PreShiftReportViewModel): boolean {
  const notes = [vm.notes.text, vm.qrScopeNote];
  const beforeShift = [...vm.beforeShiftLines];
  const max = PAGE_CONTENT_PT - px(22) - px(30); // minus the section's top margin and heading
  return [notes, beforeShift].some((col) => mayExceedUnsplitHeight(col, BOTTOM_COLUMN_PT, px(11), max));
}

export function PreShiftReportDocument(props: { vm: PreShiftReportViewModel; creationDate: Date }): ReactElement {
  const vm = props.vm;
  if (vm.columns.length !== COLUMN_WIDTHS.length) throw new Error('native PDF renderer: pre-shift report column count changed');
  const columns: TableColumn[] = vm.columns.map((label, i) => ({ label, widthPct: COLUMN_WIDTHS[i]! }));
  return h(
    Document,
    // D7: both dates are the document's generatedAt, so the same record renders to the same bytes.
    { title: vm.documentTitle, creator: 'Crewflow', producer: 'Crewflow', creationDate: props.creationDate, modificationDate: props.creationDate },
    h(SegmentedTablePages, {
      page: { size: 'A4', orientation: 'landscape', style: pageStyle() },
      columns,
      rows: vm.rows.map(rowCells),
      emptyText: vm.emptyText,
      before: [
        h(DocumentHeader, { key: 'header', title: vm.title }),
        h(TopRow, { key: 'top', vm }),
        h(Text, { key: 'summary', style: { color: COLOR.detail, marginTop: px(16), marginBottom: px(8), fontSize: px(10.5) } }, vm.summary),
      ],
      after: [
        h(Text, { key: 'note-line', style: { color: COLOR.muted, fontSize: px(9.5), marginTop: px(8) } }, vm.noteLine),
        h(BottomSection, {
          key: 'bottom',
          mayBreak: bottomMayBreak(vm),
          children: [
            // The shift notes keep the line breaks their author typed (pre-line, owner decision 2026-11-04).
            h(SignOffBlock, { heading: vm.notesHeading, paragraphs: [{ ...vm.notes, whiteSpace: 'pre-line' }, { text: vm.qrScopeNote, muted: true }] }),
            h(SignOffBlock, { heading: vm.beforeShiftHeading, paragraphs: vm.beforeShiftLines.map((text) => ({ text, muted: false })) }),
          ],
        }),
      ],
      footer: h(PageFooter, { left: vm.footer.left, generated: vm.footer.generated }),
    }),
  );
}
