/**
 * MAIL-01 — the one canonical HTML-escaping helper for dynamic text
 * interpolated into a trusted HTML template (never used on the template
 * markup itself, only on user/business-controlled values inserted into a
 * text position — see `NotificationService.notify()`'s own doc comment for
 * the full text-vs-template-structure distinction).
 *
 * Was previously duplicated verbatim in `pre-shift-report.html.ts` and
 * `final-timesheet.html.ts` — exactly the "ad-hoc escaping in multiple
 * services" this consolidation avoids going forward. Both now import this
 * instead of keeping their own private copy.
 *
 * Escapes the five characters that matter for HTML text/attribute contexts:
 * `&` first (so it never double-encodes the entities this function itself
 * just produced), then `< > " '`.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
