import { escapeHtml } from '@rab/server/engine/utils/escape-html';

/**
 * Subject, plain text and HTML for the two report emails (pre-shift roster + QR, final timesheet).
 *
 * The venue name is Manager-controlled free text. Before it reaches any email field it is reduced to ONE safe line:
 * every C0/C1 control character (CR and LF included) and the Unicode line/paragraph separators become a space, runs
 * of whitespace collapse, and the result is capped. In the HTML body the same line is then escaped with the one
 * canonical helper (MAIL-01, `escapeHtml`); `<p>…</p>` is trusted template markup. The subject as a whole is also
 * reduced to one capped line, so no value can add a header line or a second subject line.
 *
 * The PDF templates are NOT touched here: they already escape their own values.
 */
export const REPORT_EMAIL_LINE_MAX = 200;

const CONTROL_AND_LINE_BREAKS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** One line, no control characters, at most `max` code points (never splits a surrogate pair). */
export function toSafeEmailLine(value: string | null | undefined, max = REPORT_EMAIL_LINE_MAX): string {
  const oneLine = String(value ?? '').replace(CONTROL_AND_LINE_BREAKS, ' ').replace(/\s+/g, ' ').trim();
  const codePoints = Array.from(oneLine);
  return codePoints.length > max ? codePoints.slice(0, max).join('').trimEnd() : oneLine;
}

export interface RenderedReportEmail {
  subject: string;
  text: string;
  html: string;
}

function render(subjectPrefix: string, sentence: (venue: string) => string, venueName: string): RenderedReportEmail {
  const venue = toSafeEmailLine(venueName);
  return {
    subject: toSafeEmailLine(`${subjectPrefix} — ${venue}`),
    text: sentence(venue),
    html: `<p>${escapeHtml(sentence(venue))}</p>`,
  };
}

export function renderRosterEmail(venueName: string): RenderedReportEmail {
  return render('Shift attendance sheet & QR', (venue) => `Your shift attendance sheet with the Shift QR for ${venue} is attached.`, venueName);
}

export function renderFinalTimesheetEmail(venueName: string): RenderedReportEmail {
  return render('Final Timesheet', (venue) => `Your finalised timesheet for ${venue} is attached.`, venueName);
}
