import { readFileSync } from 'fs';
import { join } from 'path';

import { documentFooterTemplate, documentFooterTemplateFromView } from '../templates/adolphus-document';
import { preShiftReportHtmlFromViewModel, renderPreShiftReportHtml } from '../templates/pre-shift-report.html';
import { buildPreShiftReportViewModel, PRE_SHIFT_REPORT_COLUMNS, PreShiftReportViewModel } from '../templates/pre-shift-report.view-model';
import { BASE_SHIFT_INFO, FIXTURE_QR_PNG_BASE64, PRE_SHIFT_FIXTURE_NAMES, PRE_SHIFT_FIXTURES } from '../../../__tests__/fixtures/pre-shift-report.fixtures';

/**
 * Pre-shift attendance sheet (roster) — PDF renderer migration, view-model seam.
 *
 * T1 golden HTML: `golden/pre-shift-report/*.html` were written by the template on origin/main 824f0824, BEFORE the
 * view-model refactor. The Chromium input (page HTML and footer template) must stay byte-identical, so the Chromium path
 * provably prints exactly what it printed before. Regenerated ONCE since, for the owner-ordered F-PDF-1 fix and pre-line
 * notes (decision 2026-11-04): VERIFIED when regenerated that, with `.bottom > div { flex: 1; }` restored, the
 * `.notes-text` rule removed and `<p class="notes-text">` back to `<p>`, every page equals its 824f0824 golden byte for
 * byte (footers unchanged), so nothing else moved.
 * T4 view-model: the strings both renderers print, the organisation timezone (incl. both DST nights), and that the
 * view-model carries no number either renderer could compute with.
 */
const GOLDEN = join(__dirname, 'golden', 'pre-shift-report');
const golden = (file: string) => readFileSync(join(GOLDEN, file), 'utf8');

describe('pre-shift attendance sheet: golden HTML (Chromium input unchanged by the view-model refactor)', () => {
  it.each(PRE_SHIFT_FIXTURE_NAMES.map((n) => [n]))('%s: page HTML is byte-identical', (name) => {
    expect(renderPreShiftReportHtml(PRE_SHIFT_FIXTURES[name]!)).toBe(golden(`${name}.html`));
  });

  it.each(PRE_SHIFT_FIXTURE_NAMES.map((n) => [n]))('%s: footer template is byte-identical, from data or from the view-model', (name) => {
    const data = PRE_SHIFT_FIXTURES[name]!;
    expect(documentFooterTemplate(data)).toBe(golden(`${name}.footer.html`));
    expect(documentFooterTemplateFromView(buildPreShiftReportViewModel(data).footer)).toBe(golden(`${name}.footer.html`));
  });

  it('renders from the view-model alone (the seam both renderers share)', () => {
    const data = PRE_SHIFT_FIXTURES['four-staff']!;
    expect(preShiftReportHtmlFromViewModel(buildPreShiftReportViewModel(data))).toBe(golden('four-staff.html'));
  });
});

/** Every leaf of the view-model, so a test can assert on its types. */
function leaves(value: unknown, path = 'vm', out: [string, unknown][] = []): [string, unknown][] {
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) leaves(v, `${path}.${k}`, out);
  } else out.push([path, value]);
  return out;
}

