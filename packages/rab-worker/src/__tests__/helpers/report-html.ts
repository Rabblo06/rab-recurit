import { renderFinalTimesheetHtml } from '@rab/server/modules/attendance/templates/final-timesheet.html';
import { renderPreShiftReportHtml } from '@rab/server/modules/attendance/templates/pre-shift-report.html';
import { renderApprovedShiftStatementHtml } from '@rab/server/modules/payroll/templates/approved-shift-statement.html';

import type { ReportDocument } from '../../queues/rab-reports/render-pdf.util';

/**
 * TEST ONLY. The HTML template output for a data-in report document: what `render-pdf.util.ts` `htmlFor(doc)` returned
 * before P5 removed the Chromium path (native only). Specs that record "what the job asked to print" as text keep doing
 * so from the same data through the same rab-server templates, which stay until D10 deletes them after one native-only
 * release. Never used to render a PDF: the Worker has no browser.
 */
export function reportHtmlFor(doc: ReportDocument): string {
  switch (doc.kind) {
    case 'pre-shift':
      return renderPreShiftReportHtml(doc.data);
    case 'final-timesheet':
      return renderFinalTimesheetHtml(doc.data);
    case 'approved-shift-statement':
      return renderApprovedShiftStatementHtml(doc.data);
  }
}
