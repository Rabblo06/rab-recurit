import { Document, Page, Text, View } from '@react-pdf/renderer';
import { ReactElement } from 'react';

import type { ApprovedShiftStatementViewModel, StatementRowView } from '@rab/server/modules/payroll/templates/approved-shift-statement.view-model';

import { COLOR, DocumentHeader, h, mm, pageStyle, px } from './document-components';

/**
 * APPROVED SHIFT STATEMENT, native layout (PDF_RENDERER=native). Prints the shared view-model
 * (`buildApprovedShiftStatementViewModel`, rab-server) and nothing else: no date, money or minute is formatted or computed
 * here; every value is a plain string child of `<Text>` (never markup). Styles follow the Chromium template's CSS
 * (`approved-shift-statement.html.ts` + `DOCUMENT_CSS`), converted with `px()`.
 *
 * Page: A4 portrait, no footer (as Chromium). Margins are 12 mm on every side — owner decision D9 (2026-11-04): the
 * Chromium path prints this document with 0 mm margins, a defect fixed here as a separately approved, visible change.
 * The Chromium path is unchanged.
 */
export const STATEMENT_PAGE_MARGIN = Object.freeze({ top: mm(12), right: mm(12), bottom: mm(12), left: mm(12) });

const C = Object.freeze({
  green: '#2E7D4F',
  greenBg: '#EEF7F1',
  amberRule: '#F0C9A6',
  amberBg: '#FFF6EE',
});

/** `table.kv`: th = 38 % on the light background, bold; td bordered below; even rows of each tbody shaded. */
function KvRows(props: { rows: StatementRowView[]; total?: boolean }): ReactElement {
  const fontSize = props.total ? px(13) : px(10.5);
  return h(
    View,
    null,
    ...props.rows.map((r, i) =>
      h(
        View,
        { key: `r${i}`, wrap: false, style: { flexDirection: 'row', alignItems: 'stretch' } },
        h(
          View,
          { style: { width: '38%', backgroundColor: COLOR.rowAlt, paddingVertical: px(9), paddingHorizontal: px(10), justifyContent: 'center' } },
          h(Text, { style: { fontSize, fontWeight: 700, color: COLOR.ink } }, r.label),
        ),
        h(
          View,
          {
            style: {
              width: '62%',
              paddingVertical: px(8),
              paddingHorizontal: px(10),
              justifyContent: 'center',
              borderBottomWidth: px(1),
              borderBottomColor: COLOR.rowRule,
              backgroundColor: i % 2 === 1 ? COLOR.rowAlt : undefined,
            },
          },
          h(Text, { style: { fontSize, fontWeight: props.total ? 700 : 400 } }, r.value),
        ),
      ),
    ),
  );
}

function LabelledValue(props: { label: string; value: string; sub?: string }): ReactElement {
  return h(
    View,
    { style: { flexGrow: 1, flexBasis: 0 } },
    h(Text, { style: { color: COLOR.muted, fontSize: px(9.5), textTransform: 'uppercase', letterSpacing: px(0.4), marginBottom: px(3) } }, props.label),
    h(Text, { style: { fontSize: px(12), fontWeight: 700 } }, props.value),
    props.sub !== undefined ? h(Text, { style: { color: COLOR.muted } }, props.sub) : null,
  );
}

export function ApprovedShiftStatementDocument(props: { vm: ApprovedShiftStatementViewModel; creationDate: Date }): ReactElement {
  const vm = props.vm;
  return h(
    Document,
    // D7: both dates are the statement's generatedAt, so the same record renders to the same bytes.
    { title: vm.documentTitle, creator: 'Crewflow', producer: 'Crewflow', creationDate: props.creationDate, modificationDate: props.creationDate },
    h(
      Page,
      { size: 'A4', orientation: 'portrait', style: pageStyle(STATEMENT_PAGE_MARGIN) },
      h(DocumentHeader, { title: vm.title }),
      // .brand: margin -10px 0 14px (pulled up into the rule's bottom margin).
      h(Text, { style: { fontSize: px(11), color: COLOR.detail, marginTop: px(-10), marginBottom: px(14) } }, vm.brandLine),
      // .approved: green left rule, light green panel, 12px semi-bold.
      h(
        View,
        { wrap: false, style: { marginBottom: px(16), paddingVertical: px(10), paddingHorizontal: px(12), borderLeftWidth: px(3), borderLeftColor: C.green, backgroundColor: C.greenBg } },
        h(Text, { style: { fontSize: px(12), fontWeight: 700 } }, vm.approvedLine),
      ),
      // .grid: two equal columns, 32px gap.
      h(
        View,
        { wrap: false, style: { flexDirection: 'row', marginBottom: px(16) } },
        h(LabelledValue, { label: vm.staffLabel, value: vm.staffName, sub: vm.staffRefLine }),
        h(View, { style: { width: px(32) } }),
        h(LabelledValue, { label: vm.referenceLabel, value: vm.statementReference }),
      ),
      h(KvRows, { rows: vm.details }),
      h(KvRows, { rows: [vm.total], total: true }),
      h(KvRows, { rows: vm.approval }),
      // .note-line: muted 9.5px, 8px above, the paragraph's 1em below.
      h(Text, { style: { color: COLOR.muted, fontSize: px(9.5), marginTop: px(8), marginBottom: px(9.5) } }, vm.generatedLine),
      // .disclaimer: amber bordered panel.
      h(
        View,
        { wrap: false, style: { marginTop: px(18 - 9.5), paddingVertical: px(10), paddingHorizontal: px(12), borderWidth: px(1), borderColor: C.amberRule, backgroundColor: C.amberBg } },
        h(Text, { style: { fontSize: px(10.5) } }, vm.disclaimer),
      ),
    ),
  );
}
