import { escapeHtml } from '../../../engine/utils/escape-html';
import { DOCUMENT_CSS, documentHeaderHtml, shiftDetailsHtmlFromView, staffCellHtmlFromView } from './adolphus-document';
import { buildFinalTimesheetViewModel, FinalTimesheetData, FinalTimesheetViewModel, TextLine } from './final-timesheet.view-model';

export type { FinalTimesheetData, FinalTimesheetStaffRow, StaffReviewScores } from './final-timesheet.view-model';

/**
 * FINAL TIMESHEET (Adolphus Group template, owner design 2026-10-17), Chromium HTML. Two variants from the same data, as
 * before: the immutable unsigned ORIGINAL (`unsigned: true`, before manager review) and the finalised document.
 *
 * Every printed string comes from the shared view-model (`final-timesheet.view-model.ts`), which the native PDF renderer
 * also consumes; this file only lays those strings out as HTML, escaping every one of them.
 */
export function renderFinalTimesheetHtml(data: FinalTimesheetData): string {
  return finalTimesheetHtmlFromViewModel(buildFinalTimesheetViewModel(data));
}

const COLUMN_WIDTH: Record<number, string> = { 0: '26%', 6: '28%' };

function p(line: TextLine): string {
  return line.muted ? `<p class="muted">${escapeHtml(line.text)}</p>` : `<p>${escapeHtml(line.text)}</p>`;
}

export function finalTimesheetHtmlFromViewModel(vm: FinalTimesheetViewModel): string {
  const rows = vm.rows
    .map((s) => {
      const review = s.review.lines.map(escapeHtml).join('<br>');
      return `
      <tr>
        <td>${staffCellHtmlFromView(s.initials, s.name, s.sub)}</td>
        <td>${escapeHtml(s.clockIn)}</td>
        <td${s.clockOutFlagged ? ' class="flag"' : ''}>${escapeHtml(s.clockOut)}</td>
        <td>${escapeHtml(s.breakText)}</td>
        <td>${escapeHtml(s.hours)}</td>
        <td>${escapeHtml(s.status)}${s.correctedNote ? `<br><small class="muted">${escapeHtml(s.correctedNote)}</small>` : ''}</td>
        <td>${s.review.muted ? `<span class="muted">${review}</span>` : review}</td>
      </tr>`;
    })
    .join('');
  const head = vm.columns.map((c, i) => `<th${COLUMN_WIDTH[i] ? ` style="width:${COLUMN_WIDTH[i]}"` : ''}>${escapeHtml(c)}</th>`).join('');
  const [first, ...rest] = vm.signOff;
  const signOff = vm.unsigned ? vm.signOff.map(p).join('') : `${first ? p(first) : ''}\n      ${rest.map(p).join('')}`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(vm.documentTitle)}</title>
<style>${DOCUMENT_CSS}</style>
</head>
<body>
  ${documentHeaderHtml(vm.title)}
  <section class="top"><div>${shiftDetailsHtmlFromView(vm.details)}</div></section>
  <div class="summary">${escapeHtml(vm.summary)}</div>
  <table>
    <thead><tr>${head}</tr></thead>
    <tbody>${rows || `<tr><td colspan="${vm.columns.length}" class="muted">${escapeHtml(vm.emptyText)}</td></tr>`}</tbody>
  </table>
  <div class="note-line">${escapeHtml(vm.scaleLegend)}</div>
  <section class="bottom">
    <div>
      <h3>${escapeHtml(vm.notesHeading)}</h3>
      <p>${vm.notes.muted ? `<span class="muted">${escapeHtml(vm.notes.text)}</span>` : escapeHtml(vm.notes.text)}</p>
      ${p({ text: vm.counts, muted: true })}
    </div>
    <div>
      <h3>${escapeHtml(vm.signOffHeading)}</h3>
      ${signOff}
      ${p({ text: vm.totalWorked, muted: true })}
    </div>
  </section>
</body>
</html>`;
}
