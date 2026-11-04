import { Document, Text, View } from '@react-pdf/renderer';
import { ReactElement, ReactNode } from 'react';

import { FinalTimesheetRowView, FinalTimesheetViewModel } from '@rab/server/modules/attendance/templates/final-timesheet.view-model';

import {
  BottomSection,
  COLOR,
  DocumentHeader,
  h,
  PageFooter,
  pageStyle,
  px,
  SegmentedTablePages,
  ShiftDetails,
  SignOffBlock,
  StaffCell,
  Style,
  TableColumn,
} from './document-components';

/**
 * FINAL TIMESHEET, native layout (PDF renderer P1). Lays out exactly the strings of the shared view-model
 * (`buildFinalTimesheetViewModel`, rab-server) that the Chromium HTML template prints: nothing is formatted, summed or
 * labelled here. A4 landscape, the margins, colours and type sizes of DOCUMENT_CSS, the staff table in 40-row page
 * segments (D4) with its header repeated on every page.
 */

/**
 * The Chromium template fixes the staff column (26%) and the review column (28%) and lets the browser size the other
 * five from their content; these are the widths Chromium chose for the typical document, measured from its output
 * (owner decision D6: fixed widths, golden rasters are the reference).
 */
const COLUMN_WIDTHS = Object.freeze([26, 6.7, 8.7, 7.6, 8, 15, 28]);

function text(value: string, style?: Style): ReactElement {
  return h(Text, { style }, value);
}

function rowCells(r: FinalTimesheetRowView): ReactNode[] {
  return [
    h(StaffCell, { initials: r.initials, name: r.name, sub: r.sub }),
    text(r.clockIn),
    text(r.clockOut, r.clockOutFlagged ? { color: COLOR.flag, fontWeight: 700 } : undefined),
    text(r.breakText),
    text(r.hours),
    // `<small>` in the template: the browser's "smaller" step (1/1.2) of the cell's 10.5 px.
    h(View, null, text(r.status), r.correctedNote ? text(r.correctedNote, { color: COLOR.muted, fontSize: px(10.5) / 1.2 }) : null),
    h(View, null, ...r.review.lines.map((line, i) => h(Text, { key: `l${i}`, style: r.review.muted ? { color: COLOR.muted } : undefined }, line))),
  ];
}

export function FinalTimesheetDocument(props: { vm: FinalTimesheetViewModel; creationDate: Date }): ReactElement {
  const vm = props.vm;
  if (vm.columns.length !== COLUMN_WIDTHS.length) throw new Error('native PDF renderer: final timesheet column count changed');
  const columns: TableColumn[] = vm.columns.map((label, i) => ({ label, widthPct: COLUMN_WIDTHS[i]! }));
  return h(
    Document,
    // D7: the creation date is the document's generatedAt, so the same record renders to the same bytes. No
    // `modificationDate`: react-pdf 4.9 writes it under the non-standard key /ModificationDate (pdfkit writes no /ModDate).
    { title: vm.documentTitle, creator: 'Crewflow', producer: 'Crewflow', creationDate: props.creationDate },
    h(SegmentedTablePages, {
      page: { size: 'A4', orientation: 'landscape', style: pageStyle() },
      columns,
      rows: vm.rows.map(rowCells),
      emptyText: vm.emptyText,
      before: [
        h(DocumentHeader, { key: 'header', title: vm.title }),
        h(ShiftDetails, { key: 'details', details: vm.details }),
        h(Text, { key: 'summary', style: { color: COLOR.detail, marginTop: px(16), marginBottom: px(8), fontSize: px(10.5) } }, vm.summary),
      ],
      after: [
        h(Text, { key: 'legend', style: { color: COLOR.muted, fontSize: px(9.5), marginTop: px(8) } }, vm.scaleLegend),
        h(BottomSection, {
          key: 'bottom',
          children: [
            h(SignOffBlock, { heading: vm.notesHeading, paragraphs: [vm.notes, { text: vm.counts, muted: true }] }),
            h(SignOffBlock, { heading: vm.signOffHeading, paragraphs: [...vm.signOff, { text: vm.totalWorked, muted: true }] }),
          ],
        }),
      ],
      footer: h(PageFooter, { left: vm.footer.left, generated: vm.footer.generated }),
    }),
  );
}
