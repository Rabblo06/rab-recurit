import { escapeHtml } from '../../../engine/utils/escape-html';
import { DOCUMENT_CSS, documentHeaderHtml } from '../../attendance/templates/adolphus-document';
import { type ApprovedShiftStatementData, type ApprovedShiftStatementViewModel, buildApprovedShiftStatementViewModel } from './approved-shift-statement.view-model';

/**
 * Approved Shift Statement — the Chromium (HTML) renderer. Every printed string comes from the shared view-model
 * (`approved-shift-statement.view-model.ts`), which the native renderer consumes too; this file only lays it out and
 * escapes every value. Data, wording and helpers are re-exported from the view-model for existing importers.
 */
export type { ApprovedShiftStatementData, ApprovedShiftStatementViewModel, StatementRowView } from './approved-shift-statement.view-model';
export {
  APPROVED_SHIFT_STATEMENT_TITLE,
  buildApprovedShiftStatementViewModel,
  breakPaidFromFigures,
  SHIFT_EARNINGS_APPROVED_LINE,
  shiftStatementReference,
  STATEMENT_DISCLAIMER,
  TO_BE_CONFIRMED,
} from './approved-shift-statement.view-model';

export function renderApprovedShiftStatementHtml(d: ApprovedShiftStatementData): string {
  return approvedShiftStatementHtmlFromViewModel(buildApprovedShiftStatementViewModel(d));
}

export function approvedShiftStatementHtmlFromViewModel(vm: ApprovedShiftStatementViewModel): string {
  const row = (r: { label: string; value: string }) => `<tr><th scope="row">${escapeHtml(r.label)}</th><td>${escapeHtml(r.value)}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(vm.documentTitle)}</title><style>${DOCUMENT_CSS}
    @page { size: A4 portrait; }
    .brand { font-size: 11px; color: #6B7270; margin: -10px 0 14px; }
    .approved { margin: 0 0 16px; padding: 10px 12px; border-left: 3px solid #2E7D4F; background: #EEF7F1; font-size: 12px; font-weight: 600; }
    .grid { display: flex; gap: 32px; margin-bottom: 16px; }
    .grid > div { flex: 1; }
    .label { color: #8A8F8C; font-size: 9.5px; text-transform: uppercase; letter-spacing: .4px; margin-bottom: 3px; }
    .value { font-size: 12px; font-weight: 600; }
    table.kv th { background: #F4F5F3; color: #1F2321; width: 38%; font-weight: 600; }
    .total td, .total th { font-size: 13px; font-weight: 700; }
    .disclaimer { margin-top: 18px; padding: 10px 12px; border: 1px solid #F0C9A6; background: #FFF6EE; font-size: 10.5px; }
  </style></head><body>
  ${documentHeaderHtml(vm.title)}
  <div class="brand">${escapeHtml(vm.brandLine)}</div>
  <div class="approved">${escapeHtml(vm.approvedLine)}</div>
  <div class="grid">
    <div><div class="label">${escapeHtml(vm.staffLabel)}</div><div class="value">${escapeHtml(vm.staffName)}</div><div class="muted">${escapeHtml(vm.staffRefLine)}</div></div>
    <div><div class="label">${escapeHtml(vm.referenceLabel)}</div><div class="value">${escapeHtml(vm.statementReference)}</div></div>
  </div>
  <table class="kv">
    <tbody>
      ${vm.details.map(row).join('\n      ')}
    </tbody>
    <tbody class="total">${row(vm.total)}</tbody>
    <tbody>
      ${vm.approval.map(row).join('\n      ')}
    </tbody>
  </table>
  <p class="note-line">${escapeHtml(vm.generatedLine)}</p>
  <div class="disclaimer">${escapeHtml(vm.disclaimer)}</div>
</body></html>`;
}
