/**
 * Plain template-literal HTML — no second templating stack pulled into the
 * worker just for one internal document (React-Email's renderer stays
 * scoped to actual emails, `packages/rab-emails`). Rendered by Playwright
 * (`chromium.launch()` -> `page.setContent()` -> `page.pdf()`) in
 * `shift-report-scheduler.job.ts`. QR is embedded as a base64 PNG data URI
 * — no external asset request Playwright would need to wait on.
 */

export interface PreShiftReportStaffRow {
  name: string;
  roleName: string;
}

export interface PreShiftReportData {
  venueName: string;
  venueAddress?: string;
  roleName: string;
  startsAt: string;
  endsAt: string;
  staff: PreShiftReportStaffRow[];
  qrPngBase64: string;
}

export function renderPreShiftReportHtml(data: PreShiftReportData): string {
  const rows = data.staff
    .map(
      (s) => `
        <tr>
          <td>${escapeHtml(s.name)}</td>
          <td>${escapeHtml(s.roleName)}</td>
          <td class="blank"></td>
          <td class="blank"></td>
          <td class="blank"></td>
        </tr>`,
    )
    .join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: Arial, Helvetica, sans-serif; color: #111312; margin: 32px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .subtitle { color: #6B7270; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th, td { border: 1px solid #E3E6E3; padding: 8px 10px; text-align: left; font-size: 13px; }
  th { background: #F2F3F1; }
  td.blank { min-width: 90px; }
  .qr-section { margin-top: 32px; text-align: center; }
  .qr-section img { width: 320px; height: 320px; }
  .qr-caption { font-weight: bold; margin-top: 8px; }
</style>
</head>
<body>
  <h1>RAB Recruitment — Shift Roster</h1>
  <div class="subtitle">
    ${escapeHtml(data.venueName)}${data.venueAddress ? ` — ${escapeHtml(data.venueAddress)}` : ''}<br>
    ${escapeHtml(data.roleName)} — ${escapeHtml(data.startsAt)} to ${escapeHtml(data.endsAt)}
  </div>
  <table>
    <thead>
      <tr><th>Name</th><th>Role</th><th>Clock In</th><th>Break</th><th>Clock Out</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="qr-section">
    <img src="data:image/png;base64,${data.qrPngBase64}" alt="Shift QR" />
    <div class="qr-caption">SCAN TO CLOCK IN / CLOCK OUT</div>
  </div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