describe('pre-shift attendance sheet: view-model', () => {
  const vm = (name: string): PreShiftReportViewModel => buildPreShiftReportViewModel(PRE_SHIFT_FIXTURES[name]!);

  it('prints the roster rows: initials, "ref · role", start / finish in the organisation timezone, planned break', () => {
    const v = vm('four-staff');
    expect(v.title).toBe('Shift attendance sheet');
    expect(v.documentTitle).toBe('Shift attendance sheet — The Grand Hall & Terrace <Main>');
    expect(v.columns).toEqual(['Assigned staff', 'Scheduled start', 'Scheduled finish', 'Planned break']);
    expect(v.columns).toBe(PRE_SHIFT_REPORT_COLUMNS);
    expect(v.rows).toEqual([
      { name: 'Staff Member 01', initials: 'SM', sub: 'ST-1000 · Bar Staff', start: '18:00', finish: '02:00', breakText: '30 min' },
      { name: 'Staff Member 02', initials: 'SM', sub: 'Bar Staff', start: '18:00', finish: '02:00', breakText: '—' },
      { name: 'Staff Member 03', initials: 'SM', sub: 'ST-1002 · Bar Staff', start: '18:00', finish: '02:00', breakText: '0 min' },
      { name: 'Staff Member 04', initials: 'SM', sub: 'Bar Staff', start: '18:00', finish: '02:00', breakText: '30 min' },
    ]);
    expect(v.summary).toBe('Before shift · 4 assigned staff · Scan the QR in the staff app to clock in or out');
    expect(v.details).toEqual({
      venueName: 'The Grand Hall & Terrace <Main>',
      address: '1 "High" Street, London',
      role: 'Role: Bar Staff',
      date: 'Tue, 20 Oct 2026',
      scheduled: '18:00–02:00',
      contact: 'Jo Venue · 020 7946 0000',
      shiftReference: 'SHIFT-20261020-9A3B0C',
    });
    expect(v.footer).toEqual({ left: 'Adolphus Events · SHIFT-20261020-9A3B0C', generated: 'Generated Tue, 20 Oct 2026, 16:00' });
    expect(v.notes).toEqual({ text: 'Black tie. Report to the side door.', muted: false });
  });

  it('carries the QR PNG bytes exactly as the QR service produced them (never re-encoded)', () => {
    expect(vm('four-staff').qr).toEqual({
      pngBase64: FIXTURE_QR_PNG_BASE64,
      alt: 'Shift QR code for clock in and clock out',
      label: 'CLOCK IN / OUT',
      caption: 'System-generated code',
    });
  });

  it('autumn DST night: a start in BST, a finish in GMT', () => {
    const v = vm('dst-autumn-night');
    expect(v.details.scheduled).toBe('00:30–06:00');
    expect(v.details.date).toBe('Sun, 25 Oct 2026');
    expect(v.rows.map((r) => [r.start, r.finish])).toEqual([['00:30', '01:59'], ['00:30', '06:00'], ['00:30', '06:00']]);
  });

  it('spring DST night: a start in GMT, a finish in BST', () => {
    const v = vm('dst-spring-night');
    expect(v.details.scheduled).toBe('23:00–06:00');
    expect(v.rows[0]).toMatchObject({ start: '23:00', finish: '06:00' });
  });

  it('a non-London organisation prints in its own timezone', () => {
    const v = vm('non-london-timezone');
    expect(v.details.scheduled).toBe('13:00–21:00');
    expect(v.footer.generated).toBe('Generated Tue, 20 Oct 2026, 11:00');
  });

  it('empty roster and absent optional fields: the stated empty text, muted "No shift notes.", no invented lines', () => {
    expect(vm('empty')).toMatchObject({ rows: [], emptyText: 'No confirmed staff yet.', notes: { text: 'No shift notes.', muted: true } });
    expect(vm('empty').summary).toBe('Before shift · 0 assigned staff · Scan the QR in the staff app to clock in or out');
    const absent = vm('optional-absent');
    expect(absent.details).toMatchObject({ address: null, contact: null });
    expect(absent.notes).toEqual({ text: 'No shift notes.', muted: true });
    expect(absent.footer.left).toBe(BASE_SHIFT_INFO.shiftReference);
    expect(vm('contact-phone-only').details.contact).toBe('07700 900123');
  });

  it('keeps hostile text as plain text (escaping is the HTML renderer\'s job; the native renderer never parses markup)', () => {
    const v = vm('hostile');
    expect(v.details.venueName).toBe('<img src="http://127.0.0.1:9/venue.png"><script>document.title="x"</script> & Co');
    expect(v.details.role).toBe('Department / role: Events & <Ops> · R&D <ops>');
    expect(v.rows[0]).toMatchObject({ name: '<script>alert(1)</script> Smith', sub: '<i>ref</i> · R&D <ops>' });
    const html = renderPreShiftReportHtml(PRE_SHIFT_FIXTURES.hostile!);
    expect(html).not.toMatch(/<script|<img src="http|<link|<i>ref/i); // case-insensitive: no raw tag in any case
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Smith');
  });

  it.each(PRE_SHIFT_FIXTURE_NAMES.map((n) => [n]))('%s: the view-model is strings and booleans only', (name) => {
    for (const [path, leaf] of leaves(vm(name))) {
      expect([path, typeof leaf === 'string' || typeof leaf === 'boolean' || leaf === null]).toEqual([path, true]);
    }
  });
});
