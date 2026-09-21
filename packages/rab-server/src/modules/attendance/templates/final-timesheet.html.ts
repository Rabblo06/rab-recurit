/** Plain template-literal HTML, same reasoning as `pre-shift-report.html.ts`. */

export interface FinalTimesheetStaffRow {
  name: string;
  roleName: string;
  scheduledStart: string;
  scheduledEnd: string;
  clockInAt: string | null;
  clockOutAt: string | null;
  breakMinutes: number | null;
  workedMinutes: number | null;
  status: string;
  corrected: boolean;
}

export interface FinalTimesheetData {
  venueName: string;
  venueAddress?: string;
  roleName: string;
  startsAt: string;
  endsAt: string;
  staff: FinalTimesheetStaffRow[];
  finalisedByName: string;
  finalisedAt: string;
}

function formatMinutes(minutes: number | null): string {
  if (minutes == null) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m}m`;
}

export function renderFinalTimesheetHtml(data: FinalTimesheetData): string {
  const rows = data.staff
    .map(
      (s) => `
        <tr>
          <td>${escapeHtml(s.name)}${s.corrected ? ' <span class="corrected">(corrected)</span>' : ''}</td>
          <td>${escapeHtml(s.roleName)}</td>
          <td>${escapeHtml(s.scheduledStart)} – ${escapeHtml(s.scheduledEnd)}</td>
          <td>${s.clockInAt ? escapeHtml(s.clockInAt) : '—'}</td>
          <td>${s.breakMinutes != null ? `${s.breakMinutes} min` : '—'}</td>
          <td>${s.clockOutAt ? escapeHtml(s.clockOutAt) : '—'}</td>
          <td>${formatMinutes(s.workedMinutes)}</td>
          <td>${escapeHtml(s.status)}</td>
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
  th, td { border: 1px solid #E3E6E3; padding: 6px 8px; text-align: left; font-size: 12px; }
  th { background: #F2F3F1; }
  .corrected { color: #B54708; font-size: 10px; }
  .footer { margin-top: 32px; font-size: 12px; color: #6B7270; }
</style>
</head>
<body>
  <h1>RAB Recruitment — Final Timesheet</h1>
  <div class="subtitle">
    ${escapeHtml(data.venueName)}${data.venueAddress ? ` — ${escapeHtml(data.venueAddress)}` : ''}<br>
    ${escapeHtml(data.roleName)} — ${escapeHtml(data.startsAt)} to ${escapeHtml(data.endsAt)}
  </div>
  <table>
    <thead>
      <tr><th>Name</th><th>Role</th><th>Scheduled</th><th>Clock In</th><th>Break</th><th>Clock Out</th><th>Worked</th><th>Status</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="footer">
    Reviewed by ${escapeHtml(data.finalisedByName)} — Finalised at ${escapeHtml(data.finalisedAt)}
  </div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
